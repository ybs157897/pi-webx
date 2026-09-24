/**
 * 外观与侧栏的本地偏好：类型、`localStorage` 键、读取函数与侧栏几何常量。
 *
 * 这些值只存在浏览器里，不进 pi 的 `settings.json` —— 与 `src/lib/storage.ts`
 * 的分工一致：那边记工作区，这边记外观。
 *
 * 所有 reader 都在函数体内访问 `window` / `localStorage`：App 这条模块图在模块级
 * 不碰 `window`（见 `scripts/check-task-panel.ts` 的说明），导入本文件不该把这一点
 * 变差。
 */

/** The stored preference; `system` resolves against the OS at render time. */
export type ThemePreference = 'light' | 'dark' | 'system';
/** What the theme layer actually paints. */
export type ThemeMode = 'light' | 'dark';
/** Which engine renders agent UI inline — ours, or TokUI. */
export type RenderStyle = 'ours' | 'tokui';

export const THEME_KEY = 'pi-webx-theme';
export const RENDER_STYLE_KEY = 'pi-webx-render-style';
export const SIDEBAR_COLLAPSED_KEY = 'pi-webx-sidebar-collapsed';

/** Expanded sidebar column width (px); the rail is 56. */
export const SIDEBAR_WIDTH = 260;
/** Matches the dsh AppFrame track transition the collapse crossfade rides on. */
export const SIDEBAR_SLIDE_MS = 300;

export function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** dsh offers Apperance as light / dark / follow-the-system; so does this. */
export function readTheme(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

export function readRenderStyle(): RenderStyle {
  return localStorage.getItem(RENDER_STYLE_KEY) === 'tokui' ? 'tokui' : 'ours';
}

export function readSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
}
