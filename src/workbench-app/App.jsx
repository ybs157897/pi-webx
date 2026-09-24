/**
 * 应用外壳：三栏布局（左菜单 / 中详情 / 右 AI 面板）、模块路由、全量 state 的持有者。
 *
 * 数据流：pi-webx SQLite 接口一次拉全量 → `data`/`profile` 两个顶层状态；
 * 任何写操作都经 `mutate(action, okText)`：保存 → 重新拉 state → 轻提示。
 * 右侧对话使用独立的 pi-webx 会话客户端，不充当模块数据权威；
 * 面板正文复用 /chat 那套 @lobehub/ui Markdown（pi-webx/AssistantMarkdown.jsx），渲染与正文一致。
 * 模块统一 props：`data`、`profile`、`mutate`、`refresh`、`notify`、`navigate`、`modules`。
 * @module src/App
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.mjs'
import { useWorkbenchPiChat } from './pi-webx/useWorkbenchPiChat.jsx'
import AssistantMarkdown from './pi-webx/AssistantMarkdown.jsx'
import { PiDialog } from './pi-webx/PiDialog.jsx'
import {
  Card, ConfirmDialog, IconButton, Modal, ToastHost, useMediaQuery,
} from './ui.jsx'
import {
  IconClose, IconCode, IconHome, IconLogs, IconMenu, IconPanel,
  IconPlus, IconRefresh, IconRequirements, IconSend, IconSparkles, IconTasks, IconWorks, IconBug,
} from './icons.jsx'
import { formatStamp } from './util.mjs'
import Dashboard from './modules/Dashboard.jsx'
import Tasks from './modules/Tasks.jsx'
import Works from './modules/Works.jsx'
import Fixes from './modules/Fixes.jsx'
import Logs from './modules/Logs.jsx'
import Requirements from './modules/Requirements.jsx'
import Codes from './modules/Codes.jsx'

/** 菜单注册表：左侧菜单、移动端抽屉、底部 tab、主页动态卡片都从这里取。 */
const MODULES = [
  { id: 'dashboard', label: '我的主页', desc: '今天的全局一屏', icon: IconHome, Component: Dashboard },
  { id: 'tasks', label: '今日规划', desc: '待办、优先级与截止日', icon: IconTasks, Component: Tasks },
  { id: 'works', label: '工作助理', desc: '待办 / 进行中 / 已完成看板', icon: IconWorks, Component: Works },
  { id: 'fixes', label: '问题修复', desc: '问题清单、严重程度与状态流转', icon: IconBug, Component: Fixes },
  { id: 'logs', label: '日志查询', desc: '对话框式检索与记录开发日志', icon: IconLogs, Component: Logs },
  { id: 'requirements', label: '需求管理', desc: '需求知识库：搜索、列表与阅读视图', icon: IconRequirements, Component: Requirements },
  { id: 'codes', label: '代码开发', desc: '文件树 + 编辑器工作区', icon: IconCode, Component: Codes },
]

/** 底部 tab 的固定四项 + AI 入口。 */
const TABS = ['dashboard', 'tasks', 'works']

/** 空数据兜底：`data` 归一化用（服务端字段缺失时不至于让模块崩）。 */
const EMPTY_DATA = {
  tasks: [], works: [], hotspots: [], exercises: [], meals: [], finance: [], reviews: [],
  fixes: [], logs: [], requirements: [], codes: [],
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
  toolFull: '完整输出',
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
    fixes: safeArray('fixes'),
    logs: safeArray('logs'),
    requirements: safeArray('requirements'),
    codes: safeArray('codes'),
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

      <div className="chat-scroll" ref={scrollRef} data-testid="chat-scroll">
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
        <p className="small muted">全部模块的数据保存在本机 SQLite。直接导入旧版 JSON 不包含图片文件；配套 pi-webx 的迁移脚本可连同旧图片一起搬迁，原文件不会被修改。</p>
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

/** 工具行短预览：取第一行、折叠空白、截到 160 字；空输出返回空串（免得渲染出孤零零的「· 」）。 */
function previewOf(output) {
  const first = String(output ?? '').split('\n')[0] ?? ''
  const flat = first.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

/**
 * 工具活动行：一行摘要 + 可展开的完整输出。
 * assistant 消息附属的 tools 与独立的 toolResult 消息共用它——
 * useWorkbenchPiChat 会为每条 toolResult 单独发一条 role:'tool' 消息，
 * 只渲染其中一条路径会让完整输出在真实会话里几乎看不到。
 */
function ToolRows({ tools }) {
  const items = Array.isArray(tools) ? tools : []
  if (items.length === 0) return null
  return (
    <div className="msg tool" data-testid="chat-tool-row">
      {items.map((tool, index) => {
        const summary = previewOf(tool.output)
        return (
          <div className="tool-entry" key={`${tool.name}-${index}`} data-testid="chat-tool-entry">
            <p className="tool-line">
              <span aria-hidden="true">🔧</span>
              <span className="tool-name">{tool.name}</span>
              {summary !== '' && <span className="tool-summary">· {summary}</span>}
            </p>
            {tool.output !== '' && (
              <details className="tool-details" data-testid="chat-tool-details">
                <summary>{TEXT.toolFull}</summary>
                <pre className="tool-output">{tool.output}</pre>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 一条聊天记录：用户气泡（正文走 Markdown）、助手正文（无气泡，与 /chat 一致）、
 * 工具行、错误气泡。
 * @param props - `message` 为 chatLog 或本地流式拼出来的消息。
 * @returns 消息元素。
 */
function ChatMessage({ message }) {
  const time = formatStamp(message.at)
  if (message.role === 'tool') return <ToolRows tools={message.tools} />
  return (
    <div className={`msg ${message.role}`} data-testid={`chat-msg-${message.role}`}>
      <ToolRows tools={message.tools} />
      {message.text !== '' && (message.role === 'error'
        ? <p className="bubble">{message.text}</p>
        : message.role === 'user'
          ? (
            <div className="bubble" data-testid="chat-msg-bubble">
              <AssistantMarkdown text={message.text} />
            </div>
          )
          : (
            <div className="msg-body" data-testid="chat-msg-body">
              <AssistantMarkdown text={message.text} />
            </div>
          ))}
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
