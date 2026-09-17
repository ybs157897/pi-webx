import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  PiCommandEnvelope,
  PiEvent,
  PiRpcResponse,
  ServerFrame,
} from '../../src/shared/protocol';
import { JsonlSplitter } from './framing';

/** Responses are acknowledgements ("accepted/queued"), so this can be generous. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
/** Bytes of stderr retained for debugging (bounded ring buffer). */
const STDERR_RING_BYTES = 64 * 1024;
/** Gap between SIGTERM and SIGKILL in `stop()`. */
const DEFAULT_KILL_GRACE_MS = 3_000;

export interface PiProcessOptions {
  /** Working directory for the child. */
  cwd: string;
  /** Extra CLI arguments appended after `--mode rpc`. */
  args?: string[];
  /** Receives every frame this child produces. Must not throw. */
  onFrame: (frame: ServerFrame) => void;
  /** Per-command response timeout. Defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number;
  /** SIGTERM -> SIGKILL grace period. */
  killGraceMs?: number;
}

interface PendingCommand {
  command: string;
  timer: NodeJS.Timeout;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
}

/**
 * One `pi --mode rpc` child process.
 *
 * Owns stdin/stdout framing, command id correlation, stderr capture and
 * lifecycle. It never interprets agent semantics - `agent_start` vs
 * `agent_settled`, session state, etc. are the manager's business.
 */
export class PiProcess {
  readonly cwd: string;
  readonly args: string[];
  readonly commandTimeoutMs: number;

  private readonly onFrame: (frame: ServerFrame) => void;
  private readonly killGraceMs: number;
  private readonly splitter = new JsonlSplitter();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly stderrChunks: Buffer[] = [];
  private readonly failed: Promise<never>;

  private child: ChildProcess | null = null;
  private stderrBytes = 0;
  private dead = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private spawnError: string | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private rejectFailed: ((error: Error) => void) | null = null;
  private resolveExited: (() => void) | null = null;
  private exited: Promise<void> | null = null;

  constructor(options: PiProcessOptions) {
    this.cwd = options.cwd;
    this.args = options.args ?? [];
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.onFrame = options.onFrame;

    this.failed = new Promise<never>((_resolve, reject) => {
      this.rejectFailed = reject;
    });
    // The failure signal is optional for callers; keep it "handled" so an
    // unobserved rejection can never take the server down.
    this.failed.catch(() => {});
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get alive(): boolean {
    return this.child !== null && !this.dead;
  }

  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.dead ? { code: this.exitCode, signal: this.exitSignal } : null;
  }

  /** Non-null when the process could not be spawned at all (e.g. ENOENT). */
  get startupError(): string | null {
    return this.spawnError;
  }

  /** Last ~64KB of stderr, kept for debugging. */
  getStderr(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }

  /** Rejects once the child dies or fails to spawn. Never resolves. */
  whenFailed(): Promise<never> {
    return this.failed;
  }

  start(): void {
    if (this.child) return;

    const child = spawn('pi', ['--mode', 'rpc', ...this.args], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    this.exited = new Promise<void>((resolve) => {
      this.resolveExited = resolve;
    });

    const { stdin, stdout, stderr } = child;

    stdout?.on('data', (chunk: Buffer) => {
      for (const record of this.splitter.push(chunk)) this.handleRecord(record);
    });
    stdout?.on('end', () => {
      for (const record of this.splitter.flush()) this.handleRecord(record);
    });
    stdout?.on('error', () => {
      /* read errors surface through 'exit'; nothing useful to add here */
    });

    stderr?.on('data', (chunk: Buffer) => {
      this.appendStderr(chunk);
      this.emit({ t: 'stderr', chunk: chunk.toString('utf8') });
    });
    stderr?.on('error', () => {});

    // Without a listener a post-exit write would raise an uncaught EPIPE.
    stdin?.on('error', () => {});

    child.on('error', (error: Error) => {
      const message = describeSpawnError(error);
      this.spawnError = message;
      this.emit({ t: 'error', message });
      this.settle(new Error(message));
    });

    child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.emit({
        t: 'exit',
        code,
        signal: signal === null ? null : String(signal),
      });
      this.settle(new Error(describeExit(code, signal)));
    });

    child.on('close', () => {
      // Spawn failures emit 'error' + 'close' without 'exit'; make sure the
      // process is always marked dead and no caller is left waiting.
      this.settle(new Error(this.spawnError ?? describeExit(this.exitCode, this.exitSignal)));
    });
  }

  /**
   * Send a command and resolve with pi's acknowledgement.
   *
   * - resolves with the matching `{type:"response"}` frame,
   * - resolves with `success:false` when the process is dead, the write fails,
   *   or the response does not arrive within the timeout,
   * - rejects only when the process dies while the command is in flight.
   */
  send(command: PiCommandEnvelope, timeoutMs = this.commandTimeoutMs): Promise<PiRpcResponse> {
    const id = typeof command.id === 'string' && command.id.length > 0 ? command.id : randomUUID();
    const name = command.type;

    if (this.dead || !this.child) {
      return Promise.resolve(failure(id, name, 'pi process is not running'));
    }

    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.resolve(failure(id, name, 'pi process stdin is not writable'));
    }

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(failure(id, name, 'timed out waiting for pi'));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { command: name, timer, resolve, reject });

      let payload: string;
      try {
        payload = `${JSON.stringify({ ...command, id })}\n`;
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(failure(id, name, `command is not serialisable: ${errorMessage(error)}`));
        return;
      }

      stdin.write(payload, 'utf8', (error?: Error | null) => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(failure(id, name, `could not write to pi stdin: ${error.message}`));
      });
    });
  }

  /**
   * Close stdin, SIGTERM, then SIGKILL after the grace period. Resolves once the
   * child is gone (or immediately when it already is).
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    if (child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
    }

    if (!this.dead) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      if (this.killTimer === null) {
        this.killTimer = setTimeout(() => {
          this.killTimer = null;
          if (!this.dead) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }, this.killGraceMs);
        this.killTimer.unref?.();
      }
    }

    await this.waitForExit(this.killGraceMs + 2_000);
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.dead || !this.exited) return;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  private handleRecord(rawRecord: string): void {
    // The splitter already stripped one trailing CR; the extra trim is cheap
    // insurance against a producer that emitted CR twice.
    const line = rawRecord.endsWith('\r') ? rawRecord.slice(0, -1) : rawRecord;
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Never fatal: pi occasionally prints non-JSON banners on stdout.
      this.emit({ t: 'stdout', line });
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.emit({ t: 'stdout', line });
      return;
    }

    if (parsed.type === 'response') {
      const response = parsed as unknown as PiRpcResponse;
      if (typeof response.id === 'string') {
        const entry = this.pending.get(response.id);
        if (entry) {
          this.pending.delete(response.id);
          clearTimeout(entry.timer);
          entry.resolve(response);
          return;
        }
      }
      // Uncorrelated (e.g. pi's own parse-error response): keep it visible.
      this.emit({ t: 'stdout', line });
      return;
    }

    this.emit({ t: 'pi', event: parsed as unknown as PiEvent });
  }

  /** Mark the process dead exactly once, fail pending commands, wake waiters. */
  private settle(error: Error): void {
    if (this.dead) return;
    this.dead = true;

    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }

    this.rejectFailed?.(error);
    this.rejectFailed = null;
    this.resolveExited?.();
    this.resolveExited = null;
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.length;

    while (this.stderrBytes > STDERR_RING_BYTES && this.stderrChunks.length > 0) {
      const head = this.stderrChunks[0];
      if (!head) break;
      const excess = this.stderrBytes - STDERR_RING_BYTES;
      if (head.length <= excess) {
        this.stderrChunks.shift();
        this.stderrBytes -= head.length;
      } else {
        this.stderrChunks[0] = head.subarray(excess);
        this.stderrBytes -= excess;
      }
    }
  }

  private emit(frame: ServerFrame): void {
    try {
      this.onFrame(frame);
    } catch {
      /* a failing consumer must not kill the child */
    }
  }
}

function failure(id: string, command: string, error: string): PiRpcResponse {
  return { type: 'response', id, command, success: false, error };
}

function describeSpawnError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return (
      'could not start "pi": no such executable on PATH. Install the pi coding agent ' +
      'globally and make sure `pi --version` works in a terminal ' +
      '(npm install -g @earendil-works/pi-coding-agent).'
    );
  }
  return `could not start "pi": ${error.message}`;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `pi process exited after signal ${signal}`;
  return `pi process exited with code ${code === null ? 'unknown' : String(code)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
