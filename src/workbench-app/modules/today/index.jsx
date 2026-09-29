import { useMemo, useState } from 'react'
import { api } from '../../api.mjs'
import { addDays, formatDay, todayISO } from '../../util.mjs'
import TaskDetails from '../tasks/TaskDetails.jsx'
import './Today.css'

function minutes(task) {
  if (task.startTime && task.endTime) {
    const [sh, sm] = task.startTime.split(':').map(Number)
    const [eh, em] = task.endTime.split(':').map(Number)
    const span = (eh * 60 + em) - (sh * 60 + sm)
    if (span > 0) return span
  }
  return Number.isInteger(task.durationMinutes) && task.durationMinutes > 0 ? task.durationMinutes : 30
}

function durationText(value) {
  if (value < 60) return `${value} 分钟`
  const hours = Math.floor(value / 60)
  const rest = value % 60
  return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`
}

function sortAgenda(a, b) {
  const left = a.startTime || '99:99'
  const right = b.startTime || '99:99'
  if (left !== right) return left.localeCompare(right)
  return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
}

function AgendaList({ title, rows, empty, pending, onDetails, onPatch }) {
  return <section className="today-group">
    <div className="today-group-head"><h3>{title}</h3><span>{rows.length}</span></div>
    {rows.length ? <ul className="today-list">{rows.map(task => <li className={`today-item ${task.done ? 'is-done' : ''}`} key={task.id} data-testid="today-entry">
      <div className="today-item-time">{task.startTime ? <><strong>{task.startTime}</strong><span>{task.endTime}</span></> : <span>{task.kind === 'fixed' ? '待定时间' : '灵活安排'}</span>}</div>
      <div className="today-item-content"><button type="button" className="today-item-title" data-testid="today-entry-open" onClick={() => onDetails(task)}>{task.title}</button><p>{durationText(minutes(task))}{task.due ? ` · ${formatDay(task.due, 'md')} 截止` : ''}{task.tag ? ` · #${task.tag}` : ''}</p></div>
      <div className="today-item-actions"><button type="button" className="btn btn-sm" data-testid="today-entry-complete" disabled={pending === task.id} onClick={() => onPatch(task, { done: !task.done }, task.done ? '已恢复为待办' : '已完成')}>{task.done ? '恢复' : '完成'}</button><button type="button" className="btn btn-sm" data-testid="today-entry-remove" disabled={pending === task.id} onClick={() => onPatch(task, { plannedDate: '', startTime: null, endTime: null }, '已从日程移除')}>移除</button></div>
    </li>)}</ul> : <p className="today-group-empty">{empty}</p>}
  </section>
}

export default function Today({ data, mutate, notify }) {
  const today = todayISO()
  const [date, setDate] = useState(today)
  const [picked, setPicked] = useState('')
  const [details, setDetails] = useState(null)
  const [pending, setPending] = useState('')
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const scheduled = useMemo(() => tasks.filter(task => task.plannedDate === date).sort(sortAgenda), [tasks, date])
  const fixed = scheduled.filter(task => task.kind === 'fixed')
  const flexible = scheduled.filter(task => task.kind !== 'fixed')
  const candidates = tasks.filter(task => task.done !== true && !task.plannedDate)
  const carryovers = tasks.filter(task => task.done !== true && task.plannedDate && task.plannedDate < today)
    .sort((a, b) => String(a.plannedDate).localeCompare(String(b.plannedDate)))
  const total = scheduled.filter(task => task.done !== true).reduce((sum, task) => sum + minutes(task), 0)
  const doneCount = scheduled.filter(task => task.done === true).length

  async function patch(task, fields, message) {
    if (pending) return false
    setPending(task.id)
    try { return await mutate?.(() => api.patchRecord('tasks', task.id, fields), message) }
    finally { setPending('') }
  }

  async function planPicked() {
    const task = candidates.find(item => item.id === picked)
    if (!task) return
    if (task.kind === 'fixed') { setDetails({ ...task, plannedDate: date }); return }
    const ok = await patch(task, { plannedDate: date }, `已安排到 ${formatDay(date)}`)
    if (ok) setPicked('')
  }

  return <div className="today" data-module="today" data-testid="today-planner">
    <header className="today-hero"><div><p className="today-eyebrow">生活秘书 · 每日安排</p><h2>{date === today ? '今天' : formatDay(date)}怎么过</h2><p>固定安排先留位，再放进可以灵活处理的事。</p></div><div className="today-date-controls"><button type="button" className="btn btn-sm" data-testid="today-prev-day" aria-label="前一天" onClick={() => setDate(addDays(date, -1))}>←</button><input type="date" aria-label="规划日期" data-testid="today-date" value={date} onChange={event => event.target.value && setDate(event.target.value)} /><button type="button" className="btn btn-sm" data-testid="today-next-day" aria-label="后一天" onClick={() => setDate(addDays(date, 1))}>→</button>{date !== today && <button type="button" className="btn btn-sm" data-testid="today-back-to-today" onClick={() => setDate(today)}>回今天</button>}</div></header>
    <div className="today-summary"><strong>{scheduled.length} 件事项</strong><span>{doneCount} 件已完成</span><span>待处理预计 {durationText(total)}</span></div>
    <div className="today-breathing">给路程、休息和临时事情留一点空白；预计用时只计算尚未完成的事项。</div>
    <AgendaList title="固定安排" rows={fixed} empty="这天还没有固定安排" pending={pending} onDetails={setDetails} onPatch={patch} />
    <AgendaList title="灵活事项" rows={flexible} empty="从下方挑一件需要处理的事，安排到这天" pending={pending} onDetails={setDetails} onPatch={patch} />
    <section className="today-pick" data-testid="today-candidates"><div><h3>从待办里安排</h3><p>选择后只设置计划日期，不改变截止日期。</p></div><div className="today-pick-controls"><select aria-label="选择待办" data-testid="today-pick-task" value={picked} onChange={event => setPicked(event.target.value)}><option value="">选择一件未安排事项</option>{candidates.map(task => <option key={task.id} value={task.id}>{task.title}{task.due ? ` · ${formatDay(task.due, 'md')} 截止` : ''}</option>)}</select><button type="button" className="btn btn-primary btn-sm" data-testid="today-plan-picked" disabled={!picked || Boolean(pending)} onClick={planPicked}>安排到这天</button></div></section>
    {carryovers.length > 0 && <section className="today-carryover" data-testid="today-carryover"><h3>之前安排但还没完成</h3><ul>{carryovers.map(task => <li key={task.id}><div><strong>{task.title}</strong><span>{formatDay(task.plannedDate, 'md')} 的安排</span></div><button type="button" className="btn btn-sm" data-testid="today-carryover-reschedule" disabled={pending === task.id} onClick={() => task.kind === 'fixed' ? setDetails({ ...task, plannedDate: date }) : patch(task, { plannedDate: date, startTime: null, endTime: null }, '已重新安排')}>安排到这天</button><button type="button" className="btn btn-sm" data-testid="today-carryover-defer" disabled={pending === task.id} onClick={() => patch(task, { plannedDate: '', startTime: null, endTime: null }, '已退回未安排')}>暂不安排</button></li>)}</ul></section>}
    <TaskDetails task={details} onClose={() => setDetails(null)} mutate={mutate} notify={notify} />
  </div>
}
