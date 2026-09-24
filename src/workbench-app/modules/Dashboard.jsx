/**
 * 我的主页：指挥台 widget 板（多列 widget 形态，参考 glanceapp/glance 的主页）。
 *
 * 栅格：CSS Grid 自适应列（宽屏三列 / 中屏两列 / 手机单列），每格一张 Card——
 * 问候 + AI 早报、今日进度环、今日待办、问题速览、最近日志、开发事项；
 * 空库（`empty` 且没有任何记录）时整块换成首启引导卡（灌入演示数据 / 先去规划今天）。
 *
 * 数据纪律：所有数字都在渲染期从 `data` 现算（`deskOverview`），模块内不存第二份记录；
 * 写操作一律 `mutate(action, okText)` 交给 App 重新拉 state。
 * props 契约见 App.jsx（`data`/`profile`/`mutate`/`navigate`/`empty`/`onLoadDemo`）。
 * @module src/modules/Dashboard
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Chip, Empty, IconButton } from '../ui.jsx'
import { IconCheck, IconPlus, IconSparkles, IconTasks } from '../icons.jsx'
import {
  addDays, byDateDesc, formatDay, greeting, groupBy, relativeDay, todayISO,
} from '../util.mjs'
import './Dashboard.css'

const TEXT = {
  brief: 'AI 早报',
  progress: '今日进度',
  progressHint: '今天到期的任务完成率',
  progressLabel: '今日清单已完成',
  dueToday: '今日到期',
  overdue: '逾期',
  noPlan: '今天还没有排期，去今日规划加一条',
  plan: '去今日规划',
  todos: '今日待办',
  todosHint: '今天到期与已逾期的未完成事项',
  viewAll: '查看全部',
  todosEmpty: '今天没有待办',
  todosEmptyHint: '到期和逾期的都清掉了，可以去规划页安排下一步',
  restPrefix: '还有',
  restSuffix: '项待办，点「查看全部」继续。',
  fixes: '问题速览',
  fixesHint: '按状态统计，高优先级排前面',
  fixTodo: '待处理',
  fixDoing: '修复中',
  fixDone: '已修复',
  fixGo: '去处理',
  fixHigh: '高优先级未完成',
  fixClear: '没有高优先级遗留',
  fixEmpty: '问题清单已清空',
  logs: '最近日志',
  logsHint: '最新 3 条开发记录',
  record: '记日志',
  logsEmpty: '还没有日志，记一条今天的进展',
  codes: '开发事项',
  codesHintEmpty: '还没有开发事项',
  codesGo: '去开发',
  open: '未完成',
  codeTotal: '共',
  noProject: '未归项目',
  guideTitle: '欢迎使用个人 AI 指挥台',
  guideText: '这里把待办、问题、日志、需求与开发事项收在同一条流水线上，所有记录都存在本机 SQLite。'
    + '先灌一份演示数据，或直接从今天要做的第一件事开始。',
  guideDemo: '灌入演示数据',
  guidePlan: '先去规划今天',
  taskDone: '任务已完成',
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }
const PRIORITY_LABEL = { high: '高优先级', normal: '中优先级', low: '低优先级' }
const PRIORITY_TONE = { high: 'danger', normal: '', low: 'ok' }

const LEVEL_LABEL = { info: '信息', warn: '警告', error: '错误' }
const LEVEL_TONE = { info: 'accent', warn: 'warn', error: 'danger' }

/** 优先级兜底：未知/缺失一律按 normal（与 schema 默认值一致）。 */
function priorityOf(value) {
  return value === 'high' || value === 'low' ? value : 'normal'
}

/** 日志级别兜底：未知/缺失一律按 info（与 schema 默认值一致）。 */
function levelOf(value) {
  return value === 'warn' || value === 'error' ? value : 'info'
}

/** 标题兜底：旧数据可能缺 title，行内文案与 aria-label 里都不能出现 undefined。 */
function titleOf(record) {
  const title = String(record.title ?? '').trim()
  return title === '' ? '未命名记录' : title
}

/** 任务算「哪一天的事」：优先完成时刻，退回最后更新时刻，最后才是截止日。 */
function taskDay(task) {
  return String(task.doneAt ?? task.updatedAt ?? task.due ?? '').slice(0, 10)
}

/** 待办排序：截止日近的在前，同天按优先级，再按创建时间倒序（新加的在上）。 */
function byQueueOrder(a, b) {
  if (a.due !== b.due) return a.due < b.due ? -1 : 1
  const rank = (PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.normal) - (PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.normal)
  if (rank !== 0) return rank
  return byDateDesc(task => task.createdAt ?? '')(a, b)
}

/** 日志倒序：先按业务日期，再按入库时刻。 */
function byLogOrder(a, b) {
  const left = `${a.date ?? ''} ${a.createdAt ?? ''}`
  const right = `${b.date ?? ''} ${b.createdAt ?? ''}`
  if (left === right) return 0
  return left < right ? 1 : -1
}

/**
 * 主页全部派生数据：一次性从 `data` 现算，组件不再存第二份。
 * 「今天」= `due === today`；「今日待办」= 未完成且 `due <= today`（含逾期）。
 * @param data - /api/state 的 data（App 已归一化）。
 * @returns 各 widget 需要的计数、列表与日期。
 */
function deskOverview(data) {
  const source = data ?? {}
  const today = todayISO()
  const yesterday = addDays(today, -1)
  const tasks = source.tasks ?? []
  const fixes = source.fixes ?? []
  const codes = source.codes ?? []
  const openTasks = tasks.filter(task => task.done !== true)
  const todayTasks = tasks.filter(task => task.due === today)
  const queue = openTasks
    .filter(task => typeof task.due === 'string' && task.due <= today)
    .sort(byQueueOrder)
  const codeRows = [...groupBy(codes, code => (
    typeof code.project === 'string' && code.project.trim() !== '' ? code.project : TEXT.noProject
  )).entries()]
    .map(([project, items]) => ({
      project,
      total: items.length,
      open: items.filter(item => item.status !== 'done').length,
    }))
    .sort((a, b) => (b.open - a.open) || (b.total - a.total) || a.project.localeCompare(b.project))

  return {
    today,
    queue,
    dueToday: openTasks.filter(task => task.due === today).length,
    overdue: openTasks.filter(task => typeof task.due === 'string' && task.due < today).length,
    todayDone: todayTasks.filter(task => task.done === true).length,
    todayTotal: todayTasks.length,
    doneYesterday: tasks.filter(task => task.done === true && taskDay(task) === yesterday).length,
    logs: [...(source.logs ?? [])].sort(byLogOrder).slice(0, 3),
    codeRows,
    codeTotal: codes.length,
    codeOpen: codes.filter(code => code.status !== 'done').length,
    fixTodo: fixes.filter(fix => fix.status === 'todo').length,
    fixDoing: fixes.filter(fix => fix.status === 'doing').length,
    fixDone: fixes.filter(fix => fix.status === 'done').length,
    fixHigh: fixes.filter(fix => fix.status !== 'done' && fix.priority === 'high').length,
    fixOpen: fixes.filter(fix => fix.status !== 'done').length,
    totalRecords: ['tasks', 'works', 'fixes', 'logs', 'requirements', 'codes']
      .reduce((sum, key) => sum + (Array.isArray(source[key]) ? source[key].length : 0), 0),
  }
}

/**
 * AI 早报文案：从计数现算的一句话摘要（真正的 AI 早报属于 P3，这里先保证首屏有句人话）。
 * @param view - `deskOverview` 的结果。
 * @returns 一句话摘要。
 */
function briefOf(view) {
  if (view.totalRecords === 0) return '工作台还是空的：加一条任务或记一条日志，这块板子就会开始说话。'
  const parts = [
    view.doneYesterday > 0 ? `昨天完成 ${view.doneYesterday} 项` : '昨天没有勾掉任务',
    view.dueToday > 0 ? `今天有 ${view.dueToday} 项待办` : '今天暂无到期待办',
    view.fixOpen > 0 ? `${view.fixOpen} 个问题待处理` : '问题清单已清空',
  ]
  if (view.codeOpen > 0) parts.push(`${view.codeOpen} 个开发事项未完成`)
  return `${parts.join('，')}。`
}

/**
 * 纯 CSS 进度环（conic-gradient 画外圈，内芯盖一个背景色圆盘）。
 * @param props - `done` / `total` 决定比例，百分比画在环心。
 * @returns 进度环元素。
 */
function ProgressRing({ done, total }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div
      className="dash-ring"
      style={{ '--dash-pct': percent }}
      role="img"
      aria-label={`今日完成度 ${percent}%，已完成 ${done} / ${total} 项`}
    >
      <span className="dash-ring-value">{percent}%</span>
    </div>
  )
}

export default function Dashboard({ data, profile, mutate, navigate, empty, onLoadDemo }) {
  const [pendingId, setPendingId] = useState('')
  const [demoBusy, setDemoBusy] = useState(false)
  const view = useMemo(() => deskOverview(data), [data])
  const name = String(profile?.name ?? '').trim() === '' ? '我' : String(profile.name).trim()
  const motto = String(profile?.motto ?? '').trim()

  /** 主页勾选即完成：写完由 App 统一刷新，失败会弹提示（不做乐观更新，避免两份状态）。 */
  async function toggleTask(task) {
    setPendingId(task.id)
    await mutate(() => api.patchRecord('tasks', task.id, { done: true }), TEXT.taskDone)
    setPendingId('')
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  // 首启（库为空）：整块换成引导卡，不摆一排空 widget。
  if (empty === true && view.totalRecords === 0) {
    return (
      <div className="dash" data-module="dashboard">
        <div className="dash-grid">
          <div className="dash-cell dash-cell-wide dash-cell-guide" data-widget="welcome">
            <Card>
              <div className="dash-guide">
                <span className="dash-guide-icon"><IconSparkles size={22} /></span>
                <h2 className="dash-guide-title">{TEXT.guideTitle}</h2>
                <p className="dash-guide-text">{TEXT.guideText}</p>
                <div className="dash-guide-actions">
                  {typeof onLoadDemo === 'function' && (
                    <button type="button" className="btn btn-primary" disabled={demoBusy} onClick={loadDemo}>
                      {demoBusy ? '正在灌入…' : TEXT.guideDemo}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => navigate('tasks')}>{TEXT.guidePlan}</button>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dash" data-module="dashboard">
      <div className="dash-grid">
        <div className="dash-cell dash-cell-wide" data-widget="greeting">
          <Card>
            <div className="dash-greet">
              <div className="dash-greet-main">
                <h2 className="dash-greet-title">{greeting()}，{name}</h2>
                <p className="dash-greet-date">{formatDay(view.today, 'full')}</p>
                {motto !== '' && <p className="dash-greet-motto">「{motto}」</p>}
              </div>
              <div className="dash-brief">
                <p className="dash-brief-label"><IconSparkles size={14} />{TEXT.brief}</p>
                <p className="dash-brief-text">{briefOf(view)}</p>
              </div>
            </div>
          </Card>
        </div>

        <div className="dash-cell" data-widget="progress">
          <Card
            title={TEXT.progress}
            subtitle={TEXT.progressHint}
            action={<IconButton label={TEXT.plan} onClick={() => navigate('tasks')}><IconTasks size={16} /></IconButton>}
          >
            <div className="dash-progress">
              <ProgressRing done={view.todayDone} total={view.todayTotal} />
              <div className="dash-progress-side">
                <p className="dash-progress-value">{view.todayDone}<span className="dash-progress-total">/{view.todayTotal}</span></p>
                <p className="dash-progress-label">{TEXT.progressLabel}</p>
              </div>
            </div>
            <div className="dash-foot">
              <span>{TEXT.dueToday} {view.dueToday} 项</span>
              {view.overdue > 0 && <Chip tone="danger">{TEXT.overdue} {view.overdue} 项</Chip>}
              {view.todayTotal === 0 && <span>{TEXT.noPlan}</span>}
            </div>
          </Card>
        </div>

        <div className="dash-cell" data-widget="todos">
          <Card
            title={TEXT.todos}
            subtitle={TEXT.todosHint}
            action={<button type="button" className="btn btn-sm" onClick={() => navigate('tasks')}>{TEXT.viewAll}</button>}
          >
            {view.queue.length === 0
              ? <Empty icon={<IconCheck size={20} />} title={TEXT.todosEmpty} hint={TEXT.todosEmptyHint} />
              : (
                <ul className="dash-list">
                  {view.queue.slice(0, 5).map(task => (
                    <li className="dash-todo" key={task.id}>
                      <input
                        type="checkbox"
                        className="dash-check"
                        checked={false}
                        disabled={pendingId === task.id}
                        aria-label={`完成：${titleOf(task)}`}
                        onChange={() => toggleTask(task)}
                      />
                      <div className="dash-todo-main">
                        <p className="dash-todo-title">{titleOf(task)}</p>
                        <p className="dash-todo-meta">
                          {typeof task.due === 'string' && (
                            <span className={`dash-due ${task.due < view.today ? 'is-overdue' : ''}`}>
                              {relativeDay(task.due, view.today)}
                            </span>
                          )}
                          <Chip tone={PRIORITY_TONE[priorityOf(task.priority)]}>{PRIORITY_LABEL[priorityOf(task.priority)]}</Chip>
                          {typeof task.tag === 'string' && task.tag !== '' && <span className="dash-tag">#{task.tag}</span>}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            {view.queue.length > 5 && (
              <p className="dash-none">{TEXT.restPrefix} {view.queue.length - 5} {TEXT.restSuffix}</p>
            )}
          </Card>
        </div>

        <div className="dash-cell" data-widget="fixes">
          <Card
            title={TEXT.fixes}
            subtitle={TEXT.fixesHint}
            action={<button type="button" className="btn btn-sm" onClick={() => navigate('fixes')}>{TEXT.fixGo}</button>}
          >
            <div className="dash-figures">
              <div className="dash-figure">
                <span className="dash-figure-value">{view.fixTodo}</span>
                <span className="dash-figure-label">{TEXT.fixTodo}</span>
              </div>
              <div className="dash-figure is-accent">
                <span className="dash-figure-value">{view.fixDoing}</span>
                <span className="dash-figure-label">{TEXT.fixDoing}</span>
              </div>
              <div className="dash-figure is-ok">
                <span className="dash-figure-value">{view.fixDone}</span>
                <span className="dash-figure-label">{TEXT.fixDone}</span>
              </div>
            </div>
            <div className="dash-foot">
              {view.fixHigh > 0
                ? <Chip tone="danger">{TEXT.fixHigh} {view.fixHigh}</Chip>
                : <Chip tone="ok">{TEXT.fixClear}</Chip>}
              <span>{view.fixOpen > 0 ? `${TEXT.open} ${view.fixOpen} 个` : TEXT.fixEmpty}</span>
            </div>
          </Card>
        </div>

        <div className="dash-cell" data-widget="logs">
          <Card
            title={TEXT.logs}
            subtitle={TEXT.logsHint}
            action={(
              <button type="button" className="btn btn-sm" onClick={() => navigate('logs')}>
                <IconPlus size={13} />
                {TEXT.record}
              </button>
            )}
          >
            {view.logs.length === 0
              ? <p className="dash-none">{TEXT.logsEmpty}</p>
              : (
                <ul className="dash-list">
                  {view.logs.map(log => (
                    <li className="dash-log" key={log.id}>
                      <p className="dash-log-head">
                        <Chip tone={LEVEL_TONE[levelOf(log.level)]}>{LEVEL_LABEL[levelOf(log.level)]}</Chip>
                        <span className="dash-log-date">{formatDay(log.date)}</span>
                        {typeof log.source === 'string' && log.source !== '' && (
                          <span className="dash-log-source">{log.source}</span>
                        )}
                      </p>
                      <p className="dash-log-text">{log.text}</p>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </div>

        <div className="dash-cell" data-widget="codes">
          <Card
            title={TEXT.codes}
            subtitle={view.codeTotal === 0 ? TEXT.codesHintEmpty : `${TEXT.open} ${view.codeOpen} / ${TEXT.codeTotal} ${view.codeTotal}`}
            action={<button type="button" className="btn btn-sm" onClick={() => navigate('codes')}>{TEXT.codesGo}</button>}
          >
            {view.codeRows.length === 0
              ? <p className="dash-none">{TEXT.codesHintEmpty}</p>
              : (
                <ul className="dash-list">
                  {view.codeRows.map(row => (
                    <li className="dash-code" key={row.project}>
                      <p className="dash-code-head">
                        <span className="dash-code-name">{row.project}</span>
                        <span className="dash-code-count">{row.open}/{row.total}</span>
                      </p>
                      <span className="dash-bar" aria-hidden="true">
                        <span style={{ width: `${row.total === 0 ? 0 : Math.round(((row.total - row.open) / row.total) * 100)}%` }} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </div>
      </div>
    </div>
  )
}
