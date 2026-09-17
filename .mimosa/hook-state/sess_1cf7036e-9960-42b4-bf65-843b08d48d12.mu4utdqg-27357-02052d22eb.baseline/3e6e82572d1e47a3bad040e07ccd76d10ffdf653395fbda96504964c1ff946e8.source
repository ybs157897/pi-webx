import { randomUUID } from 'node:crypto';
import type {
  CreateSessionRequest,
  PiCommandEnvelope,
  PiModel,
  PiRpcResponse,
  PiSessionState,
  ServerFrame,
  SessionSummary,
} from '../../src/shared/protocol';
import { PiProcess } from './process';

/** Hard cap on child processes this server keeps alive. */
export const MAX_SESSIONS = 12;
/** How often dead, unwatched sessions are reaped. */
const SWEEP_INTERVAL_MS = 60_000;
/** A dead session with no SSE subscribers is dropped after this long. */
const SWEEP_DEAD_AFTER_MS = 10 * 60_000;
/** Startup handshake (first `get_state`) budget. */
const STARTUP_TIMEOUT_MS = 20_000;
/** Timeout for fire-and-forget summary refreshes. */
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * Commands that can change what `get_state` reports, so the cached summary is
 * refreshed after they succeed.
 */
const STATE_CHANGING_COMMANDS = new Set<string>([
  'set_model',
  'cycle_model',
  'set_thinking_level',
  'cycle_thinking_level',
  'new_session',
  'switch_session',
  'fork',
  'clone',
  'set_session_name',
  'compact',
]);

export class SessionLimitError extends Error {}
export class SessionStartError extends Error {}
export class UnknownSessionError extends Error {}

export interface SessionSubscriber {
  /** Deliver a frame. Must never throw. */
  frame: (frame: ServerFrame) => void;
  /** Session was torn down (or explicitly killed); end the stream. */
  close: () => void;
}

export interface Session {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
  /** true when the session was created with `--session <path>`. */
  readonly resumed: boolean;
  readonly proc: PiProcess;
  readonly subscribers: Set<SessionSubscriber>;
  sessionFile: string | null;
  sessionName: string | null;
  provider: string | null;
  model: string | null;
  streaming: boolean;
  deadSince: number | null;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  /**
   * Spawn a session and wait for its first `get_state` so the caller gets a
   * populated summary. Throws {@link SessionStartError} when pi cannot start.
   */
  async create(request: CreateSessionRequest): Promise<Session> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new SessionLimitError(
        `session limit reached (${MAX_SESSIONS} concurrent sessions); delete a session and retry`,
      );
    }

    const cwd = request.cwd && request.cwd.trim().length > 0 ? request.cwd : process.cwd();
    const id = randomUUID();

    // The frame callback needs the session record, which in turn needs the
    // process. Frames can only arrive on a later tick, so the closure below
    // always observes the assigned session.
    let session: Session | null = null;
    const proc = new PiProcess({
      cwd,
      args: buildPiArgs(request),
      onFrame: (frame) => {
        if (session) this.handleFrame(session, frame);
      },
    });

    session = {
      id,
      cwd,
      createdAt: Date.now(),
      resumed: typeof request.sessionPath === 'string' && request.sessionPath.length > 0,
      proc,
      subscribers: new Set(),
      sessionFile: null,
      sessionName: null,
      provider: null,
      model: null,
      streaming: false,
      deadSince: null,
    };
    this.sessions.set(id, session);

    try {
      proc.start();
      const outcome = await this.handshake(proc);
      if (!outcome.ok) {
        throw new SessionStartError(outcome.error);
      }
      if (!outcome.response.success) {
        throw new SessionStartError(
          outcome.response.error ?? 'pi rejected the initial get_state command',
        );
      }
      this.applyState(session, outcome.response.data);
      return session;
    } catch (error) {
      void proc.stop();
      this.sessions.delete(id);
      throw error instanceof SessionStartError
        ? error
        : new SessionStartError(errorMessage(error));
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  summary(session: Session): SessionSummary {
    return {
      id: session.id,
      cwd: session.cwd,
      pid: session.proc.pid,
      createdAt: session.createdAt,
      alive: session.proc.alive,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      provider: session.provider,
      model: session.model,
      streaming: session.streaming,
      clients: session.subscribers.size,
    };
  }

  async sendCommand(sessionId: string, command: PiCommandEnvelope): Promise<PiRpcResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSessionError(`unknown session: ${sessionId}`);

    const response = await session.proc.send(command);
    if (response.success && STATE_CHANGING_COMMANDS.has(command.type)) {
      this.refreshState(session);
    }
    return response;
  }

  /** Fire-and-forget `get_state`; failures are ignored on purpose. */
  refreshState(session: Session): void {
    void session.proc.send({ type: 'get_state' }, REFRESH_TIMEOUT_MS).then(
      (response) => {
        if (response.success) this.applyState(session, response.data);
      },
      () => {
        /* process died; the exit frame already told the client */
      },
    );
  }

  subscribe(session: Session, subscriber: SessionSubscriber): void {
    session.subscribers.add(subscriber);
  }

  unsubscribe(session: Session, subscriber: SessionSubscriber): void {
    session.subscribers.delete(subscriber);
  }

  /** Dispose the child and forget the session. Returns false when unknown. */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.teardown(session, 'session deleted');
    return true;
  }

  /** Kill every child (shutdown path). */
  async disposeAll(): Promise<void> {
    clearInterval(this.sweeper);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) this.teardown(session, 'server shutting down');
    await Promise.all(sessions.map((session) => session.proc.stop().catch(() => {})));
  }

  private teardown(session: Session, reason: string): void {
    void session.proc.stop();
    if (session.subscribers.size > 0) {
      for (const subscriber of session.subscribers) {
        safeFrame(subscriber, { t: 'error', message: reason });
      }
    }
    const subscribers = [...session.subscribers];
    session.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.close();
      } catch {
        /* a broken stream must not stop the teardown */
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.proc.alive || session.subscribers.size > 0) continue;
      const since = session.deadSince ?? now;
      session.deadSince = since;
      if (now - since >= SWEEP_DEAD_AFTER_MS) {
        this.kill(session.id);
      }
    }
  }

  private async handshake(
    proc: PiProcess,
  ): Promise<{ ok: true; response: PiRpcResponse } | { ok: false; error: string }> {
    const firstState = proc.send({ type: 'get_state' }, STARTUP_TIMEOUT_MS);
    const failure = proc.whenFailed().then(
      () => null,
      (error: unknown) => error,
    );

    const outcome = await Promise.race([
      firstState.then((response) => ({ kind: 'response' as const, response })),
      failure.then((error) => ({ kind: 'failure' as const, error })),
    ]);

    if (outcome.kind === 'response') {
      if (!outcome.response.success && !proc.alive) {
        return { ok: false, error: outcome.response.error ?? 'pi is not running' };
      }
      return { ok: true, response: outcome.response };
    }
    return { ok: false, error: errorMessage(outcome.error) };
  }

  private handleFrame(session: Session, frame: ServerFrame): void {
    switch (frame.t) {
      case 'pi': {
        const type = frame.event.type;
        if (type === 'agent_start') {
          session.streaming = true;
        } else if (type === 'agent_settled') {
          session.streaming = false;
          // Session file/name/model can change during a run.
          this.refreshState(session);
        } else if (type === 'compaction_end') {
          this.refreshState(session);
        }
        break;
      }
      case 'exit': {
        session.streaming = false;
        session.deadSince ??= Date.now();
        break;
      }
      case 'error': {
        if (!session.proc.alive) session.deadSince ??= Date.now();
        break;
      }
      default:
        break;
    }

    for (const subscriber of session.subscribers) {
      safeFrame(subscriber, frame);
    }
  }

  private applyState(session: Session, data: unknown): void {
    if (!isRecord(data)) return;
    const state = data as PiSessionState;

    if (state.sessionFile === null) session.sessionFile = null;
    else if (typeof state.sessionFile === 'string') session.sessionFile = state.sessionFile;

    session.sessionName = typeof state.sessionName === 'string' ? state.sessionName : null;

    const model = state.model;
    if (isRecord(model)) {
      const typed = model as PiModel;
      if (typeof typed.id === 'string') session.model = typed.id;
      if (typeof typed.provider === 'string') session.provider = typed.provider;
    } else if (model === null) {
      session.model = null;
      session.provider = null;
    }

    if (typeof state.isStreaming === 'boolean') session.streaming = state.isStreaming;
    if (session.proc.alive) session.deadSince = null;
  }
}

/** CLI arguments after the mandatory `--mode rpc`. */
export function buildPiArgs(request: CreateSessionRequest): string[] {
  const args: string[] = [];

  if (nonEmpty(request.provider)) args.push('--provider', request.provider);
  if (nonEmpty(request.model)) args.push('--model', request.model);
  if (nonEmpty(request.thinking)) args.push('--thinking', request.thinking);
  if (nonEmpty(request.name)) args.push('--name', request.name);
  if (nonEmpty(request.sessionPath)) args.push('--session', request.sessionPath);
  if (request.noSession === true) args.push('--no-session');

  if (Array.isArray(request.extraArgs)) {
    for (const extra of request.extraArgs) {
      if (typeof extra === 'string' && extra.length > 0) args.push(extra);
    }
  }

  return args;
}

function safeFrame(subscriber: SessionSubscriber, frame: ServerFrame): void {
  try {
    subscriber.frame(frame);
  } catch {
    /* a broken SSE stream must not affect the session */
  }
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
