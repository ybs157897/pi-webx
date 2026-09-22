/**
 * User-owned sub-agent definitions: the *configuration* store.
 *
 * This module is deliberately runtime-free: it imports pi's `getAgentDir()` and
 * the frozen shared contract, and nothing else from this app. Starting a child
 * agent is the runtime's job (`server/pi/host.ts`); deciding who may edit a
 * definition is the router's (`server/agent-definitions-routes.ts`).
 *
 * Guarantees, stated where they are enforced:
 *
 *   - **One file, one revision.** The whole file is versioned by `revision`;
 *     every write takes `expectedRevision` and fails 409 when the file moved
 *     under it. This is a *file-level* CAS, not a per-agent one.
 *   - **Single-process atomicity, honestly labelled.** Writes are serialized by
 *     an in-process queue keyed by the *canonical* path of the file — symlink
 *     aliases and `..` spellings of one physical file share a key, so two writers
 *     cannot both win a CAS — and land through `tmp + fsync + rename`.
 *     **Not covered:** a second pi-webx process, any external writer, hard links
 *     (a different realpath for the same inode), or a malicious actor racing the
 *     filesystem between the check and the rename. Nothing here pretends to be a
 *     cross-process transaction or a TOCTOU-safe lock.
 *   - **A corrupt file is never overwritten.** Bad JSON, an unknown
 *     `schemaVersion` or an entry that fails validation reads as a 500; the
 *     bytes on disk are left exactly as they were.
 *   - **No credentials, ever.** A definition has no auth field, and unknown keys
 *     in any request are rejected rather than dropped, so a client cannot smuggle
 *     one in (`id`, `revision`, `role`, `modelOverride`, …).
 *   - **Built-ins are merged, not stored.** Every response is
 *     `builtin (unless shadowed by a user definition of the same name) + user
 *     definitions`, built-ins first. They are read-only (`source: 'builtin'`,
 *     `readOnly: true`, PATCH/DELETE refused with 400) and **always enabled** —
 *     there is no enable switch, so the dispatch tool exists out of the box even
 *     with no user definition at all. That is a deliberate product behaviour, not
 *     a default that a later change may quietly flip. See `server/builtin-agents.ts`.
 *
 * Scope: this is an *application-level* permission surface (the settings UI and
 * `/api/agent-definitions`). It is not an OS sandbox and it does not isolate
 * users from each other — the bridge is single-user, loopback-only, and the file
 * is readable by anything running as the same OS user.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { PI_THINKING_LEVELS, type PiThinkingLevel } from '../src/shared/protocol';
import { isBuiltinAgentId, mergeBuiltinAndUserAgents } from './builtin-agents';
import {
  AGENT_NAME_PATTERN,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_PROMPT_LENGTH,
  MIN_AGENT_NAME_LENGTH,
  SUBAGENT_COLORS,
  SUBAGENT_TOOL_NAME,
  type AgentDefinitionInput,
  type AgentDefinitionPatch,
  type AgentDefinitionsResponse,
  type AgentModelSelection,
  type AgentToolPolicy,
  type SubagentColor,
} from '../src/shared/agent-definitions';

/* ------------------------------------------------------------------- limits */

/** Schema version of the on-disk file. Anything else is a 500, not a migration. */
const SCHEMA_VERSION = 1;

/** Environment override for the definitions file. Must be absolute when set. */
const FILE_ENV = 'PI_WEBX_SUBAGENTS_FILE';

/** Upper bound on `tools: { mode: 'selected', names }`. */
const MAX_SELECTED_TOOLS = 128;

const MIN_MAX_TURNS = 1;
const MAX_MAX_TURNS = 100;
const MIN_MAX_CONCURRENT = 1;
const MAX_MAX_CONCURRENT = 4;

/* -------------------------------------------------------------- tool policy */

/**
 * Names a definition may never allow.
 *
 * Everything that could start another agent, or manage definitions, is excluded
 * *by name* so the runtime and the UI share one list: a child that could
 * re-enter dispatch would recurse past every turn budget the parent set. Aliases
 * are listed explicitly because a caller — a model, a wheel, a hand-written
 * request — can spell dispatch several ways; none of them becomes an
 * authorization just by being declarable. A definition carries no role field,
 * and this list is what the runtime consults, not anything a tool caller says
 * about itself.
 *
 * Kept as data, not as an import from the runtime, so the store stays free of
 * runtime dependencies.
 */
const RESTRICTED_AGENT_TOOL_NAMES: readonly string[] = [
  SUBAGENT_TOOL_NAME,
  'agent',
  'subagent',
  'spawn_agent',
  'dispatch_agent',
  'spawn_teammate',
  'subagent_fork',
  'workflow',
];

/** Prefixes that cover families (`team_task*`, `agent_definition*` CRUD). */
const RESTRICTED_AGENT_TOOL_PREFIXES: readonly string[] = [
  'subagent',
  'spawn_agent',
  'dispatch_agent',
  'spawn_teammate',
  'team_task',
  'agent_definition',
];

/**
 * The same exclusion set as the UI should display it. Wildcards are shown so a
 * reader can tell a family from a single name; {@link isRestrictedAgentTool} is
 * the thing that decides.
 */
export const RESTRICTED_AGENT_TOOL_DISPLAY_NAMES: readonly string[] = [
  SUBAGENT_TOOL_NAME,
  'Agent',
  'subagent',
  'spawn_agent',
  'dispatch_agent',
  'spawn_teammate',
  'subagent_fork',
  'workflow',
  'team_task*',
  'agent_definitions*',
];

/**
 * Whether a tool name is a dispatch/definition-management name that a
 * definition may never enable.
 *
 * Case-insensitive, and an empty or blank name is restricted too — a blank tool
 * name is not something the runtime can resolve, and admitting it would let a
 * definition look configured while dispatching nothing.
 */
export function isRestrictedAgentTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (RESTRICTED_AGENT_TOOL_NAMES.includes(normalized)) return true;
  return RESTRICTED_AGENT_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/* ------------------------------------------------------------------- errors */

/** A failure with an HTTP status the router can hand straight to the client. */
export class AgentDefinitionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

/* ------------------------------------------------------------ raw disk shape */

/**
 * An agent **as it exists on disk**.
 *
 * Deliberately not `AgentDefinition`: `source` and `readOnly` are derived on the
 * way out (like the response's `path`), because writing them would make the file
 * claim things only the code can know — and a file carrying them is rejected on
 * read, so a write must never put them there.
 */
type StoredAgent = AgentDefinitionInput & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

interface RawDiskFile {
  schemaVersion: number;
  revision: number;
  agents: StoredAgent[];
}

/* -------------------------------------------------------------- validation */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(status: number, message: string): never {
  throw new AgentDefinitionError(status, message);
}

/**
 * Reject any key outside the allowlist.
 *
 * Strict rather than forgiving: a dropped unknown key is a client bug the user
 * never sees, and `id`/`revision`/`timestamp`/`role`/`modelOverride` arriving in
 * a body must be an error, not a silent no-op.
 */
function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  status: number,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(status, `${where}含未知字段：${key}`);
  }
}

/** Code-point length, so a name of emoji is counted the way a user counts it. */
function textLength(value: string): number {
  return [...value].length;
}

function requireText(
  value: unknown,
  field: string,
  max: number,
  status: number,
): string {
  if (typeof value !== 'string') fail(status, `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(status, `${field} 不能为空`);
  if (textLength(trimmed) > max) fail(status, `${field} 最多 ${max} 个字符`);
  return trimmed;
}

function requireBoolean(value: unknown, field: string, status: number): boolean {
  if (typeof value !== 'boolean') fail(status, `${field} 必须是布尔值`);
  return value;
}

function requireIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  status: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(status, `${field} 必须是整数`);
  }
  if (value < min || value > max) fail(status, `${field} 必须在 ${min}..${max} 之间`);
  return value;
}

function parseModelSelection(value: unknown, status: number): AgentModelSelection {
  if (!isRecord(value)) fail(status, 'model 必须是对象');
  const mode = value['mode'];
  if (mode === 'inherit') {
    assertOnlyKeys(value, ['mode'], 'model', status);
    return { mode: 'inherit' };
  }
  if (mode === 'fixed') {
    assertOnlyKeys(value, ['mode', 'providerId', 'modelId'], 'model', status);
    return {
      mode: 'fixed',
      providerId: requireText(value['providerId'], 'model.providerId', 200, status),
      modelId: requireText(value['modelId'], 'model.modelId', 200, status),
    };
  }
  return fail(status, 'model.mode 只能是 inherit 或 fixed');
}

function parseThinkingLevel(value: unknown, status: number): PiThinkingLevel {
  if (typeof value !== 'string') fail(status, 'thinkingLevel 必须是字符串');
  const found = PI_THINKING_LEVELS.find((level) => level === value);
  if (found === undefined) {
    fail(status, `thinkingLevel 必须是 ${PI_THINKING_LEVELS.join(' / ')} 之一`);
  }
  return found;
}

/**
 * An identity colour from {@link SUBAGENT_COLORS}.
 *
 * The list is the contract, so membership is checked against it rather than
 * against a hand-written set; the message spells the options out because the
 * form surfaces the server's text.
 */
function parseColor(value: unknown, status: number): SubagentColor {
  const found = SUBAGENT_COLORS.find((color) => color === value);
  if (found === undefined) {
    fail(status, `颜色必须是 ${SUBAGENT_COLORS.join('/')} 之一`);
  }
  return found;
}

function parseToolPolicy(value: unknown, status: number): AgentToolPolicy {
  if (!isRecord(value)) fail(status, 'tools 必须是对象');
  const mode = value['mode'];
  if (mode === 'all') {
    // `all` means "whatever the parent may use"; a `names` list beside it is a
    // contradiction, not a hint.
    assertOnlyKeys(value, ['mode'], 'tools', status);
    return { mode: 'all' };
  }
  if (mode === 'selected') {
    assertOnlyKeys(value, ['mode', 'names'], 'tools', status);
    const raw = value['names'];
    if (!Array.isArray(raw)) fail(status, 'tools.names 必须是数组');
    if (raw.length > MAX_SELECTED_TOOLS) {
      fail(status, `tools.names 最多 ${MAX_SELECTED_TOOLS} 项`);
    }
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'string') fail(status, 'tools.names 的每一项都必须是字符串');
      const name = entry.trim();
      if (name.length === 0) fail(status, 'tools.names 不能包含空名字');
      if (seen.has(name)) fail(status, `tools.names 重复：${name}`);
      seen.add(name);
      if (isRestrictedAgentTool(name)) {
        fail(status, `tools.names 不能包含系统派发/管理工具：${name}`);
      }
      names.push(name);
    }
    // An empty list is legal on purpose: pure reasoning, no tools, no minimum.
    return { mode: 'selected', names };
  }
  return fail(status, 'tools.mode 只能是 all 或 selected');
}

/**
 * Fields every definition must carry.
 *
 * `thinkingLevel`, `color` and `injectAgentsMd` are absent from this list on
 * purpose: they are optional, and their absence is a meaningful state.
 */
const REQUIRED_INPUT_FIELDS = [
  'name',
  'description',
  'systemPrompt',
  'model',
  'tools',
  'maxTurns',
  'maxConcurrentInstances',
  'enabled',
] as const;

/** Optional fields: validated when present, absence is legal. */
const OPTIONAL_INPUT_FIELDS = ['thinkingLevel', 'color', 'injectAgentsMd'] as const;

/** Field-level validators shared by requests (400) and stored files (500). */
const DEFINITION_FIELDS = [...REQUIRED_INPUT_FIELDS, ...OPTIONAL_INPUT_FIELDS] as const;

/**
 * Fields where a PATCH `null` *deletes* the property.
 *
 * Both are optional with no "none" spelling of their own, so without `null` a UI
 * could set them once and never take them back.
 */
const NULL_CLEARS_FIELDS: readonly string[] = ['thinkingLevel', 'color'];

/**
 * Write-side name rule: {@link MIN_AGENT_NAME_LENGTH}..
 * {@link MAX_AGENT_NAME_LENGTH} code points of Unicode letters, Unicode digits
 * and `-`.
 *
 * The two messages are ZCode's, verbatim, because the settings form shows the
 * server's text when it has one. Length is counted in **code points**, so a
 * Chinese name of three characters passes while `ab` does not.
 */
function parseAgentName(value: unknown, status: number): string {
  if (typeof value !== 'string') fail(status, '名称必须是字符串');
  const trimmed = value.trim();
  const length = textLength(trimmed);
  if (length < MIN_AGENT_NAME_LENGTH || length > MAX_AGENT_NAME_LENGTH) {
    fail(
      status,
      `长度必须在 ${String(MIN_AGENT_NAME_LENGTH)} 到 ${String(MAX_AGENT_NAME_LENGTH)} 个字符之间`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(trimmed)) fail(status, '仅允许使用字母、数字和连字符');
  return trimmed;
}

/**
 * Read-side name check: the *shape* only.
 *
 * Names stored before the current rule existed are not re-judged — a historical
 * `ab` or `my_agent` must read back, not turn the whole file into a 500. The
 * value is returned exactly as stored (no trimming), so reading never rewrites
 * what the user has.
 */
function parseStoredName(value: unknown, where: string, status: number): string {
  if (typeof value !== 'string') fail(status, `${where} 必须是字符串`);
  if (value.trim().length === 0) fail(status, `${where} 不能为空`);
  return value;
}

/** Parse one field of a definition. Absent optional fields stay absent. */
function parseField(
  field: (typeof DEFINITION_FIELDS)[number],
  value: unknown,
  status: number,
): unknown {
  switch (field) {
    case 'name':
      return parseAgentName(value, status);
    case 'description':
      return requireText(value, 'description', MAX_AGENT_DESCRIPTION_LENGTH, status);
    case 'systemPrompt':
      return requireText(value, 'systemPrompt', MAX_AGENT_PROMPT_LENGTH, status);
    case 'model':
      return parseModelSelection(value, status);
    case 'thinkingLevel':
      return parseThinkingLevel(value, status);
    case 'color':
      return parseColor(value, status);
    case 'injectAgentsMd':
      return requireBoolean(value, 'injectAgentsMd', status);
    case 'tools':
      return parseToolPolicy(value, status);
    case 'maxTurns':
      return requireIntegerInRange(value, 'maxTurns', MIN_MAX_TURNS, MAX_MAX_TURNS, status);
    case 'maxConcurrentInstances':
      return requireIntegerInRange(
        value,
        'maxConcurrentInstances',
        MIN_MAX_CONCURRENT,
        MAX_MAX_CONCURRENT,
        status,
      );
    case 'enabled':
      return requireBoolean(value, 'enabled', status);
  }
}

/** Full input, as POST carries it. Missing required fields are an error. */
function parseDefinitionInput(value: unknown, status: number): AgentDefinitionInput {
  if (!isRecord(value)) fail(status, 'definition 必须是对象');
  assertOnlyKeys(value, DEFINITION_FIELDS, 'definition', status);
  const input: Record<string, unknown> = {};
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (!(field in value)) fail(status, `definition 缺少必填字段：${field}`);
    input[field] = parseField(field, value[field], status);
  }
  for (const field of OPTIONAL_INPUT_FIELDS) {
    if (Object.hasOwn(value, field)) input[field] = parseField(field, value[field], status);
  }
  return input as unknown as AgentDefinitionInput;
}

/** Partial input, as PATCH carries it. `{}` is a legal no-op. */
function parseDefinitionPatch(value: unknown, status: number): AgentDefinitionPatch {
  if (!isRecord(value)) fail(status, 'patch 必须是对象');
  assertOnlyKeys(value, DEFINITION_FIELDS, 'patch', status);
  const patch: Record<string, unknown> = {};
  for (const field of DEFINITION_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (NULL_CLEARS_FIELDS.includes(field)) {
      // `null` clears the property; anything else still has to be a real value.
      patch[field] = raw === null ? null : parseField(field, raw, status);
      continue;
    }
    // Every other field rejects null in its own validator: a null `name` is a
    // malformed request, not "unset".
    patch[field] = parseField(field, raw, status);
  }
  return patch as AgentDefinitionPatch;
}

/**
 * Apply a parsed patch to a stored definition.
 *
 * The one asymmetry: the {@link NULL_CLEARS_FIELDS} (`thinkingLevel`, `color`)
 * *remove* the property when the patch sends `null`, so the merged object carries
 * no key at all — which is how "follow the parent's level" and "no colour" are
 * spelled everywhere else. A key the patch omits leaves the existing value alone.
 */
function mergeDefinitionPatch(
  target: StoredAgent,
  patch: AgentDefinitionPatch,
): StoredAgent {
  const merged = { ...target } as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (value === null && NULL_CLEARS_FIELDS.includes(field)) {
      delete merged[field];
      continue;
    }
    merged[field] = value;
  }
  return merged as unknown as StoredAgent;
}

/**
 * Every field *except* the name, with the strict per-field rules.
 *
 * The name is the caller's business because its rule differs by direction:
 * reading a stored file checks the shape only (history is not re-judged), while
 * accepting a write applies the full rule — and a write that does not touch the
 * name must not re-judge the stored one, or a definition saved before the rule
 * could never have its description changed.
 */
function parseDefinitionFieldsExceptName(
  value: Record<string, unknown>,
  status: number,
  where: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (field === 'name') continue;
    if (!Object.hasOwn(value, field)) fail(status, `${where} 缺少字段：${field}`);
    out[field] = parseField(field, value[field], status);
  }
  for (const field of OPTIONAL_INPUT_FIELDS) {
    if (Object.hasOwn(value, field)) out[field] = parseField(field, value[field], status);
  }
  return out;
}

/**
 * Post-merge validation before a PATCH is written.
 *
 * Every value the patch supplied was already checked field-by-field; this pass
 * re-establishes the whole definition so the file can never end up holding
 * something a later read would reject as malformed. The name is judged by the
 * read-side rule here, because a patch that leaves the name alone is not a name
 * write — the strict rule was applied to the patch's own value when it had one.
 */
function validateMergedForWrite(merged: StoredAgent, status: number): AgentDefinitionInput {
  const source = merged as unknown as Record<string, unknown>;
  return {
    name: parseStoredName(source['name'], 'name', status),
    ...parseDefinitionFieldsExceptName(source, status, 'definition'),
  } as unknown as AgentDefinitionInput;
}

/** Identity and bookkeeping of a stored definition, as it must appear on disk. */
function parseStoredDefinition(value: unknown, index: number, status: number): StoredAgent {
  const where = `agents[${String(index)}]`;
  if (!isRecord(value)) fail(status, `${where} 必须是对象`);
  assertOnlyKeys(value, [...DEFINITION_FIELDS, 'id', 'revision', 'createdAt', 'updatedAt'], where, status);
  const id = requireText(value['id'], `${where}.id`, 128, status);
  const revision = requireIntegerInRange(value['revision'], `${where}.revision`, 1, Number.MAX_SAFE_INTEGER, status);
  const createdAt = requireIsoTimestamp(value['createdAt'], `${where}.createdAt`, status);
  const updatedAt = requireIsoTimestamp(value['updatedAt'], `${where}.updatedAt`, status);
  // The name goes through the read-side rule, not the write-side one: a file
  // written before the current rule must still load.
  const stored = {
    name: parseStoredName(value['name'], `${where}.name`, status),
    ...parseDefinitionFieldsExceptName(value, status, where),
  };
  return { ...(stored as unknown as AgentDefinitionInput), id, revision, createdAt, updatedAt };
}

function requireIsoTimestamp(value: unknown, field: string, status: number): string {
  if (typeof value !== 'string') fail(status, `${field} 必须是 ISO 时间字符串`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(status, `${field} 不是合法的时间：${value}`);
  return value;
}

/** Case-insensitive identity for uniqueness: NFKC, then case-fold. */
function nameKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/** Duplicates *within* one file: two entries may not share a name key. */
function assertUniqueNames(agents: readonly StoredAgent[], status: number): void {
  const seen = new Map<string, string>();
  for (const agent of agents) {
    const key = nameKey(agent.name);
    const previous = seen.get(key);
    if (previous !== undefined) {
      fail(status, `定义文件中存在同名智能体：${agent.name}（id ${previous} 与 ${agent.id}，名称不区分大小写）`);
    }
    seen.set(key, agent.id);
  }
}

/** A new or renamed entry must not collide with any *other* entry. */
function assertNameFree(
  agents: readonly StoredAgent[],
  name: string,
  status: number,
  ignoreId?: string,
): void {
  const key = nameKey(name);
  for (const agent of agents) {
    if (ignoreId !== undefined && agent.id === ignoreId) continue;
    if (nameKey(agent.name) === key) {
      fail(status, `已有同名智能体：${agent.name}（名称不区分大小写）`);
    }
  }
}

function parseStoredFile(raw: unknown, status: number): RawDiskFile {
  if (!isRecord(raw)) fail(status, '定义文件顶层必须是 JSON 对象');
  const schemaVersion = raw['schemaVersion'];
  if (schemaVersion !== SCHEMA_VERSION) {
    fail(status, `不支持的定义文件 schemaVersion：${String(schemaVersion)}（本版本只认 ${String(SCHEMA_VERSION)}）`);
  }
  const revision = raw['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    fail(status, '定义文件的 revision 必须是非负安全整数');
  }
  const agentsRaw = raw['agents'];
  if (!Array.isArray(agentsRaw)) fail(status, '定义文件的 agents 必须是数组');
  const agents = agentsRaw.map((entry, index) => parseStoredDefinition(entry, index, status));
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) fail(status, `定义文件存在重复 id：${agent.id}`);
    ids.add(agent.id);
  }
  assertUniqueNames(agents, status);
  return { schemaVersion: SCHEMA_VERSION, revision, agents };
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
