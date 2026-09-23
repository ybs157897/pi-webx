/** Built-in Windows AppContainer isolation through the bundled landstrip binary. */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

import { TeamSandboxUnavailableError, type ToolLaunchPlan } from './isolation-contract';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const HOST_FILE = join(import.meta.dirname, 'sandbox-tool-host.mts');
const TSX_LOADER = join(realpathSync(join(PROJECT_ROOT, 'node_modules')), 'tsx', 'dist', 'loader.mjs');
const BIN_DIR = join(PROJECT_ROOT, 'node_modules', '.cache', 'pi-webx-team-tools');
const REQUIRE = createRequire(import.meta.url);
const EXPECTED_BINARIES = {
  'rg.exe': 'f162b54de2adfc72d78adb1dbada2dedda111ae0a5e2f6e9500f4f909664c5d2',
  'fd.exe': 'fd3d4853da7a319a604e1cb03ede88cbf584edd12b89a0991871fb4d9cd3ba5b',
};
const verified = new Set<string>();
const pending = new Map<string, Promise<void>>();
const execFileAsync = promisify(execFile);

function canonical(path: string): string {
  const resolved = existsSync(path) ? realpathSync(path) : win32.resolve(path);
  return resolved.startsWith('\\\\?\\') ? resolved.slice(4) : resolved;
}

function within(parent: string, child: string): boolean {
  const rel = win32.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${win32.sep}`) && !win32.isAbsolute(rel));
}

function validateWorkspace(cwd: string, agentDir: string): string {
  if (!win32.isAbsolute(cwd) || cwd.startsWith('\\\\')) {
    throw new TeamSandboxUnavailableError(400, 'Windows Team 工作区必须是本地盘符上的绝对目录。');
  }
  let workspace: string;
  try { workspace = canonical(cwd); }
  catch { throw new TeamSandboxUnavailableError(400, 'Windows Team 工作区不存在或无法解析。'); }
  const store = canonical(agentDir);
  const home = canonical(homedir());
  const appRoot = canonical(PROJECT_ROOT);
  if (workspace === win32.parse(workspace).root || within(workspace, home)
    || within(workspace, store) || within(store, workspace)
    || within(workspace, appRoot) || within(appRoot, workspace)) {
    throw new TeamSandboxUnavailableError(400, '工作区覆盖用户目录、Agent 配置目录或宿主程序文件，不能授予 Team 写权限。');
  }
  if (/[\r\n]/u.test(workspace)) throw new TeamSandboxUnavailableError(400, '工作区路径含不可用字符。');
  return workspace;
}

function landstripBinary(): string {
  try {
    const packageApi = REQUIRE('@landstrip/landstrip-api') as { binaryPath(): string };
    const binary = packageApi.binaryPath();
    if (!existsSync(binary)) throw new Error('native binary missing');
    return binary;
  } catch (cause) {
    throw new TeamSandboxUnavailableError(501, `Windows AppContainer 执行器不可用：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function assertWindowsAppContainerStatus(report: unknown): void {
  if (typeof report !== 'object' || report === null) {
    throw new TeamSandboxUnavailableError(501, 'Windows AppContainer 状态格式无效。');
  }
  const state = report as { active?: unknown; installed?: unknown; healthy?: unknown };
  if (state.active !== 'appContainer' || state.installed !== false || state.healthy !== true) {
    throw new TeamSandboxUnavailableError(501, 'Agent Team 需要原生 LPAC AppContainer；当前 Landstrip 后端不匹配。');
  }
}

function assertNativeAppContainer(binary: string): void {
  const status = spawnSync(binary, ['windows', 'status'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  if (status.status !== 0) {
    throw new TeamSandboxUnavailableError(501, 'Windows AppContainer 状态检查失败。');
  }
  let report: unknown;
  try { report = JSON.parse(status.stdout) as unknown; }
  catch { throw new TeamSandboxUnavailableError(501, 'Windows AppContainer 状态格式无效。'); }
  assertWindowsAppContainerStatus(report);
}

function verifySearchBinaries(): void {
  for (const [name, expected] of Object.entries(EXPECTED_BINARIES)) {
    const file = join(BIN_DIR, name);
    if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) {
      throw new TeamSandboxUnavailableError(501, `缺少经过校验的 ${name}；请运行 npm run team:windows-tools。`);
    }
  }
}

/** Pure policy shape for Windows static checks; paths are validated before use. */
export function windowsAppContainerPolicy(input: {
  readonly workspace: string;
  readonly agentDir: string;
  readonly scratch: string;
  readonly nodeBin: string;
  readonly dependencies: string;
  readonly searchBinDir: string;
  readonly extraDeniedRead?: string;
}) {
  return {
    filesystem: {
      allowRead: [
        input.workspace, input.scratch, input.nodeBin, input.dependencies,
        input.searchBinDir, HOST_FILE,
        join(PROJECT_ROOT, 'package.json'), join(PROJECT_ROOT, 'tsconfig.json'),
      ],
      allowWrite: [input.workspace, input.scratch],
      denyRead: [input.agentDir, ...(input.extraDeniedRead ? [input.extraDeniedRead] : [])],
      denyWrite: [input.agentDir],
    },
    network: { allowNetwork: false },
    windows: { appContainerMode: 'lpac', allowLoopback: false },
  } as const;
}

function childEnvironment(scratch: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    Path: [BIN_DIR, dirname(process.execPath), join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      join(systemRoot, 'System32'), systemRoot].join(';'),
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: scratch,
    TEMP: scratch,
    TMP: scratch,
    PI_CODING_AGENT_DIR: scratch,
  };
}

function policyFor(workspace: string, agentDir: string, scratch: string, extraDeniedRead?: string) {
  return windowsAppContainerPolicy({
    workspace, agentDir: canonical(agentDir), scratch,
    nodeBin: dirname(canonical(process.execPath)),
    dependencies: canonical(join(PROJECT_ROOT, 'node_modules')),
    searchBinDir: canonical(BIN_DIR),
    ...(extraDeniedRead ? { extraDeniedRead } : {}),
  });
}

async function verifyPolicy(binary: string, workspace: string, agentDir: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-webx-team-win-preflight-'));
  const deniedRoot = mkdtempSync(join(tmpdir(), 'pi-webx-team-win-denied-'));
  const allowedFile = join(scratch, 'allowed.txt');
  const deniedFile = join(deniedRoot, 'denied.txt');
  const policyFile = join(scratch, 'policy.json');
  try {
    writeFileSync(allowedFile, 'allowed');
    writeFileSync(deniedFile, 'denied');
    writeFileSync(policyFile, JSON.stringify(policyFor(workspace, agentDir, scratch, deniedRoot)));
    const program = [
      'const fs=require("node:fs");',
      'if(fs.readFileSync(process.argv[1],"utf8")!=="allowed")process.exit(2);',
      'try{fs.readFileSync(process.argv[2]);process.exit(3)}',
      'catch(error){if(error.code!=="EACCES"&&error.code!=="EPERM")process.exit(4);}',
      'process.stdout.write("APP_CONTAINER_DENIED");',
    ].join('');
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(binary, [
      'run', '-p', policyFile, '--', process.execPath, '-e', program, allowedFile, deniedFile,
      ], {
      cwd: workspace, env: childEnvironment(scratch), encoding: 'utf8',
      timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
      }));
    } catch (cause) {
      throw new TeamSandboxUnavailableError(
        501,
        `Windows AppContainer 预检进程失败：${cause instanceof Error ? cause.message.slice(0, 400) : String(cause)}`,
      );
    }
    if (stdout !== 'APP_CONTAINER_DENIED') {
      throw new TeamSandboxUnavailableError(
        501,
        `Windows AppContainer 读文件正负对照未通过：${stdout.slice(0, 400)}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(deniedRoot, { recursive: true, force: true });
  }
}

/** Synchronous prerequisite checks; the real LPAC probe is awaited separately. */
export function assertWindowsAppContainerAvailable(cwd: string, agentDir: string): void {
  if (process.platform !== 'win32') {
    throw new TeamSandboxUnavailableError(501, 'Windows AppContainer 只能在 Windows 主机验收。');
  }
  validateWorkspace(cwd, agentDir);
  verifySearchBinaries();
  const binary = landstripBinary();
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (version.status !== 0) {
    throw new TeamSandboxUnavailableError(501, 'Windows AppContainer 执行器启动失败。');
  }
  assertNativeAppContainer(binary);
}

/** First use verifies actual read allow/deny behavior without blocking Node's event loop. */
export async function ensureWindowsAppContainerVerified(cwd: string, agentDir: string): Promise<void> {
  assertWindowsAppContainerAvailable(cwd, agentDir);
  const workspace = validateWorkspace(cwd, agentDir);
  const key = `${workspace}\0${canonical(agentDir)}`;
  if (verified.has(key)) return;
  let check = pending.get(key);
  if (!check) {
    check = verifyPolicy(landstripBinary(), workspace, agentDir)
      .then(() => { verified.add(key); })
      .finally(() => { pending.delete(key); });
    pending.set(key, check);
  }
  await check;
}

export function prepareWindowsAppContainerLaunch(cwd: string, agentDir: string, params: unknown): ToolLaunchPlan {
  assertWindowsAppContainerAvailable(cwd, agentDir);
  const workspace = validateWorkspace(cwd, agentDir);
  const scratch = mkdtempSync(join(tmpdir(), 'pi-webx-team-win-tool-'));
  const policyFile = join(scratch, 'policy.json');
  try { writeFileSync(policyFile, JSON.stringify(policyFor(workspace, agentDir, scratch))); }
  catch (cause) { rmSync(scratch, { recursive: true, force: true }); throw cause; }
  return {
    command: landstripBinary(),
    args: ['run', '-p', policyFile, '--', process.execPath, '--import', TSX_LOADER, HOST_FILE],
    cwd: workspace,
    toolCwd: workspace,
    params,
    env: childEnvironment(scratch),
    stop(pid) {
      if (pid === undefined) return;
      try { process.kill(pid, 'SIGKILL'); } catch { /* The Job already exited. */ }
    },
    cleanup() {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Best effort. */ }
    },
  };
}
