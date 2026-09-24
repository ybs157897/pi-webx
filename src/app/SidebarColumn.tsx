/**
 * 侧栏列：滑动的定宽列（折叠动画）+ `SidebarRoot` 的骨架 + 交给它的
 * `WorkspaceBrowser` 浏览区。
 *
 * 列宽与动画时长来自 `preferences`；折叠状态由 shell 决定（宽屏看记忆的偏好，
 * 窄屏看移动端展开开关）。
 */
import type { SessionSummary, StoredSession } from '../shared/protocol';
import { SidebarRoot } from '../components/sidebar/SidebarRoot';
import { WorkspaceBrowser } from '../components/sidebar/WorkspaceBrowser';
import type { SessionNode, WorkspaceItem } from '../components/sidebar/tree';
import { SIDEBAR_SLIDE_MS, SIDEBAR_WIDTH } from './preferences';

export interface SidebarColumnProps {
  collapsed: boolean;
  onToggle: () => void;
  piVersion: string | null;
  onNewSession: () => void;
  onOpenSettings: () => void;
  home: string | undefined;
  workspaces: readonly WorkspaceItem[];
  live: readonly SessionSummary[];
  stored: readonly StoredSession[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  /** 在某个工作区里新建会话（工作区行上的动作）。 */
  onNewSessionAt: (path: string) => void;
  onRename: (id: string, name: string) => void;
  onResume: (entry: StoredSession) => void;
  onFork: (node: SessionNode) => void;
  onPickWorkspace: (path: string) => void;
  onSetDefault: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
  onBrowseWorkspace: () => void;
}

export function SidebarColumn({
  collapsed,
  onToggle,
  piVersion,
  onNewSession,
  onOpenSettings,
  home,
  workspaces,
  live,
  stored,
  currentId,
  onSwitch,
  onNewSessionAt,
  onRename,
  onResume,
  onFork,
  onPickWorkspace,
  onSetDefault,
  onForgetWorkspace,
  onBrowseWorkspace,
}: SidebarColumnProps) {
  return (
    /* The sliding column: fixed-width tracks that animate the collapse while
        the shell freezes its content at the expanded width and crossfades. */
    <div
      style={{
        flex: 'none',
        height: '100%',
        overflow: 'hidden',
        width: collapsed ? 56 : SIDEBAR_WIDTH,
        transition: `width ${SIDEBAR_SLIDE_MS}ms var(--ds-ease-in-out, ease-in-out)`,
        borderRight: '1px solid var(--dsw-alias-border-l2)',
      }}
    >
      <SidebarRoot
        width={SIDEBAR_WIDTH}
        collapsed={collapsed}
        onToggle={onToggle}
        piVersion={piVersion}
        onNewSession={onNewSession}
        onOpenSettings={onOpenSettings}
        region={(wide, expandSidebar) => (
          <WorkspaceBrowser
            wide={wide}
            expandSidebar={expandSidebar}
            home={home}
            workspaces={workspaces}
            live={live}
            stored={stored}
            currentId={currentId}
            onSwitch={onSwitch}
            onNewSession={onNewSessionAt}
            onRename={onRename}
            onResume={onResume}
            onFork={onFork}
            onPickWorkspace={onPickWorkspace}
            onSetDefault={onSetDefault}
            onForgetWorkspace={onForgetWorkspace}
            onBrowseWorkspace={onBrowseWorkspace}
          />
        )}
      />
    </div>
  );
}
