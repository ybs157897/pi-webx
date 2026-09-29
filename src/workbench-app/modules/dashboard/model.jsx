

import { addDays, byDateDesc, groupBy, todayISO } from '../../util.mjs'

const TEXT = {
  brief: 'AI 早报',
  progress: '今日进度',
  progressHint: '今天已安排事项的完成率',
  progressLabel: '今日清单已完成',
  dueToday: '今日到期',
  overdue: '逾期',
  noPlan: '今天还没有安排，和生活秘书一起规划',
  plan: '去今日规划',
  todos: '今日待办',
  todosHint: '今日安排，以及到期需要关注的事项',
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
  guideText: '生活秘书帮你收集待办、安排今天，工作模块帮你处理需求与开发。'
    + '可以先记下一件事，也可以载入演示数据看看。',
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
 * 今日进度按 plannedDate 统计；待关注列表同时包含到期事项。
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
  const todayTasks = tasks.filter(task => task.plannedDate === today)
  const queue = openTasks
    .filter(task => task.plannedDate === today || (typeof task.due === 'string' && task.due !== '' && task.due <= today))
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

export {
  TEXT, PRIORITY_RANK, PRIORITY_LABEL, PRIORITY_TONE, LEVEL_LABEL,
  LEVEL_TONE, priorityOf, levelOf, titleOf, taskDay,
  byQueueOrder, byLogOrder, deskOverview, briefOf, ProgressRing,
}
