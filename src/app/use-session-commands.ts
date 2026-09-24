/**
 * 会话命令：新建（只是退到空状态，pi 进程由首条消息创建）、分叉（复制转写并打开
 * 新会话）、重命名（写给会话自己，再刷新列表）。
 */
import { useCallback } from 'react';

import { api as bridge } from '../lib/api';
import type { PiSessionApi } from '../lib/usePiSession';
import { errorText } from './connection';
import type { SessionRuntime } from './use-session-runtime';
import type { NewSessionMode, ShellState } from './use-shell-state';
import type { WorkspaceActions } from './use-workspace-actions';

export type SessionCommands = ReturnType<typeof useSessionCommands>;

export function useSessionCommands(
  state: ShellState,
  session: PiSessionApi,
  runtime: SessionRuntime,
  workspace: WorkspaceActions,
) {
  const { setCwd, setSessionId, setNewSessionMode, setTeamPanelOpen, setMobileSidebarExpanded } = state;
  const { refreshSessions, loadStored } = runtime;
  const { pickWorkspace } = workspace;

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

  return { onNewSession, onForkSession, onRenameSession };
}
