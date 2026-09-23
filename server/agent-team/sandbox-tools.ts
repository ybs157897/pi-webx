/** MacOS Seatbelt boundary for Team coding tools; the model and auth stay in the host. */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  createBashTool, createEditTool, createFindTool, createGrepTool,
  createLsTool, createPowerShellTool, createReadTool, createWriteTool,
  type AgentToolUpdateCallback,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { TeamSandboxUnavailableError, type ToolLaunchPlan } from './isolation-contract';
import { assertWindowsAppContainerAvailable, ensureWindowsAppContainerVerified, prepareWindowsAppContainerLaunch } from './windows-appcontainer';
export { TeamSandboxUnavailableError } from './isolation-contract';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const HOST_FILE = join(import.meta.dirname, 'sandbox-tool-host.mts');
const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const TSX_LOADER = join(realpathSync(join(PROJECT_ROOT, 'node_modules')), 'tsx', 'dist', 'loader.mjs');
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 120_000;
const PREFIX = '@pi-webx-tool:';

export const ISOLATED_TOOL_NAMES = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'] as const;
type IsolatedToolName = typeof ISOLATED_TOOL_NAMES[number];

function executableOnPath(name: string): string | undefined {
  const locations = [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin', '/usr/local/bin',
    join(homedir(), '.local', 'bin'), join(homedir(), '.kimi-code', 'bin'),
  ];
  for (const directory of new Set(locations)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return canonical(candidate);
    } catch { /* Check the next directory. */ }
  }
  return undefined;
}

const SEARCH_BINARIES = ['rg', 'fd'].map(executableOnPath);
const verifiedProfiles = new Set<string>();

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
}

function canonical(path: string): string {
  return realpathSync(path);
}

/** Fail closed on unsupported hosts or workspaces that contain the agent store. */
export function assertTeamSandboxAvailable(cwd: string, agentDir: string): void {
  if (process.platform === 'win32') return assertWindowsAppContainerAvailable(cwd, agentDir);
  if (process.platform !== 'darwin') {
    throw new TeamSandboxUnavailableError(501, 'Agent Team 的编码工具需要系统或容器隔离；当前平台尚未配置隔离运行时。');
  }
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK);
    if (SEARCH_BINARIES.some((path) => path === undefined)) {
      throw new TeamSandboxUnavailableError(501, 'Agent Team 隔离工具需要本机安装 rg 与 fd。');
    }
    const workspace = canonical(cwd);
    const store = existsSync(agentDir) ? canonical(agentDir) : resolve(agentDir);
    if (within(workspace, store) || within(store, workspace)) {
      throw new TeamSandboxUnavailableError(400, '工作区与 Agent 配置目录重叠，无法隔离定义和凭据。');
    }
    const appRoot = canonical(PROJECT_ROOT);
    if (within(workspace, appRoot) || within(appRoot, workspace)) {
      throw new TeamSandboxUnavailableError(400, '工作区包含正在运行的 pi-webx 程序文件，不能让 Team 修改宿主代码。');
    }
    const home = canonical(homedir());
    if (workspace === home || within(workspace, home)) {
      throw new TeamSandboxUnavailableError(400, '不能把整个用户目录作为 Team 的编码工作区。');
    }
    const key = `${workspace}\0${store}`;
    if (!verifiedProfiles.has(key)) {
      verifyProfile(workspace, store);
      verifiedProfiles.add(key);
    }
  } catch (cause) {
    if (cause instanceof TeamSandboxUnavailableError) throw cause;
    throw new TeamSandboxUnavailableError(501, `Agent Team 隔离运行时不可用：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function profile(cwd: string, agentDir: string, scratch: string): string {
  const workspace = canonical(cwd);
  const project = canonical(PROJECT_ROOT);
  const dependencies = canonical(join(PROJECT_ROOT, 'node_modules'));
  const nodeBin = dirname(canonical(process.execPath));
  const home = canonical(homedir());
  const osTemp = canonical(tmpdir());
  const store = existsSync(agentDir) ? canonical(agentDir) : resolve(agentDir);
  const readPaths = [workspace, dependencies, nodeBin, scratch].filter(existsSync);
  const readFiles = [HOST_FILE, join(project, 'package.json'), join(project, 'tsconfig.json'),
    ...SEARCH_BINARIES.filter((path): path is string => path !== undefined)]
    .filter(existsSync).map(canonical);
  const readRules = [
    ...readPaths.map((path) => `(subpath ${quote(path)})`),
    ...readFiles.map((path) => `(literal ${quote(path)})`),
  ].join(' ');
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data (subpath ${quote(home)}))`,
    `(deny file-read-data (subpath ${quote(osTemp)}))`,
    '(deny file-read-data (subpath "/private/tmp"))',
    '(deny file-read-data (subpath "/Volumes"))',
    `(allow file-read-data ${readRules})`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${quote(workspace)}) (subpath ${quote(scratch)}))`,
    `(deny file-read-data (subpath ${quote(store)}))`,
    `(deny file-write* (subpath ${quote(store)}))`,
    '(deny signal)',
    '(allow signal (target self))',
    '(allow signal (target children))',
    '(deny appleevent-send)',
    '(deny lsopen)',
    '(deny network-inbound)',
    '(deny network-outbound)',
  ].join('\n');
}

function verifyProfile(cwd: string, agentDir: string): void {
  const scratch = canonical(mkdtempSync(join(tmpdir(), 'pi-webx-sandbox-preflight-')));
  const deniedRoot = canonical(mkdtempSync(join(tmpdir(), 'pi-webx-sandbox-denied-')));
  const allowedFile = join(scratch, 'allowed.txt');
  const deniedFile = join(deniedRoot, 'denied.txt');
  try {
    writeFileSync(allowedFile, 'allowed');
    writeFileSync(deniedFile, 'denied');
    const policy = profile(cwd, agentDir, scratch);
    const allowed = spawnSync(SANDBOX_EXEC, ['-p', policy, '/bin/cat', allowedFile], {
      encoding: 'utf8', timeout: 3000,
    });
    const denied = spawnSync(SANDBOX_EXEC, ['-p', policy, '/bin/cat', deniedFile], {
      encoding: 'utf8', timeout: 3000,
    });
    if (allowed.status !== 0 || allowed.stdout !== 'allowed'
      || denied.status === 0 || !/Operation not permitted|Permission denied/i.test(denied.stderr)) {
      throw new TeamSandboxUnavailableError(501, 'macOS 隔离策略未通过读文件正负对照，拒绝启动 Team。');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(deniedRoot, { recursive: true, force: true });
  }
}

interface ToolResponse { type: 'update' | 'result' | 'error'; value?: unknown; message?: string }

function prepareMacLaunch(cwd: string, agentDir: string, params: unknown): ToolLaunchPlan {
  const scratch = canonical(mkdtempSync(join(tmpdir(), 'pi-webx-team-sandbox-')));
  const profileFile = join(scratch, 'profile.sb');
  try {
    writeFileSync(profileFile, profile(cwd, agentDir, scratch), { mode: 0o600 });
  } catch (cause) {
    rmSync(scratch, { recursive: true, force: true });
    throw cause;
  }
  return {
    command: SANDBOX_EXEC,
    args: ['-f', profileFile, process.execPath, '--import', TSX_LOADER, HOST_FILE],
    cwd: canonical(cwd),
    toolCwd: canonical(cwd),
    params,
    env: {
      PATH: [...new Set(['/usr/bin', '/bin', '/opt/homebrew/bin',
        ...SEARCH_BINARIES.filter((path): path is string => path !== undefined).map(dirname),
      ])].join(delimiter),
      HOME: scratch,
      TMPDIR: scratch,
      XDG_CACHE_HOME: scratch,
      PI_CODING_AGENT_DIR: scratch,
      LANG: 'en_US.UTF-8',
    },
    stop(pid) {
      if (pid === undefined) return;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ }
    },
    cleanup() {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Best-effort scratch cleanup. */ }
    },
  };
}

async function executeIsolated(
  name: IsolatedToolName,
  cwd: string,
  agentDir: string,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<unknown> {
  assertTeamSandboxAvailable(cwd, agentDir);
  signal?.throwIfAborted();
  if (process.platform === 'win32') await ensureWindowsAppContainerVerified(cwd, agentDir);
  signal?.throwIfAborted();
  const plan = process.platform === 'win32'
    ? prepareWindowsAppContainerLaunch(cwd, agentDir, params)
    : prepareMacLaunch(cwd, agentDir, params);
  const child = spawn(plan.command, [...plan.args], {
    cwd: plan.cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: plan.env,
  });

  return await new Promise<unknown>((resolveResult, rejectResult) => {
    let done = false;
    let output = '';
    let responseBytes = 0;
    let stderr = '';
    let result: unknown;
    let hasResult = false;
    let remoteError: string | undefined;
    let stopReason: string | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const killGroup = () => plan.stop(child.pid);
    const cleanup = () => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      if (process.platform !== 'win32') killGroup();
      plan.cleanup();
      return true;
    };
    const requestStop = (reason: string) => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      try { child.stdin.write('{"type":"cancel"}\n'); } catch { /* Force-stop timer remains armed. */ }
      forceTimer = setTimeout(killGroup, 2000);
    };
    const abort = () => requestStop('团队工具调用已取消');
    const timer = setTimeout(() => requestStop('团队工具调用超时'), TOOL_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on('error', () => { /* A failed launch can close stdin before the request is written. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        requestStop('团队工具输出超过上限');
        return;
      }
      output += chunk.toString();
      for (;;) {
        const lineEnd = output.indexOf('\n');
        if (lineEnd < 0) break;
        const line = output.slice(0, lineEnd);
        output = output.slice(lineEnd + 1);
        if (!line.startsWith(PREFIX)) continue;
        try {
          const response = JSON.parse(line.slice(PREFIX.length)) as ToolResponse;
          if (response.type === 'update') onUpdate?.(response.value as Parameters<AgentToolUpdateCallback<unknown>>[0]);
          else if (response.type === 'result') { result = response.value; hasResult = true; }
          else if (response.type === 'error') remoteError = response.message ?? 'isolated tool failed';
        } catch {
          remoteError = 'isolated tool returned invalid data';
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8192); });
    child.on('error', (cause) => {
      if (cleanup()) rejectResult(cause);
    });
    child.on('close', (code, exitSignal) => {
      if (!cleanup()) return;
      if (stopReason) rejectResult(new Error(stopReason));
      else if (remoteError) rejectResult(new Error(remoteError));
      else if (code !== 0 || !hasResult) rejectResult(new Error(`团队工具隔离进程失败（exit ${code ?? exitSignal ?? 'unknown'}）：${stderr.trim()}`));
      else resolveResult(result);
    });
    child.stdin.write(`${JSON.stringify({ name, cwd: plan.toolCwd, toolCallId, params: plan.params })}\n`);
  });
}

/** Override every built-in coding tool before the Team member sees the registry. */
export function createIsolatedToolDefinitions(cwd: string, agentDir: string): ToolDefinition[] {
  assertTeamSandboxAvailable(cwd, agentDir);
  const builtins = {
    read: createReadTool(cwd), bash: createBashTool(cwd), powershell: createPowerShellTool(cwd),
    edit: createEditTool(cwd), write: createWriteTool(cwd),
    grep: createGrepTool(cwd), find: createFindTool(cwd), ls: createLsTool(cwd),
  };
  return ISOLATED_TOOL_NAMES.map((name): ToolDefinition => ({
    ...builtins[name],
    execute: (id, params, signal, onUpdate) => executeIsolated(
      name, cwd, agentDir, id, params, signal, onUpdate,
    ) as ReturnType<ToolDefinition['execute']>,
  }));
}
