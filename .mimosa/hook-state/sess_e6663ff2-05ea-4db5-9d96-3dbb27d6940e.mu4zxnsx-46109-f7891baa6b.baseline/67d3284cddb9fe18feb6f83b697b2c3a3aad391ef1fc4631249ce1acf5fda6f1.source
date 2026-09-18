/**
 * In-process session host: one `AgentSession` per hosted conversation, created
 * through the pi SDK (`createAgentSession`) — no subprocess, no PATH lookup.
 *
 * pi's own config dir (`~/.pi/agent`) supplies models.json, auth.json and
 * extensions, so everything configured elsewhere in this app keeps working.
 *
 * The outward surface deliberately mirrors the old subprocess bridge
 * (`POST /command` with pi's command vocabulary and `ServerFrame` SSE frames)
 * so the client needs no protocol changes.
 */

import {
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
} from '@earendil-works/pi-coding-agent';

import type {
  PiCommandEnvelope,
  PiModel,
  PiRpcResponse,
  PiSessionState,
  PiSessionStats,
  ServerFrame,
  SessionSummary,
} from '../../src/shared/protocol';

const MAX_SESSIONS = 12;
/** Sweep dead sessions with no subscribers after this long. */
const SWEEP_AFTER_MS = 10 * 60_000;

export interface HostSubscriber {
  frame: (frame: ServerFrame) => void;
  close: () => void;
}

export class HostError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HostedSession {
  id: string;
  cwd: string;
  createdAt: number;
  resumed: boolean;
  alive: boolean;
  streaming: boolean;
  sessionFile: string | null;
  sessionName: string | null;
  session: AgentSession;
  subscribers: Set<HostSubscriber>;
  unsubscribe: (() => void) | null;
  lastSeen: number;
}

export interface CreateHostedSessionOptions {
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  sessionPath?: string;
  name?: string;
  /** `--no-session`: keep the transcript in memory only. */
  noSession?: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asModel(model: Model<any> | undefined | null): PiModel | null {
  if (!model) return null;
  return model as unknown as PiModel;
}

export class PiHost {
  private modelRuntime: ModelRuntime | null = null;
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private runtime(): Promise<ModelRuntime> {
    if (this.modelRuntime) return Promise.resolve(this.modelRuntime);
    this.modelRuntimePromise ??= ModelRuntime.create().then((runtime) => {
      this.modelRuntime = runtime;
      return runtime;
    });
    return this.modelRuntimePromise;
  }

  /* ----------------------------------------------------------------- create */

  async create(options: CreateHostedSessionOptions = {}): Promise<HostedSession> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new HostError(429, `session limit reached (${MAX_SESSIONS})`);
    }
    const cwd = options.cwd ?? process.cwd();
    const runtime = await this.runtime();

    let model: Model<any> | undefined;
    if (options.provider && options.model) {
      const resolved = resolveCliModel({
        cliModel: `${options.provider}/${options.model}`,
        modelRuntime: runtime,
      });
      if (resolved.error) throw new HostError(400, resolved.error);
      model = resolved.model;
    }

    const sessionManager = options.sessionPath
      ? SessionManager.open(options.sessionPath, undefined, cwd)
      : options.noSession
        ? SessionManager.inMemory(cwd)
        : SessionManager.create(cwd);

    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      ...(model ? { model } : {}),
      ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
      modelRuntime: runtime,
      sessionManager,
    });

    if (options.name) session.setSessionName(options.name);

    const hosted: HostedSession = {
      id: crypto.randomUUID(),
      cwd,
      createdAt: Date.now(),
      resumed: Boolean(options.sessionPath),
      alive: true,
      streaming: false,
      sessionFile: session.sessionFile ?? null,
      sessionName: options.name ?? null,
      session,
      subscribers: new Set(),
      unsubscribe: null,
      lastSeen: Date.now(),
    };

    hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
    this.sessions.set(hosted.id, hosted);
    return hosted;
  }

  /* ------------------------------------------------------------- event fan-out */

  private onEvent(hosted: HostedSession, event: AgentSessionEvent): void {
    hosted.lastSeen = Date.now();
    if (event.type === 'agent_start') hosted.streaming = true;
    if (event.type === 'agent_settled' || event.type === 'agent_end') hosted.streaming = false;
    // SDK events are a superset of the RPC-mode union the client models; the
    // transcript reducer ignores the extras (entry_appended, …) safely.
    this.broadcast(hosted, { t: 'pi', event: event as unknown as ServerFrame extends { t: 'pi'; event: infer E } ? E : never });
  }

  private broadcast(hosted: HostedSession, frame: ServerFrame): void {
    for (const subscriber of hosted.subscribers) subscriber.frame(frame);
  }

  private broadcastError(hosted: HostedSession, message: string): void {
    this.broadcast(hosted, { t: 'error', message });
  }

  subscribe(session: HostedSession, subscriber: HostSubscriber): void {
    session.subscribers.add(subscriber);
    session.lastSeen = Date.now();
  }

  unsubscribe(session: HostedSession, subscriber: HostSubscriber): void {
    session.subscribers.delete(subscriber);
    session.lastSeen = Date.now();
  }

  /* ------------------------------------------------------------------- CRUD */

  get(id: string): HostedSession | undefined {
    return this.sessions.get(id);
  }

  list(): HostedSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  summary(session: HostedSession): SessionSummary {
    const model = asModel(session.session.model);
    return {
      id: session.id,
      cwd: session.cwd,
      pid: null,
      createdAt: session.createdAt,
      alive: session.alive,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      streaming: session.streaming,
      clients: session.subscribers.size,
    };
  }

  async kill(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.alive = false;
    session.streaming = false;
    try {
      session.unsubscribe?.();
      session.session.dispose();
    } catch {
      // Disposal is best-effort; the session is gone either way.
    }
    this.broadcast(session, { t: 'exit', code: 0, signal: null });
    for (const subscriber of session.subscribers) subscriber.close();
    return true;
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.kill(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.alive && session.subscribers.size === 0) {
        void this.kill(session.id);
        continue;
      }
      if (session.subscribers.size === 0 && now - session.lastSeen > SWEEP_AFTER_MS) {
        void this.kill(session.id);
      }
    }
  }

  /* -------------------------------------------------------- command dispatch */

  async command(id: string, command: PiCommandEnvelope): Promise<PiRpcResponse> {
    const hosted = this.sessions.get(id);
    if (!hosted) return fail(command.type, 'unknown session');
    if (!hosted.alive) return fail(command.type, 'session is not running');
    hosted.lastSeen = Date.now();
    const session = hosted.session;

    try {
      switch (command.type) {
        case 'prompt': {
          const accepted = new Promise<boolean>((resolve) => {
            void session
              .prompt(command.message, {
                ...(command.images && command.images.length > 0
                  ? { images: command.images as unknown as ImageContent[] }
                  : {}),
                ...(command.streamingBehavior
                  ? { streamingBehavior: command.streamingBehavior }
                  : {}),
                preflightResult: resolve,
              })
              .catch((error: unknown) => this.broadcastError(hosted, errorText(error)));
          });
          const success = await accepted;
          return ok(command.type, { accepted: success });
        }
        case 'steer':
          await session.steer(command.message);
          return ok(command.type);
        case 'follow_up':
          await session.followUp(command.message);
          return ok(command.type);
        case 'abort':
          await session.abort();
          return ok(command.type);
        case 'clear_queue':
          return { type: 'response', command: command.type, success: true, data: session.clearQueue() };
        case 'new_session': {
          await this.resetInPlace(hosted);
          return { type: 'response', command: command.type, success: true, data: { cancelled: false } };
        }
        case 'get_state':
          return { type: 'response', command: command.type, success: true, data: this.stateOf(hosted) };
        case 'get_messages':
          return { type: 'response', command: command.type, success: true, data: { messages: session.messages } };
        case 'set_model': {
          const runtime = await this.runtime();
          const resolved = resolveCliModel({
            cliModel: `${command.provider}/${command.modelId}`,
            modelRuntime: runtime,
          });
          if (resolved.error) return fail(command.type, resolved.error);
          if (!resolved.model) return fail(command.type, 'model not found');
          await session.setModel(resolved.model);
          return { type: 'response', command: command.type, success: true, data: asModel(session.model) };
        }
        case 'cycle_model': {
          const result = await session.cycleModel();
          return { type: 'response', command: command.type, success: true, data: result ?? null };
        }
        case 'get_available_models': {
          const runtime = await this.runtime();
          const models = await runtime.getAvailable();
          return { type: 'response', command: command.type, success: true, data: { models } };
        }
        case 'set_thinking_level':
          session.setThinkingLevel(command.level);
          return ok(command.type);
        case 'cycle_thinking_level':
          return { type: 'response', command: command.type, success: true, data: { level: session.cycleThinkingLevel() ?? session.thinkingLevel } };
        case 'get_available_thinking_levels':
          return { type: 'response', command: command.type, success: true, data: { levels: this.thinkingLevels(hosted) } };
        case 'set_steering_mode':
          session.setSteeringMode(command.mode);
          return ok(command.type);
        case 'set_follow_up_mode':
          session.setFollowUpMode(command.mode);
          return ok(command.type);
        case 'compact':
          return { type: 'response', command: command.type, success: true, data: await session.compact(command.customInstructions) };
        case 'get_session_stats':
          return { type: 'response', command: command.type, success: true, data: this.statsOf(hosted) };
        case 'set_session_name':
          session.setSessionName(command.name);
          hosted.sessionName = command.name;
          return ok(command.type);
        case 'set_auto_compaction':
        case 'set_auto_retry':
        case 'export_html':
        case 'get_commands':
        case 'bash':
        case 'abort_bash':
          return fail(command.type, `${command.type} is not supported by the SDK host yet`);
        default:
          return fail(command.type, `unknown command: ${(command as { type: string }).type}`);
      }
    } catch (error) {
      return fail(command.type, errorText(error));
    }
  }

  private stateOf(hosted: HostedSession): PiSessionState {
    const { session } = hosted;
    return {
      model: asModel(session.model),
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      sessionFile: session.sessionFile ?? null,
      sessionId: session.sessionId,
      sessionName: hosted.sessionName ?? undefined,
      messageCount: session.messages.length,
      pendingMessageCount: 0,
    };
  }

  private statsOf(hosted: HostedSession): PiSessionStats {
    const { session } = hosted;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    for (const message of session.messages) {
      if (message.role === 'user') userMessages += 1;
      if (message.role === 'assistant') {
        assistantMessages += 1;
        for (const block of message.content) {
          if (block.type === 'toolCall') toolCalls += 1;
        }
        const usage = message.usage;
        if (usage) {
          input += usage.input ?? 0;
          output += usage.output ?? 0;
          cacheRead += usage.cacheRead ?? 0;
          cacheWrite += usage.cacheWrite ?? 0;
          cost += usage.cost?.total ?? 0;
        }
      }
    }
    const contextWindow = session.model?.contextWindow ?? 0;
    const tokens = input + output;
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      model: asModel(session.model),
      thinkingLevel: session.thinkingLevel,
      totalMessages: session.messages.length,
      userMessages,
      assistantMessages,
      toolCalls,
      totalTokens: tokens,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalCost: cost,
      contextUsage:
        contextWindow > 0
          ? { tokens, contextWindow, percent: Math.round((tokens / contextWindow) * 100) }
          : null,
    };
  }

  private thinkingLevels(hosted: HostedSession): ModelThinkingLevel[] {
    const map = (hosted.session.model as { thinkingLevelMap?: Record<string, unknown> } | undefined)
      ?.thinkingLevelMap;
    if (!map) return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const levels = (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).filter(
      (level) => level === 'off' || (map[level] !== null && map[level] !== undefined),
    );
    return levels as unknown as ModelThinkingLevel[];
  }

  /** Fresh conversation in the same hosted session, mirroring pi's `new_session`. */
  private async resetInPlace(hosted: HostedSession): Promise<void> {
    const cwd = hosted.cwd;
    const model = hosted.session.model;
    const thinking = hosted.session.thinkingLevel;
    const runtime = await this.runtime();

    try {
      hosted.unsubscribe?.();
      hosted.session.dispose();
    } catch {
      // Recreate regardless.
    }

    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      ...(model ? { model } : {}),
      thinkingLevel: thinking,
      modelRuntime: runtime,
      sessionManager: SessionManager.create(cwd),
    });
    if (hosted.sessionName) session.setSessionName(hosted.sessionName);

    hosted.session = session;
    hosted.sessionFile = session.sessionFile ?? null;
    hosted.streaming = false;
    hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
  }
}

function ok(command: string, data?: unknown): PiRpcResponse {
  return { type: 'response', command, success: true, ...(data === undefined ? {} : { data }) };
}

function fail(command: string, error: string): PiRpcResponse {
  return { type: 'response', command, success: false, error };
}
