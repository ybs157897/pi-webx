import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const START_TIMEOUT_MS = 8_000;

export interface IdeStatus { ready: boolean; error?: string }
export interface GatewayConnection { port: number; token: string }

export function webIdeaDir(): string {
  return process.env.PI_WEBX_WEB_IDEA_DIR ?? path.resolve(projectRoot, '../web-idea');
}

export class CodesIdeRuntime {
  readonly distDir: string;
  private readonly binary: string;
  private child: ChildProcess | undefined;
  private connection: GatewayConnection | undefined;
  private starting: Promise<GatewayConnection> | undefined;
  private stopping: Promise<void> | undefined;
  private stopped = false;

  constructor(repoDir = webIdeaDir(), private readonly reservePort = freeLoopbackPort) {
    this.distDir = path.join(repoDir, 'apps/web/dist');
    this.binary = path.join(repoDir, '.local/bin/web-idea-gateway');
  }

  async status(): Promise<IdeStatus> {
    try {
      await Promise.all([access(path.join(this.distDir, 'index.html')), access(this.binary)]);
      return { ready: true };
    } catch {
      return { ready: false, error: 'web-idea 未构建；运行 npm run setup:web-idea' };
    }
  }

  async start(): Promise<GatewayConnection> {
    if (this.stopped) throw new Error('代码编辑器服务已关闭');
    if (this.connection && this.child?.exitCode === null) return this.connection;
    if (this.starting) return this.starting;
    this.starting = this.spawnGateway();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  getConnection(): GatewayConnection | undefined {
    return this.child?.exitCode === null ? this.connection : undefined;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.connection = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child) return Promise.resolve();
    this.stopping = stopProcessGroup(child);
    return this.stopping;
  }

  private async spawnGateway(): Promise<GatewayConnection> {
    const status = await this.status();
    if (!status.ready) throw new Error(status.error);
    if (this.stopped) throw new Error('代码编辑器服务已关闭');
    const port = await this.reservePort();
    if (this.stopped) throw new Error('代码编辑器服务已关闭');
    const token = randomBytes(32).toString('hex');
    const child = spawn(this.binary, [], {
      cwd: path.dirname(this.binary),
      env: {
        ...process.env,
        WEBIDEA_LISTEN: `127.0.0.1:${port}`,
        WEBIDEA_DEV_TOKEN: token,
        WEBIDEA_CORS_ORIGINS: 'http://127.0.0.1:1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;
    let errorText = '';
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      errorText = (errorText + chunk.toString()).slice(-2000);
    });
    child.once('exit', () => {
      if (this.child === child) {
        this.child = undefined;
        this.connection = undefined;
      }
    });
    child.once('error', () => {
      if (this.child === child) {
        this.child = undefined;
        this.connection = undefined;
      }
    });
    const spawnFailure = new Promise<never>((_resolve, reject) => child.once('error', reject));
    try {
      await Promise.race([waitForHealth(port, child), spawnFailure]);
    } catch (error) {
      child.kill('SIGTERM');
      if (this.child === child) this.child = undefined;
      throw new Error(`web-idea gateway 启动失败：${errorText.trim() || String(error)}`);
    }
    if (this.stopped) {
      child.kill('SIGTERM');
      throw new Error('代码编辑器服务已关闭');
    }
    const connection = { port, token };
    this.connection = connection;
    return connection;
  }
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  signalProcessGroup(child, 'SIGTERM');
  await waitForExit(child, 500);
  // The Go gateway does not trap SIGTERM. Its jdtls child shares this process
  // group, so finish any descendant that outlived the gateway before returning.
  if (process.platform !== 'win32') signalProcessGroup(child, 'SIGKILL');
  else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child, 500);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return; }
    catch { /* process group already exited */ }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(); }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('gateway 进程已退出');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch { /* child may still be binding */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('等待 healthz 超时');
}
