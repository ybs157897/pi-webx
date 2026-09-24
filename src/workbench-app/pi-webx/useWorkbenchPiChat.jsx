import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api as piApi } from '../../lib/api'
import { usePiSession } from '../../lib/usePiSession'

const SESSION_KEY = 'ai-workbench.pi-session-id'

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function toChatMessages(entries) {
  const messages = []
  for (const entry of entries) {
    if (entry.kind === 'user') {
      messages.push({ id: entry.id, role: 'user', text: entry.text, at: entry.at })
    } else if (entry.kind === 'assistant') {
      // 输出不再在这里截断：短预览由展示层现算，完整输出要能原样到达可展开区域。
      const tools = entry.tools.map((run) => ({
        name: run.toolName,
        output: run.output,
      }))
      if (entry.text || tools.length > 0) {
        messages.push({ id: entry.id, role: 'assistant', text: entry.text, at: entry.at, tools })
      }
    } else if (entry.kind === 'toolResult') {
      messages.push({
        id: entry.id,
        role: 'tool',
        text: '',
        at: entry.at,
        tools: [{ name: entry.run.toolName, output: entry.run.output }],
      })
    } else if (entry.kind === 'notice' && entry.level === 'error') {
      messages.push({ id: entry.id, role: 'error', text: entry.text, at: entry.at })
    }
  }
  return messages
}

export function useWorkbenchPiChat() {
  const [sessionId, setSessionId] = useState(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const creating = useRef(null)
  const pi = usePiSession(sessionId)

  useEffect(() => {
    const stored = window.localStorage.getItem(SESSION_KEY)
    if (!stored) return undefined
    let active = true
    piApi.createSession({ sessionId: stored })
      .then(({ session }) => { if (active) setSessionId(session.id) })
      .catch((cause) => {
        if (!active) return
        window.localStorage.removeItem(SESSION_KEY)
        setError(`上一段 Pi 会话未能恢复：${errorText(cause)}`)
      })
    return () => { active = false }
  }, [])

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId
    if (creating.current) return creating.current
    creating.current = piApi.createSession({ name: 'AI 个人工作台' })
      .then(({ session }) => {
        window.localStorage.setItem(SESSION_KEY, session.id)
        setSessionId(session.id)
        return session.id
      })
      .finally(() => { creating.current = null })
    return creating.current
  }, [sessionId])

  const send = useCallback(async (text) => {
    const content = text.trim()
    if (!content || sending) return
    setSending(true)
    setError('')
    try {
      const id = await ensureSession()
      const response = id === sessionId && pi.status === 'live'
        ? await pi.prompt(content)
        : await piApi.sendCommand(id, { type: 'prompt', message: content })
      if (!response.success) throw new Error(response.error ?? 'Pi Agent 未接受消息')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSending(false)
    }
  }, [ensureSession, pi, sending, sessionId])

  const newConversation = useCallback(() => {
    window.localStorage.removeItem(SESSION_KEY)
    setSessionId(null)
    setError('')
  }, [])

  const chat = useMemo(() => {
    const messages = toChatMessages(pi.transcript.entries)
    const detail = error || pi.transcript.lastError || pi.error
    if (detail) messages.push({ id: 'pi-error', role: 'error', text: detail, at: Date.now() })
    for (const notice of pi.notifications.filter((entry) => entry.level === 'error')) {
      messages.push({ id: notice.id, role: 'error', text: notice.detail ? `${notice.text}：${notice.detail}` : notice.text, at: notice.at })
    }
    return messages
  }, [error, pi.error, pi.notifications, pi.transcript.entries, pi.transcript.lastError])

  return {
    chat,
    busy: sending || pi.transcript.running,
    modelName: pi.piState?.model?.id ?? 'pi-webx',
    status: pi.status,
    send,
    newConversation,
    dialog: pi.dialogs[0]?.request ?? null,
    respondToDialog: pi.respondToDialog,
  }
}
