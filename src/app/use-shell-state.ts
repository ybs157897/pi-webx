/**
 * Shell 的状态名册：启动偏好快照（`boot`）与全部 `useState` 原子。
 *
 * 这个 hook 只声明状态，不做别的事：原子由下面各个逻辑 hook 分头使用，所以集中
 * 声明一次，好让它们的相对次序（= React 的 hook 槽位）与原 `App.tsx` 里的 `Shell`
 * 完全一致 —— 拆出去的 hook 只是把同一串 hook 换了个归属，不重排。
 */
import { useMemo, useState } from 'react';

import type { ModelSelection } from '../components/ModelPicker';
import { loadPrefs } from '../lib/storage';
import type { ModelCatalog } from '../shared/model-catalog';
import type { ServerConfigResponse, SessionSummary, StoredSession } from '../shared/protocol';
import { readSidebarCollapsed } from './preferences';

/** 空会话的两种启动模式：单会话，或 Agent Team。 */
export type NewSessionMode = 'chat' | 'team';

export type ShellState = ReturnType<typeof useShellState>;

export function useShellState() {
  const boot = useMemo(() => loadPrefs(), []);
  const [config, setConfig] = useState<ServerConfigResponse | null>(null);
  const [cwd, setCwd] = useState(boot.cwd ?? '');
  const [sessionId, setSessionId] = useState<string | null>(
    // The address bar is this session's address: a reload, a bookmark, or a
    // restart of the bridge all land back on the same conversation.
    () => new URLSearchParams(window.location.search).get('session'),
  );
  const [newSessionMode, setNewSessionMode] = useState<NewSessionMode>(
    () => new URLSearchParams(window.location.search).get('team') === '1' ? 'team' : 'chat',
  );
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Whether the bridge's session list has been read at least once. */
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [narrowViewport, setNarrowViewport] = useState(
    () => window.matchMedia('(max-width: 640px)').matches,
  );
  const [mobileSidebarExpanded, setMobileSidebarExpanded] = useState(false);
  const [savedWorkspaces, setSavedWorkspaces] = useState<string[]>(() => loadPrefs().workspaces ?? []);
  /**
   * Workspaces the user removed from the sidebar's list. It is a *subtraction*
   * from the derived list below, not a second source of truth: without it a
   * removal is a no-op, because the current cwd, the server's suggestions, and
   * every workspace that has a session all re-add the row on the next render.
   */
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<string[]>(
    () => loadPrefs().hiddenWorkspaces ?? [],
  );
  const [allStored, setAllStored] = useState<StoredSession[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  /**
   * The session-independent model catalog. Held here rather than in the session
   * hook because it must outlive every session: a session is created by the
   * first message, so the picker needs a catalogue while none exists.
   */
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  /**
   * A selection made before any session existed. dsh calls the equivalent state
   * "pending": it is what a blank session reads even when the saved default has
   * not caught up yet, so picking a model and sending immediately cannot race
   * the settings write.
   */
  const [pendingModel, setPendingModel] = useState<ModelSelection | null>(null);

  return {
    boot,
    config, setConfig,
    cwd, setCwd,
    sessionId, setSessionId,
    newSessionMode, setNewSessionMode,
    sessions, setSessions,
    sessionsLoaded, setSessionsLoaded,
    sessionSettingsOpen, setSessionSettingsOpen,
    teamPanelOpen, setTeamPanelOpen,
    appSettingsOpen, setAppSettingsOpen,
    sidebarCollapsed, setSidebarCollapsed,
    narrowViewport, setNarrowViewport,
    mobileSidebarExpanded, setMobileSidebarExpanded,
    savedWorkspaces, setSavedWorkspaces,
    hiddenWorkspaces, setHiddenWorkspaces,
    allStored, setAllStored,
    bootError, setBootError,
    catalog, setCatalog,
    pendingModel, setPendingModel,
  };
}
