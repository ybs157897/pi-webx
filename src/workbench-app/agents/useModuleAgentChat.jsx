/**
 * 模块 Agent 会话生命周期：与 useWorkbenchPiChat 同形（chat/transcript/localRows/
 * busy/modelName/status/send/newConversation/retry/dialog/respondToDialog），
 * 但会话只经 `POST /api/module-agents/:id/sessions` 装配，工具面由服务端配置决定。
 *
 * 会话是懒创建：首次 send 才建；打开面板本身不产生会话。恢复指针双写
 * sessionStorage（本标签页）与 localStorage（最近会话默认值），恢复失败
 * （404/409）清指针 + 软提示，不 fatal——下次发送按需重建。
 * @module agents/useModuleAgentChat
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api as piApi } from '../../lib/api'
import { usePiSession } from '../../lib/usePiSession'
import { toChatMessages } from '../pi-webx/useWorkbenchPiChat.jsx'

const SESSION_KEY_PREFIX = 'ai-workbench.agent-session:default:'

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** sessionStorage 优先（本标签页自己的会话），其次 localStorage（最近会话默认值）。 */
function readPointer(key) {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePointer(key, id) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(key, id)
    window.localStorage.setItem(key, id)
  } catch { /* 存储不可用时每次新开，不致命 */ }
}

function clearPointer(key) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(key)
    window.localStorage.removeItem(key)
  } catch { /* 同上 */ }
}

function newRequestId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useModuleAgentChat(agentId) {
  const [sessionId, setSessionId] = useState(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [fatal, setFatal] = useState(false)
  const [capability, setCapability] = useState(null)
  const [capabilityError, setCapabilityError] = useState('')
  const creating = useRef(null)
  const pi = usePiSession(sessionId)
  const storageKey = `${SESSION_KEY_PREFIX}${agentId}`

  // 能力投影：只取本 agent 那一项；失败只进 capabilityError，不挡会话路径。
  useEffect(() => {
    let active = true
    piApi.moduleAgents()
      .then(({ agents }) => {
        if (active) setCapability(agents.find(item => item.id === agentId) ?? null)
      })
      .catch((cause) => { if (active) setCapabilityError(errorText(cause)) })
    return () => { active = false }
  }, [agentId])

  const startSession = useCallback(async () => {
    if (creating.current) return creating.current
    creating.current = piApi.createModuleAgentSession(agentId, { requestId: newRequestId() })
      .then(({ session }) => {
        writePointer(storageKey, session.id)
        setSessionId(session.id)
        setFatal(false)
        setError('')
        return session.id
      })
      .finally(() => { creating.current = null })
    return creating.current
  }, [agentId, storageKey])

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId
    return startSession()
  }, [sessionId, startSession])

  // 恢复上次会话：服务端按已登记 sessionId 定位磁盘文件并核对身份。
  // 404/409 = 会话没了或不属于本 agent → 清指针 + 软提示，保持懒创建不 fatal；
  // 其他错误（含 503 配置不可用）留 error 由 retry 重试。
  useEffect(() => {
    const stored = readPointer(storageKey)
    if (!stored) return undefined
    let active = true
    piApi.createModuleAgentSession(agentId, { requestId: newRequestId(), sessionId: stored })
      .then(({ session }) => {
        if (!active) return
        writePointer(storageKey, session.id)
        setSessionId(session.id)
      })
      .catch((cause) => {
        if (!active) return
        if (cause?.status === 404 || cause?.status === 409) {
          clearPointer(storageKey)
          setNotice('上一段会话已失效，发送时会自动开始新对话')
        } else {
          setFatal(true)
          setError(errorText(cause))
        }
      })
    return () => { active = false }
  }, [agentId, storageKey])

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
      if (!response.success) throw new Error(response.error ?? 'Agent 未接受消息')
    } catch (cause) {
      setError(errorText(cause))
      // 503 = 配置不可用/未注册：错误原样透出，retry 可重试。
      if (cause?.status === 503) setFatal(true)
    } finally {
      setSending(false)
    }
  }, [ensureSession, pi, sending, sessionId])

  // 只清指针与本地会话，不立刻新建（懒创建）——下次发送时再装配。
  const newConversation = useCallback(async () => {
    clearPointer(storageKey)
    setSessionId(null)
    setError('')
    setNotice('')
  }, [storageKey])

  const retry = useCallback(async () => {
    setFatal(false)
    try {
      await ensureSession()
    } catch (cause) {
      setError(errorText(cause))
      if (cause?.status === 503) setFatal(true)
    }
  }, [ensureSession])

  const localRows = useMemo(() => {
    const rows = []
    const detail = error || pi.transcript.lastError || (fatal ? pi.error : '')
    if (notice !== '') rows.push({ id: 'agent-notice', role: 'notice', text: notice, at: Date.now() })
    if (detail !== '') rows.push({ id: 'agent-error', role: 'error', text: detail, at: Date.now(), retry: fatal })
    for (const entry of pi.notifications.filter((item) => item.level === 'error')) {
      rows.push({ id: entry.id, role: 'error', text: entry.detail ? `${entry.text}：${entry.detail}` : entry.text, at: entry.at })
    }
    return rows
  }, [error, fatal, notice, pi.error, pi.notifications, pi.transcript.lastError])

  const chat = useMemo(() => {
    const messages = toChatMessages(pi.transcript.entries)
    messages.push(...localRows)
    return messages
  }, [localRows, pi.transcript.entries])

  const status = fatal ? 'error' : sessionId === null ? 'idle' : pi.status

  return {
    chat,
    transcript: pi.transcript,
    localRows,
    busy: sending || pi.transcript.running,
    modelName: pi.piState?.model?.id ?? capability?.model?.id ?? 'pi-webx',
    status,
    send,
    newConversation,
    retry,
    dialog: pi.dialogs[0] ?? null,
    respondToDialog: pi.respondToDialog,
    capability,
    capabilityError,
  }
}
