import { constants, realpathSync, statSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  stat as fsStat,
} from 'node:fs/promises';
import path from 'node:path';
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type EditOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';

const MAX_LS_ENTRIES = 200;
const SDK_NORMALIZED_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

const ACCESS_GUIDANCE =
  '需求助手的文件工具只访问其绑定工作区。产品事实请使用 requirements_context；其他文档请通过本会话附件或绑定工作区材料提供。';

function deniedPath(): Error {
  return new Error(`路径被拒绝：${ACCESS_GUIDANCE}`);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function canonicalWorkspaceRoot(workspaceDir: string): string {
  if (typeof workspaceDir !== 'string' || !path.isAbsolute(workspaceDir) || workspaceDir.includes('\0')) {
    throw new Error('需求助手绑定工作区必须是绝对路径。');
  }

  try {
    const root = realpathSync.native(path.resolve(workspaceDir));
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new Error('需求助手绑定工作区不可访问；请检查 Agent 设置中的工作区路径。');
  }
}

async function canonicalExistingOrFuture(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    // A dangling symlink is not a safe missing path: a later write could follow it
    // if its target appears between validation and the filesystem operation.
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw deniedPath();
      return await realpath(candidate);
    } catch (lookupError) {
      if ((lookupError as NodeJS.ErrnoException).code !== 'ENOENT') throw lookupError;
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    const canonicalParent = await canonicalExistingOrFuture(parent);
    return path.join(canonicalParent, path.basename(candidate));
  }
}

function createWorkspacePathGuard(
  root: string,
  acceptedRoots: readonly string[],
): (candidate: string) => Promise<string> {
  const lexicalRoots = [...new Set([root, ...acceptedRoots].map((value) => path.resolve(value)))];

  return async (candidate: string): Promise<string> => {
    if (typeof candidate !== 'string' || candidate.includes('\0')) throw deniedPath();
    const absolute = path.resolve(root, candidate);
    if (!lexicalRoots.some((allowedRoot) => isWithin(allowedRoot, absolute))) throw deniedPath();

    const canonical = await canonicalExistingOrFuture(absolute);
    if (!isWithin(root, canonical)) throw deniedPath();
    return canonical;
  };
}

async function sdkSafePath(
  guard: (candidate: string) => Promise<string>,
  candidate: string,
): Promise<string> {
  const canonical = await guard(candidate);
  if (canonical.replace(SDK_NORMALIZED_SPACES, ' ') !== canonical) {
    throw new Error('路径含有 Pi 文件工具会改写的特殊空格；请改用普通空格命名后重试。');
  }
  return canonical;
}

async function withGuardedFile<T>(
  guard: (candidate: string) => Promise<string>,
  candidate: string,
  flags: number,
  operation: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>,
): Promise<T> {
  const authorized = await guard(candidate);
  const handle = await open(authorized, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('需求助手文件工具只支持工作区内的普通文件。');
    return await operation(handle);
  } finally {
    await handle.close();
  }
}

function bindToolToWorkspace<T extends ToolDefinition<any, any, any>>(
  tool: T,
  workspaceDir: string,
  transformParams?: (params: any) => any | Promise<any>,
): T {
  const originalExecute = tool.execute;
  tool.execute = (async (toolCallId, params, signal, onUpdate, ctx) => {
    // The SDK normally prefers ctx.cwd over the factory cwd. Make relative paths
    // resolve from the configured workspace while retaining the original context.
    const boundContext = Object.create(ctx) as typeof ctx;
    Object.defineProperty(boundContext, 'cwd', { value: workspaceDir, enumerable: true });
    const safeParams = transformParams ? await transformParams(params) : params;
    return originalExecute.call(
      tool,
      toolCallId,
      safeParams,
      signal,
      onUpdate,
      boundContext,
    );
  }) as T['execute'];

  tool.description = `${tool.description} ${ACCESS_GUIDANCE}`;
  tool.promptGuidelines = [...(tool.promptGuidelines ?? []), ACCESS_GUIDANCE];
  return tool;
}

export function createRequirementsFileTools(workspaceDir: string): ToolDefinition[] {
  const root = canonicalWorkspaceRoot(workspaceDir);
  const guard = createWorkspacePathGuard(root, [workspaceDir]);

  const readOperations: ReadOperations = {
    async access(candidate) {
      await withGuardedFile(guard, candidate, constants.O_RDONLY, async () => undefined);
    },
    async readFile(candidate) {
      return withGuardedFile(guard, candidate, constants.O_RDONLY, (handle) => handle.readFile());
    },
    async detectImageMimeType(candidate) {
      return detectSupportedImageMimeTypeFromFile(await guard(candidate));
    },
  };

  const writeOperations: WriteOperations = {
    async mkdir(candidate) {
      const authorized = await guard(candidate);
      await mkdir(authorized, { recursive: true });
      // Re-resolve after creation so newly introduced symlink changes fail closed.
      const created = await guard(authorized);
      if (!isWithin(root, created)) throw deniedPath();
    },
    async writeFile(candidate, content) {
      const initial = await guard(candidate);
      const parent = await guard(path.dirname(initial));
      if (!isWithin(root, parent)) throw deniedPath();

      // O_NOFOLLOW prevents replacing a leaf symlink after the canonical check.
      await withGuardedFile(guard, initial, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
        (handle) => handle.writeFile(content, 'utf8'),
      );
    },
  };

  const editOperations: EditOperations = {
    async access(candidate) {
      await withGuardedFile(guard, candidate, constants.O_RDWR, async () => undefined);
    },
    async readFile(candidate) {
      return withGuardedFile(guard, candidate, constants.O_RDONLY, (handle) => handle.readFile());
    },
    async writeFile(candidate, content) {
      await writeOperations.writeFile(candidate, content);
    },
  };

  const lsOperations: LsOperations = {
    async exists(candidate) {
      try {
        await fsStat(await guard(candidate));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async stat(candidate) {
      return fsStat(await guard(candidate));
    },
    async readdir(candidate) {
      const directory = await guard(candidate);
      const handle = await opendir(directory);
      const entries: string[] = [];
      try {
        for await (const entry of handle) {
          entries.push(entry.name);
          if (entries.length > MAX_LS_ENTRIES) break;
        }
      } finally {
        try { await handle.close(); } catch { /* The iterator may already have closed it. */ }
      }
      return entries;
    },
  };

  const tools: ToolDefinition<any, any, any>[] = [
    bindToolToWorkspace(
      createReadToolDefinition(root, { operations: readOperations }),
      root,
      async (params: { path: string; offset?: number; limit?: number }) => ({
        ...params,
        path: await sdkSafePath(guard, params.path),
      }),
    ),
    bindToolToWorkspace(
      createWriteToolDefinition(root, { operations: writeOperations }),
      root,
      async (params: { path: string; content: string }) => ({
        ...params,
        path: await sdkSafePath(guard, params.path),
      }),
    ),
    bindToolToWorkspace(
      createEditToolDefinition(root, { operations: editOperations }),
      root,
      async (params: { path: string; edits: Array<{ oldText: string; newText: string }> }) => ({
        ...params,
        path: await sdkSafePath(guard, params.path),
      }),
    ),
    bindToolToWorkspace(
      createLsToolDefinition(root, { operations: lsOperations }),
      root,
      async (params: { path?: string; limit?: number }) => ({
        ...params,
        path: await sdkSafePath(guard, params.path ?? '.'),
        limit: Math.max(1, Math.min(MAX_LS_ENTRIES, Math.trunc(params.limit ?? MAX_LS_ENTRIES))),
      }),
    ),
  ];

  // The SDK definitions carry specific render-call generic types. The runtime
  // registry consumes the same definitions heterogeneously, so widen them here.
  return tools as unknown as ToolDefinition[];
}
