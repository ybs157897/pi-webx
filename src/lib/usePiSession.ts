/**
 * React adapter over `PiSessionClient` — the dsh-style session object.
 *
 * This hook owns no session state of its own: it mounts the framework-agnostic
 * client through `useSyncExternalStore` and forwards its methods, so the wire
 * (one shared WebSocket), the recovery logic and the transcript projection all
 * stay testable outside React. Per-session state resets come for free: a new
 * sessionId builds a new client with a fresh snapshot.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { api } from './api';
import { sharedConnection } from './connection';
import {
  PiSessionClient,
  idleSnapshot,
  type AppNotification,
  type PendingDialog,
  type SessionStatus,
  type SessionSnapshot,
  type WidgetState,
} from './session-client';
import type {
  PiCommandEnvelope,
  PiImage,
  PiModel,
  PiRpcResponse,
  PiSessionState,
  PiSessionStats,
  PiSlashCommand,
  PiThinkingLevel,
  PiToolInfo,
} from '../shared/protocol';
import type { TranscriptState } from '../shared/transcript';

export type ConnectionStatus = SessionStatus;
export type { AppNotification, PendingDialog, WidgetState };

export interface PiSessionApi {
  status: ConnectionStatus;
  error: string | null;
  sessionFile: string | null;
  cwd: string | null;
  /** Always null in the SDK host (no subprocess); kept for interface stability. */
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

const IDLE_SNAPSHOT: SessionSnapshot = idleSnapshot();

function noSession(command: string): PiRpcResponse {
  return { type: 'response', command, success: false, error: 'no active session' };
}

/** Stable no-session api: every action answers the same failure the old hook did. */
const IDLE_API: PiSessionApi = {
  ...IDLE_SNAPSHOT,
  pid: null,
  prompt: (_text, _options) => Promise.resolve(noSession('prompt')),
  abort: () => Promise.resolve(),
  clearQueue: () => Promise.resolve({ steering: [], followUp: [] }),
  compact: () => Promise.resolve(),
  newSession: () => Promise.resolve(),
  refreshState: () => Promise.resolve(),
  setModel: (_provider, _modelId) => Promise.resolve(noSession('set_model')),
  setThinkingLevel: () => Promise.resolve(noSession('set_thinking_level')),
  setTools: () => Promise.resolve(noSession('set_tools')),
  renameSession: () => Promise.resolve(noSession('set_session_name')),
  exportHtml: () => Promise.resolve(null),
  setAutoCompaction: () => Promise.resolve(noSession('set_auto_compaction')),
  setAutoRetry: () => Promise.resolve(noSession('set_auto_retry')),
  setSteeringMode: () => Promise.resolve(noSession('set_steering_mode')),
  setFollowUpMode: () => Promise.resolve(noSession('set_follow_up_mode')),
  send: (command) => Promise.resolve(noSession(command.type)),
  sendTo: (sessionId, command) => api.sendCommand(sessionId, command),
  notify: () => {},
  respondToDialog: () => Promise.resolve(),
  dismissNotification: () => {},
  consumeEditorText: () => {},
};

export function usePiSession(sessionId: string | null): PiSessionApi {
  const [client, setClient] = useState<PiSessionClient | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setClient(null);
      return;
    }
    const next = new PiSessionClient(sessionId, sharedConnection);
    next.open();
    setClient(next);
    return () => {
      next.close();
    };
  }, [sessionId]);

  const subscribe = useCallback(
    (listener: () => void) => (client ? client.subscribe(listener) : () => {}),
    [client],
  );

  const getSnapshot = useCallback(
    () => (client ? client.getSnapshot() : IDLE_SNAPSHOT),
    [client],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo<PiSessionApi>(
    () =>
      client
        ? {
            ...state,
            pid: null,
            prompt: client.prompt,
            abort: client.abort,
            clearQueue: client.clearQueue,
            compact: client.compact,
            newSession: client.newSession,
            refreshState: client.refreshState,
            setModel: client.setModel,
            setThinkingLevel: client.setThinkingLevel,
            setTools: client.setTools,
            renameSession: client.renameSession,
            exportHtml: client.exportHtml,
            setAutoCompaction: client.setAutoCompaction,
            setAutoRetry: client.setAutoRetry,
            setSteeringMode: client.setSteeringMode,
            setFollowUpMode: client.setFollowUpMode,
            send: client.send,
            sendTo: (targetSessionId, command) => api.sendCommand(targetSessionId, command),
            notify: client.notify,
            respondToDialog: client.respondToDialog,
            dismissNotification: client.dismissNotification,
            consumeEditorText: client.consumeEditorText,
          }
        : IDLE_API,
    [client, state],
  );
}

/* Re-exported so components can share the transcript type without a deep import. */
export type { TranscriptState };
export { applyPiEvent, applySnapshot } from './transcript';
