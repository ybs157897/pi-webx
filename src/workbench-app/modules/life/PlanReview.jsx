import { useState } from 'react'
import { formatDay } from '../../util.mjs'

async function changePlan(id, method, body) {
  const response = await fetch(`/api/workbench/life/plans/${encodeURIComponent(id)}${method === 'POST' ? '/apply' : ''}`, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error ?? `规划操作失败（${response.status}）`)
  return payload
}

export default function PlanReview({ plans, tasks, sessionId, refresh, notify }) {
  const [pending, setPending] = useState('')
  const [errors, setErrors] = useState({})
  const [resolved, setResolved] = useState({})
  const [syncError, setSyncError] = useState('')
  const sessionPlans = Array.isArray(plans) && sessionId
    ? plans.filter(plan => plan?.sourceSessionId === sessionId && resolved[plan.id] !== 'deleted').sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    : []
  if (!sessionPlans.length && !syncError) return null
  const taskMap = new Map((Array.isArray(tasks) ? tasks : []).map(task => [task.id, task]))

  async function act(plan, method) {
    if (pending) return
    setPending(plan.id)
    setErrors(current => ({ ...current, [plan.id]: '' }))
    try {
      await changePlan(plan.id, method, method === 'POST' ? { expectedUpdatedAt: plan.updatedAt } : undefined)
      setResolved(current => ({ ...current, [plan.id]: method === 'POST' ? 'applied' : 'deleted' }))
      notify?.(method === 'POST' ? '安排已加入日程' : '已取消这份建议')
      try { await refresh?.(); setSyncError('') }
      catch { setSyncError('操作已保存，但列表刷新失败。请重新加载。') }
    } catch (error) {
      const message = String(error?.message ?? error)
      setErrors(current => ({ ...current, [plan.id]: message }))
      notify?.(message, 'error')
      if (method === 'POST') await refresh?.().catch(() => { setSyncError('列表刷新失败，请重新加载。') })
    } finally { setPending('') }
  }

  return <div className="life-plan-review" data-testid="life-plan-review">
    <div className="life-plan-review-head"><h3>安排建议</h3><span>确认后才会写入日程</span></div>
    {syncError && <div className="life-plan-sync-error" role="alert">{syncError} <button type="button" className="btn btn-sm" data-testid="life-plan-retry" onClick={() => Promise.resolve(refresh?.()).then(() => setSyncError('')).catch(() => setSyncError('重新加载失败，请稍后重试。'))}>重新加载</button></div>}
    {sessionPlans.map(plan => <section className="life-plan-card" data-testid="life-plan-card" key={plan.id}>
      <h4>{plan.title || '生活安排建议'}</h4>
      {plan.note && <p>{plan.note}</p>}
      <ul>{(Array.isArray(plan.entries) ? plan.entries : []).map((entry, index) => {
        const task = taskMap.get(entry.taskId)
        return <li key={`${entry.taskId}-${index}`} data-testid="life-plan-entry"><strong>{task?.title || '待办事项'}</strong><span>{entry.plannedDate ? formatDay(entry.plannedDate) : '待定日期'}{entry.startTime ? ` · ${entry.startTime}–${entry.endTime}` : ' · 灵活安排'}</span>{entry.reason && <small> · {entry.reason}</small>}</li>
      })}</ul>
      {errors[plan.id] && <p className="life-plan-error" role="alert">{errors[plan.id]}</p>}
      <div className="life-plan-actions">
        {plan.appliedAt || resolved[plan.id] === 'applied' ? <span className="life-plan-applied" data-testid="life-plan-applied">已加入日程</span> : <><button type="button" className="btn btn-sm" data-testid="life-plan-cancel" disabled={Boolean(pending)} onClick={() => act(plan, 'DELETE')}>取消建议</button><button type="button" className="btn btn-primary btn-sm" data-testid="life-plan-apply" disabled={Boolean(pending)} onClick={() => act(plan, 'POST')}>{pending === plan.id ? '处理中…' : '确认安排'}</button></>}
      </div>
    </section>)}
  </div>
}
