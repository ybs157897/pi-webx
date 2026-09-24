/**
 * 左侧导航：模块注册表的唯一渲染处（桌面）。每项带「待办计数」徽章——
 * 徽章让导航本身成为仪表盘：不用点进去就知道哪里有事。
 * @module shell/SideNav
 */

import { IconSparkles } from '../icons.jsx'

/** 每个模块的徽章口径：未完成 / 进行中的事项数；主页不显示；知识库无完成态，计条目总数。 */
export function badgeOf(moduleId, data) {
  const open = (list) => (Array.isArray(list) ? list.filter(item => item.status !== undefined ? item.status !== 'done' : !item.done).length : 0)
  switch (moduleId) {
    case 'tasks': return Array.isArray(data.tasks) ? data.tasks.filter(item => !item.done).length : 0
    case 'works': return open(data.works)
    case 'fixes': return open(data.fixes)
    case 'logs': return Array.isArray(data.logs) ? data.logs.filter(item => item.date >= new Date().toISOString().slice(0, 10)).length : 0
    case 'requirements': return open(data.requirements)
    case 'codes': return open(data.codes)
    case 'knowledge': return Array.isArray(data.knowledge) ? data.knowledge.length : 0
    default: return 0
  }
}

export default function SideNav({ modules, active, data, piStatus, onNavigate }) {
  return (
    <nav className="sidebar" aria-label="模块导航">
      <ul className="nav">
        {modules.map(module => {
          const Icon = module.icon
          const badge = badgeOf(module.id, data)
          return (
            <li key={module.id}>
              <button
                type="button"
                className={`nav-item ${module.id === active ? 'is-active' : ''}`}
                onClick={() => onNavigate(module.id)}
                title={module.desc}
                aria-current={module.id === active ? 'page' : undefined}
              >
                <span className="nav-icon"><Icon size={18} /></span>
                <span className="nav-label">{module.label}</span>
                {badge > 0 && <span className="nav-badge">{badge > 99 ? '99+' : badge}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="sidebar-foot">
        <span className="pi-status">
          <span className={`status-dot ${piStatus === 'live' ? '' : piStatus === 'connecting' ? 'connecting' : 'off'}`} />
          {piStatus === 'live' ? '小台已连接' : piStatus === 'connecting' ? '小台连接中' : piStatus === 'idle' ? '小台待命' : '小台待连接'}
        </span>
        <a className="pi-full-chat-link" href="/chat"><IconSparkles size={15} />完整 Pi 对话</a>
      </div>
    </nav>
  )
}
