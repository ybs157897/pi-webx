import { useEffect, useRef, useState } from 'react'
import { taskReviewKey } from './TaskBoard.jsx'

const ACTION_STORAGE_KEY = 'pi-webx-chatroom-pending-actions'

function writePending(roomId, pending) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(`${ACTION_STORAGE_KEY}:${roomId}`, JSON.stringify([...pending])) } catch { /* optional */ }
}

function newEntryKey() {
  return globalThis.crypto?.randomUUID?.() ?? `chatroom-task-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useChatroomTaskActions({ room, ingest, ingestTask, retry }) {
  const [busyAction, setBusyAction] = useState('')
  const [actionError, setActionError] = useState(null)
  const [actionNotice, setActionNotice] = useState('')
  const [reviewed, setReviewed] = useState(new Set())
  const pendingRef = useRef(new Map())
  const busyRef = useRef(false)
  const roomId = room?.id || 'internal'

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const saved = JSON.parse(window.localStorage.getItem(`${ACTION_STORAGE_KEY}:${roomId}`) || '[]')
      pendingRef.current = new Map(Array.isArray(saved) ? saved.filter(item =>
        Array.isArray(item) && typeof item[0] === 'string' && typeof item[1]?.entryKey === 'string'
          && Number.isSafeInteger(item[1].expectedVersion)) : [])
    } catch { pendingRef.current = new Map() }
  }, [roomId])

  function onReviewChange(key, checked) {
    setReviewed(current => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  async function onAction(task, action, agentId, reviewedChoice) {
    if (busyRef.current) return
    const key = taskReviewKey(task.id, agentId)
    const reviewKey = action === 'review' ? taskReviewKey(task.id, 'review')
      : taskReviewKey(task.id, agentId || task.assignments?.[0]?.agentId)
    if (reviewedChoice && !reviewed.has(reviewKey)) return
    const operationKey = `${key}:${action}`
    const previous = pendingRef.current.get(operationKey)
    const submission = previous || { action, entryKey: newEntryKey(), expectedVersion: task.version,
        ...(agentId ? { agentId } : {}), ...(reviewedChoice ? { reviewed: true } : {}) }
    pendingRef.current.set(operationKey, submission)
    writePending(roomId, pendingRef.current)
    busyRef.current = true
    setBusyAction(key)
    setActionError(null)
    setActionNotice('')
    try {
      const response = await fetch(`/api/chatroom/tasks/${encodeURIComponent(task.id)}/actions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submission),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 409) {
          pendingRef.current.delete(operationKey)
          writePending(roomId, pendingRef.current)
          retry()
          throw new Error('任务状态已变化，请查看最新状态后重试。')
        }
        throw new Error('操作未确认，请检查任务状态后重试。')
      }
      if (!payload?.task) throw new Error('操作未确认，请检查任务状态后重试。')
      pendingRef.current.delete(operationKey)
      writePending(roomId, pendingRef.current)
      ingestTask(payload.task)
      if (payload.message) ingest(payload.message)
      retry()
      setActionNotice(action === 'cancel' ? '已请求取消任务。'
        : action === 'review' ? '已记录核对结果。' : '已请求继续执行。')
      if (reviewedChoice) onReviewChange(reviewKey, false)
    } catch (cause) {
      setActionError({ key, text: cause instanceof Error ? cause.message : '操作未确认，请检查任务状态后重试。' })
    } finally {
      busyRef.current = false
      setBusyAction('')
    }
  }

  return { busyAction, actionError, actionNotice, reviewed, onReviewChange, onAction }
}
