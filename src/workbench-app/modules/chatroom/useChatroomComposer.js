import { useMemo, useRef, useState } from 'react'
import { CHATROOM_MENTION_OPTIONS, findChatroomMentionDraft, parseChatroomMentions } from '../../../shared/chatroom-mentions.mjs'

function entryKey() {
  return globalThis.crypto?.randomUUID?.() ?? `chatroom-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function errorText(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

function sameDraft(snapshot, body, reply) {
  return snapshot.body === body.trim() && snapshot.replyTo === (reply?.id ?? null)
}

export function useChatroomComposer(members, { ingest, retry }) {
  const [body, setBody] = useState('')
  const [replyingTo, setReplyingTo] = useState(null)
  const [mentionDraft, setMentionDraft] = useState(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [failedSubmission, setFailedSubmission] = useState(null)
  const textareaRef = useRef(null)
  const bodyRef = useRef('')
  const replyRef = useRef(null)
  const sendingRef = useRef(false)
  const failedRef = useRef(null)

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

  async function send(snapshot = null) {
    if (sendingRef.current) return
    if (members.length === 0) {
      setSendError('请等待聊天室同步完成后发送。')
      return
    }
    const submission = snapshot ?? {
      body: bodyRef.current.trim(),
      replyTo: replyRef.current?.id ?? null,
      entryKey: failedRef.current && sameDraft(failedRef.current, bodyRef.current, replyRef.current)
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
    sendingRef.current = true
    setSending(true)
    setSendError('')
    try {
      const response = await fetch('/api/chatroom/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: submission.body, entryKey: submission.entryKey,
          ...(submission.replyTo ? { replyTo: submission.replyTo } : {}) }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error ?? `发送失败（${response.status}）`)
      if (!payload?.message) throw new Error('聊天室没有返回消息')
      ingest(payload.message)
      retry()
      if (sameDraft(submission, bodyRef.current, replyRef.current)) {
        bodyRef.current = ''
        replyRef.current = null
        setBody('')
        setReplyingTo(null)
        setMentionDraft(null)
        setMentionOpen(false)
      }
      failedRef.current = null
      setFailedSubmission(null)
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
    replyingTo, onCancelReply, onReply,
    sending, sendError, onRetrySend: () => { if (failedSubmission) void send(failedSubmission) },
    canRetrySend: Boolean(failedSubmission) && sendError.startsWith('上一条'),
    onDismissSendError: () => { setFailedSubmission(null); setSendError('') },
    onSend: () => { void send() }, textareaRef,
  }
}
