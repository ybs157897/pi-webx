/**
 * 应用外壳：顶栏 / 左导航 / 主区 / AI 副驾四件套 + 命令面板与设置的持有者。
 *
 * 数据流不变：pi-webx SQLite 接口一次拉全量 → `data`/`profile`/`prefs`；
 * 写操作经 `mutate(action, okText)`：保存 → 重新拉 state → 轻提示。与旧版的差别：
 * 外壳拆成了 shell/ 下的独立组件，App 只做装配、快捷键与全局浮层；
 * 模块契约新增 `prefs`/`setPref`（视图偏好）、`empty`/`onLoadDemo`（首启引导）
 * 与 `askAI(text)`（把文本送进 AI 副驾并展开面板，知识库「问小台」用）。
 * `askAI` 在 pi 接口不可用时（send 走失败路径、只留底层报错）先把文本落成一条本地
 * pending 用户消息，内容不丢，错误条换成人话；pending 气泡的留存/撤销由
 * `shell/AIPanel` 导出的纯函数 `nextAskState` 决策（发送在途 ≠ 面板被清空），
 * transcript 回显成功后撤掉。
 * @module src/App
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.mjs'
import { useWorkbenchPiChat } from './pi-webx/useWorkbenchPiChat.jsx'
import { PiDialog } from './pi-webx/PiDialog.jsx'
import {
  Card, ConfirmDialog, ToastHost, useMediaQuery,
} from './ui.jsx'
import {
  IconBug, IconBook, IconCode, IconHome, IconLogs, IconMenu,
  IconRefresh, IconRequirements, IconSparkles, IconTasks, IconWorks,
} from './icons.jsx'
import { usePrefs } from './state/prefs.js'
import TopBar from './shell/TopBar.jsx'
import SideNav from './shell/SideNav.jsx'
import AIPanel, { nextAskState } from './shell/AIPanel.jsx'
import CommandPalette from './shell/CommandPalette.jsx'
import SettingsSheet from './shell/SettingsSheet.jsx'
import Dashboard from './modules/Dashboard.jsx'
import Tasks from './modules/Tasks.jsx'
import Works from './modules/Works.jsx'
import Fixes from './modules/Fixes.jsx'
import Logs from './modules/Logs.jsx'
import Requirements from './modules/Requirements.jsx'
import Codes from './modules/Codes.jsx'
import Knowledge from './modules/Knowledge.jsx'

export const APP_NAME = 'AI 指挥台'

/** 菜单注册表：左导航、底部 tab、移动端抽屉、命令面板跳转都从这里取。 */
export const MODULES = [
  { id: 'dashboard', label: '我的主页', desc: '今天的全局一屏', icon: IconHome, Component: Dashboard },
  { id: 'tasks', label: '今日规划', desc: '待办、优先级与截止日', icon: IconTasks, Component: Tasks },
  { id: 'works', label: '工作助理', desc: '待办 / 进行中 / 已完成看板', icon: IconWorks, Component: Works },
  { id: 'fixes', label: '问题修复', desc: '问题清单、优先级与状态流转', icon: IconBug, Component: Fixes },
  { id: 'logs', label: '日志查询', desc: '对话框式检索与记录开发日志', icon: IconLogs, Component: Logs },
  { id: 'requirements', label: '需求管理', desc: '需求知识库：搜索、列表与阅读视图', icon: IconRequirements, Component: Requirements },
  { id: 'codes', label: '代码开发', desc: '文件树 + 编辑器工作区', icon: IconCode, Component: Codes },
  { id: 'knowledge', label: '知识库', desc: '检索、阅读与关联沉淀的知识', icon: IconBook, Component: Knowledge },
]

/** 底部 tab 的固定三项 + 更多 + AI。 */
const TABS = ['dashboard', 'tasks', 'works']

/** AI 副驾文案：hook 的底层报错在这里换成人话（useWorkbenchPiChat 只透出 error.message）。 */
const AI_TEXT = {
  askFailed: '小台暂时连不上，这条内容没有发出去。已保留在面板里，点右上角「重试连接」恢复后再发一次。',
}

/** 「问小台」本地草稿的初始态：引用稳定，供 setAsk(ASK_IDLE) 复用。 */
const ASK_IDLE = { pending: null, failed: false }

/** 空数据兜底：`data` 归一化用（服务端字段缺失时不至于让模块崩）。 */
const EMPTY_DATA = {
  tasks: [], works: [], hotspots: [], exercises: [], meals: [], finance: [], reviews: [],
  fixes: [], logs: [], requirements: [], codes: [], knowledge: [], knowledgeBases: [], knowledgeFolders: [],
  pets: { profile: {}, records: [] },
  relationships: { profile: {}, records: [] },
}

/**
 * 把 `/api/state` 的 data 归一化成模块可以直接信任的结构。
 * @param raw - 服务端返回的 data。
 * @returns 结构完整的 data。
 */
export function normalizeData(raw) {
  if (raw === null || typeof raw !== 'object') return EMPTY_DATA
  const safeArray = key => (Array.isArray(raw[key]) ? raw[key] : [])
  const safeAtom = key => ({
    profile: typeof raw[key]?.profile === 'object' && raw[key]?.profile !== null ? raw[key].profile : {},
    records: Array.isArray(raw[key]?.records) ? raw[key].records : [],
  })
  return {
    tasks: safeArray('tasks'),
    works: safeArray('works'),
    hotspots: safeArray('hotspots'),
    exercises: safeArray('exercises'),
    meals: safeArray('meals'),
    finance: safeArray('finance'),
    reviews: safeArray('reviews'),
    fixes: safeArray('fixes'),
    logs: safeArray('logs'),
    requirements: safeArray('requirements'),
    codes: safeArray('codes'),
    knowledge: safeArray('knowledge'),
    knowledgeBases: safeArray('knowledgeBases'),
    knowledgeFolders: safeArray('knowledgeFolders'),
    pets: safeAtom('pets'),
    relationships: safeAtom('relationships'),
  }
}

export default function App() {
  const [data, setData] = useState(EMPTY_DATA)
  const [profile, setProfile] = useState({ name: '我', motto: '' })
  const [empty, setEmpty] = useState(false)
  const [activeModule, setActiveModule] = useState('dashboard')
  const [ready, setReady] = useState(false)
  const [bootError, setBootError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [toasts, setToasts] = useState([])
  const [prefs, setPref, replacePrefs] = usePrefs()
  const isMobile = useMediaQuery('(max-width: 639px)')
  const [panelOpen, setPanelOpen] = useState(() => (
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : !window.matchMedia('(max-width: 639px)').matches
  ))
  const { chat, busy, modelName, status: piStatus, send, newConversation, retry, dialog, respondToDialog } = useWorkbenchPiChat()
  // 「问小台」本地草稿：pi 不可用时 send() 内部吞掉异常、只往面板丢一条底层报错，
  // 笔记标题 / 正文会整段消失。这里先落成 pending 用户消息，回显成功后撤掉。
  const [ask, setAsk] = useState(ASK_IDLE)
  const toastId = useRef(0)

  const notify = useCallback((text, tone = 'ok') => {
    toastId.current += 1
    const id = toastId.current
    setToasts(current => [...current, { id, text, tone }])
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), 2600)
  }, [])

  /** 重新拉全量数据；`data` 与 `profile` 同属一份快照。 */
  const refresh = useCallback(async () => {
    const snapshot = await api.state()
    setData(normalizeData(snapshot.data))
    setProfile(snapshot.profile ?? { name: '我', motto: '' })
    setEmpty(snapshot.empty === true)
  }, [])

  /** 写操作统一入口：请求 → 刷新 → 反馈；失败弹错误提示，不抛给调用方。 */
  const mutate = useCallback(async (action, okText) => {
    try {
      await action()
      await refresh()
      if (okText !== undefined) notify(okText, 'ok')
      return true
    } catch (error) {
      notify(String(error?.message ?? error), 'error')
      return false
    }
  }, [notify, refresh])

  /** 模块「问小台」入口：把文本送进 AI 副驾并展开面板（空文本忽略）。 */
  const askAI = useCallback((text) => {
    const content = String(text ?? '').trim()
    if (content === '') return
    setPanelOpen(true)
    // 先落本地 pending 气泡再 send：pi 不可用时 send 走失败路径也只丢报错，不丢内容。
    setAsk({ pending: { text: content, at: Date.now() }, failed: false })
    send(content)
  }, [send])

  // pending 气泡的留存 / 撤销统一走 nextAskState（纯函数，UI 门禁直测）：
  // 发送在途时 chat 为空是正常空态、不能撤；只有回显成功或显式清空才撤；
  // send 走完失败路径（有错误条）则保留气泡并把报错换成人话。
  useEffect(() => {
    setAsk((current) => {
      const next = nextAskState(current, { chat, busy })
      // 无变化时返回原引用，React 直接 bail out，effect 不会自触发成环。
      return next.pending === current.pending && next.failed === current.failed ? current : next
    })
  }, [chat, busy])

  // 面板消息 = hook 的 chat +（失败路径下）pending 用户气泡与友好错误文案。
  const panelChat = useMemo(() => {
    const messages = ask.failed
      ? chat.map(message => (message.role === 'error'
        ? { ...message, text: AI_TEXT.askFailed }
        : message))
      : chat
    if (ask.pending === null) return messages
    const pending = {
      id: 'ask-pending', role: 'user', text: ask.pending.text, at: ask.pending.at, pending: true,
    }
    // pending 气泡排在错误条之前：先看到自己发的内容，再看到为什么没送达。
    const errorAt = messages.findIndex(message => message.role === 'error')
    return errorAt === -1
      ? [...messages, pending]
      : [...messages.slice(0, errorAt), pending, ...messages.slice(errorAt)]
  }, [ask, chat])

  // 启动：拉数据 + 偏好；偏好落到 <html>（主题/密度）。
  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const snapshot = await api.state()
        if (cancelled) return
        setData(normalizeData(snapshot.data))
        setProfile(snapshot.profile ?? { name: '我', motto: '' })
        setEmpty(snapshot.empty === true)
        replacePrefs(snapshot.prefs ?? {})
        setReady(true)
      } catch (error) {
        if (!cancelled) setBootError(String(error?.message ?? error))
      }
    }
    boot()
    return () => { cancelled = true }
  }, [replacePrefs])

  // 全局快捷键：⌘K 命令面板、⌘1-8 切模块。
  useEffect(() => {
    const onKeyDown = event => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(open => !open)
      } else if (mod && event.key >= '1' && event.key <= String(MODULES.length)) {
        event.preventDefault()
        setActiveModule(MODULES[Number(event.key) - 1].id)
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // AI 面板开合记忆在服务端偏好里（默认桌面展开）。
  const applyPanel = useCallback((open) => {
    setPanelOpen(open)
    setPref('panelOpen', open)
  }, [setPref])

  useEffect(() => {
    if (prefs.panelOpen !== undefined && !isMobile) setPanelOpen(prefs.panelOpen === true)
  }, [prefs.panelOpen, isMobile])

  const byId = useMemo(() => new Map(MODULES.map(module => [module.id, module])), [])
  const active = byId.get(activeModule) ?? MODULES[0]
  const ModuleView = active.Component
  const theme = typeof document === 'undefined' ? 'light' : (document.documentElement.dataset.theme ?? 'light')

  function openModule(id) {
    setActiveModule(id)
    setDrawerOpen(false)
    if (isMobile) setPanelOpen(false)
  }

  async function clearChat() {
    setAsk(ASK_IDLE)
    await newConversation()
    setConfirmClear(false)
    notify('已开始新对话')
  }

  async function manualRefresh() {
    try {
      await refresh()
      notify('数据已是最新')
    } catch (error) {
      notify(String(error?.message ?? error), 'error')
    }
  }

  async function exportData() {
    try {
      const state = await api.exportData()
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(state, null, 2)}\n`], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `ai-workbench-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      notify('已导出 SQLite 中的工作台数据')
    } catch (error) {
      notify(String(error?.message ?? error), 'error')
    }
  }

  async function importData(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!window.confirm('导入会覆盖本机 SQLite 中的工作台记录。请先导出备份。确定继续？')) return
    try {
      const parsed = JSON.parse(await file.text())
      await api.importData(parsed)
      await refresh()
      notify('工作台数据已导入')
    } catch (error) {
      notify(`导入失败：${String(error?.message ?? error)}`, 'error')
    }
  }

  async function loadDemo() {
    await mutate(() => api.loadDemo(), '已灌入演示数据')
  }

  async function clearAll() {
    await mutate(() => api.clearAll(), '已清空全部数据')
  }

  if (bootError !== '') {
    return (
      <div className="loading-screen">
        <Card className="boot-error">
          <p className="card-title">读取工作台数据失败</p>
          <p className="small muted" style={{ marginTop: '8px' }}>{bootError}</p>
          <button type="button" className="btn btn-primary" style={{ marginTop: '16px' }} onClick={() => window.location.reload()}>
            重试
          </button>
        </Card>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="loading-screen">
        <span className="spinner" />
        <p>正在打开工作台…</p>
      </div>
    )
  }

  return (
    <div className="app" data-panel={panelOpen ? 'open' : 'closed'}>
      <TopBar
        appName={APP_NAME}
        profileName={profile.name === '我' ? '' : profile.name}
        theme={theme}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleTheme={() => setPref('theme', theme === 'dark' ? 'light' : 'dark')}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SideNav modules={MODULES} active={activeModule} data={data} piStatus={piStatus} onNavigate={openModule} />

      <main className="main">
        <div className={`main-inner ${activeModule === 'knowledge' ? 'kb-main-inner' : ''}`}>
          <div className="page-head">
            <div>
              <h1 className="page-title">{active.label}</h1>
              <p className="page-desc">{active.desc}</p>
            </div>
            <div className="page-actions">
              <button type="button" className="icon-btn" aria-label="刷新数据" title="刷新数据" onClick={manualRefresh}>
                <IconRefresh size={17} />
              </button>
            </div>
          </div>
          <ModuleView
            data={data}
            profile={profile}
            modules={MODULES}
            mutate={mutate}
            refresh={refresh}
            notify={notify}
            navigate={openModule}
            prefs={prefs}
            setPref={setPref}
            empty={empty}
            onLoadDemo={loadDemo}
            askAI={askAI}
          />
        </div>
      </main>

      <aside className="aside" aria-label="AI 副驾">
        <AIPanel
          chat={panelChat}
          busy={busy}
          status={piStatus}
          modelName={modelName}
          onSend={send}
          onNew={() => setConfirmClear(true)}
          onRetry={retry}
          onRefreshData={manualRefresh}
          isMobile={isMobile}
          onClose={() => applyPanel(false)}
        />
      </aside>

      {/* 面板收起后的唯一入口：桌面在右下角，移动端浮在底部 tab 之上。 */}
      {panelOpen === false && (
        <button type="button" className="fab" aria-label="展开 AI 面板" title="展开 AI 面板" onClick={() => applyPanel(true)}>
          <IconSparkles size={22} />
        </button>
      )}

      <nav className="tabbar" aria-label="模块导航">
        {TABS.map(id => {
          const module = byId.get(id)
          const Icon = module.icon
          return (
            <button
              type="button"
              key={id}
              className={`tab ${activeModule === id ? 'is-active' : ''}`}
              onClick={() => openModule(id)}
            >
              <Icon size={20} />
              {module.label}
            </button>
          )
        })}
        <button type="button" className={`tab ${drawerOpen ? 'is-active' : ''}`} onClick={() => setDrawerOpen(true)}>
          <IconMenu size={20} />
          更多
        </button>
        <button type="button" className={`tab ${panelOpen ? 'is-active' : ''}`} onClick={() => setPanelOpen(true)}>
          <IconSparkles size={20} />
          AI
        </button>
      </nav>

      {drawerOpen && (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="全部功能">
          <div
            className="drawer-backdrop"
            onMouseDown={event => {
              if (event.target === event.currentTarget) setDrawerOpen(false)
            }}
          />
          <div className="drawer-panel">
            <p className="drawer-title">全部功能</p>
            <div className="drawer-grid">
              {MODULES.map(module => {
                const Icon = module.icon
                return (
                  <button
                    type="button"
                    key={module.id}
                    className={`drawer-item ${module.id === activeModule ? 'is-active' : ''}`}
                    onClick={() => openModule(module.id)}
                  >
                    <Icon size={18} />
                    {module.label}
                  </button>
                )
              })}
              <a className="drawer-item" href="/chat"><IconSparkles size={18} />完整 Pi 对话</a>
            </div>
          </div>
        </div>
      )}

      {paletteOpen && (
        <CommandPalette
          modules={MODULES}
          theme={theme}
          onNavigate={openModule}
          onOpenSettings={() => { setSettingsOpen(true); setPaletteOpen(false) }}
          onToggleTheme={() => setPref('theme', theme === 'dark' ? 'light' : 'dark')}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      <SettingsSheet
        open={settingsOpen}
        prefs={prefs}
        setPref={setPref}
        onExport={exportData}
        onImport={importData}
        onLoadDemo={loadDemo}
        onClearAll={clearAll}
        onClose={() => setSettingsOpen(false)}
      />

      <ConfirmDialog
        open={confirmClear}
        title="新对话"
        message="开始一段新对话？旧会话仍保存在 pi-webx，可以在 pi-webx 中找回。"
        confirmText="开始新对话"
        busy={busy}
        onCancel={() => setConfirmClear(false)}
        onConfirm={clearChat}
      />

      <PiDialog request={dialog} onRespond={respondToDialog} />

      <ToastHost toasts={toasts} />
    </div>
  )
}
