/**
 * Shell —— 会话外壳的组合点：把状态、各职责 hook 与子视图接起来。
 *
 * 这里只剩「接线」：状态名册在 `use-shell-state`，逻辑按职责散在 `use-*` 的各个
 * hook 里，可见的子视图各自一个文件。**hook 的调用次序与拆分前的 `App.tsx` 完全
 * 一致** —— 每个新 hook 只是把原来同一串 hook 换了个归属，槽位没有重排。
 */
import { Flexbox } from '@lobehub/ui';
import { theme } from 'antd';
import { useCallback } from 'react';

import { NotificationStack } from '../components/NotificationStack';
import { SessionSettings } from '../components/SessionSettings';
import { TeamPanel } from '../components/TeamPanel';
import { SettingsPage } from '../components/settings';
import { savePrefs } from '../lib/storage';
import { usePiSession } from '../lib/usePiSession';
import { useTeamSnapshot } from '../lib/useTeamSnapshot';
import { BootErrorScreen } from './BootErrorScreen';
import { ComposerDock } from './ComposerDock';
import { ConversationSurface } from './ConversationSurface';
import { SessionErrorBanner } from './SessionErrorBanner';
import { SidebarColumn } from './SidebarColumn';
import { TopBar } from './TopBar';
import type { RenderStyle, ThemeMode, ThemePreference } from './preferences';
import { settingsSections } from './settings-sections';
import { useSessionCommands } from './use-session-commands';
import { useSessionLifecycle } from './use-session-lifecycle';
import { useSessionRuntime } from './use-session-runtime';
import { useShellEffects } from './use-shell-effects';
import { useShellHeader } from './use-shell-header';
import { useShellState } from './use-shell-state';
import { useShellSync } from './use-shell-sync';
import { useWorkspaceActions } from './use-workspace-actions';
import { useWorkspaceRows } from './use-workspace-rows';

export interface ShellProps {
  /** The stored preference, which may be "follow the system". */
  themePreference: ThemePreference;
  /** The resolved theme the theme layer paints. */
  themeMode: ThemeMode;
  renderStyle: RenderStyle;
  onThemePreferenceChange: (next: ThemePreference) => void;
  onRenderStyleChange: (style: RenderStyle) => void;
}

export function Shell({
  themePreference,
  themeMode,
  renderStyle,
  onThemePreferenceChange,
  onRenderStyleChange,
}: ShellProps) {
  const { token } = theme.useToken();

  const state = useShellState();
  const {
    config, cwd, setCwd, sessionId, setSessionId,
    newSessionMode, setNewSessionMode, sessions,
    sessionSettingsOpen, setSessionSettingsOpen,
    teamPanelOpen, setTeamPanelOpen,
    appSettingsOpen, setAppSettingsOpen,
    setSidebarCollapsed,
    narrowViewport, setMobileSidebarExpanded,
    allStored, bootError, catalog,
  } = state;

  const session = usePiSession(sessionId);
  const teamState = useTeamSnapshot(sessionId, teamPanelOpen);
  const sidebarIsCollapsed = useShellSync(state, teamState);
  const runtime = useSessionRuntime(state, session);
  const workspace = useWorkspaceActions(state, session);
  const { pickWorkspace, forgetWorkspace, browseWorkspace } = workspace;
  const {
    openSession, guardedPrompt, composerApi, applyToolPreset, pendingQuestion,
  } = useSessionLifecycle(state, session, runtime);
  const { retryBoot } = useShellEffects(state, runtime);
  const { sessionToolPreset, loadCatalog } = runtime;
  const workspaces = useWorkspaceRows(state);
  const commands = useSessionCommands(state, session, runtime, workspace);
  const { onNewSession, onForkSession, onRenameSession } = commands;
  const { title, contextPercent, todos, menuItems, onMenuClick } = useShellHeader(state, session, commands);

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
    return <BootErrorScreen error={bootError} onRetry={retryBoot} />;
  }

  const empty = session.transcript.entries.length === 0;

  return (
    <Flexbox
      horizontal
      style={{ height: '100vh', overflow: 'hidden', background: token.colorBgLayout }}
    >
      <SidebarColumn
        collapsed={sidebarIsCollapsed}
        onToggle={() => {
          if (narrowViewport) setMobileSidebarExpanded((prev) => !prev);
          else setSidebarCollapsed((prev) => !prev);
        }}
        piVersion={config?.piVersion ?? null}
        onNewSession={() => { onNewSession(); }}
        onOpenSettings={() => { setAppSettingsOpen(true); }}
        home={config?.home}
        workspaces={workspaces}
        live={sessions}
        stored={allStored}
        currentId={sessionId}
        onSwitch={(id) => { setMobileSidebarExpanded(false); setNewSessionMode('chat'); setSessionId(id); }}
        onNewSessionAt={(path) => { onNewSession(path); }}
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

      <Flexbox style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <TopBar
          session={session}
          title={title}
          narrowViewport={narrowViewport}
          menuItems={menuItems}
          onMenuClick={onMenuClick}
          showTeamTag={teamState.snapshot !== null || (sessionId === null && newSessionMode === 'team')}
          sessionId={sessionId}
          onOpenTeamPanel={() => setTeamPanelOpen(true)}
          onOpenSessionSettings={() => setSessionSettingsOpen(true)}
        />

        {session.error !== null && <SessionErrorBanner message={session.error} />}

        {/* A blank session is one centered surface: the welcome sits directly
            above the composer, the composer lands mid-screen, and the spacer
            below it is the space the transcript will grow into. Keeping the
            composer in the same child slot across both layouts is what stops a
            first send from remounting it (and dropping the draft). */}
        <ConversationSurface
          empty={empty}
          sessionId={sessionId}
          mode={sessionId === null ? newSessionMode : teamState.snapshot ? 'team' : 'chat'}
          onModeChange={sessionId === null ? setNewSessionMode : undefined}
          cwd={cwd}
          transcript={session.transcript}
          onAction={sendAction}
          renderStyle={renderStyle}
        />

        <ComposerDock
          session={session}
          api={composerApi}
          catalog={catalog}
          toolPreset={sessionToolPreset}
          onToolPresetChange={applyToolPreset}
          contextPercent={contextPercent}
          empty={empty}
          cwd={cwd}
          workspacePaths={workspaces.map(({ key }) => key)}
          home={config?.home}
          onPickWorkspace={(path) => {
            pickWorkspace(path);
            setCwd(path);
            setSessionId(null);
          }}
          onBrowseWorkspace={browseWorkspace}
          todos={todos}
          pendingQuestion={pendingQuestion}
        />
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
        sections={settingsSections({
          themePreference,
          onThemePreferenceChange,
          renderStyle,
          onRenderStyleChange,
          sessionId,
          themeMode,
          onAction: sendAction,
        })}
      />

      <NotificationStack
        notifications={session.notifications}
        onDismiss={session.dismissNotification}
      />
    </Flexbox>
  );
}
