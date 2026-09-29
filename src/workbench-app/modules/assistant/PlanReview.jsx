/**
 * 方案确认卡：对话列里唯一的写入口——助理提出的安排草稿在这里给用户过目、确认、取消。
 *
 * 草稿本身不改任何待办；`POST /api/workbench/plans/:id/apply` 才把计划写进日程，
 * `DELETE /api/workbench/plans/:id` 只丢弃草稿。两个动作都带 `expectedUpdatedAt`，
 * 服务端版本过期时返回 409，界面据此给出「重新确认一次」而不是静默重试。
 * 排序与筛选都以服务端记录为准（本地 resolved 只记住「刚删掉/刚应用」的瞬时状态）。
 * @module modules/assistant/PlanReview
 */

import { useMemo, useState } from 'react'
import { IconCheck, IconChevronDown } from '../../icons.jsx'
import { formatDay, relativeDay, todayISO } from '../../util.mjs'

const TEXT = {
  title: '一份安排建议',
  sub: '确认前不会改动你的日程',
  expand: '展开',
  collapse: '收起',
  cancel: '取消建议',
  apply: '确认安排',
  applying: '处理中…',
  hint: '确认后写入日程，可在今天页改期',
  applied: count => `已加入日程 · ${count} 条`,
  dismiss: '收起',
  expired: '方案已过期，请和助理重新确认一次',
  retryApply: '重试确认',
  retryCancel: '重试取消',
  anytime: '灵活安排',
  fallbackTitle: '待办事项',
  fallbackTime: '待安排',
  more: count => `另有 ${count} 份建议`,
}

/** 本地 resolved 的两个终态：删掉的不再出现，应用过的挂着「已加入日程」等用户收起。 */
const HIDDEN = new Set(['deleted', 'dismissed'])

const SHIELD = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 3.4 19 6v5.6c0 4.2-2.9 7.7-7 8.9-4.1-1.2-7-4.7-7-8.9V6Z" />
  </svg>
)

async function changePlan(id, method, body) {
  const path = `/api/workbench/plans/${encodeURIComponent(id)}${method === 'POST' ? '/apply' : ''}`
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error ?? `安排操作失败（${response.status}）`)
    // 版本过期（409）要换成「重新确认一次」的话术，其它失败照搬服务端文案。
    error.status = response.status
    throw error
  }
  return payload
}

/** 一条安排的时长：时段优先，其次事项自己的预计时长，最后按 30 分钟估。 */
function minutesOf(entry, task) {
  if (entry.startTime && entry.endTime) {
    const [sh, sm] = entry.startTime.split(':').map(Number)
    const [eh, em] = entry.endTime.split(':').map(Number)
    const span = (eh * 60 + em) - (sh * 60 + sm)
    if (span > 0) return span
  }
  const planned = Number(task?.durationMinutes)
  return Number.isInteger(planned) && planned > 0 ? planned : 30
}

function durationText(value) {
  if (value < 60) return `${value} 分钟`
  const hours = Math.floor(value / 60)
  const rest = value % 60
  return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`
}

/** 条目顺序：先按天，再按时段；没时段的排在当天最后。 */
function byEntryOrder(a, b) {
  return `${a.plannedDate ?? ''} ${a.startTime ?? '99:99'}`.localeCompare(`${b.plannedDate ?? ''} ${b.startTime ?? '99:99'}`)
}

/** 按天分组（保序）：展开区一次看清「哪天做什么」。 */
function byDay(entries) {
  const days = []
  for (const entry of entries) {
    const last = days[days.length - 1]
    if (last && last.date === entry.plannedDate) last.entries.push(entry)
    else days.push({ date: entry.plannedDate, entries: [entry] })
  }
  return days
}

/**
 * 展开区：按天分组（组头日期 + 延展线），每条一行为「左列时段 / 右列标题 + 时长 + 理由」。
 * 单独导出：SSR 门禁可以直接喂一份 plan 断言展开后的 DOM，不用先点开（交互分支不可达）。
 * @param entries - 已排序的条目。
 * @param tasks - 全部待办（取标题与预计时长）。
 * @param today - 本机今天，用来把组头写成「今天 · 9月29日」。
 * @returns 分组后的条目列表。
 */
export function PlanEntries({ entries, tasks, today }) {
  const taskMap = new Map((Array.isArray(tasks) ? tasks : []).map(task => [task.id, task]))
  return <>{byDay(entries).map(day => <div className="assistant-plan-day" key={day.date ?? 'undated'}>
    <p className="assistant-plan-day-head">
      <span className="assistant-plan-day-title">{day.date ? (day.date === today ? `今天 · ${formatDay(day.date)}` : relativeDay(day.date, today)) : TEXT.fallbackTime}</span>
      <span className="assistant-plan-day-rule" />
    </p>
    <ul className="assistant-plan-list">
      {day.entries.map((entry, index) => {
        const task = taskMap.get(entry.taskId)
        return <li className="assistant-plan-entry" data-testid="assistant-plan-entry" key={`${entry.taskId}-${index}`}>
          <span className={`assistant-plan-entry-time${entry.startTime ? '' : ' is-anytime'}`}>
            {entry.startTime ? `${entry.startTime}–${entry.endTime}` : TEXT.anytime}
          </span>
          <div className="assistant-plan-entry-main">
            <p className="assistant-plan-entry-title">
              <span>{task?.title || TEXT.fallbackTitle}</span>
              <span className="assistant-plan-entry-duration">{durationText(minutesOf(entry, task))}</span>
            </p>
            {entry.reason && <p className="assistant-plan-entry-reason">{entry.reason}</p>}
          </div>
        </li>
      })}
    </ul>
  </div>)}</>
}

export default function PlanReview({ plans, tasks, sessionId, refresh, notify }) {
  const [pending, setPending] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [resolved, setResolved] = useState({})
  const [failures, setFailures] = useState({})
  const list = useMemo(() => {
    if (!Array.isArray(plans) || !sessionId) return []
    return plans
      .filter(plan => plan?.sourceSessionId === sessionId && !HIDDEN.has(resolved[plan.id]))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }, [plans, sessionId, resolved])
  if (list.length === 0) return null

  const plan = list[Math.min(cursor, list.length - 1)]
  const entries = (Array.isArray(plan.entries) ? [...plan.entries] : []).sort(byEntryOrder)
  const today = todayISO()
  const first = entries[0]
  const meta = `${entries.length} 条${first ? ` · ${formatDay(first.plannedDate)}${first.startTime ? ` ${first.startTime} 起` : ''}` : ''}`
  const applied = (plan.appliedAt !== null && plan.appliedAt !== undefined) || resolved[plan.id] === 'applied'
  const failure = failures[plan.id]

  async function act(method) {
    if (pending) return
    setPending(plan.id)
    setFailures(current => ({ ...current, [plan.id]: null }))
    try {
      await changePlan(plan.id, method, method === 'POST' ? { expectedUpdatedAt: plan.updatedAt } : undefined)
      setResolved(current => ({ ...current, [plan.id]: method === 'POST' ? 'applied' : 'deleted' }))
      if (method === 'POST') setExpanded(false)
      notify?.(method === 'POST' ? '安排已加入日程' : '已取消这份建议')
      try {
        await refresh?.()
      } catch {
        // 写入已经成功，失败的是回读：告诉用户刷新，不把成功的操作说成失败。
        notify?.('安排已保存，但列表没刷新成功，点右上角刷新再看一次。', 'error')
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      setFailures(current => ({ ...current, [plan.id]: { message, status: error?.status, method } }))
      notify?.(message, 'error')
    } finally {
      setPending('')
    }
  }

  return <section className="assistant-plan-dock" data-testid="assistant-plan-dock" data-plan-session={sessionId} aria-label="安排建议">
    {applied
      ? <div className="assistant-plan-applied" role="status" data-testid="assistant-plan-applied">
        <IconCheck size={13} />
        <span>{TEXT.applied(entries.length)}</span>
        <button type="button" className="btn btn-sm" onClick={() => setResolved(current => ({ ...current, [plan.id]: 'dismissed' }))}>{TEXT.dismiss}</button>
      </div>
      : failure
      ? <div className="assistant-plan-error" role="alert" data-testid="assistant-plan-error">
        <span>{failure.status === 409 ? TEXT.expired : failure.message}</span>
        <button type="button" className="btn btn-sm" disabled={Boolean(pending)} onClick={() => act(failure.method)}>
          {failure.method === 'POST' ? TEXT.retryApply : TEXT.retryCancel}
        </button>
      </div>
      : <>
        <div className="assistant-plan-head">
          <span className="assistant-plan-shield">{SHIELD}</span>
          <span className="assistant-plan-title">{TEXT.title}</span>
          <span className="assistant-plan-meta">{meta}</span>
          {list.length > 1 && (
            <button type="button" className="assistant-plan-more" data-testid="assistant-plan-more" aria-label="查看其他安排建议"
              onClick={() => setCursor(current => (current + 1) % list.length)}>{TEXT.more(list.length - 1)}</button>
          )}
          <button type="button" className="assistant-plan-expand" data-testid="assistant-plan-expand" aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}>
            {expanded ? TEXT.collapse : TEXT.expand}
            <IconChevronDown size={13} className="assistant-plan-chevron" />
          </button>
        </div>
        {expanded
          ? <div className="assistant-plan-body">
            {plan.note && <p className="assistant-plan-memo">{plan.note}</p>}
            <PlanEntries entries={entries} tasks={tasks} today={today} />
          </div>
          : <p className="assistant-plan-sub">{TEXT.sub}</p>}
        <div className="assistant-plan-actions">
          <button type="button" className="btn btn-sm" data-testid="assistant-plan-cancel" disabled={Boolean(pending)} onClick={() => act('DELETE')}>{TEXT.cancel}</button>
          <button type="button" className="btn btn-primary btn-sm" data-testid="assistant-plan-apply" disabled={Boolean(pending)} onClick={() => act('POST')}>{pending === plan.id ? TEXT.applying : TEXT.apply}</button>
        </div>
        <p className="assistant-plan-hint">{TEXT.hint}</p>
      </>}
  </section>
}
