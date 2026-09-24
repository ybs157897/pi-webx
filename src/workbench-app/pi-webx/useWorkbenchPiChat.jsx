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

/**
 * 工作台 AI 副驾的会话生命周期。
 *
 * 与旧版的差别：localStorage 里的旧 session 在服务端已不存在时，不再把技术错误
 * 抛成红条，而是自动开一段新会话并给一条软提示——副驾要永远可用，自愈优先于报错。
 * 连接状态分三档给面板用：live（可用）/ connecting（在建会话）/ error（真失败，可重试）。
 */
export function useWorkbenchPiChat() {
  const [sessionId, setSessionId] = useState(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [fatal, setFatal] = useState(false)
  const creating = useRef(null)
  const pi = usePiSession(sessionId)

  const startSession = useCallback(async (name = 'AI 个人工作台') => {
    if (creating.current) return creating.current
    creating.current = piApi.createSession({ name })
      .then(({ session }) => {
        window.localStorage.setItem(SESSION_KEY, session.id)
        setSessionId(session.id)
        setFatal(false)
        setError('')
        return session.id
      })
      .finally(() => { creating.current = null })
    return creating.current
  }, [])

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId
    return startSession()
  }, [sessionId, startSession])

  // 恢复上次会话；失败则自愈：直接开新会话，只留一句软提示。
  useEffect(() => {
    const stored = window.localStorage.getItem(SESSION_KEY)
    if (!stored) return undefined
    let active = true
    piApi.createSession({ sessionId: stored })
      .then(({ session }) => { if (active) setSessionId(session.id) })
      .catch(async () => {
        if (!active) return
        window.localStorage.removeItem(SESSION_KEY)
        try {
          await startSession()
          if (active) setNotice('上一段会话已失效，已自动为你开始新对话')
        } catch {
          if (active) setFatal(true)
        }
      })
    return () => { active = false }
  }, [startSession])

  const send = useCallback(async (text) => {
    const content = text.trim()
    if (!content || sending) return
    setSending(true)
    setError('')
    setNotice('')
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

  const newConversation = useCallback(async () => {
    window.localStorage.removeItem(SESSION_KEY)
    setSessionId(null)
    setError('')
    setNotice('')
    await startSession()
  }, [startSession])

  const retry = useCallback(async () => {
    setFatal(false)
    try {
      await ensureSession()
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [ensureSession])

  const chat = useMemo(() => {
    const messages = toChatMessages(pi.transcript.entries)
    const detail = error || pi.transcript.lastError || (fatal ? pi.error : '')
    if (notice !== '') messages.push({ id: 'pi-notice', role: 'notice', text: notice, at: Date.now() })
    if (detail !== '') messages.push({ id: 'pi-error', role: 'error', text: detail, at: Date.now(), retry: fatal })
    for (const entry of pi.notifications.filter((item) => item.level === 'error')) {
      messages.push({ id: entry.id, role: 'error', text: entry.detail ? `${entry.text}：${entry.detail}` : entry.text, at: entry.at })
    }
    return messages
  }, [error, fatal, notice, pi.error, pi.notifications, pi.transcript.entries, pi.transcript.lastError])

  // idle：还没有会话（首次发送时才懒创建，不给不聊天的用户白开会话）；
  // connecting：正在建会话或会话刚建好还在连；error：真失败，可重试。
  const status = fatal ? 'error' : sessionId === null ? 'idle' : pi.status

  return {
    chat,
    busy: sending || pi.transcript.running,
    modelName: pi.piState?.model?.id ?? 'pi-webx',
    status,
    send,
    newConversation,
    retry,
    dialog: pi.dialogs[0]?.request ?? null,
    respondToDialog: pi.respondToDialog,
  }
}
