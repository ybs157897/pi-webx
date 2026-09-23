import { ActionIcon, Alert, Flexbox, Text, ThemeProvider, Tooltip } from '@lobehub/ui';
import { ChatHeader } from '@lobehub/ui/chat';
import { Dropdown, Tag, theme } from 'antd';
import {
  Copy,
  Download,
  Ellipsis,
  Eraser,
  GitBranch,
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  UsersRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api as bridge } from './lib/api';
import { catalogDefaultSelection, modelCatalogApi } from './lib/modelCatalog';
import { SessionCwdProvider } from './lib/session-cwd';
import { loadPrefs, savePrefs } from './lib/storage';
import { usePiSession, type ConnectionStatus, type PiSessionApi } from './lib/usePiSession';
import { useTeamSnapshot } from './lib/useTeamSnapshot';
import { Composer } from './components/Composer';
import { readToolPresetPreference } from './components/ToolPresetSelect';
import { EmptyState } from './components/EmptyState';
import { QueueDock } from './components/QueueDock';
import { QuestionComposer } from './components/QuestionComposer';
import type { ModelSelection } from './components/ModelPicker';
import { BranchSelect } from './components/BranchSelect';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { NotificationStack } from './components/NotificationStack';
import { SessionSettings } from './components/SessionSettings';
import { StatusStrip, WidgetStrip } from './components/StatusStrip';
import { TranscriptView } from './components/TranscriptView';
import { TeamPanel } from './components/TeamPanel';
import { UiShowcase } from './components/uikit/UiShowcase';
import { SidebarRoot } from './components/sidebar/SidebarRoot';
import { WorkspaceBrowser } from './components/sidebar/WorkspaceBrowser';
import { workspaceLabel } from './components/sidebar/tree';
import type { WorkspaceItem } from './components/sidebar/tree';
import { AgentDefinitionsSection, GeneralSettings, ModelsSection, SettingsPage } from './components/settings';
import type { ModelCatalog } from './shared/model-catalog';
import { presetFromToolNames, toolNamesForPreset, type ToolPreset } from './shared/tool-presets';
import type {
  PiCommandEnvelope,
  PiRpcResponse,
  PiThinkingLevel,
  ServerConfigResponse,
  SessionSummary,
  StoredSession,
} from './shared/protocol';

/** The stored preference; `system` resolves against the OS at render time. */
type ThemePreference = 'light' | 'dark' | 'system';
/** What the theme layer actually paints. */
type ThemeMode = 'light' | 'dark';
/** Which engine renders agent UI inline — ours, or TokUI. */
type RenderStyle = 'ours' | 'tokui';
type NewSessionMode = 'chat' | 'team';

const THEME_KEY = 'pi-webx-theme';
const RENDER_STYLE_KEY = 'pi-webx-render-style';
const SIDEBAR_COLLAPSED_KEY = 'pi-webx-sidebar-collapsed';

/** Expanded sidebar column width (px); the rail is 56. */
const SIDEBAR_WIDTH = 260;
/** Matches the dsh AppFrame track transition the collapse crossfade rides on. */
const SIDEBAR_SLIDE_MS = 300;

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** dsh offers Apperance as light / dark / follow-the-system; so does this. */
function readTheme(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function readRenderStyle(): RenderStyle {
  return localStorage.getItem(RENDER_STYLE_KEY) === 'tokui' ? 'tokui' : 'ours';
}

function readSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: '未连接',
  connecting: '连接中',
  live: '已连接',
  reconnecting: '重连中',
  exited: '已结束',
  error: '连接失败',
};

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** pi's answer for a prompt that never made it onto the wire. */
function failedPrompt(error: string): PiRpcResponse {
  return { type: 'response', command: 'prompt', success: false, error };
}

/** Result of the lazy first-send session creation. */
type CreateOutcome = { id: string } | { error: string };

function Shell({
  themePreference,
  themeMode,
  renderStyle,
  onThemePreferenceChange,
  onRenderStyleChange,
}: {
  /** The stored preference, which may be "follow the system". */
  themePreference: ThemePreference;
  /** The resolved theme the theme layer paints. */
  themeMode: ThemeMode;
  renderStyle: RenderStyle;
  onThemePreferenceChange: (next: ThemePreference) => void;
  onRenderStyleChange: (style: RenderStyle) => void;
}) {
  const { token } = theme.useToken();
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

  const session = usePiSession(sessionId);
  const teamState = useTeamSnapshot(sessionId, teamPanelOpen);
  const sidebarIsCollapsed = narrowViewport ? !mobileSidebarExpanded : sidebarCollapsed;

  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const update = () => {
      setNarrowViewport(query.matches);
      if (!query.matches) setMobileSidebarExpanded(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  /** Keep the URL in step with the open session, without a history entry. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (sessionId !== null) url.searchParams.set('session', sessionId);
    else url.searchParams.delete('session');
    if (newSessionMode === 'team') url.searchParams.set('team', '1');
    else url.searchParams.delete('team');
    window.history.replaceState(null, '', url);
  }, [newSessionMode, sessionId]);

  useEffect(() => {
    if (sessionId === null || teamState.sessionId !== sessionId || !teamState.ready) return;
    setNewSessionMode(teamState.snapshot === null ? 'chat' : 'team');
  }, [sessionId, teamState.ready, teamState.sessionId, teamState.snapshot]);

  /** Set once a resume has been attempted for an id, so the poll cannot loop. */
  const resumeAttempted = useRef<string | null>(null);

  /**
   * The model a new session starts from: the user's in-flight pick, else the
   * deployment default read from pi's own settings. This replaces an earlier
   * read of a localStorage slot nothing ever wrote — which is why every new
   * session silently fell back to whatever settings.json happened to hold.
   */
  const defaultModel: ModelSelection | null = useMemo(
    () => pendingModel ?? catalogDefaultSelection(catalog),
    [pendingModel, catalog],
  );

  /**
   * The preset the active session is running with, read back from its own record —
   * a resumed transcript reports the tools it was last run with, so the control
   * shows that rather than the browser preference.
   */
  const sessionToolPreset: ToolPreset | null = useMemo(
    () => (session.toolSelection === null ? null : presetFromToolNames(session.toolSelection)),
    [session.toolSelection],
  );

  /** The running session's model when there is one, else the pending default. */
  const activeSelection: ModelSelection | null = useMemo(() => {
    const live = session.piState?.model;
    return live ? { provider: live.provider, id: live.id } : defaultModel;
  }, [defaultModel, session.piState?.model]);

  const loadCatalog = useCallback(async (target: string): Promise<void> => {
    try {
      setCatalog(await modelCatalogApi.read(target.length > 0 ? target : undefined));
    } catch {
      // Transient: the picker falls back to the session's own catalogue, and
      // the next load retries. A missing catalog must not block sending.
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions((await bridge.listSessions()).sessions);
      // The list has been read at least once, so "not in it" now means the
      // bridge does not have this session — see the resume effect below.
      setSessionsLoaded(true);
    } catch {
      // transient; the poll retries
    }
  }, []);

  const loadStored = useCallback(async () => {
    try {
      // One unfiltered listing covers both the sidebar list and the per-workspace counts.
      // Cheap to repeat: the bridge caches each transcript's header and preview
      // and only re-reads a file whose size/mtime moved, so this is a stat pass
      // in the steady state rather than a body scan.
      setAllStored((await bridge.storedSessions({ limit: 100 })).sessions);
    } catch {
      setAllStored([]);
    }
  }, []);

  /**
   * 「地址里有 id，但服务端已经不认这个会话」时自动把它捞回来。
   *
   * 桥接服务重启会结束所有内存中的会话，而页面地址栏里只有 `?session=<id>`。
   * 以前这种情况下正文直接空掉、提示去会话列表手动重新打开；其实转写就在磁盘上，
   * `POST /api/sessions { sessionId }` 自己会去找文件（见 `findStoredSessionById`）。
   * 这里只负责在确认这个会话确实不在内存里之后发一次请求。
   *
   * 只在「桥接的会话列表已经读到、且里面没有这个 id」时动手：连接未建立或列表还没
   * 读到的空列表不代表会话不在，那样会在启动瞬间白捞一次。判定刻意**不**看会话
   * 客户端的状态——一个服务端已经不认的会话永远等不到 live，用它当门槛恰好会在最
   * 需要这条路径的时候不触发。每个 id 只试一次，避免和轮询互相触发成环。
   */
  useEffect(() => {
    if (sessionId === null || !sessionsLoaded) return;
    if (sessions.some((entry) => entry.id === sessionId)) return;
    if (resumeAttempted.current === sessionId) return;
    resumeAttempted.current = sessionId;
    void (async () => {
      try {
        const result = await bridge.createSession({
          sessionId,
          ...(newSessionMode === 'team' ? { teamMode: true } : {}),
        });
        setCwd(result.session.cwd);
        await refreshSessions();
      } catch {
        // 磁盘上也没有这个 id：保留现场提示，不打扰用户。
      }
    })();
  }, [newSessionMode, refreshSessions, sessions, sessionId, sessionsLoaded]);

  const pickWorkspace = useCallback((path: string) => {
    setSavedWorkspaces((prev) => {
      if (prev.includes(path)) return prev;
      savePrefs({ workspaces: [...prev, path].slice(0, 20) });
      return [...prev, path].slice(0, 20);
    });
    // An explicit pick is what un-hides a workspace: `从列表移除` is a decision
    // about the list, so choosing the path again (switcher, 浏览目录, or one of its
    // session rows) revives the row instead of leaving it silently suppressed.
    setHiddenWorkspaces((prev) => {
      if (!prev.includes(path)) return prev;
      const next = prev.filter((entry) => entry !== path);
      savePrefs({ hiddenWorkspaces: next });
      return next;
    });
  }, []);

  const forgetWorkspace = useCallback((path: string) => {
    // The current workspace is never removed: a live session runs in it, and the
    // derived list re-adds it anyway. The row's menu disables the action; this
    // guard is what makes that a fact rather than a UI promise.
    if (path === cwd) return;
    setSavedWorkspaces((prev) => {
      const next = prev.filter((entry) => entry !== path);
      savePrefs({ workspaces: next });
      return next;
    });
    setHiddenWorkspaces((prev) => {
      if (prev.includes(path)) return prev;
      const next = [...prev, path].slice(0, 100);
      savePrefs({ hiddenWorkspaces: next });
      return next;
    });
  }, [cwd]);

  /**
   * Add a workspace by asking the OS for one: the chooser runs on the bridge
   * host, so it has that machine's sidebar, favourites, and network volumes, and
   * whatever it returns is by construction a directory there. A dismissed dialog
   * comes back as `path: null` and simply changes nothing.
   */
  const browseWorkspace = useCallback((): void => {
    void (async () => {
      try {
        const picked = await bridge.pickDirectory(cwd);
        if (picked.path === null) return;
        pickWorkspace(picked.path);
        setCwd(picked.path);
        setSessionId(null);
      } catch (cause) {
        session.notify('error', '无法打开系统目录选择器', errorText(cause));
      }
    })();
  }, [cwd, pickWorkspace, session]);

  /**
   * Opens an existing pi session — the resume path from the sidebar, which has
   * to run immediately because there is a transcript to show. Fresh sessions
   * are *not* created here: they materialize on the first send (guardedPrompt),
   * so merely launching the app leaves no empty transcript behind.
   */
  const openSession = useCallback(
    async (target: string, sessionPath: string) => {
      try {
        const result = await bridge.createSession({ cwd: target, sessionPath });
        setMobileSidebarExpanded(false);
        setNewSessionMode('chat');
        setSessionId(result.session.id);
        setCwd(result.session.cwd);
        setBootError(null);
        savePrefs({ cwd: result.session.cwd });
        await refreshSessions();
      } catch (cause) {
        setBootError(errorText(cause));
      }
    },
    [refreshSessions],
  );

  /**
   * In-flight lazy creation, shared by concurrent sends so a double-click
   * cannot spawn two sessions. Only the promise is cached (not the id): it is
   * dropped as soon as the shell re-renders with a session, and a failed
   * attempt is dropped at once so the next send retries.
   */
  const pendingCreate = useRef<Promise<CreateOutcome> | null>(null);

  useEffect(() => {
    pendingCreate.current = null;
  }, [sessionId]);

  const ensureSession = useCallback((): Promise<CreateOutcome> => {
    if (pendingCreate.current) return pendingCreate.current;
    const pending = (async (): Promise<CreateOutcome> => {
      try {
        const result = await bridge.createSession({
          // No cwd yet means the config never loaded; let the bridge default it.
          ...(cwd.length > 0 ? { cwd } : {}),
          ...(defaultModel ? { provider: defaultModel.provider, model: defaultModel.id } : {}),
          // pi-web's split: the browser preference decides what a new session
          // starts from, and the session records it from there on.
          toolNames: toolNamesForPreset(readToolPresetPreference()),
          ...(newSessionMode === 'team' ? { teamMode: true } : {}),
        });
        setSessionId(result.session.id);
        setCwd(result.session.cwd);
        savePrefs({ cwd: result.session.cwd });
        await refreshSessions();
        return { id: result.session.id };
      } catch (cause) {
        pendingCreate.current = null;
        return { error: errorText(cause) };
      }
    })();
    pendingCreate.current = pending;
    return pending;
  }, [cwd, defaultModel, newSessionMode, refreshSessions]);

  /** Failed response for a local guard, shaped like a pi response. */
  const refused = useCallback(
    (command: string, error: string): PiRpcResponse => ({
      type: 'response',
      command,
      success: false,
      error,
    }),
    [],
  );

  /**
   * Picker write path, following dsh's `session.selectModel`: the choice applies
   * to the addressed session *and* is recorded as the deployment default, so the
   * next blank session starts from it. A failed default write is reported as a
   * notification but does not undo the session's selection — dsh logs it for the
   * same reason, and the session is already running the chosen model.
   */
  const applyModel = useCallback<PiSessionApi['setModel']>(
    async (provider, modelId) => {
      if (sessionId !== null) {
        const response = await session.setModel(provider, modelId);
        if (!response.success) return response;
      }
      // Recorded before the (async) settings write so picking and sending in one
      // gesture cannot race it: the created session reads this, not the file.
      setPendingModel({ provider, id: modelId });
      try {
        setCatalog(
          await modelCatalogApi.saveDefault({
            provider,
            model: modelId,
            ...(cwd.length > 0 ? { cwd } : {}),
          }),
        );
      } catch (cause) {
        session.notify('warning', '默认模型未保存', errorText(cause));
      }
      return { type: 'response', command: 'set_model', success: true };
    },
    [cwd, session, sessionId],
  );

  /**
   * Thinking-level write, same shape: apply to the session when there is one, and
   * remember the level against the selected model. pi keys that memory
   * `provider/model`, so a level can never be inherited by a model that rejects
   * it — the property dsh reaches by clearing a stored effort on a model change.
   */
  const applyThinkingLevel = useCallback<PiSessionApi['setThinkingLevel']>(
    async (level: PiThinkingLevel | null) => {
      if (level !== null && sessionId !== null) {
        const response = await session.setThinkingLevel(level);
        if (!response.success) return response;
      }
      if (activeSelection === null) {
        return refused('set_thinking_level', '请先选择模型');
      }
      try {
        // `null` clears the remembered level (dsh's `Default`); an omitted field
        // would instead leave the stored value in place.
        setCatalog(
          await modelCatalogApi.saveDefault({
            provider: activeSelection.provider,
            model: activeSelection.id,
            thinkingLevel: level,
            ...(cwd.length > 0 ? { cwd } : {}),
          }),
        );
      } catch (cause) {
        session.notify('warning', '推理等级未保存', errorText(cause));
      }
      return { type: 'response', command: 'set_thinking_level', success: true };
    },
    [activeSelection, cwd, refused, session, sessionId],
  );

  /**
   * The question the agent is waiting on, if any.
   *
   * pi blocks the extension on one dialog at a time, so the oldest is always the
   * actionable one; a later request stays in the session snapshot and surfaces
   * once this one resolves.
   */
  const pendingQuestion = session.dialogs[0] ?? null;

  /**
   * Send path for the composer: with a session attached it is a plain prompt,
   * otherwise the session is created first and the message goes straight to it
   * via `sendTo` — `session.prompt` would still close over the old (null) id
   * until the next render.
   */
  const guardedPrompt = useCallback<PiSessionApi['prompt']>(
    async (text, options) => {
      try {
        if (sessionId !== null) return await session.prompt(text, options);

        const created = await (pendingCreate.current ?? ensureSession());
        if ('error' in created) return failedPrompt(created.error);

        const body: PiCommandEnvelope = {
          type: 'prompt',
          message: text,
          ...(options?.images && options.images.length > 0 ? { images: options.images } : {}),
          ...(options?.behavior ? { streamingBehavior: options.behavior } : {}),
        };
        return await session.sendTo(created.id, body);
      } catch (cause) {
        return failedPrompt(errorText(cause));
      }
    },
    [ensureSession, session, sessionId],
  );

  /** The composer talks to the same api, with sending swapped for the lazy path
      and model/thinking writes routed through the paths that also record the
      deployment default. */
  const composerApi = useMemo<PiSessionApi>(
    () => ({
      ...session,
      prompt: guardedPrompt,
      setModel: applyModel,
      setThinkingLevel: applyThinkingLevel,
    }),
    [applyModel, applyThinkingLevel, guardedPrompt, session],
  );

  /** Apply a preset to the running session; the host records it on the session. */
  const applyToolPreset = useCallback(
    (preset: ToolPreset) => {
      if (sessionId === null) return;
      void session.setTools(toolNamesForPreset(preset));
    },
    [session, sessionId],
  );

  /* Boot: discover defaults and remember the workspace. No session is created
     here — sending the first message is what materializes one. */
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await bridge.config();
        setConfig(loaded);
        const target = boot.cwd && boot.cwd.length > 0 ? boot.cwd : loaded.defaultCwd;
        setCwd(target);
        savePrefs({ cwd: target });
      } catch (cause) {
        setBootError(errorText(cause));
      }
    })();
  }, [boot.cwd]);

  useEffect(() => {
    void refreshSessions();
    const timer = setInterval(() => void refreshSessions(), 5_000);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  /* The catalog is read per workspace: project settings can override the global
     default, so switching workspaces re-reads instead of reusing the answer. */
  useEffect(() => {
    void loadCatalog(cwd);
  }, [cwd, loadCatalog]);

  /**
   * The stored transcripts, refreshed on the same cadence as the live list.
   *
   * dsh pushes list changes over its event stream; pi writes transcripts to disk
   * with no channel we can subscribe to, so a poll is the honest equivalent — and
   * it is affordable only because the bridge caches each file's summary instead
   * of re-reading transcripts on every pass.
   */
  useEffect(() => {
    void loadStored();
    const timer = setInterval(() => void loadStored(), 5_000);
    return () => clearInterval(timer);
  }, [loadStored]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  /**
   * Workspace rows for the sidebar browser, ordered current → saved →
   * suggested → anything that has sessions, minus the workspaces the user
   * removed. The browser groups sessions under these itself.
   *
   * The list is a union of five sources, which is exactly why a removal has to
   * be expressed as a subtraction (`hiddenWorkspaces`) rather than as an edit to
   * any one of them: removing a path from the saved list alone leaves it coming
   * back from the server's suggestions or from a stored session's cwd.
   */
  const workspaces = useMemo<WorkspaceItem[]>(() => {
    const order: string[] = [];
    const push = (path: string | undefined): void => {
      if (path && !order.includes(path)) order.push(path);
    };
    push(cwd);
    savedWorkspaces.forEach(push);
    (config?.suggestedCwds ?? []).forEach(push);
    sessions.forEach((entry) => push(entry.cwd));
    allStored.forEach((entry) => push(entry.cwd));
    const defaultCwd = boot.cwd ?? '';
    const hidden = new Set(hiddenWorkspaces);
    return order
      // The current workspace is exempt: hiding the directory a live session runs
      // in would leave that session with no row of its own.
      .filter((path) => path === cwd || !hidden.has(path))
      .map((path) => ({
        key: path,
        // The row reads as the folder it is; the path stays available in the
        // row's hover card, which is also what disambiguates two folders that
        // share a name.
        title: workspaceLabel(path),
        isCurrent: path === cwd,
        isDefault: path === defaultCwd,
      }));
  }, [allStored, boot.cwd, config?.suggestedCwds, cwd, hiddenWorkspaces, savedWorkspaces, sessions]);

  /**
   * "New session" now just detaches to the empty state — the pi process is
   * created by the first message, so clicking it costs nothing. A running
   * session keeps going and stays reachable from the sidebar.
   */
  const onNewSession = useCallback(
    (path?: string, mode: NewSessionMode = 'chat') => {
      if (path !== undefined) {
        pickWorkspace(path);
        setCwd(path);
      }
      setNewSessionMode(mode);
      setTeamPanelOpen(false);
      setMobileSidebarExpanded(false);
      setSessionId(null);
    },
    [pickWorkspace],
  );

  /**
   * dsh's `分叉会话`: copy the transcript into a new session and open it.
   *
   * A live row forks from its hosted session, a stored row from its file — the
   * bridge resolves the first and re-checks the containment of the second. The
   * new session is opened rather than the old one closed, matching dsh: forking
   * is a way to continue somewhere else, not a way to end what was running.
   */
  const onForkSession = useCallback(
    async (node: { id: string; kind: 'live' | 'stored'; cwd?: string }) => {
      try {
        const source = node.kind === 'live'
          ? { sessionId: node.id }
          : { path: node.id.replace(/^stored:/, '') };
        const result = await bridge.forkSession({
          ...source,
          ...(node.cwd === undefined || node.cwd.length === 0 ? {} : { cwd: node.cwd }),
        });
        setMobileSidebarExpanded(false);
        setNewSessionMode('chat');
        setSessionId(result.session.id);
        await refreshSessions();
        await loadStored();
      } catch (cause) {
        session.notify('error', '分叉会话失败', errorText(cause));
      }
    },
    [loadStored, refreshSessions, session],
  );

  const onRenameSession = useCallback(
    async (id: string, name: string) => {
      await session.sendTo(id, { type: 'set_session_name', name });
      await refreshSessions();
    },
    [refreshSessions, session],
  );

  /** Stored-session count per workspace, for the switcher's menu and the empty state. */
  const activeSession = useMemo(
    () => sessions.find((entry) => entry.id === sessionId) ?? null,
    [sessionId, sessions],
  );

  const title = useMemo(() => {
    if (activeSession?.sessionName) return activeSession.sessionName;
    if (cwd.length === 0) return 'pi webx';
    return cwd.split('/').filter(Boolean).pop() ?? cwd;
  }, [activeSession?.sessionName, cwd]);

  const contextPercent = useMemo(() => {
    const usage = session.stats?.contextUsage;
    if (!usage?.percent) return null;
    return Math.min(100, Math.round(usage.percent));
  }, [session.stats?.contextUsage]);

  const menuItems = useMemo(
    () => [
      { key: 'new', icon: <MessageSquarePlus size={13} />, label: '新建会话' },
      { key: 'new-team', icon: <UsersRound size={13} />, label: '新建 Agent Team' },
      { type: 'divider' as const },
      { key: 'compact', icon: <Eraser size={13} />, label: '立即压缩上下文', disabled: session.transcript.running },
      { key: 'export', icon: <Download size={13} />, label: '导出会话为 HTML', disabled: !session.sessionFile },
      { key: 'copy', icon: <Copy size={13} />, label: '复制会话文件路径', disabled: !session.sessionFile },
      { type: 'divider' as const },
      { key: 'fork', icon: <GitBranch size={13} />, label: '分叉会话', disabled: !session.sessionFile },
    ],
    [session.sessionFile, session.transcript.running],
  );

  const onMenuClick = useCallback(
    (key: string) => {
      switch (key) {
        case 'new':
          onNewSession();
          break;
        case 'new-team':
          onNewSession(undefined, 'team');
          break;
        case 'compact':
          void session.compact();
          break;
        case 'export':
          void session.exportHtml().then((result) => {
            if (result) void navigator.clipboard.writeText(result.path);
          });
          break;
        case 'copy':
          if (session.sessionFile) void navigator.clipboard.writeText(session.sessionFile);
          break;
        case 'fork':
          if (sessionId) void onForkSession({ id: sessionId, kind: 'live', cwd });
          break;
        default:
          break;
      }
    },
    [cwd, onForkSession, onNewSession, session, sessionId],
  );

  /**
   * Rendered-component actions (buttons/forms in agent UI) loop back to pi as a
   * normal message, through the same submission policy as the composer: the
   * host queues it when a turn is running, starts one when it is not. Steering
   * is the composer's explicit chord, not a side effect of where the text came
   * from — a card action must not cut into a turn the user did not aim it at.
   */
  const sendAction = useCallback(
    (action: string) => {
      void guardedPrompt(action);
    },
    [guardedPrompt],
  );

  /* Every hook sits above this guard: the boot-error screen must not change
     the hook order the shell renders with. */
  if (bootError !== null && sessionId === null) {
    return (
      <Flexbox align="center" justify="center" style={{ height: '100vh', padding: 24 }}>
        <Flexbox gap={12} style={{ maxWidth: 620, width: '100%' }}>
          <Alert type="error" showIcon message="无法启动 pi 会话" description={bootError} />
          <Text fontSize={12} type="secondary">
            请确认桥接服务已启动（agent 通过内嵌的 pi SDK 在进程内运行），
            以及模型配置里有可用的模型和凭据。
          </Text>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                try {
                  const loaded = await bridge.config();
                  setConfig(loaded);
                  const target = boot.cwd && boot.cwd.length > 0 ? boot.cwd : loaded.defaultCwd;
                  setCwd(target);
                  savePrefs({ cwd: target });
                  setBootError(null);
                } catch (cause) {
                  setBootError(errorText(cause));
                }
              })();
            }}
            style={{
              padding: '8px 16px',
              cursor: 'pointer',
              color: token.colorTextLightSolid,
              background: token.colorPrimary,
              border: 'none',
              borderRadius: token.borderRadius,
            }}
          >
            重试
          </button>
        </Flexbox>
      </Flexbox>
    );
  }

  const empty = session.transcript.entries.length === 0;

  return (
    <Flexbox
      horizontal
      style={{ height: '100vh', overflow: 'hidden', background: token.colorBgLayout }}
    >
      {/* The sliding column: fixed-width tracks that animate the collapse while
          the shell freezes its content at the expanded width and crossfades. */}
      <div
        style={{
          flex: 'none',
          height: '100%',
          overflow: 'hidden',
          width: sidebarIsCollapsed ? 56 : SIDEBAR_WIDTH,
          transition: `width ${SIDEBAR_SLIDE_MS}ms var(--ds-ease-in-out, ease-in-out)`,
          borderRight: '1px solid var(--dsw-alias-border-l2)',
        }}
      >
        <SidebarRoot
          width={SIDEBAR_WIDTH}
          collapsed={sidebarIsCollapsed}
          onToggle={() => {
            if (narrowViewport) setMobileSidebarExpanded((prev) => !prev);
            else setSidebarCollapsed((prev) => !prev);
          }}
          piVersion={config?.piVersion ?? null}
          onNewSession={() => { onNewSession(); }}
          onOpenSettings={() => { setAppSettingsOpen(true); }}
          region={(wide, expandSidebar) => (
            <WorkspaceBrowser
              wide={wide}
              expandSidebar={expandSidebar}
              home={config?.home}
              workspaces={workspaces}
              live={sessions}
              stored={allStored}
              currentId={sessionId}
              onSwitch={(id) => { setMobileSidebarExpanded(false); setNewSessionMode('chat'); setSessionId(id); }}
              onNewSession={(path) => { onNewSession(path); }}
              onRename={(id, name) => { void onRenameSession(id, name); }}
              onResume={(entry) => { void openSession(entry.cwd, entry.path); }}
              onFork={(node) => { void onForkSession(node); }}
              onPickWorkspace={(path) => {
                pickWorkspace(path);
                setCwd(path);
                setSessionId(null);
              }}
              onSetDefault={(path) => { savePrefs({ cwd: path }); }}
              onForgetWorkspace={forgetWorkspace}
              onBrowseWorkspace={browseWorkspace}
            />
          )}
        />
      </div>

      <Flexbox style={{ flex: 1, minWidth: 0, height: '100%' }}>
        {/* LobeHub's ChatHeader is `position: absolute; width: 100%`, sized
            against its containing block because the layout it ships for is a CSS
            grid whose header area is 52px tall. A flex column gives it neither,
            and both halves of that went wrong: `width: 100%` resolved against a
            full-width ancestor, so the bar stretched 260px past this column (its
            right-hand controls — status, refresh, session settings — landed off
            screen with nothing able to scroll to them), and being out of flow it
            reserved no height, so the first 52px of content sat underneath it.
            This wrapper supplies exactly what the grid would: a 52px box that is
            positioned, so the bar spans the column and the content starts below
            it. */}
        <div style={{ position: 'relative', height: 52, flex: 'none' }}>
          <ChatHeader
          left={
            <Flexbox horizontal align="center" gap={6}>
              <Text fontSize={14} weight={600} ellipsis style={{ maxWidth: narrowViewport ? 112 : 320 }}>
                {title}
              </Text>
              <Dropdown
                trigger={['click']}
                menu={{ items: menuItems, onClick: ({ key }) => onMenuClick(String(key)) }}
              >
                <ActionIcon icon={Ellipsis} size="small" />
              </Dropdown>
            </Flexbox>
          }
          right={
            <Flexbox horizontal align="center" gap={4}>
              <Tag
                style={{ fontSize: 11, marginRight: 4, display: narrowViewport ? 'none' : undefined }}
                color={
                  session.status === 'live'
                    ? session.transcript.running
                      ? 'processing'
                      : 'success'
                    : session.status === 'error' || session.status === 'exited'
                      ? 'error'
                      : 'default'
                }
              >
                {session.transcript.running ? '执行中' : STATUS_LABEL[session.status]}
              </Tag>
              {(teamState.snapshot !== null || (sessionId === null && newSessionMode === 'team')) && (
                <Tag color="blue" style={{ fontSize: 11, marginRight: 4, display: narrowViewport ? 'none' : undefined }}>Agent Team</Tag>
              )}
              <Tooltip title="团队面板">
                <ActionIcon
                  icon={UsersRound}
                  size="small"
                  aria-label="团队面板"
                  onClick={() => setTeamPanelOpen(true)}
                />
              </Tooltip>
              <Tooltip title="刷新状态">
                <ActionIcon
                  icon={RefreshCw}
                  size="small"
                  disabled={sessionId === null}
                  onClick={() => void session.refreshState()}
                />
              </Tooltip>
              <Tooltip title="会话设置">
                <ActionIcon icon={Settings2} size="small" onClick={() => setSessionSettingsOpen(true)} />
              </Tooltip>
            </Flexbox>
          }
          styles={{
            center: {
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
            },
          }}
            style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, flexShrink: 0 }}
          />
        </div>

        {session.error !== null && (
          <Alert
            type="warning"
            variant="borderless"
            showIcon
            closable
            message={session.error}
            style={{ margin: '8px 16px 0' }}
          />
        )}

        {/* A blank session is one centered surface: the welcome sits directly
            above the composer, the composer lands mid-screen, and the spacer
            below it is the space the transcript will grow into. Keeping the
            composer in the same child slot across both layouts is what stops a
            first send from remounting it (and dropping the draft). */}
        {empty ? (
          <Flexbox align="center" justify="flex-end" style={{ flex: 1, minHeight: 0 }}>
            <EmptyState
              mode={sessionId === null ? newSessionMode : teamState.snapshot ? 'team' : 'chat'}
              onModeChange={sessionId === null ? setNewSessionMode : undefined}
            />
          </Flexbox>
        ) : (
          <Flexbox style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {/* Keyed by session: transcript-local UI state (fold expansion)
                must not leak from one session's turn numbering to another's. */}
            <SessionCwdProvider cwd={cwd === '' ? null : cwd}>
              <TranscriptView
                key={sessionId ?? 'pending'}
                transcript={session.transcript}
                onAction={sendAction}
                renderStyle={renderStyle}
              />
            </SessionCwdProvider>
          </Flexbox>
        )}

        <Flexbox paddingInline={20} style={{ flex: 'none', minWidth: 0, maxWidth: 940, margin: '0 auto', width: '100%' }}>
          <WidgetStrip widgets={session.widgets} placement="aboveEditor" />
          <StatusStrip api={session} />
        </Flexbox>

        {/* The dock hangs above the composer card, outside the box the question
            replaces: a message queued behind a running turn must stay visible
            and steerable while the agent is also waiting on an answer. */}
        <div style={{ flex: 'none', minWidth: 0, padding: '0 20px', maxWidth: 940, margin: '0 auto', width: '100%' }}>
          <QueueDock
            items={session.transcript.queued.pending}
            running={session.transcript.running}
            onSteer={(id) => session.updateQueue(id, { kind: 'steer' }).then(() => undefined)}
            onEdit={(id, next) => session.updateQueue(id, { kind: 'edit', text: next }).then(() => undefined)}
            onRemove={(id) => session.updateQueue(id, { kind: 'remove' }).then(() => undefined)}
          />
        </div>

        {/* The question takes the composer's seat — dsh's `conversation.composer`
            chain, where an elected entry overlays the bar. The bar itself stays
            mounted behind `display: none` rather than unmounting: a draft being
            written when the agent asks something has to survive the question. */}
        <div style={{ display: pendingQuestion === null ? 'contents' : 'none' }}>
          <Composer
            api={composerApi}
            catalog={catalog}
            toolPreset={sessionToolPreset}
            onToolPresetChange={applyToolPreset}
            /* Nothing to send to yet is not a reason to lock the composer: the
               first send creates the session (see guardedPrompt). */
            disabled={false}
            contextPercent={contextPercent}
            /* The workspace/branch chips answer a question a blank session still
               has — where does this run. Once a conversation exists, the workspace
               is that session's own fact and dsh drops the accessory row too, so
               the composer below a transcript is just the input and its controls. */
            contextBar={empty ? (
              <>
                <WorkspaceSwitcher
                  cwd={cwd}
                  recent={[...savedWorkspaces, ...(config?.suggestedCwds ?? [])]}
                  {...(config?.home === undefined ? {} : { home: config.home })}
                  onPick={(path) => {
                    pickWorkspace(path);
                    setCwd(path);
                    setSessionId(null);
                  }}
                  onBrowse={browseWorkspace}
                />
                {cwd.length > 0 && (
                  <BranchSelect
                    cwd={cwd}
                    running={session.transcript.running}
                    onError={(message) => { session.notify('error', '切换分支失败', message); }}
                  />
                )}
              </>
            ) : undefined}
          />
        </div>
        {pendingQuestion !== null && (
          <QuestionComposer
            /* Keyed to the request: the surface must not carry a previous
               question's text into the next one. */
            key={pendingQuestion.request.id}
            dialog={pendingQuestion}
            onRespond={(body) => void session.respondToDialog(pendingQuestion.request.id, body)}
          />
        )}
        <Flexbox paddingInline={20} style={{ maxWidth: 940, margin: '0 auto', width: '100%' }}>
          <WidgetStrip widgets={session.widgets} placement="belowEditor" />
        </Flexbox>
        {empty && <div style={{ flex: 1, minHeight: 0 }} aria-hidden="true" />}
      </Flexbox>

      <SessionSettings
        open={sessionSettingsOpen}
        onClose={() => setSessionSettingsOpen(false)}
        api={session}
        disabled={sessionId === null}
      />

      <TeamPanel
        open={teamPanelOpen}
        onClose={() => setTeamPanelOpen(false)}
        sessionId={sessionId}
        team={teamState.snapshot}
        loading={teamState.loading}
        error={teamState.error}
        onRefresh={teamState.refresh}
        onNewTeam={() => onNewSession(undefined, 'team')}
      />

      <SettingsPage
        open={appSettingsOpen}
        onClose={() => {
          setAppSettingsOpen(false);
          // Providers, credentials and models.json all feed the catalog, and a
          // session's catalogue only refreshes on an explicit state read.
          void session.refreshState();
          void loadCatalog(cwd);
        }}
        sections={[
          {
            id: 'general',
            label: '常规',
            group: '基础设置',
            title: '通用设置',
            render: () => (
              <GeneralSettings
                themeMode={themePreference}
                onThemeModeChange={onThemePreferenceChange}
                renderStyle={renderStyle}
                onRenderStyleChange={onRenderStyleChange}
              />
            ),
          },
          {
            id: 'models',
            label: '模型设置',
            group: '基础设置',
            title: '模型设置',
            render: () => <ModelsSection />,
          },
          {
            id: 'agents',
            label: '子智能体',
            group: '基础设置',
            title: '子智能体',
            /* The tool catalog is per-session, so the section takes the session
               the app already has; `undefined` before the first message, which
               the section answers by listing built-in tools only. */
            render: () => <AgentDefinitionsSection sessionId={sessionId ?? undefined} />,
          },
          {
            id: 'showcase',
            label: '组件库',
            group: '更多',
            title: '组件库',
            render: () => <UiShowcase onAction={sendAction} themeMode={themeMode} />,
          },
        ]}
      />

      <NotificationStack
        notifications={session.notifications}
        onDismiss={session.dismissNotification}
      />
    </Flexbox>
  );
}

export default function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readTheme);
  const [renderStyle, setRenderStyle] = useState<RenderStyle>(readRenderStyle);
  // Re-resolve when the OS flips, so "follow the system" is live rather than a
  // decision taken at boot.
  const [systemDark, setSystemDark] = useState(prefersDark);

  useEffect(() => {
    if (themePreference !== 'system') return;
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => { setSystemDark(event.matches) };
    query.addEventListener('change', onChange);
    return () => { query.removeEventListener('change', onChange) };
  }, [themePreference]);

  const themeMode: ThemeMode =
    themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference;

  useEffect(() => {
    localStorage.setItem(THEME_KEY, themePreference);
    document.documentElement.style.colorScheme = themeMode;
    // The dsw design tokens (the sidebar/settings system) key their dark sheet
    // off this attribute.
    document.body.toggleAttribute('data-ds-dark-theme', themeMode === 'dark');
  }, [themeMode, themePreference]);

  useEffect(() => {
    localStorage.setItem(RENDER_STYLE_KEY, renderStyle);
  }, [renderStyle]);

  return (
    <ThemeProvider themeMode={themeMode} enableCustomFonts={false}>
      <Shell
        themePreference={themePreference}
        themeMode={themeMode}
        renderStyle={renderStyle}
        onThemePreferenceChange={setThemePreference}
        onRenderStyleChange={setRenderStyle}
      />
    </ThemeProvider>
  );
}
