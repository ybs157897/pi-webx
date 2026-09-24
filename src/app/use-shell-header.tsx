/**
 * Shell 顶栏与任务面板要读的展示事实：当前会话行、标题、上下文占用、任务表，以及
 * 顶栏菜单的条目与点击动作。
 *
 * 它们都从转写/会话列表派生，放在一节是因为顶栏的控件（标题、状态标签、菜单）与
 * composer 上方的任务面板读的是同一批派生值。
 */
import { useCallback, useMemo } from 'react';
import {
  Copy,
  Download,
  Eraser,
  GitBranch,
  MessageSquarePlus,
  UsersRound,
} from 'lucide-react';

import { todosForPanel } from '../components/TaskPanel';
import type { PiSessionApi } from '../lib/usePiSession';
import type { SessionCommands } from './use-session-commands';
import type { ShellState } from './use-shell-state';

export type ShellHeader = ReturnType<typeof useShellHeader>;

export function useShellHeader(state: ShellState, session: PiSessionApi, commands: SessionCommands) {
  const { cwd, sessionId, sessions } = state;
  const { onNewSession, onForkSession } = commands;

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

  /**
   * 面板看的任务表。等价于 dsh 的 `todos` 投影：每次渲染重扫整篇转写，所以按
   * 输入（转写 + widget）记忆化，而不是按 session 对象 —— 后者每次事件都换引用。
   */
  const todos = useMemo(
    () => todosForPanel(session.transcript.entries, session.widgets),
    [session.transcript.entries, session.widgets],
  );

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

  return { title, contextPercent, todos, menuItems, onMenuClick };
}
