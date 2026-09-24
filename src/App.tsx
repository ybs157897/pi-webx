/**
 * 应用组合根：解析外观（主题偏好 + 渲染风格）并挂上会话外壳。
 *
 * 这里曾经是一个 1200 行的 god component（聊天主界面 + 全部会话逻辑）。现在它只
 * 做「接线」，拆出去的部分都在 `src/app/`：
 *
 *   - `Shell.tsx`               外壳本身（布局 + 接线；hook 次序与原文件一致）
 *   - `use-shell-state.ts`      状态名册（boot + 全部 useState 原子）
 *   - `use-shell-sync.ts`       视口断点 / 地址栏 / team 模式同步
 *   - `use-session-runtime.ts`  bridge 列表加载、地址栏会话恢复、模型派生
 *   - `use-workspace-actions.ts` 工作区增删与系统目录选择
 *   - `use-session-lifecycle.ts` 打开 / 懒创建 / 模型与推理等级写入 / 发送
 *   - `use-shell-effects.ts`    启动与轮询副作用（含引导失败屏的「重试」）
 *   - `use-workspace-rows.ts`   侧栏工作区行派生
 *   - `use-session-commands.ts` 新建 / 分叉 / 重命名
 *   - `use-shell-header.tsx`    顶栏与任务面板的展示派生 + 菜单动作
 *   - 子视图：`TopBar` / `SidebarColumn` / `ConversationSurface` / `ComposerDock`
 *     / `SessionErrorBanner` / `BootErrorScreen` / `settings-sections`
 */
import { ThemeProvider } from '@lobehub/ui';

import { Shell } from './app/Shell';
import { useAppAppearance } from './app/use-app-appearance';

export default function App() {
  const { themePreference, themeMode, renderStyle, setThemePreference, setRenderStyle } =
    useAppAppearance();

  return (
    <ThemeProvider themeMode={themeMode} enableCustomFonts={false}>
      <Shell
        themePreference={themePreference}
        themeMode={themeMode}
        renderStyle={renderStyle}
        onThemePreferenceChange={setThemePreference}
        onRenderStyleChange={setRenderStyle}
      />
    </ThemeProvider>
  );
}
