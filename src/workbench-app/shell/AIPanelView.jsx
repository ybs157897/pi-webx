/**
 * 全屏 AI 对话浮层：展开后占据整屏、正文列居中（900px，与 /chat 正文同源）。
 *
 * 正文渲染不再自绘气泡，直接复用 /chat 的 TranscriptView——简洁模式（对齐
 * deepseek-harness 的「工作步骤展示 · 简洁」）随它一并到位：过程（思考 + 工具 +
 * 中间回复）折叠成摘要行、最终答案永不折叠、单段过程手动展开。输出规范见
 * docs/workbench-ai-chat-compact-mode.md，两处共用同一实现，不会漂移。
 * 「工作步骤展示」的四档模式由设置面板写进 prefs，App 解析后经 `stepsMode` 传进来，
 * 面板只做透传（不解释枚举，折叠策略全在 TranscriptView 的 presentation policy 里）。
 *
 * 工作台本地兜底（「问小台」pending 气泡 / 软提示 / 错误条）钉在输入框上方的
 * 固定条里：不滚进正文、永远可见。`pending` 用户气泡（App 的「问小台」失败兜底）：
 * 内容已上屏但还没送达，带「未送达」脚标——pi 不可用时用户也看得见自己刚发了什么。
 *
 * 模块可以往正文与输入框之间挂一块自己的结构面板（`dock`，如我的助理的安排建议确认卡）；
 * 不传时面板结构与旧行为逐字节一致，/chat 与其它使用方不受影响。
 *
 * 附件能力由 `supportsImages` 开关（默认 false）：打开后输入框出现回形针入口，可加图片
 * （走既有 PiImage 内联管线）与文本文件（发送时内联进消息，见 shell/composer-attachments.mjs），
 * 也支持把文件直接拖进输入区（拖拽悬浮层提示「放开以添加」）；文件以卡片展示（类型角标 +
 * 文件名 + 类型标签），准入错误钉在输入框上方；关闭时 DOM 与旧版一致，只是发送按钮把
 * 「空附件」也计入可发送条件。
 * @module shell/AIPanel
 */

import { useEffect } from 'react'
import { ThemeProvider } from '@lobehub/ui'
import { QuestionComposer } from '../../components/QuestionComposer'
import { TranscriptView } from '../../components/TranscriptView'
import AssistantMarkdown from '../pi-webx/AssistantMarkdown.jsx'
import { IconClose, IconPlus, IconRefresh, IconSparkles } from '../icons.jsx'
import { formatStamp } from '../util.mjs'
import AgentComposer from './AgentComposer.jsx'
import { QueueDock } from '../../components/QueueDock'

/**
 * 「问小台」pending 气泡的状态机（纯函数：App 的 askAI 兜底与 UI 门禁共用一份逻辑）。
 *
 * 输入当前态 `{ pending, failed }`（pending = 本地草稿 `{text, at}`，null = 没有）与面板
 * 观测值 `{ chat, busy }`（chat = hook 投影的消息列表，busy = 发送是否在途），返回下一步。
 *
 * 关键区分**发送在途**与**面板被清空**：pi 不可用时 send 要先空跑一截才把错误落进 chat，
 * 这段在途期 transcript 还是空的是正常空态。早前版本把「chat 为空」一律当成面板被清空，
 * 气泡在点击后约 150ms 被自己撤掉，随后错误才落进 chat、askFailed 再也置不上，稳态只剩
 * 原始报错。现在空态只有不在发送途中才撤销；其余按「回显成功 → 撤」「有错误 → 留 + 失败」
 * 「其他 → 继续等」处理。
 * @param current - 当前 `{ pending, failed }`。
 * @param observe - `{ chat, busy }` 面板观测值。
 * @returns 下一步的 `{ pending, failed }`（无变化时返回等价新对象，由调用方做引用比较）。
 */
export function nextAskState(current, observe = {}) {
  const pending = current?.pending ?? null
  if (pending === null) return { pending: null, failed: false }
  const messages = Array.isArray(observe.chat) ? observe.chat : []
  const busy = observe.busy === true
  // 回显：transcript 出现同文本的用户消息 = 内容已进会话，草稿使命完成。
  if (messages.some(message => message?.role === 'user' && message?.text === pending.text)) {
    return { pending: null, failed: false }
  }
  // 在途：既没回显也没错误，等着——此刻 chat 为空只是还没开始落 transcript。
  if (busy) return { pending, failed: false }
  // 空闲且面板空：只有显式新对话会把 transcript 清空，草稿一并撤。
  if (messages.length === 0) return { pending: null, failed: false }
  // 空闲且有错误条：send 走完了失败路径——草稿留着上屏，错误换成人话。
  if (messages.some(message => message?.role === 'error')) return { pending, failed: true }
  // 空闲且有其他内容（例如助手还在回复、本条尚未回显）：继续等。
  return { pending, failed: false }
}

const TEXT = {
  assistant: '小台',
  clearChat: '新对话',
  close: '收起对话（Esc）',
  send: '发送',
  retry: '重试连接',
  thinking: '小台正在想…',
  sendPlaceholder: '和小台说点什么…（Enter 发送，Shift+Enter 换行）',
  pending: '未送达：小台还没连上',
  welcome: '小台已就位',
  welcomeText: '工作台记录保存在本机 SQLite。我可以回答问题、陪你梳理需求与计划；记录数据的读写还在逐步开放。',
  suggestions: ['帮我拟一份今日计划', '最近有哪些待修复的问题？', '如何安排一周运动？'],
  connecting: '小台连接中…',
  idle: '小台待命',
  retryHint: '连接失败',
  stopHint: '回复中…',
  refresh: '刷新数据',
}

/**
 * 输入框上方的本地兜底条：pending 气泡 / 软提示 / 错误条都是工作台自己叠的状态，
 * 不属于会话 transcript，固定钉在这里（不随正文滚动，永远看得见）。
 */
function FallbackRows({ rows, onRetry }) {
  if (rows.length === 0) return null
  return (
    <div className="ai-fallback" data-testid="chat-fallback">
      {rows.map((message) => {
        const time = formatStamp(message.at)
        if (message.role === 'notice') {
          return <p className="small muted ai-fallback-note" key={message.id}>💡 {message.text}</p>
        }
        if (message.role === 'user') {
          return (
            <div className={`msg ${message.role}`} key={message.id}>
              <div className="bubble" data-testid="chat-msg-bubble" data-pending={message.pending === true ? 'true' : undefined}>
                <AssistantMarkdown text={message.text} />
                {message.pending === true && (
                  <p className="small muted" style={{ marginTop: 'var(--sp-2)' }}>{TEXT.pending}</p>
                )}
              </div>
              {time !== '' && <span className="msg-time">{time}</span>}
            </div>
          )
        }
        return (
          <div className="msg error" key={message.id} data-testid="chat-msg-error">
            <p className="bubble">
              <span>⚠️ {message.text}</span>
              {message.retry && (
                <button type="button" className="btn btn-sm" onClick={onRetry}>{TEXT.retry}</button>
              )}
            </p>
          </div>
        )
      })}
    </div>
  )
}

export default function AIPanel({
  transcript, assistRows, busy, status, modelName, themeMode, stepsMode, dialog, onRespondDialog, onSend, onNew, onRetry, onRefreshData, onAction, onClose,
  // 模块 Agent 复用本外壳时的三个可选项：title 换掉「小台」名，subtitle 换掉
  // live 状态行的「Pi Agent」前缀（如「日志 Agent · gpt-…」），emptyExtra
  // 渲染在空态欢迎语下方（能力卡）。不传则与旧行为完全一致。
  title, subtitle, emptyExtra, onStop, stopping, sendDisabled, onUpdateQueue, canNewConversation, draft, onDraftChange, welcomeText, suggestions, inputPlaceholder, embedded = false,
  // 挂件槽：渲染在正文与输入框之间（模块自带的结构面板，如安排建议确认卡）。
  // 不传 / 传 null 时正文与输入框之间不出现任何节点；/chat 与其它使用方零影响。
  dock = null,
  // 模块自带首页内容；输入框保持挂载，发送、提问和草稿逻辑仍共用。
  emptyState, composerLeading, composerFooter,
  // 附件开关：打开后输入框出现回形针（图片 + 文本文件），默认关闭时输入区与旧版一致。
  supportsImages = false,
}) {
  // Esc 关闭：与命令面板/抽屉一致的键盘出口（渲染期不碰 window，SSR 纯渲染安全）。
  useEffect(() => {
    if (embedded || typeof onClose !== 'function' || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, embedded])

  const statusText = status === 'live'
    ? `${subtitle ?? 'Pi Agent'} · ${modelName}`
    : status === 'connecting' ? `${title ?? TEXT.assistant}连接中…` : status === 'idle' ? `${title ?? TEXT.assistant}待命` : TEXT.retryHint

  const entries = Array.isArray(transcript?.entries) ? transcript.entries : []
  const rows = Array.isArray(assistRows) ? assistRows : []
  const queued = Array.isArray(transcript?.queued?.pending) ? transcript.queued.pending : []
  const running = transcript?.running === true
  const connecting = status === 'connecting'
  const steerQueued = typeof onUpdateQueue === 'function' ? async () => {
    for (const row of queued) await onUpdateQueue(row.id, { kind: 'steer' })
  } : undefined
  const isEmpty = entries.length === 0 && transcript?.running !== true && (emptyState == null || (!busy && !dialog))

  // 正文走 antd/lobehub 令牌（与 /chat 同一套），外面用 ThemeProvider 对齐工作台主题，
  // 暗色模式下不会出现浅色气泡。
  return (
    <ThemeProvider themeMode={themeMode === 'dark' ? 'dark' : 'light'}>
      <div className={`ai-overlay${embedded ? ' ai-overlay-embedded' : ''}`} role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : 'true'} aria-label={embedded ? `${title ?? TEXT.assistant}对话` : 'AI 对话'} data-testid="ai-overlay" data-empty={isEmpty ? 'true' : 'false'}>
        <div className="ai-overlay-surface">
        <header className="aside-head">
          <span className="aside-avatar"><IconSparkles size={17} /></span>
          <div className="grow">
            <p className="aside-title">{title ?? TEXT.assistant}</p>
            <p className="aside-sub">
              <span className={`status-dot ${status === 'live' ? '' : status === 'connecting' ? 'connecting' : 'off'}`} />
              {busy && !connecting ? `${title ?? TEXT.assistant}正在处理…` : statusText}
            </p>
          </div>
          <div className="aside-actions">
            <button type="button" className="icon-btn" aria-label={TEXT.refresh} title={TEXT.refresh} onClick={onRefreshData}>
              <IconRefresh size={17} />
            </button>
            <button type="button" className="icon-btn" data-testid="module-agent-new" aria-label={TEXT.clearChat} title={queued.length ? '请先处理排队消息再新建对话' : TEXT.clearChat} disabled={busy || queued.length > 0 || canNewConversation === false} onClick={onNew}>
              <IconPlus size={17} />
            </button>
            {!embedded && <button type="button" className="icon-btn" aria-label={TEXT.close} title={TEXT.close} onClick={onClose}>
              <IconClose size={18} />
            </button>}
          </div>
        </header>

        <div className="chat-scroll" data-testid="chat-scroll">
          {connecting && entries.length === 0 && !running
            ? <p className="small muted" role="status" data-testid="module-agent-connecting">正在连接{title ?? TEXT.assistant}…</p>
            : isEmpty
            ? (
              emptyState ??
              <div className="chat-empty">
                <span className="empty-icon"><IconSparkles size={22} /></span>
                <div>
                  <p className="chat-empty-title">{title ? `${title}已就位` : TEXT.welcome}</p>
                  <p className="chat-empty-text">{welcomeText ?? TEXT.welcomeText}</p>
                </div>
                {emptyExtra}
                <div className="suggest">
                  {(suggestions ?? TEXT.suggestions).map(question => (
                    <button type="button" className="suggest-item" key={question} disabled={busy} onClick={() => onSend(question)}>
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            )
            : <TranscriptView transcript={transcript} mode={stepsMode} onAction={onAction} />}
        </div>

        {dock}

        <div className="composer">
          {busy && !connecting && (
            <div className="typing">
              <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
              {TEXT.stopHint}
            </div>
          )}
          <FallbackRows rows={rows} onRetry={onRetry} />
          {typeof onUpdateQueue === 'function' && queued.length > 0 && <div className="module-agent-queue" data-testid="module-agent-queue" aria-label="待发送消息">
            <QueueDock items={queued} running={running}
              onSteer={id => onUpdateQueue(id, { kind: 'steer' })}
              onEdit={(id, text) => onUpdateQueue(id, { kind: 'edit', text })}
              onRemove={id => onUpdateQueue(id, { kind: 'remove' })} />
          </div>}
          {/* dsh 的提问形态：问题占据输入框的座位（同一 QuestionComposer，与 /chat 同源，
              不弹窗）。Composer 保持挂载只是隐藏——草稿跨问题存活；问题作答完即还位。 */}
          <div style={dialog ? { display: 'none' } : undefined}>
            <AgentComposer busy={busy} sendDisabled={sendDisabled} running={running} onSend={onSend} onStop={onStop} stopping={stopping} onSteerQueued={steerQueued} draft={draft} onDraftChange={onDraftChange} placeholder={inputPlaceholder} leading={composerLeading} visible={!dialog} supportsImages={supportsImages} />
          </div>
          {dialog && (
            <QuestionComposer
              key={dialog.request.id}
              dialog={dialog}
              onRespond={(body) => { void onRespondDialog(dialog.request.id, body) }}
            />
          )}
          {isEmpty && composerFooter}
        </div>
        </div>
      </div>
    </ThemeProvider>
  )
}
