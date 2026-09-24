/**
 * 侧栏工作区行的派生：当前目录 → 已存列表 → 服务端建议 → 有会话的目录，做并集后
 * 减去用户移除过的路径。
 *
 * 五个来源取并正是「移除」必须记成减法（`hiddenWorkspaces`）的原因：任何一路都
 * 会在下一次渲染把行加回来，行本身只带展示事实，分组与排序交给 `WorkspaceBrowser`。
 */
import { useMemo } from 'react';

import { workspaceLabel } from '../components/sidebar/tree';
import type { WorkspaceItem } from '../components/sidebar/tree';
import type { ShellState } from './use-shell-state';

export function useWorkspaceRows(state: ShellState): WorkspaceItem[] {
  const { boot, config, cwd, savedWorkspaces, hiddenWorkspaces, sessions, allStored } = state;

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

  return workspaces;
}
