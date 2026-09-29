import { useEffect, useState } from 'react'
import { FormModal } from '../../ui.jsx'
import { api } from '../../api.mjs'

function draftOf(task) {
  return {
    title: String(task?.title ?? ''), due: task?.due ?? '', tag: task?.tag ?? '',
    priority: task?.priority ?? 'normal', note: task?.note ?? '',
    durationMinutes: Number.isInteger(task?.durationMinutes) ? task.durationMinutes : 30,
    kind: task?.kind === 'fixed' ? 'fixed' : 'flexible',
    plannedDate: task?.plannedDate ?? '', startTime: task?.startTime ?? '', endTime: task?.endTime ?? '',
  }
}

export default function TaskDetails({ task, onClose, mutate, notify }) {
  const [draft, setDraft] = useState(() => draftOf(task))
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDraft(draftOf(task)) }, [task?.id])
  useEffect(() => {
    if (!task || typeof document === 'undefined') return undefined
    const previous = document.activeElement
    const dialog = document.querySelector('[data-testid="task-details-form"]')?.closest('[role="dialog"]')
    if (!dialog) return undefined
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    const firstInput = dialog.querySelector('[data-testid="task-details-form"] input')
    firstInput?.focus()
    const trap = event => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', trap)
    return () => { dialog.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus?.() }
  }, [task?.id])
  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))

  async function save() {
    if (!task || busy) return
    if (!draft.title.trim()) return notify?.('先写下要做什么', 'warn')
    if (Boolean(draft.startTime) !== Boolean(draft.endTime)) return notify?.('开始和结束时间需同时填写', 'warn')
    if ((draft.startTime || draft.endTime) && !draft.plannedDate) return notify?.('填写时间前先选择计划日期', 'warn')
    if (draft.kind === 'fixed' && draft.plannedDate && (!draft.startTime || !draft.endTime)) return notify?.('固定安排需要填写开始和结束时间', 'warn')
    if (draft.startTime && draft.endTime <= draft.startTime) return notify?.('结束时间须晚于开始时间', 'warn')
    const minutes = Number(draft.durationMinutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return notify?.('预计时长需为 1–1440 分钟', 'warn')
    setBusy(true)
    try {
      const ok = await mutate?.(() => api.patchRecord('tasks', task.id, {
        ...draft, title: draft.title.trim(), durationMinutes: minutes, tag: draft.tag.trim(),
        startTime: draft.startTime || null, endTime: draft.endTime || null,
      }), '待办已更新')
      if (ok) onClose?.()
    } finally { setBusy(false) }
  }

  return <FormModal open={Boolean(task)} title="编辑待办" onClose={onClose} onSubmit={save} busy={busy} wide>
    <div className="tasks-detail-form" data-testid="task-details-form">
      <label className="field"><span className="field-label">事项</span><input className="input" value={draft.title} onChange={event => set('title', event.target.value)} maxLength={160} /></label>
      <div className="tasks-detail-grid">
        <label className="field"><span className="field-label">截止日期</span><input className="input" aria-label="截止日期" type="date" value={draft.due} onChange={event => set('due', event.target.value)} /></label>
        <label className="field"><span className="field-label">标签</span><input className="input" value={draft.tag} onChange={event => set('tag', event.target.value)} maxLength={40} placeholder="购物、家务、健康…" /></label>
        <label className="field"><span className="field-label">优先级</span><select className="select" value={draft.priority} onChange={event => set('priority', event.target.value)}><option value="normal">普通</option><option value="high">高</option><option value="low">低</option></select></label>
        <label className="field"><span className="field-label">预计用时（分钟）</span><input className="input" type="number" min="1" max="1440" value={draft.durationMinutes} onChange={event => set('durationMinutes', event.target.value)} /></label>
        <label className="field"><span className="field-label">安排类型</span><select className="select" value={draft.kind} onChange={event => set('kind', event.target.value)}><option value="flexible">灵活事项</option><option value="fixed">固定安排</option></select></label>
        <label className="field"><span className="field-label">计划日期</span><input className="input" aria-label="计划日期" type="date" value={draft.plannedDate} onChange={event => set('plannedDate', event.target.value)} /></label>
        <label className="field"><span className="field-label">开始时间</span><input className="input" type="time" value={draft.startTime} onChange={event => set('startTime', event.target.value)} disabled={!draft.plannedDate} /></label>
        <label className="field"><span className="field-label">结束时间</span><input className="input" type="time" value={draft.endTime} onChange={event => set('endTime', event.target.value)} disabled={!draft.plannedDate} /></label>
      </div>
      {draft.plannedDate && <button className="btn btn-sm" type="button" data-testid="task-clear-plan" onClick={() => setDraft(current => ({ ...current, plannedDate: '', startTime: '', endTime: '' }))}>从日程移除</button>}
      <p className="tasks-detail-hint">截止日期是必须处理的期限；计划日期是准备哪天做，可以随时调整。</p>
      <label className="field"><span className="field-label">备注</span><textarea className="textarea" rows="3" value={draft.note} onChange={event => set('note', event.target.value)} maxLength={8000} /></label>
      {task?.originalText && <div className="tasks-original"><span>最初记录</span><p>{task.originalText}</p></div>}
    </div>
  </FormModal>
}
