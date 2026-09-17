import { ActionIcon, Alert, Flexbox, Text, ThemeProvider, Tooltip } from '@lobehub/ui';
import { ChatHeader } from '@lobehub/ui/chat';
import { Dropdown, Tag, theme } from 'antd';
import {
  Copy,
  Download,
  Ellipsis,
  Eraser,
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api as bridge } from './lib/api';
import { THINKING_LABELS } from './lib/format';
import { loadPrefs, savePrefs } from './lib/storage';
import { usePiSession, type ConnectionStatus } from './lib/usePiSession';
import { Composer } from './components/Composer';
import { DirectoryPicker } from './components/DirectoryPicker';
import { EmptyState } from './components/EmptyState';
import { ExtensionDialogs } from './components/Dialogs';
import type { ModelSelection } from './components/ModelSelectV3';
import { shortPath } from './components/WorkspaceSwitcher';
import { NotificationStack } from './components/NotificationStack';
import { SessionSettings } from './components/SessionSettings';
import { StatusStrip, WidgetStrip } from './components/StatusStrip';
import { TranscriptView } from './components/TranscriptView';
import { UiShowcase } from './components/uikit/UiShowcase';
import { SidebarRoot } from './components/sidebar/SidebarRoot';
import { WorkspaceBrowser } from './components/sidebar/WorkspaceBrowser';
import type { WorkspaceItem } from './components/sidebar/tree';
import { ModelsSection, SettingsModal } from './components/settings';
import type { ServerConfigResponse, SessionSummary, StoredSession } from './shared/protocol';

type ThemeMode = 'light' | 'dark';
/** Which engine renders agent UI inline — ours, or TokUI. */
type RenderStyle = 'ours' | 'tokui';

const THEME_KEY = 'pi-webx-theme';
const RENDER_STYLE_KEY = 'pi-webx-render-style';
const SIDEBAR_COLLAPSED_KEY = 'pi-webx-sidebar-collapsed';

/** Expanded sidebar column width (px); the rail is 56. */
const SIDEBAR_WIDTH = 260;
/** Matches the dsh AppFrame track transition the collapse crossfade rides on. */
const SIDEBAR_SLIDE_MS = 300;

function readTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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

function Shell({
  themeMode,
  renderStyle,
  onToggleTheme,
  onRenderStyleChange,
}: {
  themeMode: ThemeMode;
  renderStyle: RenderStyle;
  onToggleTheme: () => void;
  onRenderStyleChange: (style: RenderStyle) => void;
}) {
  const { token } = theme.useToken();
  const boot = useMemo(() => loadPrefs(), []);
  const [config, setConfig] = useState<ServerConfigResponse | null>(null);
  const [cwd, setCwd] = useState(boot.cwd ?? '');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [seedText, setSeedText] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [savedWorkspaces, setSavedWorkspaces] = useState<string[]>(() => loadPrefs().workspaces ?? []);
  const [allStored, setAllStored] = useState<StoredSession[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  const session = usePiSession(sessionId);

  const defaultModel: ModelSelection | null = useMemo(
    () => (boot.provider && boot.modelId ? { provider: boot.provider, id: boot.modelId } : null),
    [boot.provider, boot.modelId],
  );

  const refreshSessions = useCallback(async () => {
    try {
      setSessions((await bridge.listSessions()).sessions);
    } catch {
      // transient; the poll retries
    }
  }, []);

  const loadStored = useCallback(async () => {
    try {
      // One unfiltered listing covers both the sidebar list and the per-workspace counts.
      setAllStored((await bridge.storedSessions({ limit: 100 })).sessions);
    } catch {
      setAllStored([]);
    }
  }, []);

  const pickWorkspace = useCallback((path: string) => {
    setSavedWorkspaces((prev) => {
      if (prev.includes(path)) return prev;
      savePrefs({ workspaces: [...prev, path].slice(0, 20) });
      return [...prev, path].slice(0, 20);
    });
  }, []);

  const forgetWorkspace = useCallback((path: string) => {
    setSavedWorkspaces((prev) => {
      const next = prev.filter((entry) => entry !== path);
      savePrefs({ workspaces: next });
      return next;
    });
  }, []);

  const startSession = useCallback(
    async (target: string, sessionPath?: string) => {
      try {
        const result = await bridge.createSession({
          cwd: target,
          ...(sessionPath === undefined ? {} : { sessionPath }),
          // A resumed session keeps its own model; only fresh ones get the default.
          ...(sessionPath === undefined && defaultModel
            ? { provider: defaultModel.provider, model: defaultModel.id }
            : {}),
        });
        setSessionId(result.session.id);
        setCwd(result.session.cwd);
        setBootError(null);
        savePrefs({ cwd: result.session.cwd });
        await refreshSessions();
      } catch (cause) {
        setBootError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [defaultModel, refreshSessions],
  );

  /* Boot: discover defaults, then reopen the last workspace (or the default). */
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await bridge.config();
        setConfig(loaded);
        const target = boot.cwd && boot.cwd.length > 0 ? boot.cwd : loaded.defaultCwd;
        setCwd(target);
        await startSession(target);
      } catch (cause) {
        setBootError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [boot.cwd, startSession]);

  useEffect(() => {
    void refreshSessions();
    const timer = setInterval(() => void refreshSessions(), 5_000);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  useEffect(() => {
    void loadStored();
  }, [loadStored]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  /**
   * Workspace rows for the sidebar browser, ordered current → saved →
   * suggested → anything that has sessions. The browser groups sessions
   * under these itself.
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
    const home = config?.home;
    const defaultCwd = boot.cwd ?? '';
    return order.map((path) => ({
      key: path,
      title: shortPath(path, home),
      isCurrent: path === cwd,
      isDefault: path === defaultCwd,
    }));
  }, [allStored, boot.cwd, config?.home, config?.suggestedCwds, cwd, savedWorkspaces, sessions]);

  const onNewSession = useCallback(async () => {
    if (sessionId && session.status === 'live') {
      // Reuse the running pi process; `new_session` resets the conversation.
      await session.newSession();
      await refreshSessions();
      return;
    }
    await startSession(cwd);
  }, [cwd, refreshSessions, session, sessionId, startSession]);

  const onKillSession = useCallback(
    async (id: string) => {
      try {
        await bridge.deleteSession(id);
      } finally {
        if (id === sessionId) setSessionId(null);
        await refreshSessions();
      }
    },
    [refreshSessions, sessionId],
  );

  const onRenameSession = useCallback(
    async (id: string, name: string) => {
      await session.sendTo(id, { type: 'set_session_name', name });
      await refreshSessions();
    },
    [refreshSessions, session],
  );

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
      { type: 'divider' as const },
      { key: 'compact', icon: <Eraser size={13} />, label: '立即压缩上下文', disabled: session.transcript.running },
      { key: 'export', icon: <Download size={13} />, label: '导出会话为 HTML', disabled: !session.sessionFile },
      { key: 'copy', icon: <Copy size={13} />, label: '复制会话文件路径', disabled: !session.sessionFile },
      { type: 'divider' as const },
      { key: 'kill', icon: <Trash2 size={13} />, label: '结束会话', danger: true },
    ],
    [session.sessionFile, session.transcript.running],
  );

  const onMenuClick = useCallback(
    (key: string) => {
      switch (key) {
        case 'new':
          void onNewSession();
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
        case 'kill':
          if (sessionId) void onKillSession(sessionId);
          break;
        default:
          break;
      }
    },
    [onKillSession, onNewSession, sessionId, session],
  );

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
              setBootError(null);
              void (async () => {
                const loaded = await bridge.config().catch(() => null);
                if (loaded) {
                  setConfig(loaded);
                  const target = boot.cwd || loaded.defaultCwd;
                  setCwd(target);
                  await startSession(target);
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

  /**
   * Rendered-component actions (buttons/forms in agent UI) loop back to pi as a
   * normal message. Steer when a run is already going.
   */
  const sendAction = useCallback(
    (action: string) => {
      const behavior = session.transcript.running ? ('steer' as const) : undefined;
      void session.prompt(action, behavior ? { behavior } : {});
    },
    [session],
  );

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
          width: sidebarCollapsed ? 56 : SIDEBAR_WIDTH,
          transition: `width ${SIDEBAR_SLIDE_MS}ms var(--ds-ease-in-out, ease-in-out)`,
          borderRight: '1px solid var(--dsw-alias-border-l2)',
        }}
      >
        <SidebarRoot
          width={SIDEBAR_WIDTH}
          collapsed={sidebarCollapsed}
          onToggle={() => { setSidebarCollapsed((prev) => !prev); }}
          piVersion={config?.piVersion ?? null}
          themeMode={themeMode}
          connected={session.status === 'live'}
          onNewSession={() => { void onNewSession(); }}
          onToggleTheme={onToggleTheme}
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
              onSwitch={setSessionId}
              onNewSession={(path) => {
                pickWorkspace(path);
                void startSession(path);
              }}
              onKill={(id) => { void onKillSession(id); }}
              onRename={(id, name) => { void onRenameSession(id, name); }}
              onResume={(entry) => { void startSession(entry.cwd, entry.path); }}
              onDeleteStored={(entry) => {
                void bridge.deleteStoredSession(entry.path).then(() => loadStored());
              }}
              onPickWorkspace={(path) => {
                pickWorkspace(path);
                void startSession(path);
              }}
              onSetDefault={(path) => { savePrefs({ cwd: path }); }}
              onForgetWorkspace={forgetWorkspace}
              onBrowseWorkspace={() => { setPickerOpen(true); }}
            />
          )}
        />
      </div>

      <Flexbox style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <ChatHeader
          left={
            <Flexbox horizontal align="center" gap={6}>
              <Text fontSize={14} weight={600} ellipsis style={{ maxWidth: 320 }}>
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
                style={{ fontSize: 11, marginRight: 4 }}
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

        <Text fontSize={11} type="secondary" style={{ padding: '4px 16px 0' }}>
          {[
            session.piState?.model
              ? `${session.piState.model.provider}/${session.piState.model.id}`
              : null,
            session.piState?.thinkingLevel
              ? `思考 ${THINKING_LABELS[session.piState.thinkingLevel] ?? session.piState.thinkingLevel}`
              : null,
            session.piState?.autoCompactionEnabled === false ? '自动压缩已关闭' : null,
            session.transcript.title,
          ]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join(' · ')}
        </Text>

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

        <Flexbox style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {empty ? (
            <EmptyState onPick={setSeedText} />
          ) : (
            <TranscriptView transcript={session.transcript} onAction={sendAction} renderStyle={renderStyle} />
          )}
        </Flexbox>

        <Flexbox paddingInline={20} style={{ maxWidth: 940, margin: '0 auto', width: '100%' }}>
          <WidgetStrip widgets={session.widgets} placement="aboveEditor" />
          <StatusStrip api={session} />
        </Flexbox>

        <Composer
          api={session}
          disabled={sessionId === null}
          contextPercent={contextPercent}
          seedText={seedText}
          onSeedConsumed={() => setSeedText(null)}
          renderStyle={renderStyle}
          onRenderStyleChange={onRenderStyleChange}
        />
        <Flexbox paddingInline={20} style={{ maxWidth: 940, margin: '0 auto', width: '100%' }}>
          <WidgetStrip widgets={session.widgets} placement="belowEditor" />
        </Flexbox>
      </Flexbox>

      <DirectoryPicker
        open={pickerOpen}
        initialPath={cwd}
        suggested={config?.suggestedCwds ?? []}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => {
          setPickerOpen(false);
          pickWorkspace(path);
          void startSession(path);
        }}
      />

      <SessionSettings
        open={sessionSettingsOpen}
        onClose={() => setSessionSettingsOpen(false)}
        api={session}
        disabled={sessionId === null}
      />

      <SettingsModal
        open={appSettingsOpen}
        onClose={() => {
          setAppSettingsOpen(false);
          // New providers/models only reach the picker after a state refresh.
          void session.refreshState();
        }}
        sections={[
          { id: 'models', label: '模型配置', render: () => <ModelsSection /> },
          {
            id: 'showcase',
            label: '组件库',
            render: () => <UiShowcase onAction={sendAction} themeMode={themeMode} />,
          },
        ]}
      />

      <ExtensionDialogs
        dialogs={session.dialogs}
        onRespond={(id, body) => void session.respondToDialog(id, body)}
      />

      <NotificationStack
        notifications={session.notifications}
        onDismiss={session.dismissNotification}
      />
    </Flexbox>
  );
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readTheme);
  const [renderStyle, setRenderStyle] = useState<RenderStyle>(readRenderStyle);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, themeMode);
    document.documentElement.style.colorScheme = themeMode;
    // The dsw design tokens (the sidebar/settings system) key their dark sheet
    // off this attribute.
    document.body.toggleAttribute('data-ds-dark-theme', themeMode === 'dark');
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem(RENDER_STYLE_KEY, renderStyle);
  }, [renderStyle]);

  return (
    <ThemeProvider themeMode={themeMode} enableCustomFonts={false}>
      <Shell
        themeMode={themeMode}
        renderStyle={renderStyle}
        onToggleTheme={() => setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'))}
        onRenderStyleChange={setRenderStyle}
      />
    </ThemeProvider>
  );
}
