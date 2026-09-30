/**
 * 模块 Agent 会话 hook：懒创建会话、双存储恢复指针、requestId 幂等。
 * send 的第二参是输入框附件：图片随 prompt 信封走 `images`（PiImage 内联管线），
 * 文本文件在发送时内联进消息正文（formatAttachmentBlocks，见 shell/composer-attachments.mjs）；
 * 本地 pending 气泡只报「附了几个」，不把大文件全文画进气泡。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api as piApi } from '../../lib/api'
import { usePiSession } from '../../lib/usePiSession'
import { formatAttachmentBlocks } from '../shell/composer-attachments.mjs'
import { agentStorageKey, normalizeProjectCwd, readPointer, writePointer, clearPointer, readDraft, writeDraft } from './session-storage.mjs'

const errorText = error => error instanceof Error ? error.message : String(error)
const requestId = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random()}`

export function useModuleAgentChat(agentId, { cwd } = {}) {
  const projectCwd = agentId === 'codes' ? normalizeProjectCwd(cwd) : null
  const storageKey = agentStorageKey(agentId, projectCwd)
  const [sessionId, setSessionId] = useState(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [error, setError] = useState('')
  const [capability, setCapability] = useState(null)
  const [capabilityError, setCapabilityError] = useState('')
  const [draft, setDraftState] = useState('')
  const [pendingText, setPendingText] = useState('')
  const opening = useRef(null)
  const targetId = useRef(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  const sendingRef = useRef(false)
  const stopRequested = useRef(false)
  const pi = usePiSession(sessionId)

  const setDraft = useCallback((text, expected) => {
    if (expected !== undefined && readDraft(storageKey) !== expected) return
    writeDraft(storageKey, text); setDraftState(text)
  }, [storageKey])
  const open = useCallback((stored = undefined) => {
    if (agentId === 'codes' && !projectCwd) return Promise.reject(new Error('请先打开代码项目目录'))
    if (opening.current) return opening.current
    const version = generation.current
    const work = piApi.createModuleAgentSession(agentId, { requestId: requestId(), ...(stored ? { sessionId: stored } : {}), ...(projectCwd ? { cwd: projectCwd } : {}) })
      .then(({ session }) => {
        if (version !== generation.current) throw new Error('会话已切换，请重新发送')
        targetId.current = session.id
        writePointer(storageKey, session.id)
        if (mounted.current) { setSessionId(session.id); setError('') }
        return session.id
      })
    opening.current = work
    void work.then(() => { if (opening.current === work) opening.current = null }, () => { if (opening.current === work) opening.current = null })
    return work
  }, [agentId, projectCwd, storageKey])

  useEffect(() => {
    mounted.current = true
    setDraftState(readDraft(storageKey))
    let active = true
    piApi.moduleAgents().then(({ agents }) => { if (active) setCapability(agents.find(item => item.id === agentId) ?? null) })
      .catch(cause => { if (active) setCapabilityError(errorText(cause)) })
    const stored = readPointer(storageKey)
    const work = stored ? open(stored) : Promise.resolve()
    work.catch(cause => { if (active) setError(errorText(cause)) })
      .finally(() => { if (active) setRestoring(false) })
    return () => { active = false; mounted.current = false }
  }, [agentId, storageKey, open])

  const ensureSession = useCallback(async () => {
    if (opening.current) return opening.current
    if (targetId.current) return targetId.current
    const stored = readPointer(storageKey)
    return open(stored ?? undefined)
  }, [open, storageKey])

  const send = useCallback(async (text, attachments = {}) => {
    const content = (text ?? '').trim()
    const images = Array.isArray(attachments?.images) ? attachments.images : []
    const files = Array.isArray(attachments?.files) ? attachments.files : []
    if ((content === '' && images.length === 0 && files.length === 0) || sendingRef.current || restoring) return false
    if (agentId === 'codes' && !projectCwd) { setError('请先打开代码项目目录'); return false }
    sendingRef.current = true
    stopRequested.current = false
    setSending(true); setError('')
    setPendingText(content + (files.length + images.length > 0
      ? `\n\n（已附 ${[files.length && `${files.length} 个文件`, images.length && `${images.length} 张图片`].filter(Boolean).join('和')}）`
      : ''))
    try {
      const id = await ensureSession()
      if (stopRequested.current) return false
      const message = files.length > 0 ? content + formatAttachmentBlocks(files) : content
      const response = await piApi.sendCommand(id, { type: 'prompt', message, id: requestId(), ...(images.length > 0 ? { images } : {}) })
      if (!response.success || response.data?.accepted === false) throw new Error(response.error ?? response.data?.reason ?? 'Agent 未接受消息')
      if (stopRequested.current) await piApi.sendCommand(id, { type: 'abort' })
      return true
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
      return false
    } finally {
      sendingRef.current = false
      if (mounted.current) { setSending(false); setPendingText('') }
    }
  }, [agentId, projectCwd, ensureSession, restoring])

  const stop = useCallback(async () => {
    stopRequested.current = true
    setStopping(true)
    try {
      const id = targetId.current
      if (id) {
        const response = await piApi.sendCommand(id, { type: 'abort' })
        if (!response.success) throw new Error(response.error ?? '停止失败')
      }
    } catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { if (mounted.current) setStopping(false) }
  }, [])

  const newConversation = useCallback(async () => {
    if (sendingRef.current || pi.transcript.running) return
    generation.current += 1
    opening.current = null; targetId.current = null
    clearPointer(storageKey); setDraft(''); setSessionId(null); setError('')
  }, [storageKey, setDraft, pi.transcript.running])
  const retry = useCallback(async () => {
    setRestoring(true)
    try { await ensureSession(); setError('') } catch (cause) { setError(errorText(cause)) }
    finally { setRestoring(false) }
  }, [ensureSession])
  const localRows = useMemo(() => {
    const rows = []
    if (pendingText) rows.push({ id: 'agent-pending', role: 'user', text: pendingText, at: Date.now() })
    const detail = error || pi.transcript.lastError || pi.error
    if (detail) rows.push({ id: 'agent-error', role: 'error', text: detail, at: Date.now(), retry: true })
    return rows
  }, [error, pendingText, pi.error, pi.transcript.lastError])
  return {
    sessionId,
    transcript: pi.transcript, localRows, busy: sending || restoring || pi.transcript.running,
    canStop: sending || pi.transcript.running, stopping, stop, draft, setDraft,
    modelName: pi.piState?.model?.id ?? capability?.model?.id ?? 'pi-webx',
    status: error ? 'error' : restoring ? 'connecting' : sessionId === null ? 'idle' : pi.status,
    send, newConversation, retry, dialog: pi.dialogs[0] ?? null, respondToDialog: pi.respondToDialog,
    capability, capabilityError,
  }
}
