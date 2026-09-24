/**
 * Shell 级同步副作用：视口断点决定的侧栏形态、地址栏里的会话地址、以及 team 模式
 * 跟随服务端会话快照。三者都是「外部事实 → 状态」的单向同步，故合成一节。
 *
 * 返回的 `sidebarIsCollapsed` 就是原来那一行 memo：窄屏看移动端展开开关，宽屏看
 * 记忆的折叠偏好。
 */
import { useEffect } from 'react';

import type { useTeamSnapshot } from '../lib/useTeamSnapshot';
import type { ShellState } from './use-shell-state';

/** `useTeamSnapshot` 的返回形状（`TeamSnapshotState` 未导出，取返回类型）。 */
type TeamState = ReturnType<typeof useTeamSnapshot>;

export function useShellSync(state: ShellState, teamState: TeamState): boolean {
  const {
    sidebarCollapsed,
    narrowViewport, setNarrowViewport,
    mobileSidebarExpanded, setMobileSidebarExpanded,
    sessionId, newSessionMode, setNewSessionMode,
  } = state;

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

  return sidebarIsCollapsed;
}
