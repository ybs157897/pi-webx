/**
 * PiSessionClient: the framework-agnostic session object, dsh's
 * session-controller client half.
 *
 * One instance owns one hosted session's entire browser-side state — the
 * transcript projection, session state, dialogs, notifications, widgets — and
 * exposes `subscribe`/`getSnapshot` so React mounts it through
 * `useSyncExternalStore` (see `usePiSession.ts`, which is only an adapter).
 *
 * Recovery semantics, all seq-driven against the server's journal:
 *
 *   - open: subscribe → buffer events → `get_messages` snapshot (carries
 *     `throughSeq`) → apply buffered frames with `seq > throughSeq`
 *   - brief drop: the connection controller re-subscribes with the last
 *     applied seq and the server replays the journal tail
 *   - gap or restart: `resync-required` → full snapshot rebuild
 *
 * Optimistic submits: `prompt` mints a requestId, shows an echo at once, and
 * the echo is retired by the frame whose `source.requestId` matches — the
 * business-id dedup lives server-side and is a different concern from this
 * display projection.
 */

import { api } from './api';
import type { ConnectionController } from './connection';
import type {
  PiAgentMessage,
  PiCommandEnvelope,
  PiExtensionUiRequest,
  PiImage,
  PiModel,
  PiRpcResponse,
  PiSessionState,
  PiSessionStats,
  PiSlashCommand,
  PiThinkingLevel,
  PiToolInfo,
  PiToolsPayload,
  ServerFrame,
  WsServerMessage,
} from '../shared/protocol';
import { PI_DIALOG_METHODS, PI_THINKING_LEVELS } from '../shared/protocol';
import type { TranscriptState } from '../shared/transcript';
import { addEcho, applyPiEvent, applySnapshot, retireEcho } from './transcript';
import { createTranscript } from '../shared/transcript';

export type SessionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'exited' | 'error';

export interface AppNotification {
  id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  detail?: string;
  at: number;
}

export interface PendingDialog {
  request: PiExtensionUiRequest;
  at: number;
}

export interface WidgetState {
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

export interface SessionSnapshot {
  status: SessionStatus;
  error: string | null;
  sessionFile: string | null;
  cwd: string | null;

  transcript: TranscriptState;
  piState: PiSessionState | null;
  stats: PiSessionStats | null;
  models: PiModel[];
  thinkingLevels: PiThinkingLevel[];
  commands: PiSlashCommand[];
  tools: PiToolInfo[];
  toolSelection: string[] | null;

  dialogs: PendingDialog[];
  notifications: AppNotification[];
  statuses: Record<string, string>;
  widgets: Record<string, WidgetState>;
  editorText: string | null;
}

const NOTIFICATION_LIMIT = 40;
/** Frames buffered while the opening snapshot is in flight; beyond this, resync. */
const BUFFER_LIMIT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickArray<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (isRecord(data) && Array.isArray(data[key])) return data[key] as T[];
  return [];
}

function pickRecord<T>(data: unknown): T | null {
  return isRecord(data) ? (data as T) : null;
}

function isDialogRequest(request: PiExtensionUiRequest): boolean {
  return (PI_DIALOG_METHODS as readonly string[]).includes(request.method);
}

let notificationSeq = 0;

function initialSnapshot(status: SessionStatus): SessionSnapshot {
  return {
    status,
    error: null,
    sessionFile: null,
    cwd: null,
    transcript: createTranscript(),
    piState: null,
    stats: null,
    models: [],
    thinkingLevels: [],
    commands: [],
    tools: [],
    toolSelection: null,
    dialogs: [],
    notifications: [],
    statuses: {},
    widgets: {},
    editorText: null,
  };
}

export class PiSessionClient {
  readonly sessionId: string;
  private readonly connection: ConnectionController;
  private snapshot: SessionSnapshot = initialSnapshot('connecting');
  private appliedSeq = 0;
  private hydrated = false;
  private closed = false;
  private disposed = false;
  private buffer: Array<{ seq: number; frame: ServerFrame }> = [];
  private readonly pendingSubmissions = new Map<string, { requestId: string; text: string; imageCount: number; images?: PiImage[] }>();
  private readonly dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private detachConnection: (() => void) | null = null;
  private detachStatus: (() => void) | null = null;

  constructor(sessionId: string, connection: ConnectionController) {
    this.sessionId = sessionId;
    this.connection = connection;
  }

  /* ------------------------------------------------------------ lifecycle */

  open(): void {
    this.detachConnection = this.connection.onMessage((message) => this.onWireMessage(message));
    // The wire status is shared across sessions; only the drop matters here —
    // coming back is confirmed per session by `subscribed`, not by the socket.
    this.detachStatus = this.connection.onStatus((wire) => {
      if (this.disposed || this.closed) return;
      if (wire === 'offline' || wire === 'reconnecting') this.update({ status: 'reconnecting' });
    });
    // The seq provider answers "what may the server skip": until the opening
    // snapshot has landed, undefined — a fresh subscribe with no replay.
    this.connection.attach(this.sessionId, () => (this.hydrated ? this.appliedSeq : undefined));
  }

  close(): void {
    this.disposed = true;
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    this.detachConnection?.();
    this.detachConnection = null;
    this.detachStatus?.();
    this.detachStatus = null;
    this.connection.detach(this.sessionId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  private update(partial: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of [...this.listeners]) listener();
  }

  private pushNotification(level: AppNotification['level'], text: string, detail?: string): void {
    notificationSeq += 1;
    const entry: AppNotification = {
      id: `n-${notificationSeq}`,
      level,
      text,
      at: Date.now(),
      ...(detail === undefined ? {} : { detail }),
    };
    const next = [...this.snapshot.notifications, entry];
    this.update({
      notifications:
        next.length > NOTIFICATION_LIMIT ? next.slice(next.length - NOTIFICATION_LIMIT) : next,
    });
  }

  dismissNotification = (id: string): void => {
    this.update({ notifications: this.snapshot.notifications.filter((entry) => entry.id !== id) });
  };

  consumeEditorText = (): void => {
    this.update({ editorText: null });
  };

  /** Surface an application-level message pi does not know about. */
  notify = (level: AppNotification['level'], text: string, detail?: string): void => {
    this.pushNotification(level, text, detail);
  };

  /* ----------------------------------------------------------- wire events */

  private onWireMessage(message: WsServerMessage): void {
    if (this.disposed) return;
    switch (message.t) {
      case 'subscribed': {
        if (message.sessionId !== this.sessionId) return;
        this.update({
          status: this.closed ? 'exited' : 'live',
          sessionFile: message.sessionFile,
          cwd: message.cwd,
          error: null,
        });
        if (!this.hydrated) {
          void this.fetchSnapshot();
        } else {
          // Reconnect with a valid seq: the journal tail covers the gap, but
          // session-level state (model, streaming) is cheaper to re-read than
          // to infer — same as the old hello path.
          void this.refreshState();
        }
        break;
      }
      case 'event': {
        if (message.sessionId !== this.sessionId) return;
        this.onEvent(message.seq, message.frame);
        break;
      }
      case 'resync-required': {
        if (message.sessionId !== this.sessionId) return;
        // The journal cannot bridge from where we are: rebuild from the
        // authoritative message list instead of guessing.
        void this.fetchSnapshot();
        break;
      }
      case 'closed': {
        if (message.sessionId !== this.sessionId) return;
        this.closed = true;
        this.update({ status: 'exited' });
        this.pushNotification('warning', '会话已结束', '该会话已不在服务端运行（可能被回收）');
        break;
      }
      case 'error': {
        this.update({ error: message.message });
        this.pushNotification('error', '事件连接错误', message.message);
        break;
      }
      default:
        break;
    }
  }

  private onEvent(seq: number, frame: ServerFrame): void {
    if (!this.hydrated) {
      this.buffer.push({ seq, frame });
      if (this.buffer.length > BUFFER_LIMIT) {
        // A snapshot that never lands: stop buffering and rebuild.
        this.buffer = [];
        void this.fetchSnapshot();
      }
      return;
    }
    if (seq <= this.appliedSeq) return; // replayed duplicate or stale reorder
    this.appliedSeq = seq;
    this.applyFrame(frame);
  }

  /** Side channels + transcript projection for one journaled frame. */
  private applyFrame(frame: ServerFrame): void {
    if (frame.t === 'error') {
      this.update({ error: frame.message });
      this.pushNotification('error', 'pi 进程错误', frame.message);
      return;
    }
    if (frame.t === 'exit') {
      this.closed = true;
      const reason =
        frame.code === null ? `被信号 ${frame.signal ?? '未知'} 终止` : `退出码 ${frame.code}`;
      this.update({ status: 'exited' });
      this.pushNotification('warning', 'pi 进程已结束', reason);
      return;
    }

    const event = frame.event;
    let transcript = this.snapshot.transcript;

    // Retire the optimistic echo in the same update that appends the durable
    // user message, so exactly one of the two is ever on screen.
    const requestId = frame.source?.requestId;
    if (requestId !== undefined) {
      transcript = retireEcho(transcript, requestId);
      this.pendingSubmissions.delete(requestId);
    }

    if (event.type === 'extension_ui_request') {
      this.handleExtensionUi(event);
    }

    // The session's own state, not the transcript's: a level changed by an
    // extension or a slash command would otherwise only show up on a reload.
    if (event.type === 'thinking_level_changed' && PI_THINKING_LEVELS.includes(event.level) && this.snapshot.piState) {
      this.update({ piState: { ...this.snapshot.piState, thinkingLevel: event.level } });
    }

    transcript = applyPiEvent(transcript, event);
    this.update({ transcript });

    if (event.type === 'agent_settled' || event.type === 'agent_end') {
      void this.send({ type: 'get_session_stats' }).then((response) => {
        const data = pickRecord<PiSessionStats>(response.data);
        if (data && !this.disposed) this.update({ stats: data });
      });
    }
  }

  private handleExtensionUi(request: PiExtensionUiRequest): void {
    switch (request.method) {
      case 'notify':
        this.pushNotification(
          request.notifyType === 'warning' || request.notifyType === 'error'
            ? request.notifyType
            : 'info',
          request.message ?? '',
        );
        break;
      case 'setStatus': {
        if (request.statusKey) {
          const key = request.statusKey;
          const text = request.statusText;
          const statuses = { ...this.snapshot.statuses };
          if (text === undefined) delete statuses[key];
          else statuses[key] = text;
          this.update({ statuses });
        }
        break;
      }
      case 'setWidget': {
        if (request.widgetKey) {
          const key = request.widgetKey;
          const lines = request.widgetLines;
          const widgets = { ...this.snapshot.widgets };
          if (!lines || lines.length === 0) delete widgets[key];
          else widgets[key] = { lines, placement: request.widgetPlacement ?? 'aboveEditor' };
          this.update({ widgets });
        }
        break;
      }
      case 'set_editor_text':
        this.update({ editorText: request.text ?? '' });
        break;
      default:
        break;
    }

    if (isDialogRequest(request)) {
      if (!this.snapshot.dialogs.some((entry) => entry.request.id === request.id)) {
        this.update({ dialogs: [...this.snapshot.dialogs, { request, at: Date.now() }] });
      }
      // pi auto-resolves on its own timeout; retire the UI to match it.
      if (typeof request.timeout === 'number' && request.timeout > 0) {
        const existing = this.dialogTimers.get(request.id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.dialogTimers.delete(request.id);
          this.update({ dialogs: this.snapshot.dialogs.filter((entry) => entry.request.id !== request.id) });
        }, request.timeout + 1_000);
        this.dialogTimers.set(request.id, timer);
      }
    }
  }

  /* -------------------------------------------------------------- recovery */

  private async fetchSnapshot(): Promise<void> {
    if (this.disposed || this.closed) return;
    const response = await this.send({ type: 'get_messages' });
    if (this.disposed) return;
    if (!response.success) {
      if (response.error?.includes('unknown session')) {
        this.closed = true;
        this.update({ status: 'exited' });
        return;
      }
      this.update({ error: response.error ?? 'get_messages failed' });
      return;
    }

    const data = pickRecord<{ messages?: unknown[]; throughSeq?: number }>(response.data);
    const messages = pickArray<PiAgentMessage>(data, 'messages');
    const throughSeq = typeof data?.throughSeq === 'number' ? data.throughSeq : 0;

    let transcript = applySnapshot(this.snapshot.transcript, messages);
    // A snapshot drops echoes by construction; prompts still in flight get
    // theirs back so the user's just-sent text does not blink away.
    for (const submission of this.pendingSubmissions.values()) {
      transcript = addEcho(transcript, submission);
    }

    // Frames that raced the snapshot: apply only what it does not cover.
    const buffered = this.buffer;
    this.buffer = [];
    this.hydrated = true;
    this.update({ transcript });

    let lastSeq = throughSeq;
    for (const { seq, frame } of buffered) {
      if (seq <= throughSeq) continue;
      this.appliedSeq = seq;
      lastSeq = seq;
      this.applyFrame(frame);
    }
    this.appliedSeq = Math.max(this.appliedSeq, lastSeq);
    void this.refreshState();
  }

  /* -------------------------------------------------------------- commands */

  send = async (command: PiCommandEnvelope): Promise<PiRpcResponse> => {
    return api.sendCommand(this.sessionId, command);
  };

  /** Send and surface a failure as a notification; null on failure. */
  private async run(command: PiCommandEnvelope): Promise<PiRpcResponse | null> {
    const response = await this.send(command);
    if (!response.success) {
      this.pushNotification('error', `命令 ${response.command} 失败`, response.error);
      return null;
    }
    return response;
  }

  prompt = async (
    text: string,
    options?: { images?: PiImage[]; behavior?: 'steer' | 'followUp' },
  ): Promise<PiRpcResponse> => {
    const requestId = crypto.randomUUID();
    const imageCount = options?.images?.length ?? 0;
    const submission = { requestId, text, imageCount, ...(options?.images ? { images: options.images } : {}) };
    this.pendingSubmissions.set(requestId, submission);
    this.update({ transcript: addEcho(this.snapshot.transcript, submission) });

    const response = await this.send({
      type: 'prompt',
      message: text,
      id: requestId,
      ...(options?.images && options.images.length > 0 ? { images: options.images } : {}),
      ...(options?.behavior ? { streamingBehavior: options.behavior } : {}),
    });

    if (!response.success && !this.disposed) {
      // The durable message will never come: drop the echo and say why.
      this.pendingSubmissions.delete(requestId);
      this.update({ transcript: retireEcho(this.snapshot.transcript, requestId) });
      this.pushNotification('error', '命令 prompt 失败', response.error);
    }
    return response;
  };

  abort = async (): Promise<void> => {
    await this.send({ type: 'abort' });
  };

  clearQueue = async (): Promise<{ steering: string[]; followUp: string[] }> => {
    const response = await this.send({ type: 'clear_queue' });
    const data = pickRecord<{ steering?: string[]; followUp?: string[] }>(response.data);
    return { steering: data?.steering ?? [], followUp: data?.followUp ?? [] };
  };

  compact = async (): Promise<void> => {
    await this.run({ type: 'compact' });
  };

  newSession = async (): Promise<void> => {
    await this.run({ type: 'new_session' });
    await this.refreshState();
  };

  refreshState = async (): Promise<void> => {
    if (this.disposed || this.closed) return;
    const [state, sessionStats, availableModels, levels, commandList, toolList] = await Promise.all([
      this.send({ type: 'get_state' }),
      this.send({ type: 'get_session_stats' }),
      this.send({ type: 'get_available_models' }),
      this.send({ type: 'get_available_thinking_levels' }),
      this.send({ type: 'get_commands' }),
      this.send({ type: 'get_tools' }),
    ]);
    if (this.disposed) return;

    const partial: Partial<SessionSnapshot> = {};
    const stateData = pickRecord<PiSessionState>(state.data);
    if (stateData) partial.piState = stateData;
    const statsData = pickRecord<PiSessionStats>(sessionStats.data);
    if (statsData) partial.stats = statsData;
    const modelList = pickArray<PiModel>(availableModels.data, 'models');
    if (modelList.length > 0) partial.models = modelList;
    const levelList = pickArray<PiThinkingLevel>(levels.data, 'levels');
    if (levelList.length > 0) partial.thinkingLevels = levelList;
    const commandEntries = pickArray<PiSlashCommand>(commandList.data, 'commands');
    if (commandEntries.length > 0) partial.commands = commandEntries;
    const toolsData = pickRecord<PiToolsPayload>(toolList.data);
    if (toolsData !== null) {
      partial.tools = pickArray<PiToolInfo>(toolsData, 'tools');
      if (Array.isArray(toolsData.selection)) partial.toolSelection = toolsData.selection;
    }
    if (Object.keys(partial).length > 0) this.update(partial);
  };

  /** Switch the model and re-read session state so the UI reflects it at once. */
  setModel = async (provider: string, modelId: string): Promise<PiRpcResponse> => {
    const response = await this.send({ type: 'set_model', provider, modelId });
    if (response.success) await this.refreshState();
    return response;
  };

  setThinkingLevel = async (level: PiThinkingLevel | null): Promise<PiRpcResponse> => {
    if (level === null) {
      // Nothing to send: pi has no "unset". The caller clears the remembered
      // default; a running session keeps the level it started with.
      return { type: 'response', command: 'set_thinking_level', success: true };
    }
    const response = await this.send({ type: 'set_thinking_level', level });
    if (response.success) await this.refreshState();
    return response;
  };

  setTools = async (toolNames: string[]): Promise<PiRpcResponse> => {
    const response = await this.send({ type: 'set_tools', toolNames });
    if (response.success) await this.refreshState();
    return response;
  };

  renameSession = async (name: string): Promise<PiRpcResponse> => {
    const response = await this.send({ type: 'set_session_name', name });
    if (response.success) await this.refreshState();
    return response;
  };

  exportHtml = async (): Promise<{ path: string } | null> => {
    const response = await this.send({ type: 'export_html' });
    if (!response.success) return null;
    const data = pickRecord<{ path?: string }>(response.data);
    return data?.path ? { path: data.path } : null;
  };

  setAutoCompaction = async (enabled: boolean): Promise<PiRpcResponse> => {
    const response = await this.send({ type: 'set_auto_compaction', enabled });
    if (response.success) await this.refreshState();
    return response;
  };

  setAutoRetry = async (enabled: boolean): Promise<PiRpcResponse> => {
    const response = await this.send({ type: 'set_auto_retry', enabled });
    if (response.success) await this.refreshState();
    return response;
  };

  setSteeringMode = async (mode: 'all' | 'one-at-a-time'): Promise<PiRpcResponse> => {
    const response = await this.send({ type: 'set_steering_mode', mode });
    if (response.success) await this.refreshState();
    return response;
  };

  setFollowUpMode = async (mode: 'all' | 'one-at-a-time'): Promise<PiRpcResponse> => {
    const response = await this.send({ type: 'set_follow_up_mode', mode });
    if (response.success) await this.refreshState();
    return response;
  };

  respondToDialog = async (
    id: string,
    body: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): Promise<void> => {
    const timer = this.dialogTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.dialogTimers.delete(id);
    }
    this.update({ dialogs: this.snapshot.dialogs.filter((entry) => entry.request.id !== id) });
    await this.send({ type: 'extension_ui_response', id, ...body });
  };
}

/** The no-session snapshot the React adapter serves before any client exists. */
export function idleSnapshot(): SessionSnapshot {
  return initialSnapshot('idle');
}
