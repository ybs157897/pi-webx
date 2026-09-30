/** 内部群聊按 seq 排序，只渲染公开正文与回复关系。 */
import { useEffect, useRef, useState } from 'react'
import { parseChatroomMentions } from '../../../shared/chatroom-mentions.mjs'
import ChatroomComposer from './Composer.jsx'
import ChatroomTaskBoard from './TaskBoard.jsx'
import { useChatroom } from './useChatroom.js'
import { useChatroomComposer } from './useChatroomComposer.js'
import { useChatroomContext } from './useChatroomContext.js'
import { useChatroomTaskActions } from './useChatroomTaskActions.js'
import './Chatroom.css'

const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
})
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
})

function messageDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date)
}

function messageTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : TIME_FORMAT.format(date)
}

function avatarLetter(name) {
  return Array.from(name || '?')[0] || '?'
}

function avatarTone(id, members) {
  const index = members.findIndex(member => member.id === id)
  if (index >= 0) return index % 4
  return Array.from(String(id || '')).reduce((sum, char) => sum + char.codePointAt(0), 0) % 4
}

function deliveryLabel(message) {
  if (message.deliveryStatus === 'pending') {
    return message.recipientId === null ? '等待认领' : '待接收'
  }
  if (message.deliveryStatus === 'running') return '处理中'
  if (message.deliveryStatus === 'failed') {
    const consumptions = message.consumptions
    if (Array.isArray(consumptions) && consumptions.length > 0
      && consumptions.every(item => item.status === 'skipped')) return '无人认领'
    return '投递失败'
  }
  return ''
}

const CONSUMPTION_LABELS = {
  pending: '待接收',
  evaluating: '判断中',
  processing: '处理中',
  consumed: '已消费并回复',
  skipped: '未认领',
  failed: '消费失败',
}

function ConsumptionStatus({ consumptions, memberNames }) {
  if (!Array.isArray(consumptions) || consumptions.length === 0) return null
  return <ul className="chatroom-consumptions" aria-label="成员消费情况" data-testid="chatroom-consumptions">
    {consumptions.map(consumption => <li
      className="chatroom-consumption" key={consumption.agentId}
      data-testid="chatroom-consumption" data-agent-id={consumption.agentId} data-status={consumption.status}
    >
      <span className="chatroom-consumption-main">
        <strong>{consumption.agentName || memberNames.get(consumption.agentId) || consumption.agentId}</strong>
        <span>{CONSUMPTION_LABELS[consumption.status] || '状态未知'}</span>
      </span>
      {consumption.status === 'failed' && consumption.error && <span className="chatroom-consumption-error">
        {String(consumption.error).slice(0, 120)}
      </span>}
    </li>)}
  </ul>
}

function terminalConsumptions(message) {
  const completed = (Array.isArray(message.consumptions) ? message.consumptions : [])
    .filter(item => item.status === 'consumed' || item.status === 'failed')
    .map(item => [item.agentId, item.status])
    .sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify(completed)
}

export function chatroomRefreshDelta(previous, messages) {
  const next = new Map(messages.map(message => [message.seq, {
    deliveryStatus: message.deliveryStatus,
    terminalConsumptions: terminalConsumptions(message),
  }]))
  const changed = messages.some(message => {
    const prior = previous.get(message.seq)
    const current = next.get(message.seq)
    return !prior
      || (prior.deliveryStatus !== current.deliveryStatus
        && (message.deliveryStatus === 'delivered' || message.deliveryStatus === 'failed'))
      || prior.terminalConsumptions !== current.terminalConsumptions
  })
  return { changed, next }
}

function bodyContent(body) {
  const text = String(body ?? '')
  const mentions = parseChatroomMentions(text).mentions.filter(mention => mention.id)
  if (mentions.length === 0) return text
  const parts = []
  let at = 0
  for (const mention of mentions) {
    if (mention.start < at) continue
    parts.push(text.slice(at, mention.start))
    parts.push(<span className="chatroom-body-mention" key={mention.start}>{text.slice(mention.start, mention.end)}</span>)
    at = mention.end
  }
  parts.push(text.slice(at))
  return parts
}

function topicTitle(messages, tasks, threadId, taskId) {
  if (!threadId) return '新话题'
  const task = tasks.find(item => item.id === taskId && item.threadId === threadId)
  if (task?.title) return task.title
  const first = messages.find(message => message.threadId === threadId)
  return first?.body ? String(first.body).replace(/\s+/g, ' ').slice(0, 52) : '继续当前讨论'
}

export function ChatroomIcon({ size = 18, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 9.1 9.1 0 0 1-3.4-.7L3 21l1.7-5.1A8.5 8.5 0 1 1 20.5 11.5Z" />
    <path d="M7.7 11.5h8.6M7.7 14.7h5.5" />
  </svg>
}

export function ChatroomView({
  room = { id: 'internal', name: '内部聊天室' }, members = [], messages = [], tasks = [],
  syncStatus = 'online', error = '', onRetry = () => {},
  viewportRef, onScroll, unseenCount = 0, onJumpToLatest = () => {},
  onReply = () => {}, onContinueThread = () => {}, onNewTopic = () => {},
  context = { threadId: null, taskId: null }, taskBoardProps = {}, composerProps = {},
}) {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq)
  const memberNames = new Map(members.map(member => [member.id, member.name]))
  const messageById = new Map(ordered.map(message => [message.id, message]))
  const selectedTopicTitle = topicTitle(ordered, tasks, context.threadId, context.taskId)
  let previousDate = ''

  return <section className="chatroom-workspace" data-module="chatroom" data-testid="chatroom-workspace" aria-label={room.name}>
    <header className="chatroom-header">
      <div className="chatroom-heading">
        <h2 data-testid="chatroom-title">{room.name}</h2>
        <p>{members.length} 位成员 · 模块间协作记录</p>
      </div>
      <div className="chatroom-sync" role="status" data-testid="chatroom-sync" data-status={syncStatus}>
        <span className="chatroom-sync-dot" aria-hidden="true" />
        {syncStatus === 'loading' ? '正在同步' : syncStatus === 'error' ? '同步中断' : '已同步'}
      </div>
    </header>
    {members.length > 0 && <div className="chatroom-members" aria-label="聊天室成员" data-testid="chatroom-members">
      {members.map(member => <span className="chatroom-member" key={member.id} title={member.name}>
        <span className={`chatroom-member-avatar tone-${avatarTone(member.id, members)}`} aria-hidden="true">{avatarLetter(member.name)}</span>
        <span>{member.name}</span>
      </span>)}
    </div>}
    <div className="chatroom-topic" data-testid="chatroom-topic" data-mode={context.threadId ? 'continue' : 'new'}>
      <div className="chatroom-topic-copy">
        <strong>{context.threadId ? '当前话题 · 可继续' : '准备发起新话题'}</strong>
        <span data-testid="chatroom-topic-title">{selectedTopicTitle}</span>
      </div>
      <button type="button" onClick={onNewTopic} data-testid="chatroom-new-topic">新话题</button>
    </div>
    <ChatroomTaskBoard tasks={tasks} members={members} selectedTaskId={context.taskId} {...taskBoardProps} />
    {error && <div className="chatroom-error" role="alert" data-testid="chatroom-error">
      <span>{error}</span>
      <button type="button" onClick={onRetry} data-testid="chatroom-retry">重试</button>
    </div>}
    <div className="chatroom-timeline-wrap">
      <div className="chatroom-timeline" ref={viewportRef} onScroll={onScroll} data-testid="chatroom-timeline" aria-label="群聊记录">
        {ordered.length === 0 && <div className="chatroom-empty" data-testid="chatroom-empty">
          <div className="chatroom-empty-mark" aria-hidden="true">•••</div>
          <strong>{syncStatus === 'loading' ? '正在读取聊天记录' : '这里还没有聊天记录'}</strong>
          <p>直接说清要做的事即可，各位成员会按职责自行认领；也可 @需求管理 等点名指定接手者。</p>
        </div>}
        <ol className="chatroom-message-list" data-testid="chatroom-message-list">
          {ordered.map(message => {
            const date = messageDate(message.createdAt)
            const showDate = date !== previousDate
            previousDate = date
            const sender = message.senderName || memberNames.get(message.senderId) || '未知成员'
            const recipient = memberNames.get(message.recipientId)
            const own = message.senderId === 'user'
            const status = deliveryLabel(message)
            const replied = message.replyTo ? messageById.get(message.replyTo) : null
            return <li className={`chatroom-entry${own ? ' is-self' : ''}`} key={message.id || message.seq} data-testid="chatroom-message" data-seq={message.seq}>
              {showDate && <div className="chatroom-date" data-testid="chatroom-date">{date}</div>}
              <article className="chatroom-message">
                <span className={`chatroom-avatar tone-${avatarTone(message.senderId, members)}`} aria-hidden="true">{avatarLetter(sender)}</span>
                <div className="chatroom-message-content">
                  <div className="chatroom-message-meta">
                    <strong data-testid="chatroom-sender">{sender}</strong>
                    {recipient && <span className="chatroom-recipient">发给 {recipient}</span>}
                    <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                    {!own && <button type="button" className="chatroom-reply-button" onClick={() => onReply(message)} aria-label={`回复${sender}`} data-testid="chatroom-reply">回复</button>}
                    {message.threadId && <button type="button" className="chatroom-reply-button" onClick={() => onContinueThread(message)}
                      aria-label={`继续${sender}所在的话题`} data-testid="chatroom-continue-thread">继续话题</button>}
                  </div>
                  <div className="chatroom-bubble" data-testid="chatroom-body">
                    {replied && <div className="chatroom-reply-quote" data-testid="chatroom-reply-quote">回复 {replied.senderName || '群成员'}：{String(replied.body || '').slice(0, 80)}</div>}
                    <p>{bodyContent(message.body)}</p>
                  </div>
                  {status && <span className={`chatroom-delivery is-${message.deliveryStatus}`} data-testid="chatroom-delivery">
                    {status}{message.deliveryStatus === 'failed' && message.error ? `：${String(message.error).slice(0, 120)}` : ''}
                  </span>}
                  <ConsumptionStatus consumptions={message.consumptions} memberNames={memberNames} />
                </div>
              </article>
            </li>
          })}
        </ol>
      </div>
      {unseenCount > 0 && <button className="chatroom-new-messages" type="button" onClick={onJumpToLatest} data-testid="chatroom-jump-latest">
        {unseenCount} 条新消息 · 回到底部
      </button>}
    </div>
    <ChatroomComposer {...composerProps} members={members} topicTitle={selectedTopicTitle}
      hasCurrentTopic={Boolean(context.threadId)} onNewTopic={onNewTopic} />
  </section>
}

export default function Chatroom({ refresh }) {
  const feed = useChatroom()
  const topic = useChatroomContext(feed.room.id, feed.messages, feed.tasks, feed.syncStatus)
  const routeReady = feed.syncStatus === 'online' && topic.ready && topic.context.mode !== 'loading'
    && (topic.context.mode !== 'auto' || feed.messages.length === 0)
  const composer = useChatroomComposer(feed.members, feed, { ...topic.sendRoute, ready: routeReady }, topic.onSent, feed.room.id)
  const taskActions = useChatroomTaskActions(feed)
  const viewportRef = useRef(null)
  const nearBottomRef = useRef(true)
  const lastSeqRef = useRef(0)
  const observedStatusesRef = useRef(new Map())
  const observedTasksRef = useRef('')
  const refreshTimerRef = useRef(null)
  const [unseenCount, setUnseenCount] = useState(0)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const newest = feed.messages.at(-1)?.seq || 0
    if (newest > lastSeqRef.current) {
      if (nearBottomRef.current) {
        viewport.scrollTop = viewport.scrollHeight
        setUnseenCount(0)
      } else {
        const count = feed.messages.filter(message => message.seq > lastSeqRef.current).length
        setUnseenCount(current => current + count)
      }
    }
    lastSeqRef.current = newest
  }, [feed.messages])

  useEffect(() => {
    const { changed, next } = chatroomRefreshDelta(observedStatusesRef.current, feed.messages)
    observedStatusesRef.current = next
    const tasksSignature = JSON.stringify(feed.tasks.map(task => [task.id, task.version, task.status,
      task.assignments?.map(assignment => [assignment.agentId, assignment.status])]))
    const tasksChanged = observedTasksRef.current !== tasksSignature
    observedTasksRef.current = tasksSignature
    if ((changed || tasksChanged) && typeof refresh === 'function') {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => { void Promise.resolve().then(refresh).catch(() => {}) }, 250)
    }
  }, [feed.messages, feed.tasks, refresh])

  useEffect(() => () => clearTimeout(refreshTimerRef.current), [])

  function onScroll() {
    const viewport = viewportRef.current
    if (!viewport) return
    nearBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
    if (nearBottomRef.current) setUnseenCount(0)
  }

  function jumpToLatest() {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    nearBottomRef.current = true
    setUnseenCount(0)
  }

  function onNewTopic() {
    composer.onCancelReply()
    topic.newTopic()
    composer.focusInput()
  }

  function onContinueThread(message) {
    composer.onCancelReply()
    topic.selectMessage(message)
    composer.focusInput()
  }

  function onSelectTask(task, agentId = null) {
    composer.onCancelReply()
    topic.selectTask(task, agentId)
    if (agentId) composer.onTargetAgent(agentId)
    composer.focusInput()
  }

  function onReply(message) {
    topic.selectMessage(message)
    composer.onReply(message)
  }

  function onTaskAction(task, action, agentId, reviewed) {
    topic.selectTask(task, agentId)
    void taskActions.onAction(task, action, agentId, reviewed)
  }

  return <ChatroomView {...feed} onRetry={feed.retry} viewportRef={viewportRef} onScroll={onScroll}
    unseenCount={unseenCount} onJumpToLatest={jumpToLatest} context={topic.context}
    onNewTopic={onNewTopic} onContinueThread={onContinueThread} onReply={onReply}
    taskBoardProps={{ ...taskActions, onSelectTask, onAction: onTaskAction }}
    composerProps={{ ...composer, taskRouteActive: Boolean(topic.sendRoute.collaborationTaskId), routeReady,
      taskNeedsRecipient: topic.sendRoute.taskNeedsRecipient,
      targetAgentName: feed.members.find(member => member.id === topic.sendRoute.targetAgentId)?.name || '' }} />
}
