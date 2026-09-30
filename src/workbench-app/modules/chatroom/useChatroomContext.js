import { useEffect, useState } from 'react'

const ACTIVE_TASK_STATUSES = new Set(['waiting', 'running', 'waiting_for_user', 'waiting_for_agent'])
const STORAGE_KEY = 'pi-webx-chatroom-current-topic'

function storedContext(roomId) {
  if (typeof window === 'undefined') return null
  try {
    const stored = JSON.parse(window.localStorage.getItem(`${STORAGE_KEY}:${roomId}`) || 'null')
    if (stored?.mode === 'new') return { mode: 'new', threadId: null, taskId: null, targetAgentId: null }
    if (stored?.mode === 'selected' && typeof stored.threadId === 'string' && stored.threadId) {
      return { mode: 'selected', threadId: stored.threadId,
        taskId: typeof stored.taskId === 'string' ? stored.taskId : null,
        targetAgentId: typeof stored.targetAgentId === 'string' ? stored.targetAgentId : null }
    }
  } catch { /* Storage may be unavailable; recent messages still restore the topic. */ }
  return null
}

export function chatroomSendRoute(context, tasks) {
  if (!context?.threadId) return { threadId: null, collaborationTaskId: null, targetAgentId: null,
    taskNeedsRecipient: false, taskAgentIds: [] }
  const selectedTask = tasks.find(task => task.id === context.taskId && task.threadId === context.threadId)
  const activeTask = selectedTask && ACTIVE_TASK_STATUSES.has(selectedTask.status) ? selectedTask : null
  return {
    threadId: context.threadId,
    collaborationTaskId: activeTask?.id ?? null,
    targetAgentId: activeTask?.assignments?.some(assignment => assignment.agentId === context.targetAgentId)
      ? context.targetAgentId : null,
    taskNeedsRecipient: (activeTask?.assignments?.length ?? 0) > 1,
    taskAgentIds: activeTask?.assignments?.map(assignment => assignment.agentId) ?? [],
  }
}

export function useChatroomContext(roomId, messages, tasks, syncStatus) {
  const [context, setContext] = useState({ mode: 'loading', threadId: null, taskId: null, targetAgentId: null })
  const [hydratedRoom, setHydratedRoom] = useState(null)

  useEffect(() => {
    setContext(storedContext(roomId) || { mode: 'auto', threadId: null, taskId: null, targetAgentId: null })
    setHydratedRoom(roomId)
  }, [roomId])

  useEffect(() => {
    if (hydratedRoom !== roomId || context.mode !== 'auto' || syncStatus === 'loading') return
    const latest = [...messages].reverse().find(message => message.senderId === 'user' && message.threadId)
      || [...messages].reverse().find(message => message.threadId)
    if (latest) setContext({ mode: 'selected', threadId: latest.threadId,
      taskId: latest.collaborationTaskId || null,
      targetAgentId: latest.senderId === 'user' && latest.collaborationTaskId ? latest.recipientId : null })
  }, [context.mode, hydratedRoom, roomId, messages, syncStatus])

  useEffect(() => {
    if (hydratedRoom !== roomId || syncStatus !== 'online' || !context.taskId) return
    if (tasks.some(task => task.id === context.taskId && task.threadId === context.threadId)) return
    setContext(previous => previous.taskId === context.taskId
      ? { ...previous, taskId: null, targetAgentId: null } : previous)
  }, [context.taskId, context.threadId, hydratedRoom, roomId, syncStatus, tasks])

  useEffect(() => {
    if (hydratedRoom !== roomId) return
    if (context.mode !== 'selected' && context.mode !== 'new') return
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem(`${STORAGE_KEY}:${roomId}`, JSON.stringify(context)) } catch { /* optional */ }
  }, [roomId, hydratedRoom, context])

  function selectTask(task, agentId = null) {
    if (task?.threadId) setContext({ mode: 'selected', threadId: task.threadId, taskId: task.id,
      targetAgentId: agentId && task.assignments?.some(assignment => assignment.agentId === agentId) ? agentId : null })
  }

  function selectMessage(message) {
    if (message?.threadId) setContext({ mode: 'selected', threadId: message.threadId,
      taskId: message.collaborationTaskId || null,
      targetAgentId: message.senderId === 'user' && message.collaborationTaskId ? message.recipientId : null })
  }

  function onSent(message) {
    if (!message?.threadId) return
    setContext(previous => ({ mode: 'selected', threadId: message.threadId,
      taskId: message.collaborationTaskId || (previous.threadId === message.threadId ? previous.taskId : null),
      targetAgentId: message.collaborationTaskId ? message.recipientId || previous.targetAgentId : null }))
  }

  return {
    context,
    ready: hydratedRoom === roomId,
    sendRoute: chatroomSendRoute(context, tasks),
    selectTask,
    selectMessage,
    newTopic: () => setContext({ mode: 'new', threadId: null, taskId: null, targetAgentId: null }),
    onSent,
  }
}
