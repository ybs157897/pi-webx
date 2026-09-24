/**
 * 应用级外观状态：主题偏好（含「跟随系统」的实时解析）、渲染风格，以及把两者写回
 * `localStorage` / `document` 的副作用。`App` 唯一需要自己持有的状态就是这一份。
 */
import { useEffect, useState } from 'react';

import {
  RENDER_STYLE_KEY,
  THEME_KEY,
  prefersDark,
  readRenderStyle,
  readTheme,
  type RenderStyle,
  type ThemeMode,
  type ThemePreference,
} from './preferences';

export interface AppAppearance {
  /** The stored preference, which may be "follow the system". */
  themePreference: ThemePreference;
  /** The theme the theme layer actually paints. */
  themeMode: ThemeMode;
  renderStyle: RenderStyle;
  setThemePreference: (next: ThemePreference) => void;
  setRenderStyle: (next: RenderStyle) => void;
}

export function useAppAppearance(): AppAppearance {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readTheme);
  const [renderStyle, setRenderStyle] = useState<RenderStyle>(readRenderStyle);
  // Re-resolve when the OS flips, so "follow the system" is live rather than a
  // decision taken at boot.
  const [systemDark, setSystemDark] = useState(prefersDark);

  useEffect(() => {
    if (themePreference !== 'system') return;
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => { setSystemDark(event.matches) };
    query.addEventListener('change', onChange);
    return () => { query.removeEventListener('change', onChange) };
  }, [themePreference]);

  const themeMode: ThemeMode =
    themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference;

  useEffect(() => {
    localStorage.setItem(THEME_KEY, themePreference);
    document.documentElement.style.colorScheme = themeMode;
    // The dsw design tokens (the sidebar/settings system) key their dark sheet
    // off this attribute.
    document.body.toggleAttribute('data-ds-dark-theme', themeMode === 'dark');
  }, [themeMode, themePreference]);

  useEffect(() => {
    localStorage.setItem(RENDER_STYLE_KEY, renderStyle);
  }, [renderStyle]);

  return { themePreference, themeMode, renderStyle, setThemePreference, setRenderStyle };
}
