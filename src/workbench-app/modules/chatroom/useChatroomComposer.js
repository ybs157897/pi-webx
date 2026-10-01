import { useEffect, useMemo, useRef, useState } from 'react'
import { CHATROOM_MENTION_OPTIONS, findChatroomMentionDraft, parseChatroomMentions } from '../../../shared/chatroom-mentions.mjs'

const DRAFT_STORAGE_KEY = 'pi-webx-chatroom-draft'

function writeDraft(roomId, draft) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(`${DRAFT_STORAGE_KEY}:${roomId}`, JSON.stringify(draft)) } catch { /* optional */ }
}

function entryKey() {
  return globalThis.crypto?.randomUUID?.() ?? `chatroom-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function errorText(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

function sameDraft(snapshot, body, reply, route) {
  return snapshot.body === body.trim() && snapshot.replyTo === (reply?.id ?? null)
    && snapshot.threadId === (route?.threadId ?? null)
    && snapshot.collaborationTaskId === (route?.collaborationTaskId ?? null)
    && (snapshot.targetAgentId ?? null) === (route?.targetAgentId ?? null)
}

/** Keep the draft text while making one explicitly selected member its sole recipient. */
export function addressChatroomDraft(body, agentId) {
  const target = CHATROOM_MENTION_OPTIONS.find(option => option.id === agentId)
  if (!target) return body
  const mentions = parseChatroomMentions(body).mentions.filter(mention => mention.id)
  if (mentions.length === 0) return `@${target.name} ${body}`
  let at = 0
  let directed = ''
  mentions.forEach((mention, index) => {
    directed += body.slice(at, mention.start)
    directed += index === 0 ? `@${target.name}` : mention.raw.slice(1)
    at = mention.end
  })
  return directed + body.slice(at)
}

export function useChatroomComposer(members, { ingest, retry }, route = {}, onSent = () => {}, roomId = 'internal') {
  const [body, setBody] = useState('')
  const [replyingTo, setReplyingTo] = useState(null)
  const [mentionDraft, setMentionDraft] = useState(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [failedSubmission, setFailedSubmission] = useState(null)
  const [staleTopicRoute, setStaleTopicRoute] = useState(false)
  const [hydratedRoom, setHydratedRoom] = useState(null)
  const textareaRef = useRef(null)
  const bodyRef = useRef('')
  const replyRef = useRef(null)
  const sendingRef = useRef(false)
  const failedRef = useRef(null)

  useEffect(() => {
    let saved = null
    if (typeof window !== 'undefined') {
      try { saved = JSON.parse(window.localStorage.getItem(`${DRAFT_STORAGE_KEY}:${roomId}`) || 'null') } catch { /* optional */ }
    }
    const restoredBody = typeof saved?.body === 'string' ? saved.body.slice(0, 12000) : ''
    const restoredReply = saved?.replyingTo && typeof saved.replyingTo.id === 'string' ? saved.replyingTo : null
    const restoredPending = saved?.pendingSubmission && typeof saved.pendingSubmission.entryKey === 'string'
      ? saved.pendingSubmission : null
    bodyRef.current = restoredBody
    replyRef.current = restoredReply
    failedRef.current = restoredPending
    setBody(restoredBody)
    setReplyingTo(restoredReply)
    setFailedSubmission(restoredPending)
    setSendError(restoredPending ? '上一条消息未确认送达，请核对聊天记录或使用相同请求重试。' : '')
    setHydratedRoom(roomId)
  }, [roomId])

  useEffect(() => {
    if (hydratedRoom !== roomId) return
    writeDraft(roomId, { body, replyingTo, pendingSubmission: failedSubmission })
  }, [roomId, hydratedRoom, body, replyingTo, failedSubmission])

  const mentionMembers = useMemo(() => CHATROOM_MENTION_OPTIONS.filter(option =>
    members.some(member => member.id === option.id)), [members])
  const mentionOptions = useMemo(() => {
    const query = mentionDraft?.query?.toLowerCase() ?? ''
    return mentionMembers.filter(option => option.aliases.some(alias => alias.toLowerCase().includes(query)))
  }, [mentionDraft, mentionMembers])

  function updateBody(next, cursor = next.length) {
    bodyRef.current = next
    setBody(next)
    const draft = findChatroomMentionDraft(next, cursor)
    setMentionDraft(draft)
    setMentionOpen(Boolean(draft))
    setActiveMentionIndex(0)
  }

  function onCaretChange(cursor) {
    const draft = findChatroomMentionDraft(bodyRef.current, cursor)
    setMentionDraft(draft)
    setMentionOpen(Boolean(draft))
    setActiveMentionIndex(0)
  }

  function focusAt(cursor) {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
    })
  }

  function onMentionButton() {
    const current = bodyRef.current
    const caret = textareaRef.current?.selectionStart ?? current.length
    const draft = findChatroomMentionDraft(current, caret)
    if (draft) {
      setMentionDraft(draft)
      setMentionOpen(true)
      setActiveMentionIndex(0)
      focusAt(caret)
      return
    }
    const prefix = /[\p{L}\p{N}._+%-]$/u.test(current.slice(0, caret)) ? ' ' : ''
    const next = `${current.slice(0, caret)}${prefix}@${current.slice(caret)}`
    const nextCaret = caret + prefix.length + 1
    updateBody(next, nextCaret)
    focusAt(nextCaret)
  }

  function onSelectMention(member) {
    const current = bodyRef.current
    const draft = mentionDraft ?? findChatroomMentionDraft(current, textareaRef.current?.selectionStart ?? current.length)
    if (!draft) return
    const replacement = `@${member.name} `
    const next = `${current.slice(0, draft.start)}${replacement}${current.slice(draft.end)}`
    const nextCaret = draft.start + replacement.length
    bodyRef.current = next
    setBody(next)
    setMentionDraft(null)
    setMentionOpen(false)
    focusAt(nextCaret)
  }

  function onReply(message) {
    replyRef.current = message
    setReplyingTo(message)
    const parsed = parseChatroomMentions(bodyRef.current)
    const option = CHATROOM_MENTION_OPTIONS.find(item => item.id === message.senderId)
    if (option && !parsed.recipientId) {
      const next = `@${option.name} ${bodyRef.current}`
      bodyRef.current = next
      setBody(next)
      setMentionDraft(null)
      setMentionOpen(false)
      focusAt(next.length)
    } else {
      textareaRef.current?.focus()
    }
  }

  function onCancelReply() {
    replyRef.current = null
    setReplyingTo(null)
    textareaRef.current?.focus()
  }

  function onTargetAgent(agentId) {
    const next = addressChatroomDraft(bodyRef.current, agentId)
    updateBody(next)
    setMentionOpen(false)
    setSendError('')
    focusAt(next.length)
  }

  async function send(snapshot = null) {
    if (sendingRef.current) return
    if (route.ready === false && !snapshot) {
      setSendError('当前话题尚未同步完成，请稍后重试。')
      return
    }
    if (members.length === 0) {
      setSendError('请等待聊天室同步完成后发送。')
      return
    }
    if (!snapshot && route.targetAgentId && bodyRef.current.trim()) {
      const directed = addressChatroomDraft(bodyRef.current, route.targetAgentId)
      if (directed !== bodyRef.current) updateBody(directed)
    }
    const submission = snapshot ?? {
      body: bodyRef.current.trim(),
      replyTo: replyRef.current?.id ?? null,
      threadId: route.threadId ?? null,
      collaborationTaskId: route.collaborationTaskId ?? null,
      targetAgentId: route.targetAgentId ?? null,
      entryKey: failedRef.current && sameDraft(failedRef.current, bodyRef.current, replyRef.current, route)
        ? failedRef.current.entryKey : entryKey(),
    }
    if (!submission.body) return
    const mentions = parseChatroomMentions(submission.body)
    if (mentions.multipleRecipients) {
      setSendError('一条消息只能点名一位 Agent。')
      return
    }
    if (mentions.unknownMentions.length > 0) {
      setSendError(`无法识别 ${mentions.unknownMentions[0]}，请从成员列表选择。`)
      return
    }
    if (submission.collaborationTaskId && route.taskNeedsRecipient && !mentions.recipientId) {
      setSendError('这个任务有多位成员，请先 @ 一位任务成员，或点选对应成员的“补充到任务”。')
      return
    }
    if (submission.collaborationTaskId && mentions.recipientId
      && route.taskAgentIds?.length > 0 && !route.taskAgentIds.includes(mentions.recipientId)) {
      setSendError('点名的成员未参与此任务，请从任务卡选择负责成员。')
      return
    }
    if (submission.targetAgentId && mentions.recipientId !== submission.targetAgentId) {
      setSendError('当前任务已指定成员，请保留对应的 @ 点名，或从任务卡切换负责成员。')
      return
    }
    sendingRef.current = true
    setSending(true)
    setSendError('')
    failedRef.current = submission
    setFailedSubmission(submission)
    writeDraft(roomId, { body: bodyRef.current, replyingTo: replyRef.current, pendingSubmission: submission })
    try {
      const response = await fetch('/api/chatroom/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: submission.body, entryKey: submission.entryKey,
          ...(submission.replyTo ? { replyTo: submission.replyTo } : {}),
          ...(submission.threadId ? { threadId: submission.threadId } : {}),
          ...(submission.collaborationTaskId ? { collaborationTaskId: submission.collaborationTaskId } : {}),
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        // 409 且提交只带旧 threadId：多半是本机保存的话题在服务端已不存在，给出换新话题重发的出口。
        if (response.status === 409 && submission.threadId && !submission.collaborationTaskId) setStaleTopicRoute(true)
        throw new Error(payload?.error ?? `发送失败（${response.status}）`)
      }
      if (!payload?.message) throw new Error('聊天室没有返回消息')
      ingest(payload.message)
      retry()
      onSent(payload.message)
      if (sameDraft(submission, bodyRef.current, replyRef.current, route)) {
        bodyRef.current = ''
        replyRef.current = null
        setBody('')
        setReplyingTo(null)
        setMentionDraft(null)
        setMentionOpen(false)
      }
      failedRef.current = null
      setFailedSubmission(null)
      setStaleTopicRoute(false)
      setSendError('')
    } catch (cause) {
      failedRef.current = submission
      setFailedSubmission(submission)
      setSendError(`上一条消息未确认送达：${errorText(cause)}`)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  function onKeyDown(event) {
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return
    if (mentionOpen) {
      if (event.key === 'ArrowDown' && mentionOptions.length > 0) {
        event.preventDefault()
        setActiveMentionIndex(index => (index + 1) % mentionOptions.length)
        return
      }
      if (event.key === 'ArrowUp' && mentionOptions.length > 0) {
        event.preventDefault()
        setActiveMentionIndex(index => (index - 1 + mentionOptions.length) % mentionOptions.length)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        if (mentionOptions[activeMentionIndex]) onSelectMention(mentionOptions[activeMentionIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionOpen(false)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return {
    body, onBodyChange: updateBody, onCaretChange, onKeyDown,
    onMentionButton, mentionOpen, mentionOptions, activeMentionIndex, onSelectMention,
    replyingTo, onCancelReply, onReply, onTargetAgent,
    sending, sendError, onRetrySend: () => {
      if (failedSubmission && sameDraft(failedSubmission, body, replyingTo, route)) void send(failedSubmission)
    },
    canRetrySend: Boolean(failedSubmission) && sendError.startsWith('上一条')
      && sameDraft(failedSubmission, body, replyingTo, route),
    onDismissSendError: () => { setSendError(''); setStaleTopicRoute(false) },
    canResendAsNewTopic: staleTopicRoute && Boolean(failedSubmission),
    onResendAsNewTopic: () => {
      const snapshot = failedRef.current
      if (!snapshot || sendingRef.current) return
      setStaleTopicRoute(false)
      void send({ ...snapshot, threadId: null, collaborationTaskId: null, targetAgentId: null, entryKey: entryKey() })
    },
    onSend: () => { void send() }, textareaRef,
    focusInput: () => textareaRef.current?.focus(),
  }
}
