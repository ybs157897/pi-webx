/**
 * Shell 的启动与轮询副作用：读 bridge 配置并记住工作区、按 5s 轮询会话与磁盘转写
 * 两份列表、随工作区重读模型目录、把侧栏折叠写回 `localStorage`。
 *
 * 引导失败屏的「重试」也在这里（`retryBoot`）：它和启动副作用是同一条加载路径，
 * 原本在 JSX 里把同一串调用抄了第二遍。
 */
import { useEffect } from 'react';

import { savePrefs } from '../lib/storage';
import { errorText, loadBootConfig } from './connection';
import { SIDEBAR_COLLAPSED_KEY } from './preferences';
import type { SessionRuntime } from './use-session-runtime';
import type { ShellState } from './use-shell-state';

export type ShellEffects = ReturnType<typeof useShellEffects>;

export function useShellEffects(state: ShellState, runtime: SessionRuntime) {
  const { boot, cwd, sidebarCollapsed, setConfig, setCwd, setBootError } = state;
  const { refreshSessions, loadCatalog, loadStored } = runtime;

  /* Boot: discover defaults and remember the workspace. No session is created
     here — sending the first message is what materializes one. */
  useEffect(() => {
    void (async () => {
      try {
        const { config: loaded, cwd: target } = await loadBootConfig(boot.cwd);
        setConfig(loaded);
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

  /** 引导失败屏的「重试」：成功则清掉错误，失败则把新错误写回。 */
  const retryBoot = (): void => {
    void (async () => {
      try {
        const { config: loaded, cwd: target } = await loadBootConfig(boot.cwd);
        setConfig(loaded);
        setCwd(target);
        savePrefs({ cwd: target });
        setBootError(null);
      } catch (cause) {
        setBootError(errorText(cause));
      }
    })();
  };

  return { retryBoot };
}
