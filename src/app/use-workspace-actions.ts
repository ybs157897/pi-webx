/**
 * 工作区列表的动作：选中（同时解除隐藏）、从列表移除（记成隐藏）、以及让桥接所在
 * 的机器弹系统目录选择器。
 *
 * 两个列表的加减法都在这里，因为「移除」只能表达为对派生列表的减法，见
 * `use-shell-state` 的 `hiddenWorkspaces` 说明。
 */
import { useCallback } from 'react';

import { api as bridge } from '../lib/api';
import { savePrefs } from '../lib/storage';
import type { PiSessionApi } from '../lib/usePiSession';
import { errorText } from './connection';
import type { ShellState } from './use-shell-state';

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;

export function useWorkspaceActions(state: ShellState, session: PiSessionApi) {
  const { cwd, setCwd, setSessionId, setSavedWorkspaces, setHiddenWorkspaces } = state;

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

  return { pickWorkspace, forgetWorkspace, browseWorkspace };
}
