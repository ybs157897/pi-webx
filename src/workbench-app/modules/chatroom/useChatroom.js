import { useEffect, useRef, useState } from 'react'

const PAGE_SIZE = 100
const POLL_INTERVAL_MS = 2000
const ACTIVE_CONSUMPTION_STATUSES = new Set(['pending', 'evaluating', 'processing'])

function sameConsumptions(left, right) {
  const previous = Array.isArray(left) ? left : []
  const incoming = Array.isArray(right) ? right : []
  return previous.length === incoming.length && previous.every((item, index) => {
    const next = incoming[index]
    return item.agentId === next?.agentId && item.agentName === next.agentName
      && item.status === next.status && item.startedAt === next.startedAt
      && item.finishedAt === next.finishedAt && item.error === next.error
  })
}

export function selectWatchedMessages(messages, offset, limit = PAGE_SIZE) {
  const watchable = messages
    .filter(message => message.deliveryStatus === 'pending' || message.deliveryStatus === 'running'
      || message.consumptions?.some(item => ACTIVE_CONSUMPTION_STATUSES.has(item.status)))
    .map(message => message.seq)
  if (watchable.length === 0) return []
  const start = offset % watchable.length
  const take = Math.min(limit, watchable.length)
  return [...watchable.slice(start, start + take), ...watchable.slice(0, Math.max(0, start + take - watchable.length))]
}

export function mergeChatroomMessages(current, incoming) {
  const bySeq = new Map()
  for (const message of [...current, ...incoming]) {
    if (Number.isSafeInteger(message?.seq) && message.seq > 0) bySeq.set(message.seq, message)
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  if (ordered.length === current.length && ordered.every((message, index) => {
    const old = current[index]
    return old.seq === message.seq && old.id === message.id && old.body === message.body
      && old.senderId === message.senderId && old.senderName === message.senderName
      && old.recipientId === message.recipientId && old.createdAt === message.createdAt
      && old.threadId === message.threadId && old.deliveryStatus === message.deliveryStatus
      && old.error === message.error && sameConsumptions(old.consumptions, message.consumptions)
  })) return current
  return ordered
}

async function requestMessages(after, watched, signal) {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (after !== null) query.set('after', String(after))
  if (watched.length > 0) query.set('watch', watched.join(','))
  const response = await fetch(`/api/chatroom/messages?${query}`, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload || !Array.isArray(payload.messages)) throw new Error('聊天室响应格式无效')
  return payload
}

/** 按 seq 拉齐历史，再轮询增量；watch 使已显示的投递状态也能转入终态。 */
export function useChatroom() {
  const [room, setRoom] = useState({ id: 'internal', name: '内部聊天室' })
  const [members, setMembers] = useState([])
  const [messages, setMessages] = useState([])
  const [syncStatus, setSyncStatus] = useState('loading')
  const [error, setError] = useState('')
  const cursorRef = useRef(null)
  const messagesRef = useRef([])
  const watchOffsetRef = useRef(0)
  const requestRef = useRef(() => {})

  useEffect(() => {
    let active = true
    let busy = false
    const controller = new AbortController()

    async function load() {
      if (!active || busy) return
      busy = true
      try {
        let more = true
        while (active && more) {
          const previousCursor = cursorRef.current
          const watched = selectWatchedMessages(messagesRef.current, watchOffsetRef.current)
          watchOffsetRef.current += PAGE_SIZE
          const payload = await requestMessages(previousCursor, watched, controller.signal)
          if (!active) return
          setRoom(payload.room?.name ? payload.room : { id: 'internal', name: '内部聊天室' })
          setMembers(Array.isArray(payload.members) ? payload.members : [])
          const merged = mergeChatroomMessages(messagesRef.current, [
            ...payload.messages,
            ...(Array.isArray(payload.updates) ? payload.updates : []),
          ])
          if (merged !== messagesRef.current) {
            messagesRef.current = merged
            setMessages(merged)
          }

          const lastFetched = payload.messages.reduce((max, message) => Math.max(max, message?.seq || 0), 0)
          const cursor = Math.max(Number(payload.nextCursor) || 0, lastFetched, previousCursor || 0)
          if (payload.hasMore && cursor <= (previousCursor || 0)) throw new Error('聊天室分页游标没有前进')
          cursorRef.current = cursor
          more = payload.hasMore === true
        }
        if (active) {
          setError('')
          setSyncStatus('online')
        }
      } catch (cause) {
        if (active && cause?.name !== 'AbortError') {
          setError('聊天记录暂时无法同步，请重试。')
          setSyncStatus('error')
        }
      } finally {
        busy = false
      }
    }

    requestRef.current = load
    void load()
    const timer = setInterval(() => { void load() }, POLL_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(timer)
      controller.abort()
      requestRef.current = () => {}
    }
  }, [])

  function ingest(message) {
    const merged = mergeChatroomMessages(messagesRef.current, [message])
    if (merged !== messagesRef.current) {
      messagesRef.current = merged
      setMessages(merged)
    }
  }

  return { room, members, messages, syncStatus, error, retry: () => requestRef.current(), ingest }
}
