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
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
} from '@earendil-works/pi-coding-agent';

import type {
  JournalEntry,
  PiCommandEnvelope,
  PiEvent,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiModel,
  PiRpcResponse,
  PiSessionState,
  PiSessionStats,
  ServerFrame,
  SessionSummary,
} from '../../src/shared/protocol';
import { PromptRequests, SessionJournal } from './session-journal';
import {
  appendToolSelection,
  readToolSelection,
  validateToolSelection,
  withExtensionTools,
} from '../tool-selection';

const MAX_SESSIONS = 12;
/** Sweep dead sessions with no subscribers after this long. */
const SWEEP_AFTER_MS = 10 * 60_000;

/** Commands whose submit is idempotent by requestId, like dsh's prompt path. */
const PROMPT_COMMANDS = new Set(['prompt', 'steer', 'follow_up']);

export interface HostSubscriber {
  frame: (entry: JournalEntry) => void;
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
  /**
   * What pi's resource loader found for this session. Its runtime is the only
   * public source of the merged slash-command list (`getCommands()`), which is
   * why it is kept: the extension-runner that builds it is private to
   * `createAgentSession`.
   */
  extensionsResult: LoadExtensionsResult;
  /**
   * Dialogs an extension is waiting on, keyed by request id. An extension's
   * `ctx.ui.confirm()` resolves only when the browser answers, so a dead session
   * has to resolve them rather than leave the agent's tool call hanging.
   */
  pendingDialogs: Map<string, (response: PiExtensionUiResponse) => void>;
  /**
   * The builtin selection this session is running with, as the user chose it
   * (before shell resolution and the extension-tool merge). `null` until a
   * selection is known.
   */
  toolSelection: string[] | null;
  /** Ordered in-memory log every subscriber's stream is cut from. */
  journal: SessionJournal;
  /** requestId ledger: duplicate-submit guard + echo-retire annotation. */
  promptRequests: PromptRequests;
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
  /**
   * Builtin tools a new session starts with, from the browser's preset. A resumed
   * session keeps the selection recorded in its own log instead: that record says
   * what the session was last run with, which the client cannot know.
   */
  toolNames?: string[];
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

  /**
   * The shared model runtime, for readers that must not touch a session.
   *
   * The picker's catalog is built from this object rather than from a live
   * session's `get_available_models`, so it reads the same registry the
   * sessions resolve against while needing no session to exist.
   */
  getModelRuntime(): Promise<ModelRuntime> {
    return this.runtime();
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

    const { session, extensionsResult } = await createAgentSession({
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
      extensionsResult,
      pendingDialogs: new Map(),
      toolSelection: options.toolNames ?? null,
      journal: new SessionJournal(),
      promptRequests: new PromptRequests(),
      subscribers: new Set(),
      unsubscribe: null,
      lastSeen: Date.now(),
    };

    hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
    this.applyInitialToolSelection(hosted, sessionManager, options.toolNames);
    await this.bindExtensions(session, hosted);
    this.sessions.set(hosted.id, hosted);
    return hosted;
  }

  /**
   * Put a session's tools where they belong, pi-web's way.
   *
   * A resumed session's own log decides: the newest `pi-webx:tool-selection` entry
   * records what it was last run with, and a client preset cannot know that. A
   * session with no such entry takes the client's preset and records it, so the
   * choice survives the next reload. A session with neither keeps pi's own default
   * tool set — the browser may simply not have sent one.
   */
  private applyInitialToolSelection(
    hosted: HostedSession,
    sessionManager: SessionManager,
    requested: readonly string[] | undefined,
  ): void {
    let entries: readonly unknown[] = [];
    try {
      entries = sessionManager.getEntries() as unknown as readonly unknown[];
    } catch {
      entries = [];
    }
    const persisted = readToolSelection(entries);
    if (persisted !== undefined) {
      this.setToolSelection(hosted, persisted, { persist: false });
      return;
    }
    if (requested === undefined) return;
    this.setToolSelection(hosted, requested, { persist: true });
  }

  /**
   * Apply one tool selection and, unless it came from the log, record it.
   *
   * `withExtensionTools` is the part that matters: a preset chooses builtin tools
   * only, and everything an extension registered stays enabled. pi's
   * `setActiveToolsByName` adopts the given set exactly, so skipping the merge
   * would silently switch off extension tools on any preset change.
   */
  private setToolSelection(
    hosted: HostedSession,
    toolNames: readonly string[],
    options: { persist: boolean },
  ): void {
    const defaultTools = hosted.session.settingsManager?.getDefaultTools?.();
    const resolved = withExtensionTools(hosted.session, toolNames, defaultTools);
    hosted.session.setActiveToolsByName(resolved);
    hosted.toolSelection = [...toolNames];
    if (!options.persist) return;
    try {
      appendToolSelection(hosted.session.sessionManager, toolNames);
    } catch (error) {
      this.broadcastError(hosted, `工具选择未能写入会话记录：${errorText(error)}`);
    }
  }

  /**
   * Copy a transcript into a new session and host it — dsh's `分叉会话`.
   *
   * `SessionManager.forkFrom` is pi's own implementation of the same idea: it
   * writes a new session file whose header names the source as `parentSession`,
   * so the fork is a real session the CLI can also open, not a private view.
   * The new session starts on the deployment default model rather than the
   * source's — dsh's fork takes the default the same way, because the copied
   * prefix is history the next model reads, not a route it is bound to.
   *
   * @param options - the source transcript and the workspace to fork into.
   * @returns the new hosted session.
   */
  async fork(options: { source: string; cwd?: string }): Promise<HostedSession> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new HostError(429, `session limit reached (${MAX_SESSIONS})`);
    }
    const cwd = options.cwd ?? process.cwd();
    const runtime = await this.runtime();

    let sessionManager: SessionManager;
    try {
      sessionManager = SessionManager.forkFrom(options.source, cwd);
    } catch (error) {
      throw new HostError(400, `无法分叉该会话：${errorText(error)}`);
    }

    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      modelRuntime: runtime,
      sessionManager,
    });

    const hosted: HostedSession = {
      id: crypto.randomUUID(),
      cwd,
      createdAt: Date.now(),
      resumed: false,
      alive: true,
      streaming: false,
      sessionFile: session.sessionFile ?? null,
      sessionName: null,
      session,
      extensionsResult,
      pendingDialogs: new Map(),
      // A fork keeps pi's default tool set until someone chooses otherwise; the
      // source session's selection describes that session, not this one.
      toolSelection: null,
      journal: new SessionJournal(),
      promptRequests: new PromptRequests(),
      subscribers: new Set(),
      unsubscribe: null,
      lastSeen: Date.now(),
    };

    hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
    await this.bindExtensions(session, hosted);
    this.sessions.set(hosted.id, hosted);
    return hosted;
  }

  /**
   * Give a freshly created session its extension bindings.
   *
   * `bindExtensions` is the public hook pi's own modes use; without it an
   * extension's `ctx.ui` actions are throwing stubs, which is the state this host
   * was in. Two differences from the TUI mode are deliberate:
   *
   *   - `mode: 'rpc'` — a non-terminal host that *does* have dialogs, which is
   *     precisely what an extension needs to know to use `ctx.ui.confirm`.
   *   - Session-swapping command actions (`newSession`, `fork`, `navigateTree`,
   *     `switchSession`) refuse instead of silently doing nothing: this host owns
   *     session identity (its own route vocabulary), so an extension command that
   *     would replace the session must say so rather than appear to work.
   */
  private async bindExtensions(session: AgentSession, hosted: HostedSession): Promise<void> {
    const refused = (action: string) => async (): Promise<never> => {
      throw new Error(`此宿主不支持扩展命令的 ${action}（会话身份由 pi-webx 管理）`);
    };
    try {
      await session.bindExtensions({
        uiContext: this.uiContextFor(hosted),
        mode: 'rpc',
        abortHandler: () => {
          void session.abort();
        },
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          reload: () => session.waitForIdle(),
          newSession: refused('newSession'),
          fork: refused('fork'),
          navigateTree: refused('navigateTree'),
          switchSession: refused('switchSession'),
        },
      });
    } catch (error) {
      // A session without extension bindings still runs; only extension UI and
      // extension commands are lost, so this is reported and not fatal.
      this.broadcastError(hosted, `扩展绑定失败：${errorText(error)}`);
    }
  }

  /* ------------------------------------------------------- extension UI bridge */

  /**
   * The `ctx.ui` an extension sees, wired to this app's own dialog surface.
   *
   * pi's TUI and RPC modes each install an implementation here; a bare
   * `createAgentSession` installs none, which is why an extension's
   * `ctx.ui.confirm()` never resolved in this host and its status/widget updates
   * were dropped. The portable half — select / confirm / input / editor / notify
   * / setStatus / setWidget / setEditorText — now travels as this app's existing
   * frames, so the browser renders the dialogs it already knew how to render.
   *
   * The terminal-only half (footers, custom TUI components, raw key input) is
   * deliberately absent: there is no terminal here. Extensions that guard on
   * `ctx.mode === 'tui'` or ask `ctx.dialogCapable` see a non-TUI,
   * dialog-capable host, which is what this is.
   */
  private uiContextFor(hosted: HostedSession): ExtensionUIContext {
    const ask = (
      method: 'select' | 'confirm' | 'input' | 'editor',
      payload: Partial<PiExtensionUiRequest>,
      options: { signal?: AbortSignal; timeout?: number } | undefined,
      fallback?: string | boolean,
    ): Promise<string | boolean | undefined> =>
      this.requestDialog(hosted, method, payload, options, fallback);

    const terminalOnly = (): void => {
      // Nothing here can render a terminal component; these are honest no-ops
      // rather than errors, because extensions call them defensively.
    };

    return {
      select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
        ask('select', { title, options: [...options] }, opts) as Promise<string | undefined>,
      confirm: async (
        title: string,
        message: string,
        opts?: ExtensionUIDialogOptions,
      ): Promise<boolean> => (await ask('confirm', { title, message }, opts, false)) === true,
      input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
        ask(
          'input',
          { title, ...(placeholder === undefined ? {} : { placeholder }) },
          opts,
        ) as Promise<string | undefined>,
      editor: (title: string, prefill?: string) =>
        ask(
          'editor',
          { title, ...(prefill === undefined ? {} : { prefill }) },
          undefined,
        ) as Promise<string | undefined>,
      notify: (message: string, type?: 'info' | 'warning' | 'error') => {
        this.broadcastUi(hosted, {
          method: 'notify',
          message,
          ...(type === undefined ? {} : { notifyType: type }),
        });
      },
      setStatus: (key: string, text: string | undefined) => {
        this.broadcastUi(hosted, {
          method: 'setStatus',
          statusKey: key,
          ...(text === undefined ? {} : { statusText: text }),
        });
      },
      setWidget: (
        key: string,
        content: string[] | ((...args: never[]) => unknown) | undefined,
        options?: ExtensionWidgetOptions,
      ) => {
        // A component-factory widget cannot cross this wire; only the
        // string-array form is meaningful outside a terminal.
        if (content !== undefined && !Array.isArray(content)) return;
        this.broadcastUi(hosted, {
          method: 'setWidget',
          widgetKey: key,
          ...(content === undefined ? {} : { widgetLines: content }),
          ...(options?.placement === undefined ? {} : { widgetPlacement: options.placement }),
        });
      },
      setEditorText: (text: string) => {
        this.broadcastUi(hosted, { method: 'set_editor_text', text });
      },
      pasteToEditor: (text: string) => {
        this.broadcastUi(hosted, { method: 'set_editor_text', text });
      },
      // No editor exists here to read back from; an empty answer is the truth.
      getEditorText: () => '',
      onTerminalInput: () => (): void => terminalOnly(),
      addAutocompleteProvider: terminalOnly,
      setWorkingMessage: terminalOnly,
      setWorkingVisible: terminalOnly,
      setWorkingIndicator: terminalOnly,
      setHiddenThinkingLabel: terminalOnly,
      setFooter: terminalOnly,
      setHeader: terminalOnly,
      setTitle: terminalOnly,
      setEditorComponent: terminalOnly,
      custom: () => Promise.reject(new Error('this host has no terminal UI')),
    } as unknown as ExtensionUIContext;
  }

  /**
   * Broadcast one dialog request and await the browser's answer.
   *
   * The timeout is mirrored here rather than trusted to the client: an extension
   * awaiting a dialog must not hang the agent when no browser is listening.
   */
  private requestDialog(
    hosted: HostedSession,
    method: 'select' | 'confirm' | 'input' | 'editor',
    payload: Partial<PiExtensionUiRequest>,
    options: { signal?: AbortSignal; timeout?: number } | undefined,
    fallback?: string | boolean,
  ): Promise<string | boolean | undefined> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const settle = (value: string | boolean | undefined): void => {
        if (settled) return;
        settled = true;
        hosted.pendingDialogs.delete(id);
        if (timer !== null) clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => settle(fallback);

      if (options?.timeout !== undefined && options.timeout > 0) {
        timer = setTimeout(() => settle(fallback), options.timeout);
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.signal?.aborted === true) {
        settle(fallback);
        return;
      }

      hosted.pendingDialogs.set(id, (response) => {
        if (response.cancelled === true) return settle(fallback);
        if (method === 'confirm') return settle(response.confirmed === true);
        settle(response.value);
      });

      this.broadcast(hosted, {
        t: 'pi',
        event: {
          type: 'extension_ui_request',
          id,
          method,
          ...payload,
          ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
        } as unknown as PiEvent,
      });
    });
  }

  /** Fire-and-forget UI updates: status, widget, notification, editor text. */
  private broadcastUi(hosted: HostedSession, payload: Partial<PiExtensionUiRequest>): void {
    this.broadcast(hosted, {
      t: 'pi',
      event: {
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        ...payload,
      } as unknown as PiEvent,
    });
  }

  /** Answer a pending dialog; an unknown id is ignored rather than an error. */
  respondToDialog(id: string, response: PiExtensionUiResponse): boolean {
    for (const hosted of this.sessions.values()) {
      const resolver = hosted.pendingDialogs.get(id);
      if (resolver !== undefined) {
        resolver(response);
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------- event fan-out */

  private onEvent(hosted: HostedSession, event: AgentSessionEvent): void {
    hosted.lastSeen = Date.now();
    if (event.type === 'agent_start') hosted.streaming = true;
    if (event.type === 'agent_settled' || event.type === 'agent_end') hosted.streaming = false;
    // SDK events are a superset of the RPC-mode union the client models; the
    // transcript reducer ignores the extras (entry_appended, …) safely.
    const source = this.claimPromptSource(hosted, event);
    this.broadcast(hosted, {
      t: 'pi',
      event: event as unknown as PiEvent,
      ...(source === undefined ? {} : { source }),
    });
  }

  /**
   * Correlate a durable user message with the prompt command that produced it.
   *
   * pi has no requestId on its own events, so the host is the adapter: the
   * oldest still-pending requestId claims the next user message, and the frame
   * carries it as `source.requestId` for the browser's echo retire.
   */
  private claimPromptSource(hosted: HostedSession, event: AgentSessionEvent): { requestId: string } | undefined {
    if (event.type !== 'message_start') return undefined;
    const message = (event as { message?: { role?: unknown } }).message;
    if (message === undefined || message.role !== 'user') return undefined;
    const requestId = hosted.promptRequests.consumePending();
    return requestId === null ? undefined : { requestId };
  }

  private broadcast(hosted: HostedSession, frame: ServerFrame): void {
    // Everything a subscriber can see passes through the journal first, so a
    // reconnecting client's replay and a live client's stream share one order.
    const entry = hosted.journal.append(frame);
    for (const subscriber of hosted.subscribers) subscriber.frame(entry);
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
    // An extension awaiting a dialog would otherwise hang forever: answer every
    // pending request as a dismissal, which is what a closed window means.
    for (const resolve of session.pendingDialogs.values()) {
      resolve({ type: 'extension_ui_response', id: '', cancelled: true });
    }
    session.pendingDialogs.clear();
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
    if (!hosted) return fail(command.type, 'unknown session', command.id);
    if (!hosted.alive) return fail(command.type, 'session is not running', command.id);
    hosted.lastSeen = Date.now();

    // Business-level idempotency, independent of the HTTP transport: a prompt
    // the host has already seen (pending or settled) is acknowledged without
    // being submitted to pi again — a retried submit must not double-send.
    const requestId = command.id;
    const idempotent = requestId !== undefined && PROMPT_COMMANDS.has(command.type);
    if (idempotent && !hosted.promptRequests.add(requestId)) {
      return ok(command.type, { accepted: true, deduplicated: true }, requestId);
    }

    try {
      const response = await this.dispatch(hosted, command);
      return command.id === undefined ? response : { ...response, id: command.id };
    } catch (error) {
      if (idempotent && requestId !== undefined) hosted.promptRequests.forget(requestId);
      return fail(command.type, errorText(error), command.id);
    }
  }

  private async dispatch(hosted: HostedSession, command: PiCommandEnvelope): Promise<PiRpcResponse> {
    const session = hosted.session;

    // Every case returns; errors propagate to command(), which releases the
    // requestId and echoes the correlation id on the response.
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
        // A rejected preflight never becomes a durable user message: release
        // the requestId so retrying the same submit re-attempts it.
        if (!success && command.id !== undefined) hosted.promptRequests.forget(command.id);
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
      case 'get_messages': {
        const messages = session.messages;
        // Captured after the list was read: pi appends to its log and emits
        // the event in the same synchronous turn, so everything the snapshot
        // reflects is already journaled and covered by `throughSeq`.
        const throughSeq = hosted.journal.latestSeq;
        return {
          type: 'response',
          command: command.type,
          success: true,
          data: { messages, throughSeq },
        };
      }
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
      case 'get_tools': {
        // pi-web's shape: every tool, each flagged with whether it is active, so
        // a panel can show what a preset turned off.
        const active = new Set(hosted.session.getActiveToolNames());
        return {
          type: 'response',
          command: command.type,
          success: true,
          data: {
            tools: hosted.session.getAllTools().map((tool) => ({
              name: tool.name,
              description: tool.description,
              active: active.has(tool.name),
            })),
            selection: hosted.toolSelection ?? hosted.session.getActiveToolNames(),
          },
        };
      }
      case 'set_tools': {
        const requested = validateToolSelection((command as unknown as { toolNames?: unknown }).toolNames);
        if (requested === undefined) {
          return fail(command.type, 'toolNames 必须是内置工具名数组');
        }
        this.setToolSelection(hosted, requested, { persist: true });
        return { type: 'response', command: command.type, success: true, data: { toolNames: requested } };
      }
      case 'get_commands':
        return {
          type: 'response',
          command: command.type,
          success: true,
          // The merged list: extension commands, prompt templates and skills.
          // pi built it while loading resources, and its runtime is the only
          // public accessor — the runner that assembles it is private to
          // `createAgentSession`.
          data: { commands: this.commandsOf(hosted) },
        };
      case 'extension_ui_response': {
        const answered = this.respondToDialog(command.id, {
          type: 'extension_ui_response',
          id: command.id,
          ...(command.value === undefined ? {} : { value: command.value }),
          ...(command.confirmed === undefined ? {} : { confirmed: command.confirmed }),
          ...(command.cancelled === undefined ? {} : { cancelled: command.cancelled }),
        });
        if (!answered) return fail(command.type, `no extension dialog is waiting on id ${command.id}`);
        return ok(command.type);
      }
      case 'set_auto_compaction':
      case 'set_auto_retry':
      case 'export_html':
      case 'bash':
      case 'abort_bash':
        return fail(command.type, `${command.type} is not supported by the SDK host yet`);
      default:
        return fail(command.type, `unknown command: ${(command as { type: string }).type}`);
    }
  }

  /**
   * The session's slash commands, as the browser's command menu needs them.
   *
   * Sending `/name args` as a prompt is enough to run one: `session.prompt`
   * dispatches extension commands and expands skill and prompt-template commands
   * by default, so this list only has to be accurate, not executable here.
   */
  private commandsOf(hosted: HostedSession): Array<{
    name: string;
    description?: string;
    source?: string;
  }> {
    try {
      const commands = hosted.extensionsResult.runtime.getCommands();
      return commands.map((entry) => ({
        name: entry.name,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.source === undefined ? {} : { source: entry.source }),
      }));
    } catch (error) {
      this.broadcastError(hosted, `无法读取斜杠命令列表：${errorText(error)}`);
      return [];
    }
  }

  private stateOf(hosted: HostedSession): PiSessionState {    const { session } = hosted;
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

  /**
   * Levels this session's model actually accepts.
   *
   * Mirrors pi's own `getSupportedThinkingLevels` (`pi-ai/dist/models.js`),
   * because it is the same function `session.setThinkingLevel` clamps against:
   * a model that does not reason supports `off` alone, and a model that does
   * supports the extended list minus every level its `thinkingLevelMap` pins to
   * `null` — with `xhigh`/`max` counted as supported only when the map names
   * them explicitly. Reporting the global vocabulary here (as this used to) told
   * the browser about levels every request would be clamped away from.
   */
  private thinkingLevels(hosted: HostedSession): ModelThinkingLevel[] {
    const model = hosted.session.model as
      | { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }
      | undefined;
    if (model?.reasoning !== true) return ['off'];
    const levels = ([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ] as const).filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (level === 'xhigh' || level === 'max') return mapped !== undefined;
      return true;
    });
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

    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      ...(model ? { model } : {}),
      thinkingLevel: thinking,
      modelRuntime: runtime,
      sessionManager: SessionManager.create(cwd),
    });
    if (hosted.sessionName) session.setSessionName(hosted.sessionName);

    hosted.session = session;
    hosted.extensionsResult = extensionsResult;
    hosted.sessionFile = session.sessionFile ?? null;
    hosted.streaming = false;
    hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
    await this.bindExtensions(session, hosted);
  }
}

function ok(command: string, data?: unknown, id?: string): PiRpcResponse {
  return {
    type: 'response',
    ...(id === undefined ? {} : { id }),
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  };
}

function fail(command: string, error: string, id?: string): PiRpcResponse {
  return {
    type: 'response',
    ...(id === undefined ? {} : { id }),
    command,
    success: false,
    error,
  };
}
