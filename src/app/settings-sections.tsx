/**
 * 设置页的分区清单：常规（外观 + 渲染器）、模型、子智能体、组件库。
 *
 * 分区是数据、由 `SettingsPage` 按 `group` 首次出现排序渲染，所以清单在这里拼好，
 * shell 只负责开关与数据来源。
 */
import {
  AgentDefinitionsSection,
  GeneralSettings,
  ModelsSection,
} from '../components/settings';
import type { SettingsSection } from '../components/settings';
import { UiShowcase } from '../components/uikit/UiShowcase';
import type { RenderStyle, ThemeMode, ThemePreference } from './preferences';

export interface SettingsSectionsArgs {
  themePreference: ThemePreference;
  onThemePreferenceChange: (next: ThemePreference) => void;
  renderStyle: RenderStyle;
  onRenderStyleChange: (next: RenderStyle) => void;
  sessionId: string | null;
  themeMode: ThemeMode;
  /** 渲染组件动作回灌给 pi 的路径（组件库的演示按钮用）。 */
  onAction: (action: string) => void;
}

export function settingsSections({
  themePreference,
  onThemePreferenceChange,
  renderStyle,
  onRenderStyleChange,
  sessionId,
  themeMode,
  onAction,
}: SettingsSectionsArgs): SettingsSection[] {
  return [
    {
      id: 'general',
      label: '常规',
      group: '基础设置',
      title: '通用设置',
      render: () => (
        <GeneralSettings
          themeMode={themePreference}
          onThemeModeChange={onThemePreferenceChange}
          renderStyle={renderStyle}
          onRenderStyleChange={onRenderStyleChange}
        />
      ),
    },
    {
      id: 'models',
      label: '模型设置',
      group: '基础设置',
      title: '模型设置',
      render: () => <ModelsSection />,
    },
    {
      id: 'agents',
      label: '子智能体',
      group: '基础设置',
      title: '子智能体',
      /* The tool catalog is per-session, so the section takes the session
         the app already has; `undefined` before the first message, which
         the section answers by listing built-in tools only. */
      render: () => <AgentDefinitionsSection sessionId={sessionId ?? undefined} />,
    },
    {
      id: 'showcase',
      label: '组件库',
      group: '更多',
      title: '组件库',
      render: () => <UiShowcase onAction={onAction} themeMode={themeMode} />,
    },
  ];
}
