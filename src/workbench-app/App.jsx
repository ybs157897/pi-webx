/**
 * 应用外壳：三栏布局（左菜单 / 中详情 / 右 AI 面板）、模块路由、全量 state 的持有者。
 *
 * 数据流：pi-webx SQLite 接口一次拉全量 → `data`/`profile` 两个顶层状态；
 * 任何写操作都经 `mutate(action, okText)`：保存 → 重新拉 state → 轻提示。
 * 右侧对话使用独立的 pi-webx 会话客户端，不充当模块数据权威。
 * 模块统一 props：`data`、`profile`、`mutate`、`refresh`、`notify`、`navigate`、`modules`。
 * @module src/App
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.mjs'
import { useWorkbenchPiChat } from './pi-webx/useWorkbenchPiChat.jsx'
import { PiDialog } from './pi-webx/PiDialog.jsx'
import {
  Card, ConfirmDialog, IconButton, Modal, ToastHost, useMediaQuery,
} from './ui.jsx'
import {
  IconClose, IconHeart, IconHome, IconMeal, IconMenu, IconPanel, IconPaw, IconRefresh, IconReview,
  IconPlus, IconRun, IconSend, IconSparkles, IconTasks, IconTrend, IconWallet, IconWorks,
} from './icons.jsx'
import { formatStamp } from './util.mjs'
import Dashboard from './modules/Dashboard.jsx'
import Tasks from './modules/Tasks.jsx'
import Works from './modules/Works.jsx'
import Hotspots from './modules/Hotspots.jsx'
import Exercises from './modules/Exercises.jsx'
import Meals from './modules/Meals.jsx'
import Finance from './modules/Finance.jsx'
import Pets from './modules/Pets.jsx'
import Relationships from './modules/Relationships.jsx'
import Reviews from './modules/Reviews.jsx'

/** 菜单注册表：左侧菜单、移动端抽屉、底部 tab、主页动态卡片都从这里取。 */
const MODULES = [
  { id: 'dashboard', label: '我的主页', desc: '今天的全局一屏', icon: IconHome, Component: Dashboard },
  { id: 'tasks', label: '今日规划', desc: '待办、优先级与截止日', icon: IconTasks, Component: Tasks },
  { id: 'works', label: '工作助理', desc: '待办 / 进行中 / 已完成看板', icon: IconWorks, Component: Works },
  { id: 'hotspots', label: '行业热点', desc: '值得留意的消息卡片', icon: IconTrend, Component: Hotspots },
  { id: 'exercises', label: '运动打卡', desc: '时长记录与趋势', icon: IconRun, Component: Exercises },
  { id: 'meals', label: '饮食记录', desc: '热量与餐次明细', icon: IconMeal, Component: Meals },
  { id: 'finance', label: '本月收支', desc: '流水、分类与结余', icon: IconWallet, Component: Finance },
  { id: 'pets', label: '宠物日记', desc: '资料卡与时间轴', icon: IconPaw, Component: Pets },
  { id: 'relationships', label: '亲密关系', desc: '纪念日与心情记录', icon: IconHeart, Component: Relationships },
  { id: 'reviews', label: '每日复盘', desc: '收获、教训与明日打算', icon: IconReview, Component: Reviews },
]

/** 底部 tab 的固定四项 + AI 入口。 */
const TABS = ['dashboard', 'tasks', 'works']

/** 空数据兜底：`data` 归一化用（服务端字段缺失时不至于让模块崩）。 */
const EMPTY_DATA = {
  tasks: [], works: [], hotspots: [], exercises: [], meals: [], finance: [], reviews: [],
  pets: { profile: {}, records: [] },
  relationships: { profile: {}, records: [] },
}

const TEXT = {
  appName: 'AI 个人工作台',
  assistant: '小台',
  assistantRole: 'Pi Agent',
  clearChat: '新对话',
  clearConfirm: '开始一段新对话？旧会话仍保存在 pi-webx，可以在 pi-webx 中找回。',
  collapse: '收起 AI 面板',
  expand: '展开 AI 面板',
  more: '更多',
  menu: '全部功能',
  close: '关闭',
  retry: '重试',
  loading: '正在打开工作台…',
  bootFailed: '读取工作台数据失败',
  sendPlaceholder: '和小台说点什么…（Enter 发送，Shift+Enter 换行）',
  send: '发送',
  thinking: '小台正在想…',
  welcome: 'Pi Agent 已接入',
  welcomeText: '工作台记录保存在本机 SQLite。当前对话使用 pi-webx 会话，尚不能直接读取或修改这些记录。',
  suggestions: ['介绍一下你能做什么', '帮我拟一份今日计划', '如何安排一周运动？'],
  chatEmpty: '还没有对话，下面几个问题可以先试试',
  stopHint: '回复中…',
  busy: '上一轮还没结束，稍等一下',
  refresh: '刷新数据',
  refreshed: '数据已是最新',
  clear: '已开始新对话',
  tools: '工具',
}

/**
 * 把 `/api/state` 的 data 归一化成模块可以直接信任的结构。
 * 这是网络 + 持久化文件边界，字段缺失只在这里补一次，模块内部不再做防御性判断。
 * @param raw - 服务端返回的 data。
 * @returns 结构完整的 data。
 */
function normalizeData(raw) {
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
    pets: safeAtom('pets'),
    relationships: safeAtom('relationships'),
  }
}

export default function App() {
  const [data, setData] = useState(EMPTY_DATA)
  const [profile, setProfile] = useState({ name: '我', motto: '' })
  const [activeModule, setActiveModule] = useState('dashboard')
  const [ready, setReady] = useState(false)
  const [bootError, setBootError] = useState('')
  // 首帧就按屏宽定面板开合：手机端若先渲染成展开，会闪一下全屏浮层。
  const [panelOpen, setPanelOpen] = useState(() => (
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : !window.matchMedia('(max-width: 639px)').matches
  ))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [toasts, setToasts] = useState([])
  const [confirmClear, setConfirmClear] = useState(false)
  const [dataToolsOpen, setDataToolsOpen] = useState(false)
  const { chat, busy, modelName, status: piStatus, send, newConversation, dialog, respondToDialog } = useWorkbenchPiChat()
  const isMobile = useMediaQuery('(max-width: 639px)')
  const scrollRef = useRef(null)
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

  // 启动：从 pi-webx SQLite 服务拉取工作台数据；Pi 会话由独立 hook 恢复。
  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const snapshot = await api.state()
        if (cancelled) return
        setData(normalizeData(snapshot.data))
        setProfile(snapshot.profile ?? { name: '我', motto: '' })
        setReady(true)
      } catch (error) {
        if (!cancelled) setBootError(String(error?.message ?? error))
      }
    }
    boot()
    return () => { cancelled = true }
  }, [])

  // 手机端默认收起 AI 面板（右下角悬浮按钮唤出），回到宽屏默认展开。
  useEffect(() => {
    setPanelOpen(!isMobile)
  }, [isMobile])

  // 新消息进来滚到底部。
  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [chat, busy])

  // 移动端抽屉：Esc 关闭（模态框自己处理，抽屉是手写的，需要补上）。
  useEffect(() => {
    if (!drawerOpen) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  const byId = useMemo(() => new Map(MODULES.map(module => [module.id, module])), [])
  const active = byId.get(activeModule) ?? MODULES[0]
  const ModuleView = active.Component

  function openModule(id) {
    setActiveModule(id)
    setDrawerOpen(false)
    if (isMobile) setPanelOpen(false)
  }

  async function clearChat() {
    newConversation()
    setConfirmClear(false)
    notify(TEXT.clear)
  }

  async function manualRefresh() {
    try {
      await refresh()
      notify(TEXT.refreshed, 'ok')
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
    event.target.value = ''
    if (!file) return
    if (!window.confirm('导入会覆盖本机 SQLite 中的工作台记录。请先导出备份。确定继续？')) return
    try {
      const parsed = JSON.parse(await file.text())
      await api.importData(parsed)
      await refresh()
      setDataToolsOpen(false)
      notify('工作台数据已导入')
    } catch (error) {
      notify(`导入失败：${String(error?.message ?? error)}`, 'error')
    }
  }

  if (bootError !== '') {
    return (
      <div className="loading-screen">
        <Card className="boot-error">
          <p className="card-title">{TEXT.bootFailed}</p>
          <p className="small muted" style={{ marginTop: '8px' }}>{bootError}</p>
          <button type="button" className="btn btn-primary" style={{ marginTop: '16px' }} onClick={() => window.location.reload()}>
            {TEXT.retry}
          </button>
        </Card>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="loading-screen">
        <span className="spinner" />
        <p>{TEXT.loading}</p>
      </div>
    )
  }

  /** AI 面板在桌面与手机是同一个组件，只有外层定位不同。 */
  const chatPanel = (
    <>
      <header className="aside-head">
        <span className="aside-avatar"><IconSparkles size={18} /></span>
        <div className="grow">
          <p className="aside-title">{TEXT.assistant}</p>
          <p className="aside-sub">
            <span className={`status-dot ${piStatus === 'live' ? '' : 'off'}`} />
            {busy ? TEXT.thinking : `${TEXT.assistantRole} · ${piStatus === 'live' ? modelName : '待连接'}`}
          </p>
        </div>
        <div className="aside-actions">
          <IconButton label={TEXT.refresh} onClick={manualRefresh}><IconRefresh size={17} /></IconButton>
          <IconButton label={TEXT.clearChat} onClick={() => setConfirmClear(true)}><IconPlus size={17} /></IconButton>
          {!isMobile && (
            <IconButton label={TEXT.collapse} onClick={() => setPanelOpen(false)}><IconPanel size={17} /></IconButton>
          )}
          {isMobile && (
            <IconButton label={TEXT.close} onClick={() => setPanelOpen(false)}><IconClose size={18} /></IconButton>
          )}
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {chat.length === 0 && (
          <div className="chat-empty">
            <span className="empty-icon"><IconSparkles size={22} /></span>
            <div>
              <p className="chat-empty-title">{TEXT.welcome}</p>
              <p className="chat-empty-text">{TEXT.welcomeText}</p>
            </div>
            <div className="suggest">
              {TEXT.suggestions.map(question => (
                <button type="button" className="suggest-item" key={question} onClick={() => send(question)}>
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.map(message => <ChatMessage key={message.id} message={message} />)}
      </div>

      <div className="composer">
        {busy && (
          <div className="typing">
            <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
            {TEXT.stopHint}
          </div>
        )}
        <Composer busy={busy} onSend={send} />
      </div>
    </>
  )

  return (
    <div className="app" data-panel={panelOpen ? 'open' : 'closed'}>
      <header className="topbar">
        <div className="grow">
          <p className="topbar-title">{active.label}</p>
          <p className="topbar-sub">{active.desc}</p>
        </div>
        <IconButton label={TEXT.menu} onClick={() => setDrawerOpen(true)}><IconMenu size={20} /></IconButton>
      </header>

      <nav className="sidebar" aria-label={TEXT.menu}>
        <div className="brand">
          <span className="brand-mark"><IconSparkles size={18} /></span>
          <span className="brand-text">
            <span className="brand-name">{TEXT.appName}</span>
            <span className="brand-sub">{profile.name}</span>
          </span>
        </div>
        <ul className="nav">
          {MODULES.map(module => {
            const Icon = module.icon
            return (
              <li key={module.id}>
                <button
                  type="button"
                  className={`nav-item ${module.id === activeModule ? 'is-active' : ''}`}
                  onClick={() => openModule(module.id)}
                  title={module.label}
                  aria-current={module.id === activeModule ? 'page' : undefined}
                >
                  <span className="nav-icon"><Icon size={19} /></span>
                  <span className="nav-label">{module.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="sidebar-foot">
          <span className={`status-dot ${piStatus === 'live' ? '' : 'off'}`} />
          <span>{TEXT.assistant}{busy ? TEXT.thinking : piStatus === 'live' ? '已连接' : '待连接'}</span>
        </div>
        <a className="pi-full-chat-link" href="/chat"><IconSparkles size={17} />完整 Pi 对话</a>
      </nav>

      <main className="main">
        <div className="main-inner">
          <div className="page-head">
            <div>
              <h1 className="page-title">{active.label}</h1>
              <p className="page-desc">{active.desc}</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setDataToolsOpen(true)}>数据导入/导出</button>
          </div>
          <ModuleView
            data={data}
            profile={profile}
            modules={MODULES}
            mutate={mutate}
            refresh={refresh}
            notify={notify}
            navigate={openModule}
          />
        </div>
      </main>

      <aside className="aside" aria-label={`AI 助理 ${TEXT.assistant}`}>
        {chatPanel}
      </aside>

      {/* 面板收起后的唯一入口：桌面在右下角，移动端浮在底部 tab 之上。 */}
      {panelOpen === false && (
        <button type="button" className="fab" aria-label={TEXT.expand} title={TEXT.expand} onClick={() => setPanelOpen(true)}>
          <IconSparkles size={22} />
        </button>
      )}

      <nav className="tabbar" aria-label={TEXT.menu}>
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
          {TEXT.more}
        </button>
        <button type="button" className={`tab ${panelOpen ? 'is-active' : ''}`} onClick={() => setPanelOpen(true)}>
          <IconSparkles size={20} />
          AI
        </button>
      </nav>

      {drawerOpen && (
        <div className="drawer" role="dialog" aria-modal="true" aria-label={TEXT.menu}>
          <div
            className="drawer-backdrop"
            onMouseDown={event => {
              if (event.target === event.currentTarget) setDrawerOpen(false)
            }}
          />
          <div className="drawer-panel">
            <p className="drawer-title">{TEXT.menu}</p>
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
              <a className="drawer-item pi-full-chat-drawer" href="/chat"><IconSparkles size={18} />完整 Pi 对话</a>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        title={TEXT.clearChat}
        message={TEXT.clearConfirm}
        confirmText="开始新对话"
        busy={busy}
        onCancel={() => setConfirmClear(false)}
        onConfirm={clearChat}
      />

      <Modal open={dataToolsOpen} title="SQLite 数据" onClose={() => setDataToolsOpen(false)}>
        <p className="small muted">十个模块的数据保存在本机 SQLite。直接导入旧版 JSON 不包含图片文件；配套 pi-webx 的迁移脚本可连同旧图片一起搬迁，原文件不会被修改。</p>
        <div className="form-row" style={{ marginTop: '16px' }}>
          <button type="button" className="btn" onClick={exportData}>导出 JSON 备份</button>
          <label className="btn" style={{ cursor: 'pointer' }}>
            导入工作台 JSON
            <input type="file" accept=".json,application/json" onChange={importData} style={{ display: 'none' }} />
          </label>
        </div>
      </Modal>

      <PiDialog request={dialog} onRespond={respondToDialog} />

      <ToastHost toasts={toasts} />
    </div>
  )
}

/**
 * 一条聊天记录：用户气泡、管家气泡、工具活动行、错误气泡。
 * @param props - `message` 为 chatLog 或本地流式拼出来的消息。
 * @returns 消息元素。
 */
function ChatMessage({ message }) {
  const time = formatStamp(message.at)
  if (message.role === 'tool') {
    const items = Array.isArray(message.tools) ? message.tools : []
    return (
      <div className="msg tool">
        {items.map((tool, index) => (
          <p className="tool-line" key={`${tool.name}-${index}`}>
            <span aria-hidden="true">🔧</span>
            <span className="tool-name">{tool.name}</span>
            {tool.summary !== '' && <span className="tool-summary">· {tool.summary}</span>}
          </p>
        ))}
      </div>
    )
  }
  return (
    <div className={`msg ${message.role}`}>
      {Array.isArray(message.tools) && message.tools.length > 0 && (
        <div className="msg tool">
          {message.tools.map((tool, index) => (
            <p className="tool-line" key={`${tool.name}-${index}`}>
              <span aria-hidden="true">🔧</span>
              <span className="tool-name">{tool.name}</span>
              {tool.summary !== '' && <span className="tool-summary">· {tool.summary}</span>}
            </p>
          ))}
        </div>
      )}
      {message.text !== '' && <p className="bubble">{message.text}</p>}
      {time !== '' && <span className="msg-time">{time}</span>}
    </div>
  )
}

/** 输入框：Enter 发送、Shift+Enter 换行，高度随内容自增到上限。 */
function Composer({ busy, onSend }) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  function submit() {
    const text = value.trim()
    if (text === '' || busy) return
    setValue('')
    onSend(text)
  }

  return (
    <div className="composer-box">
      <textarea
        ref={inputRef}
        className="composer-input"
        rows={1}
        value={value}
        placeholder={TEXT.sendPlaceholder}
        aria-label={TEXT.sendPlaceholder}
        onChange={event => {
          setValue(event.target.value)
          const node = event.target
          node.style.height = 'auto'
          node.style.height = `${Math.min(132, node.scrollHeight)}px`
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <button
        type="button"
        className="send-btn"
        aria-label={TEXT.send}
        title={TEXT.send}
        disabled={busy || value.trim() === ''}
        onClick={submit}
      >
        <IconSend size={17} />
      </button>
    </div>
  )
}
