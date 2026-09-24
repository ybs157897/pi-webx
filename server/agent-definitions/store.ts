/**
 * The definitions file: path resolution, atomic writes and the store class.
 *
 * The two invariants enforced here are the ones that need the filesystem:
 * **single-process atomicity** (writes are serialized by an in-process queue
 * keyed by the *canonical* path, and land through `tmp + fsync + rename`) and
 * **a corrupt file is never overwritten** (bad bytes read as a 500 and are left
 * exactly as they were). Nothing here pretends to be a cross-process
 * transaction or a TOCTOU-safe lock.
 *
 * See `./index.ts` for the module's full guarantee list.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { AgentDefinitionsResponse } from '../../src/shared/agent-definitions';
import { isBuiltinAgentId, mergeBuiltinAndUserAgents } from '../builtin-agents';
import {
  SCHEMA_VERSION,
  assertNameFree,
  mergeDefinitionPatch,
  parseStoredFile,
  validateMergedForWrite,
  type RawDiskFile,
  type StoredAgent,
} from './merge';
import {
  AgentDefinitionError,
  assertOnlyKeys,
  fail,
  isRecord,
  parseDefinitionInput,
  parseDefinitionPatch,
} from './validation';

/** Environment override for the definitions file. Must be absolute when set. */
const FILE_ENV = 'PI_WEBX_SUBAGENTS_FILE';

/* -------------------------------------------------------------------- paths */

function resolveConfiguredPath(): string {
  const fromEnv = process.env[FILE_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!path.isAbsolute(fromEnv)) {
      throw new AgentDefinitionError(500, `${FILE_ENV} 必须是绝对路径：${fromEnv}`);
    }
    return path.normalize(fromEnv);
  }
  return path.join(getAgentDir(), 'pi-webx', 'agent-definitions.json');
}

/**
 * The default file, resolved lazily.
 *
 * Lazy on purpose: a bad `PI_WEBX_SUBAGENTS_FILE` must fail the request that
 * touches the file, not the `import` that creates the singleton — a bridge that
 * cannot boot because of one env var has no way to tell the user what is wrong.
 */
function defaultFilePath(): string {
  return resolveConfiguredPath();
}

/* -------------------------------------------------------------- file access */

function readFileText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new AgentDefinitionError(500, `读取定义文件失败：${filePath}（${String(code)}）`);
  }
}

/**
 * Read and validate the file. A missing file is an empty store at revision 0 —
 * the only state that does not require the file to exist.
 */
function readDiskFile(filePath: string): RawDiskFile {
  const text = readFileText(filePath);
  if (text === undefined) return { schemaVersion: SCHEMA_VERSION, revision: 0, agents: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentDefinitionError(500, `定义文件无法解析（${message}），请先手工修复：${filePath}`);
  }
  return parseStoredFile(parsed, 500);
}

/**
 * Write through `tmp + fsync + rename`.
 *
 * `open(..., 'wx', 0o600)` refuses to reuse a tmp name, so two writers that
 * somehow raced cannot interleave inside one tmp file; the rename is the only
 * thing that publishes, and it is atomic on the same filesystem.
 */
async function writeDiskFile(filePath: string, payload: RawDiskFile): Promise<void> {
  // Follow a symlinked file to its target instead of replacing the link.
  const target = writeTargetFor(filePath);
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, target);
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The handle is already unusable; the tmp file is what has to go.
      }
    }
    try {
      await rm(tmp, { force: true });
    } catch {
      // Leaving a tmp file behind is noise, not a correctness problem: it is
      // never read and the next write uses a fresh name.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentDefinitionError(500, `写入定义文件失败：${message}`);
  }
  // Durability of the rename itself needs the directory synced. Not every
  // platform allows fsync on a directory, and a failure here must not fail a
  // write that already landed.
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Best effort only.
  }
}

/* --------------------------------------------------------------- serializing */

/**
 * Per-file promise queue.
 *
 * Every read and write for one normalized path runs to completion before the
 * next starts, which is what makes read-modify-write CAS sound *in this
 * process*. Keyed by path rather than held as one global lock so a test with two
 * temp stores never serializes against the app's real file.
 */
const fileQueues = new Map<string, Promise<unknown>>();

/**
 * The canonical identity of a definitions file.
 *
 * Two spellings of one physical path — a symlinked parent directory, or the
 * `/var` → `/private/var` aliasing macOS gives every temp dir — must land on the
 * same queue key, or two writes read the same revision and both succeed while
 * only one survives on disk (a lost update, which was reproduced).
 *
 * Resolution walks up to the deepest ancestor that exists, takes its real path,
 * and re-joins the parts that do not exist yet. That handles "the parent is
 * about to be created by this very write": the answer is the real path of the
 * ancestor plus the missing suffix, so a store whose directory does not exist
 * yet still shares a key with the spelling that creates it. Nothing is created
 * here — a read must not mkdir to find out what the path means.
 *
 * When the file itself exists, `realpathSync` also resolves a symlinked *file*,
 * so a link and its target share one key.
 *
 * Computed per call rather than cached: a cached answer can go stale the moment
 * a parent directory is created, and a few `realpath` calls per request are
 * nothing next to the file I/O they guard.
 */
function canonicalFilePath(filePath: string): string {
  const absolute = path.resolve(filePath);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the root with nothing existing: the absolute path is the best
      // identity available, and it is at least stable.
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Where bytes for `filePath` should actually land.
 *
 * A path that *is* a symlink is written through to its target: `rename` onto the
 * link would replace the link with a regular file, and the next writer using the
 * other spelling would then be editing a different file — the split the queue key
 * exists to prevent.
 */
function writeTargetFor(filePath: string): string {
  try {
    if (lstatSync(filePath).isSymbolicLink()) return realpathSync(filePath);
  } catch {
    // Missing, or not a link: write the path as given (this is also the path
    // that does not exist yet, i.e. the normal first write).
  }
  return filePath;
}

function enqueueForFile<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  // The key is the *physical* file, not the spelling used to reach it.
  const key = canonicalFilePath(filePath);
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail: Promise<unknown> = next.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(key, tail);
  void tail.then(() => {
    if (fileQueues.get(key) === tail) fileQueues.delete(key);
  });
  return next;
}

/* ----------------------------------------------------------------- the store */

export interface AgentDefinitionStoreOptions {
  /** Explicit file path. Tests pass a temp file; the app uses the default. */
  filePath?: string;
}

function requireExpectedRevision(request: Record<string, unknown>, status = 400): number {
  const value = request['expectedRevision'];
  if (value === undefined) fail(status, 'expectedRevision 是必填字段');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(status, 'expectedRevision 必须是非负安全整数');
  }
  return value;
}

function responseFor(filePath: string, file: RawDiskFile): AgentDefinitionsResponse {
  // `path` is added on the way out and never stored: it belongs to this process's
  // configuration, not to the file's contents.
  //
  // Built-ins are merged here for the same reason — they are product constants,
  // not file contents — and that includes the response to a *write*, so a client
  // that replaces its list with the response does not lose them. A user
  // definition whose name matches a builtin shadows it (see
  // `mergeBuiltinAndUserAgents`).
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: file.revision,
    path: filePath,
    agents: mergeBuiltinAndUserAgents(
      file.agents.map((agent) => ({ ...agent, source: 'user', readOnly: false })),
    ),
  };
}

/**
 * The definitions file, with file-level CAS and atomic writes.
 *
 * Every mutating method returns the whole file so a caller never has to guess
 * what the new state is — and so the UI's revision is always the one that was
 * just written.
 */
export class AgentDefinitionStore {
  private readonly explicitPath: string | undefined;

  constructor(options: AgentDefinitionStoreOptions = {}) {
    const given = options.filePath?.trim();
    this.explicitPath = given !== undefined && given.length > 0 ? path.resolve(given) : undefined;
  }

  /**
   * The absolute path this store reads and writes.
   *
   * Throws `AgentDefinitionError(500)` when `PI_WEBX_SUBAGENTS_FILE` is set to a
   * relative path — a misconfiguration must be loud, not a file quietly created
   * relative to whatever cwd the bridge happens to have.
   */
  filePath(): string {
    return this.explicitPath ?? defaultFilePath();
  }

  /**
   * Every method resolves the path *inside* the returned promise.
   *
   * A misconfigured env var therefore rejects the call rather than throwing
   * synchronously out of an argument list, which is what a caller of a
   * `Promise`-returning method is entitled to expect.
   */
  private onPath<T>(run: (filePath: string) => Promise<T>): Promise<T> {
    return Promise.resolve().then(() => {
      const filePath = this.filePath();
      return run(filePath);
    });
  }

  read(): Promise<AgentDefinitionsResponse> {
    return this.onPath((filePath) =>
      enqueueForFile(filePath, async () => responseFor(filePath, readDiskFile(filePath))),
    );
  }

  create(request: unknown): Promise<AgentDefinitionsResponse> {
    return this.onPath((filePath) => enqueueForFile(filePath, async () => {
      if (!isRecord(request)) fail(400, '请求体必须是 JSON 对象');
      assertOnlyKeys(request, ['expectedRevision', 'definition'], '请求体', 400);
      const expectedRevision = requireExpectedRevision(request);
      const input = parseDefinitionInput(request['definition'], 400);
      const file = readDiskFile(filePath);
      if (file.revision !== expectedRevision) {
        fail(409, `定义文件已被其他修改更新（当前 revision=${String(file.revision)}，请求 revision=${String(expectedRevision)}），请刷新后重试`);
      }
      assertNameFree(file.agents, input.name, 400);
      const now = new Date().toISOString();
      const created: StoredAgent = { ...input, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
      const next: RawDiskFile = {
        schemaVersion: SCHEMA_VERSION,
        revision: file.revision + 1,
        agents: [...file.agents, created],
      };
      await writeDiskFile(filePath, next);
      return responseFor(filePath, next);
    }));
  }

  update(id: string, request: unknown): Promise<AgentDefinitionsResponse> {
    return this.onPath((filePath) => enqueueForFile(filePath, async () => {
      if (!isRecord(request)) fail(400, '请求体必须是 JSON 对象');
      assertOnlyKeys(request, ['expectedRevision', 'patch'], '请求体', 400);
      // Checked before anything else, and before the file is even read: a builtin
      // is a product constant, so the answer is the same whatever `expectedRevision`
      // says, and nothing may be written on the way to saying it.
      if (isBuiltinAgentId(id)) fail(400, '内置子智能体不可修改');
      const expectedRevision = requireExpectedRevision(request);
      const patch = parseDefinitionPatch(request['patch'], 400);
      const file = readDiskFile(filePath);
      if (file.revision !== expectedRevision) {
        fail(409, `定义文件已被其他修改更新（当前 revision=${String(file.revision)}，请求 revision=${String(expectedRevision)}），请刷新后重试`);
      }
      const target = file.agents.find((agent) => agent.id === id);
      if (target === undefined) fail(404, `没有这个智能体定义：${id}`);
      const keys = Object.keys(patch);
      if (keys.length === 0) {
        // `{}` is a read-back: no write, no revision bump, so a UI that renders
        // the result cannot invent a revision change out of a no-op.
        return responseFor(filePath, file);
      }
      const merged = mergeDefinitionPatch(target, patch);
      assertNameFree(file.agents, merged.name, 400, id);
      // Final validation over the merged definition: it re-establishes the whole
      // shape so a patch can never produce something a later read would reject,
      // and a `null` level or colour can never reach the DTO or the disk. The
      // stored name is left judged by the read-side rule when the patch did not
      // write one, so a legacy definition stays editable.
      const validated = validateMergedForWrite(merged, 400);
      const updated: StoredAgent = {
        ...validated,
        id: target.id,
        revision: target.revision + 1,
        createdAt: target.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const next: RawDiskFile = {
        schemaVersion: SCHEMA_VERSION,
        revision: file.revision + 1,
        agents: file.agents.map((agent) => (agent.id === id ? updated : agent)),
      };
      await writeDiskFile(filePath, next);
      return responseFor(filePath, next);
    }));
  }

  /**
   * Remove a definition. The id is never reused, so a stale UI holding one gets
   * 404 rather than somebody else's agent.
   *
   * No tombstone: dispatch is synchronous in this phase, so there is no
   * in-flight reference that would need to resolve to "deleted".
   */
  delete(id: string, request: unknown): Promise<AgentDefinitionsResponse> {
    return this.onPath((filePath) => enqueueForFile(filePath, async () => {
      if (!isRecord(request)) fail(400, '请求体必须是 JSON 对象');
      assertOnlyKeys(request, ['expectedRevision'], '请求体', 400);
      // Same rule as `update`: refused before the file is read, so a builtin id
      // can never be the reason a write happens.
      if (isBuiltinAgentId(id)) fail(400, '内置子智能体不可删除');
      const expectedRevision = requireExpectedRevision(request);
      const file = readDiskFile(filePath);
      if (file.revision !== expectedRevision) {
        fail(409, `定义文件已被其他修改更新（当前 revision=${String(file.revision)}，请求 revision=${String(expectedRevision)}），请刷新后重试`);
      }
      if (!file.agents.some((agent) => agent.id === id)) fail(404, `没有这个智能体定义：${id}`);
      const next: RawDiskFile = {
        schemaVersion: SCHEMA_VERSION,
        revision: file.revision + 1,
        agents: file.agents.filter((agent) => agent.id !== id),
      };
      await writeDiskFile(filePath, next);
      return responseFor(filePath, next);
    }));
  }
}

/** The app-wide store. Tests build their own with an explicit `filePath`. */
export const agentDefinitionsStore = new AgentDefinitionStore();
