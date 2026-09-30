/**
 * 今日视图：一天的安排 = 一根时间轴。
 *
 * 分组依据从「类型」改为「时间」——有 `startTime` 的事项（不分 kind）按时间升序进同一根轴，
 * fixed / flexible 的区别交给节点符号（实心锚点 / 空心补位）；没有 startTime 的进轴末
 * 「时间待定」小节。遗留与候选都不进轴，各自收在轴两端的默认折叠里。
 *
 * 概览卡、待定小节、候选列表共用同一个 `useMemo` 派生的数据——概览数字和列表必须同源，
 * 两处独立算口径迟早对不上。渲染期只读 `new Date()` 做纯计算（当前时刻线），
 * 不碰 window/document：SSR 门禁用 react-dom/server 纯渲染这些组件。
 *
 * @module modules/today
 */

import { useMemo, useState } from 'react'
import { api } from '../../api.mjs'
import { addDays, formatDay, todayISO, weekdayCN } from '../../util.mjs'
import { IconCalendar, IconChevronRight } from '../../icons.jsx'
import TaskDetails from '../tasks/TaskDetails.jsx'
import { dueLabel, durationText } from '../tasks/model.jsx'
import TodayOverview from './TodayOverview.jsx'
import './Today.css'

/** 相邻两件事之间空闲到这个分钟数才画呼吸缝。 */
const GAP_MINUTES = 45

/** 没有时长也没有时段的事项按半小时估。 */
const DEFAULT_MINUTES = 30

/** `HH:mm` → 从零点起的分钟数；缺失或非法输入返回 null。 */
function toMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''))
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** 一件事要占的分钟数：合法时段优先，其次预计时长，都没有兜底半小时。 */
function minutesOf(task) {
  const start = toMinutes(task.startTime)
  const end = toMinutes(task.endTime)
  if (start !== null && end !== null && end > start) return end - start
  return Number.isInteger(task.durationMinutes) && task.durationMinutes > 0 ? task.durationMinutes : DEFAULT_MINUTES
}

/** 事项在轴上的占位区间；没有合法开始时间时返回 null（进待定小节）。 */
function spanOf(task) {
  const start = toMinutes(task.startTime)
  if (start === null) return null
  const end = toMinutes(task.endTime)
  return { start, end: end !== null && end > start ? end : start + minutesOf(task) }
}

/** 轴内排序：时间升序，同刻按创建时间（缺字段的在先）。 */
function byTime(a, b) {
  const left = toMinutes(a.startTime)
  const right = toMinutes(b.startTime)
  if (left !== right) return (left ?? 0) - (right ?? 0)
  return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
}

/** 行内元信息一句话：时长 + 截止 + 标签。 */
function metaText(task) {
  const parts = [durationText(minutesOf(task))]
  if (task.due) parts.push(`${formatDay(task.due, 'md')} 截止`)
  if (task.tag) parts.push(`#${task.tag}`)
  return parts.join(' · ')
}

/**
 * 派生这一天的全部版面数据。
 * @param tasks - 全库事项。
 * @param date - 正在查看的日期（`YYYY-MM-DD`）。
 * @param today - 本机今天（`YYYY-MM-DD`）。
 * @param nowMinutes - 当前时刻（从零点起的分钟数），用来决定当前时刻线插在哪儿。
 */
function deriveBoard(tasks, date, today, nowMinutes) {
  const scheduled = tasks.filter(task => task.plannedDate === date).sort(byTime)
  const timed = scheduled.filter(task => spanOf(task) !== null)
  const undated = scheduled.filter(task => spanOf(task) === null)
  const open = scheduled.filter(task => task.done !== true)
  const done = scheduled.filter(task => task.done === true)
  const openMinutes = open.reduce((sum, task) => sum + minutesOf(task), 0)

  // 余量 = 整段跨度 − Σ带时段时长；带时段项少于 2 件时这个口径没有意义。
  const spans = timed.map(spanOf)
  const slack = spans.length >= 2
    ? Math.max(0, Math.max(...spans.map(span => span.end)) - Math.min(...spans.map(span => span.start))
      - spans.reduce((sum, span) => sum + (span.end - span.start), 0))
    : null

  // 当前时刻线：只看今天，且「现在」要落在轴的区间里；时刻落在两行之间也按时间序插入。
  const first = spans.length > 0 ? Math.min(...spans.map(span => span.start)) : 0
  const last = spans.length > 0 ? Math.max(...spans.map(span => span.end)) : 0
  const showNow = date === today && spans.length > 0 && nowMinutes >= first && nowMinutes <= last
  const rows = []
  let nowPlaced = false
  timed.forEach((task, index) => {
    const span = spanOf(task)
    if (showNow && !nowPlaced && nowMinutes <= span.start) {
      rows.push({ type: 'now', key: 'now' })
      nowPlaced = true
    }
    rows.push({ type: 'slot', key: task.id, task })
    const next = timed[index + 1]
    if (next === undefined) return
    const free = spanOf(next).start - span.end
    if (free >= GAP_MINUTES) rows.push({ type: 'gap', key: `gap-${task.id}`, minutes: free })
  })
  if (showNow && !nowPlaced) rows.push({ type: 'now', key: 'now' })

  return {
    scheduled, timed, undated, open, done, openMinutes, slack, rows,
    // 遗留只列「别的日子」上欠着的事：正在看的这天已经画在轴上，不重复出现。
    carryovers: tasks
      .filter(task => task.done !== true && task.plannedDate && task.plannedDate < today && task.plannedDate !== date)
      .sort((a, b) => String(a.plannedDate).localeCompare(String(b.plannedDate))),
    // 候选 = 没排期也没完成的；口径与概览格「待安排」完全一致。
    candidates: tasks.filter(task => task.done !== true && !task.plannedDate),
  }
}

/** 轴上/待定行共用的动作区：保留 today-entry-complete / today-entry-remove 契约。 */
function SlotActions({ task, pending, onDetails, onPatch, extraLabel }) {
  const done = task.done === true
  return <div className="assistant-slot-actions">
    {extraLabel !== undefined && <button type="button" className="btn btn-sm" onClick={() => onDetails(task)}>{extraLabel}</button>}
    <button type="button" className="btn btn-sm" data-testid="today-entry-complete" disabled={pending === task.id} onClick={() => onPatch(task, { done: !done }, done ? '已恢复为待办' : '已完成')}>{done ? '恢复' : '完成'}</button>
    <button type="button" className="btn btn-sm" data-testid="today-entry-remove" disabled={pending === task.id} onClick={() => onPatch(task, { plannedDate: '', startTime: null, endTime: null }, '已从日程移除')}>移除</button>
  </div>
}

/** 轴行：gutter 时间 + 节点 + 卡片体；kind 只在这里分叉（实心 / 空心）。 */
function SlotRow({ task, pending, onDetails, onPatch }) {
  const done = task.done === true
  const state = `${task.kind === 'fixed' ? 'is-fixed' : 'is-flex'}${done ? ' is-done' : ''}`
  return <li className={`assistant-slot ${state}`} data-testid="today-entry">
    <div className="assistant-slot-gutter">
      {task.kind === 'fixed'
        ? <strong><time dateTime={task.startTime}>{task.startTime}</time></strong>
        : <span className="assistant-slot-time"><time dateTime={task.startTime}>{task.startTime}</time></span>}
      {task.endTime && <span className="assistant-slot-end">{task.endTime}</span>}
    </div>
    <span className="assistant-slot-dot" aria-hidden="true" />
    <div className="assistant-slot-body" data-testid="assistant-slot">
      <div className="assistant-slot-main">
        <button type="button" className="assistant-slot-title" data-testid="today-entry-open" onClick={() => onDetails(task)}>{task.title}</button>
        <p className="assistant-slot-meta">{metaText(task)}</p>
      </div>
      <SlotActions task={task} pending={pending} onDetails={onDetails} onPatch={onPatch} />
    </div>
  </li>
}

/** 待定行：轴外，gutter 写「待定」、不画节点；固定安排补一个「补上时间」入口。 */
function UndatedRow({ task, pending, onDetails, onPatch }) {
  const done = task.done === true
  return <li className={`assistant-slot is-undated${done ? ' is-done' : ''}`} data-testid="today-entry">
    <div className="assistant-slot-gutter"><span className="assistant-slot-time">待定</span></div>
    <div className="assistant-slot-body" data-testid="assistant-slot">
      <div className="assistant-slot-main">
        <button type="button" className="assistant-slot-title" data-testid="today-entry-open" onClick={() => onDetails(task)}>{task.title}</button>
        <p className="assistant-slot-meta">{metaText(task)}</p>
      </div>
      <SlotActions
        task={task}
        pending={pending}
        onDetails={onDetails}
        onPatch={onPatch}
        extraLabel={task.kind === 'fixed' ? '补上时间' : undefined}
      />
    </div>
  </li>
}

/** 默认折叠的区块：折叠头是唯一的交互面，展开态交给 aria-expanded。 */
function Fold({ tone, testid, head, open, onToggle, children }) {
  return <section className={`assistant-fold ${tone}`} data-testid={testid}>
    <button type="button" className={`assistant-fold-head ${tone}`} aria-expanded={open} onClick={onToggle}>
      <span>{head}</span>
      <span className="assistant-fold-chevron" aria-hidden="true"><IconChevronRight size={14} /></span>
    </button>
    <div className="assistant-fold-body" hidden={!open}>{children}</div>
  </section>
}

export default function Today({ data, mutate, notify, onShowTasks }) {
  const today = todayISO()
  const [date, setDate] = useState(today)
  const [details, setDetails] = useState(null)
  const [pending, setPending] = useState('')
  const [carryOpen, setCarryOpen] = useState(false)
  const [pickOverride, setPickOverride] = useState(null)
  // 「现在」是纯计算：渲染期读一次本机时钟，分钟粒度变化才重算版面。
  const clock = new Date()
  const clockMinutes = clock.getHours() * 60 + clock.getMinutes()
  const board = useMemo(
    () => deriveBoard(Array.isArray(data?.tasks) ? data.tasks : [], date, today, clockMinutes),
    [data, date, today, clockMinutes],
  )
  const empty = board.scheduled.length === 0
  const candidatesOpen = pickOverride ?? empty
  const showTasks = typeof onShowTasks === 'function' ? onShowTasks : null
  const title = date === today ? '今天' : `${formatDay(date)} ${weekdayCN(date)}`
  const headSub = date === today
    ? `${formatDay(date)} ${weekdayCN(date)} · ${board.open.length} 件已排`
    : `${board.open.length} 件已排`

  async function patch(task, fields, message) {
    if (pending) return false
    setPending(task.id)
    try { return await mutate?.(() => api.patchRecord('tasks', task.id, fields), message) }
    finally { setPending('') }
  }

  /** 安排到这天：固定安排必须落到具体时段，交回详情弹窗补；灵活事项直接排进今天。 */
  async function planTask(task) {
    if (pending) return
    if (task.kind === 'fixed') { setDetails({ ...task, plannedDate: date }); return }
    await patch(task, { plannedDate: date }, `已安排到 ${formatDay(date)}`)
  }

  function reschedule(task) {
    if (task.kind === 'fixed') { setDetails({ ...task, plannedDate: date }); return }
    patch(task, { plannedDate: date, startTime: null, endTime: null }, '已重新安排')
  }

  const progress = board.scheduled.length === 0 ? 0 : Math.round((board.done.length / board.scheduled.length) * 100)

  return <div className="today" data-module="today" data-testid="today-planner">
    <header className="assistant-head">
      <div className="assistant-head-main">
        <h2 className="assistant-head-title">{title}</h2>
        <p className="assistant-head-sub">{headSub}</p>
      </div>
      <div className="assistant-head-controls">
        <button type="button" className="btn btn-sm" data-testid="today-prev-day" aria-label="前一天" onClick={() => setDate(addDays(date, -1))}>←</button>
        <input className="assistant-date-input" type="date" aria-label="规划日期" data-testid="today-date" value={date} onChange={event => event.target.value && setDate(event.target.value)} />
        <button type="button" className="btn btn-sm" data-testid="today-next-day" aria-label="后一天" onClick={() => setDate(addDays(date, 1))}>→</button>
        {date !== today && <button type="button" className="btn btn-sm" data-testid="today-back-to-today" onClick={() => setDate(today)}>回今天</button>}
      </div>
    </header>

    <TodayOverview board={board} progress={progress} candidatesOpen={candidatesOpen} onToggleCandidates={() => setPickOverride(!candidatesOpen)} />

    <div className="today-body">
      <section className="today-schedule-card" data-testid="today-schedule-card" aria-label="当天日程">
        <div className="today-section-heading">
          <div>
            <h3>当天日程</h3>
            <p>{board.scheduled.length} 件已排 · 按时间查看</p>
          </div>
        </div>
        {empty
          ? <div className="assistant-empty" data-testid="assistant-empty">
            <span className="assistant-empty-icon" aria-hidden="true"><IconCalendar size={20} /></span>
            <p className="assistant-empty-title">这一天还是空的</p>
            <p className="assistant-empty-hint">先放两件真的要做的事，剩下的留给意外。</p>
          </div>
          : <>
            <ol className="assistant-timeline" data-testid="assistant-timeline" data-timeline={board.timed.length > 0 ? 'on' : 'off'}>
              {board.rows.map(row => {
                if (row.type === 'now') {
                  return <li className="assistant-now" data-testid="assistant-now" key={row.key}>
                    <span className="assistant-now-pill">{String(clock.getHours()).padStart(2, '0')}:{String(clock.getMinutes()).padStart(2, '0')}</span>
                    <span className="assistant-now-line" />
                  </li>
                }
                if (row.type === 'gap') {
                  return <li className="assistant-gap" data-testid="assistant-gap" key={row.key}>
                    <span className="assistant-gap-rule" />
                    <span className="assistant-gap-text">空 {durationText(row.minutes)}</span>
                    <span className="assistant-gap-rule" />
                  </li>
                }
                return <SlotRow key={row.key} task={row.task} pending={pending} onDetails={setDetails} onPatch={patch} />
              })}
            </ol>
            {board.undated.length > 0 && <section className="assistant-undated" data-testid="assistant-undated">
              <div className="assistant-undated-head">
                <span className="assistant-undated-title">{date === today ? '今天' : formatDay(date)}，时间待定（{board.undated.length}）</span>
                <span className="assistant-undated-rule" aria-hidden="true" />
              </div>
              <ul className="assistant-undated-list">
                {board.undated.map(task => <UndatedRow key={task.id} task={task} pending={pending} onDetails={setDetails} onPatch={patch} />)}
              </ul>
            </section>}
          </>}
      </section>

      <aside className="today-supporting-cards" data-testid="today-supporting-cards" aria-label="待处理事项">
        {board.carryovers.length > 0 && <Fold
          tone="is-warn"
          testid="today-carryover"
          head={`有 ${board.carryovers.length} 件之前安排的事还没完成`}
          open={carryOpen}
          onToggle={() => setCarryOpen(!carryOpen)}
        >
          <ul className="assistant-carryover-list" data-testid="assistant-carryover">
            {board.carryovers.map(task => <li className="assistant-carryover-row" key={task.id}>
              <div className="assistant-carryover-main">
                <p className="assistant-carryover-title">{task.title}</p>
                <p className="assistant-carryover-meta">{formatDay(task.plannedDate, 'md')} 的安排</p>
              </div>
              <button type="button" className="btn btn-sm" data-testid="today-carryover-reschedule" disabled={pending === task.id} onClick={() => reschedule(task)}>安排到这天</button>
              <button type="button" className="btn btn-sm" data-testid="today-carryover-defer" disabled={pending === task.id} onClick={() => patch(task, { plannedDate: '', startTime: null, endTime: null }, '已退回未安排')}>暂不安排</button>
            </li>)}
          </ul>
        </Fold>}

        <Fold
          tone="is-pick"
          testid="today-candidates"
          head={`从待办里挑（${board.candidates.length}）`}
          open={candidatesOpen}
          onToggle={() => setPickOverride(!candidatesOpen)}
        >
          <ul className="assistant-candidates" data-testid="assistant-candidates">
            {board.candidates.length === 0
              ? <li className="assistant-candidate is-empty">没有未安排的待办了</li>
              : board.candidates.map((task, index) => {
                const due = dueLabel(task, today)
                return <li className="assistant-candidate" key={task.id} data-testid={index === 0 ? 'today-plan-picked' : undefined}>
                  <div className="assistant-candidate-main">
                    <p className="assistant-candidate-title">{task.title}</p>
                    <p className="assistant-candidate-meta">
                      {task.due && <span className={`assistant-candidate-due ${due.tone}`}>{due.text}</span>}
                      <span className="assistant-candidate-span">约 {durationText(minutesOf(task))}</span>
                    </p>
                  </div>
                  <button type="button" className="btn btn-sm" data-testid="today-pick-task" disabled={pending === task.id} onClick={() => planTask(task)}>安排到今天</button>
                </li>
              })}
          </ul>
          {showTasks && <div className="assistant-fold-foot">
            <button type="button" className="assistant-link" onClick={() => showTasks()}>查看全部待办 →</button>
          </div>}
        </Fold>
      </aside>
    </div>

    <TaskDetails task={details} onClose={() => setDetails(null)} mutate={mutate} notify={notify} />
  </div>
}
