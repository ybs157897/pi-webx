/**
 * Bridges one pi session to React state.
 *
 * Owns the SSE subscription, keeps the transcript in sync (full snapshot on
 * connect/reconnect, incremental folding afterwards), and surfaces the parts of
 * the protocol that are not transcript content: extension dialogs, statuses,
 * widgets, notifications and the composer prefill channel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api';
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
} from '../shared/protocol';
import { PI_DIALOG_METHODS } from '../shared/protocol';
import { createTranscript, type TranscriptState } from '../shared/transcript';
import { applyPiEvent, applySnapshot } from './transcript';

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'exited' | 'error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

export interface PiSessionApi {
  status: ConnectionStatus;
  error: string | null;
  sessionFile: string | null;
  cwd: string | null;
  pid: number | null;

  transcript: TranscriptState;
  piState: PiSessionState | null;
  stats: PiSessionStats | null;
  models: PiModel[];
  thinkingLevels: PiThinkingLevel[];
  commands: PiSlashCommand[];
  /** Every tool the session has, with its active flag (dsh/pi-web's tools panel). */
  tools: PiToolInfo[];
  /** The builtin selection behind the active set; `null` before it is known. */
  toolSelection: string[] | null;

  dialogs: PendingDialog[];
  notifications: AppNotification[];
  statuses: Record<string, string>;
  widgets: Record<string, WidgetState>;
  /** text pushed by an extension via `set_editor_text`; consumed once by the composer */
  editorText: string | null;

  prompt(text: string, options?: { images?: PiImage[]; behavior?: 'steer' | 'followUp' }): Promise<PiRpcResponse>;
  abort(): Promise<void>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  compact(): Promise<void>;
  newSession(): Promise<void>;
  refreshState(): Promise<void>;
  /** Switches the model and re-reads session state so the UI reflects it at once. */
  setModel(provider: string, modelId: string): Promise<PiRpcResponse>;
  /**
   * `null` asks for the model's own default (dsh's `Default` entry). pi has no
   * "unset" on a running session, so the caller records the cleared default
   * instead of sending a command.
   */
  setThinkingLevel(level: PiThinkingLevel | null): Promise<PiRpcResponse>;
  /**
   * Replace the session's tool selection with these builtin names. The host merges
   * the extension tools back in, so this can only narrow the builtin set.
   */
  setTools(toolNames: string[]): Promise<PiRpcResponse>;
  renameSession(name: string): Promise<PiRpcResponse>;
  exportHtml(): Promise<{ path: string } | null>;
  setAutoCompaction(enabled: boolean): Promise<PiRpcResponse>;
  setAutoRetry(enabled: boolean): Promise<PiRpcResponse>;
  setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<PiRpcResponse>;
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<PiRpcResponse>;
  send(command: PiCommandEnvelope): Promise<PiRpcResponse>;
  /** Sends to an arbitrary session, for list actions on non-active sessions. */
  sendTo(sessionId: string, command: PiCommandEnvelope): Promise<PiRpcResponse>;
  /**
   * Surface an application-level message through the same stack the protocol
   * notifications use. Needed by callers that perform work pi does not know
   * about — e.g. saving the deployment default, which can fail without
   * invalidating the session's own selection.
   */
  notify(level: AppNotification['level'], text: string, detail?: string): void;
  respondToDialog(id: string, body: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void>;
  dismissNotification(id: string): void;
  consumeEditorText(): void;
}

const NOTIFICATION_LIMIT = 40;

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

export function usePiSession(sessionId: string | null): PiSessionApi {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sessionFile, setSessionFile] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [pid, setPid] = useState<number | null>(null);

  const [transcript, setTranscript] = useState<TranscriptState>(createTranscript);
  const [piState, setPiState] = useState<PiSessionState | null>(null);
  const [stats, setStats] = useState<PiSessionStats | null>(null);
  const [models, setModels] = useState<PiModel[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<PiThinkingLevel[]>([]);
  const [commands, setCommands] = useState<PiSlashCommand[]>([]);
  const [tools, setToolsState] = useState<PiToolInfo[]>([]);
  const [toolSelection, setToolSelection] = useState<string[] | null>(null);

  const [dialogs, setDialogs] = useState<PendingDialog[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [widgets, setWidgets] = useState<Record<string, WidgetState>>({});
  const [editorText, setEditorText] = useState<string | null>(null);

  const dialogTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const pushNotification = useCallback(
    (level: AppNotification['level'], text: string, detail?: string) => {
      notificationSeq += 1;
      const entry: AppNotification = {
        id: `n-${notificationSeq}`,
        level,
        text,
        at: Date.now(),
        ...(detail === undefined ? {} : { detail }),
      };
      setNotifications((prev) => {
        const next = [...prev, entry];
        return next.length > NOTIFICATION_LIMIT ? next.slice(next.length - NOTIFICATION_LIMIT) : next;
      });
    },
    [],
  );

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const consumeEditorText = useCallback(() => setEditorText(null), []);

  /** Send a command straight through; the raw pi response is returned. */
  const send = useCallback(
    async (command: PiCommandEnvelope): Promise<PiRpcResponse> => {
      if (!sessionId) {
        return {
          type: 'response',
          command: command.type,
          success: false,
          error: 'no active session',
        };
      }
      return api.sendCommand(sessionId, command);
    },
    [sessionId],
  );

  const sendTo = useCallback(
    (targetSessionId: string, command: PiCommandEnvelope): Promise<PiRpcResponse> =>
      api.sendCommand(targetSessionId, command),
    [],
  );

  /** Send a command and surface a failure as a notification + returned null. */
  const run = useCallback(
    async (command: PiCommandEnvelope): Promise<PiRpcResponse | null> => {
      const response = await send(command);
      if (!response.success) {
        pushNotification('error', `命令 ${response.command} 失败`, response.error);
        return null;
      }
      return response;
    },
    [send, pushNotification],
  );

  const refreshState = useCallback(async () => {
    if (!sessionId) return;
    const [state, sessionStats, availableModels, levels, commandList, toolList] = await Promise.all([
      send({ type: 'get_state' }),
      send({ type: 'get_session_stats' }),
      send({ type: 'get_available_models' }),
      send({ type: 'get_available_thinking_levels' }),
      send({ type: 'get_commands' }),
      send({ type: 'get_tools' }),
    ]);

    const stateData = pickRecord<PiSessionState>(state.data);
    if (stateData) setPiState(stateData);

    const statsData = pickRecord<PiSessionStats>(sessionStats.data);
    if (statsData) setStats(statsData);

    const modelList = pickArray<PiModel>(availableModels.data, 'models');
    if (modelList.length > 0) setModels(modelList);

    const levelList = pickArray<PiThinkingLevel>(levels.data, 'levels');
    if (levelList.length > 0) setThinkingLevels(levelList);

    const commandEntries = pickArray<PiSlashCommand>(commandList.data, 'commands');
    if (commandEntries.length > 0) setCommands(commandEntries);

    const toolsData = pickRecord<PiToolsPayload>(toolList.data);
    if (toolsData !== null) {
      setToolsState(pickArray<PiToolInfo>(toolsData, 'tools'));
      if (Array.isArray(toolsData.selection)) setToolSelection(toolsData.selection);
    }
  }, [send, sessionId]);

  // pi acknowledges a model switch long before it reports the new state, so the
  // header would otherwise keep showing the previous model until the next turn.
  const setModel = useCallback(
    async (provider: string, modelId: string) => {
      const response = await send({ type: 'set_model', provider, modelId });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  const setThinkingLevel = useCallback(
    async (level: PiThinkingLevel | null) => {
      if (level === null) {
        // Nothing to send: pi has no "unset". The caller clears the remembered
        // default; a running session keeps the level it started with.
        return { type: 'response', command: 'set_thinking_level', success: true } as PiRpcResponse;
      }
      const response = await send({ type: 'set_thinking_level', level });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  const setTools = useCallback(
    async (toolNames: string[]) => {
      const response = await send({ type: 'set_tools', toolNames });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  const renameSession = useCallback(
    async (name: string) => {
      const response = await send({ type: 'set_session_name', name });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  const exportHtml = useCallback(async () => {
    const response = await send({ type: 'export_html' });
    if (!response.success) return null;
    const data = pickRecord<{ path?: string }>(response.data);
    return data?.path ? { path: data.path } : null;
  }, [send]);

  /** Every toggle below changes pi's session config, so state is re-read after. */
  const setAutoCompaction = useCallback(
    async (enabled: boolean) => {
      const response = await send({ type: 'set_auto_compaction', enabled });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  const setAutoRetry = useCallback(
    async (enabled: boolean) => {
      const response = await send({ type: 'set_auto_retry', enabled });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  const setSteeringMode = useCallback(
    async (mode: 'all' | 'one-at-a-time') => {
      const response = await send({ type: 'set_steering_mode', mode });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  const setFollowUpMode = useCallback(
    async (mode: 'all' | 'one-at-a-time') => {
      const response = await send({ type: 'set_follow_up_mode', mode });
      if (response.success) await refreshState();
      return response;
    },
    [send, refreshState],
  );

  /* ------------------------------------------------------------ SSE plumbing */

  useEffect(() => {
    if (!sessionId) {
      setStatus('idle');
      return;
    }

    setStatus('connecting');
    setError(null);

    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);

    const handleFrame = (frame: ServerFrame) => {
      switch (frame.t) {
        case 'hello': {
          setStatus('live');
          setError(null);
          setSessionFile(frame.sessionFile);
          setCwd(frame.cwd);
          setPid(frame.pid);
          // Full resync: a reconnect may have missed events, and a fresh mount
          // needs the backlog. Streaming state is re-derived from later events.
          void (async () => {
            const response = await send({ type: 'get_messages' });
            if (response.success) {
              const messages = pickArray<PiAgentMessage>(response.data, 'messages');
              setTranscript((prev) => applySnapshot(prev, messages));
            }
            await refreshState();
          })();
          break;
        }

        case 'pi': {
          const event = frame.event;
          if (event.type === 'extension_ui_request') {
            const request = event;
            switch (request.method) {
              case 'notify':
                pushNotification(
                  request.notifyType === 'warning' || request.notifyType === 'error'
                    ? request.notifyType
                    : 'info',
                  request.message ?? '',
                );
                break;
              case 'setStatus':
                if (request.statusKey) {
                  const key = request.statusKey;
                  const text = request.statusText;
                  setStatuses((prev) => {
                    if (text === undefined) {
                      const next = { ...prev };
                      delete next[key];
                      return next;
                    }
                    return { ...prev, [key]: text };
                  });
                }
                break;
              case 'setWidget':
                if (request.widgetKey) {
                  const key = request.widgetKey;
                  const lines = request.widgetLines;
                  setWidgets((prev) => {
                    if (!lines || lines.length === 0) {
                      const next = { ...prev };
                      delete next[key];
                      return next;
                    }
                    return {
                      ...prev,
                      [key]: { lines, placement: request.widgetPlacement ?? 'aboveEditor' },
                    };
                  });
                }
                break;
              case 'set_editor_text':
                setEditorText(request.text ?? '');
                break;
              default:
                break;
            }

            if (isDialogRequest(request)) {
              setDialogs((prev) =>
                prev.some((entry) => entry.request.id === request.id)
                  ? prev
                  : [...prev, { request, at: Date.now() }],
              );
              // pi auto-resolves on its own timeout; retire the UI to match it.
              if (typeof request.timeout === 'number' && request.timeout > 0) {
                const existing = dialogTimers.current.get(request.id);
                if (existing) clearTimeout(existing);
                const timer = setTimeout(() => {
                  dialogTimers.current.delete(request.id);
                  setDialogs((prev) => prev.filter((entry) => entry.request.id !== request.id));
                }, request.timeout + 1_000);
                dialogTimers.current.set(request.id, timer);
              }
            }
          }

          setTranscript((prev) => applyPiEvent(prev, event));

          if (event.type === 'agent_settled' || event.type === 'agent_end') {
            void (async () => {
              const response = await send({ type: 'get_session_stats' });
              const data = pickRecord<PiSessionStats>(response.data);
              if (data) setStats(data);
            })();
          }
          break;
        }

        case 'stderr': {
          const chunk = frame.chunk.trim();
          if (chunk.length > 0) setError(chunk.slice(0, 2_000));
          break;
        }

        case 'error': {
          setError(frame.message);
          pushNotification('error', 'pi 进程错误', frame.message);
          break;
        }

        case 'exit': {
          setStatus('exited');
          const reason =
            frame.code === null ? `被信号 ${frame.signal ?? '未知'} 终止` : `退出码 ${frame.code}`;
          pushNotification('warning', 'pi 进程已结束', reason);
          break;
        }

        case 'stdout':
          break;

        default:
          break;
      }
    };

    source.onmessage = (message) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(message.data as string) as ServerFrame;
      } catch {
        return;
      }
      handleFrame(frame);
    };

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setStatus('error');
        setError('与 pi 桥接服务的连接已断开');
      } else {
        setStatus('reconnecting');
      }
    };

    return () => {
      source.close();
    };
  }, [sessionId, send, refreshState, pushNotification]);

  /* Clear per-session transient state when switching sessions. */
  useEffect(() => {
    setTranscript(createTranscript());
    setPiState(null);
    setStats(null);
    setDialogs([]);
    setStatuses({});
    setWidgets({});
    setEditorText(null);
    setError(null);
    for (const timer of dialogTimers.current.values()) clearTimeout(timer);
    dialogTimers.current.clear();
  }, [sessionId]);

  /* ---------------------------------------------------------------- actions */

  const prompt = useCallback<PiSessionApi['prompt']>(
    async (text, options) => {
      const body: PiCommandEnvelope = {
        type: 'prompt',
        message: text,
        ...(options?.images && options.images.length > 0 ? { images: options.images } : {}),
        ...(options?.behavior ? { streamingBehavior: options.behavior } : {}),
      };
      return send(body);
    },
    [send],
  );

  const abort = useCallback(async () => {
    await send({ type: 'abort' });
  }, [send]);

  const clearQueue = useCallback(async () => {
    const response = await send({ type: 'clear_queue' });
    const data = pickRecord<{ steering?: string[]; followUp?: string[] }>(response.data);
    return { steering: data?.steering ?? [], followUp: data?.followUp ?? [] };
  }, [send]);

  const compact = useCallback(async () => {
    await run({ type: 'compact' });
  }, [run]);

  const newSession = useCallback(async () => {
    await run({ type: 'new_session' });
    await refreshState();
  }, [run, refreshState]);

  const respondToDialog = useCallback<PiSessionApi['respondToDialog']>(
    async (id, body) => {
      const timer = dialogTimers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        dialogTimers.current.delete(id);
      }
      setDialogs((prev) => prev.filter((entry) => entry.request.id !== id));
      await send({ type: 'extension_ui_response', id, ...body });
    },
    [send],
  );

  return useMemo<PiSessionApi>(
    () => ({
      status,
      error,
      sessionFile,
      cwd,
      pid,
      transcript,
      piState,
      stats,
      models,
      thinkingLevels,
      commands,
      tools,
      toolSelection,
      dialogs,
      notifications,
      statuses,
      widgets,
      editorText,
      prompt,
      abort,
      clearQueue,
      compact,
      newSession,
      refreshState,
      setModel,
      setThinkingLevel,
      setTools,
      renameSession,
      exportHtml,
      setAutoCompaction,
      setAutoRetry,
      setSteeringMode,
      setFollowUpMode,
      send,
      sendTo,
      notify: pushNotification,
      respondToDialog,
      dismissNotification,
      consumeEditorText,
    }),
    [
      status,
      error,
      sessionFile,
      cwd,
      pid,
      transcript,
      piState,
      stats,
      models,
      thinkingLevels,
      commands,
      tools,
      toolSelection,
      dialogs,
      notifications,
      statuses,
      widgets,
      editorText,
      prompt,
      abort,
      clearQueue,
      compact,
      newSession,
      refreshState,
      setModel,
      setThinkingLevel,
      setTools,
      renameSession,
      exportHtml,
      setAutoCompaction,
      setAutoRetry,
      setSteeringMode,
      setFollowUpMode,
      send,
      sendTo,
      pushNotification,
      respondToDialog,
      dismissNotification,
      consumeEditorText,
    ],
  );
}

/* Re-exported so components can share the transcript type without a deep import. */
export type { TranscriptState };
export { applyPiEvent, applySnapshot };
