/**
 * 顶栏：品牌（修复了旧版「AI 个人工作台老 Yin」连写）、命令面板入口、
 * 主题快切、设置入口。⌘K 的全局监听在 App，这里只负责显式点击入口。
 * @module shell/TopBar
 */

import { IconMoon, IconSearch, IconSettings, IconSparkles, IconSun } from '../icons.jsx'

export default function TopBar({ appName, profileName, theme, onOpenPalette, onToggleTheme, onOpenSettings }) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark"><IconSparkles size={17} /></span>
        <span className="brand-text">
          <span className="brand-name">{appName}</span>
          {profileName !== '' && <span className="brand-sub">{profileName}</span>}
        </span>
      </div>

      <button type="button" className="topbar-search" onClick={onOpenPalette} aria-label="搜索或执行命令">
        <IconSearch size={15} />
        <span>搜索记录、跳转模块、执行命令…</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="topbar-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={nextTheme === 'dark' ? '切换到暗色主题' : '切换到亮色主题'}
          title={nextTheme === 'dark' ? '切换到暗色主题' : '切换到亮色主题'}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
        </button>
        <button type="button" className="icon-btn" aria-label="设置" title="设置" onClick={onOpenSettings}>
          <IconSettings size={18} />
        </button>
      </div>
    </header>
  )
}
