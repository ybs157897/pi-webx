

import { addDays, formatDay, formatTime, relativeDay, todayISO } from '../../util.mjs'

const TEXT = {
  list: '日志记录',
  query: '查询日志',
  queryTitle: '查询日志',
  queryHint: '条件只在点「查询」时生效；工具行里的搜索与 chips 改的是同一份条件。',
  record: '记录日志',
  recordTitle: '记录日志',
  recordHint: '内容必填；来源与标签可以留空，之后能按它们检索。',
  keyword: '关键字',
  keywordPlaceholder: '搜内容或来源…',
  keywordLabel: '日志搜索',
  level: '级别',
  levelHint: '可多选；不选表示全部级别',
  source: '来源',
  sourceAll: '全部来源',
  from: '开始日期',
  to: '结束日期',
  range: '日期',
  reset: '重置',
  submitQuery: '查询',
  submitRecord: '记录',
  hits: '命中',
  total: total => `共 ${total} 条`,
  filtered: (hits, total) => `筛选出 ${hits} / ${total} 条`,
  expandHint: '点正文展开全文',
  expand: '展开全文',
  collapse: '收起全文',
  condLabel: '当前条件',
  clearFilter: '清空条件',
  moreSources: '更多来源',
  lessSources: '收起来源',
  time: '时间',
  content: '内容',
  actions: '操作',
  empty: '还没有日志',
  emptyHint: '日志是检索的原料：记下「做了什么、改了什么、结论是什么」',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据，看看检索中心长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  filteredEmpty: '没有匹配的日志',
  filteredEmptyHint: '换个关键字，或放宽级别与日期范围',
  contentPlaceholder: '发生了什么、改了什么、结论是什么',
  date: '日期',
  dateHint: '默认今天',
  tags: '标签',
  tagsPlaceholder: '前端, 数据',
  tagsHint: '用逗号分隔，最多 8 个',
  tagsLimit: '标签最多 8 个',
  sourcePlaceholder: '可留空，比如「pi-webx」',
  recordedAt: '记录于',
  noSource: '无来源',
  delete: '删除',
  deleteConfirm: '删除日志',
  deleteMessage: '确定删除这条日志？删除后无法恢复。',
  deleted: '日志已删除',
  added: '已记录日志',
  needContent: '先写点内容',
  rangeInvalid: '开始日期晚于结束日期',
}

/** 级别：颜色（色条与 chip 同源）、文案、分段控件选项都用这一份。 */
const LEVEL_OPTIONS = [
  { value: 'info', label: '信息', tone: '' },
  { value: 'warn', label: '警告', tone: 'warn' },
  { value: 'error', label: '错误', tone: 'danger' },
]

/** 空条件：`levels` 为空数组与 `source`/`from`/`to` 为空串都表示「不筛」。 */
const EMPTY_FILTERS = { keyword: '', levels: [], source: '', from: '', to: '' }

/** 工具行直接摆几个来源 chip，多出来的折到「更多来源」后面。 */
const SOURCE_LIMIT = 8

/** 标签上限（与其它模块一致）。 */
const TAG_LIMIT = 8

/** 未知级别一律按 info 处理：色条、chip、计数都不会漏样式。 */
function levelOf(value) {
  return LEVEL_OPTIONS.find(option => option.value === value) ?? LEVEL_OPTIONS[0]
}

/** 标签草稿 → 标签数组：中英文逗号都认，去重去空。 */
function parseTags(text) {
  const parts = String(text ?? '').split(/[，,]/)
  return [...new Set(parts.map(part => part.trim()).filter(part => part !== ''))]
}

/** 记录自身字段的倒序：先比 `date`，再比 `createdAt`（缺时间戳的排在当天末尾）。 */
function byRecency(a, b) {
  const left = String(a?.date ?? '')
  const right = String(b?.date ?? '')
  if (left !== right) return left < right ? 1 : -1
  const aStamp = String(a?.createdAt ?? '')
  const bStamp = String(b?.createdAt ?? '')
  if (aStamp === bStamp) return 0
  return aStamp < bStamp ? 1 : -1
}

/** 最近两天（今天 / 昨天）才用相对说法，组头里也顺手补一个完整日期。 */
function isRecent(day, today) {
  return day === today || day === addDays(today, -1)
}

/** 组头文案：今天 / 昨天 / 9月20日 —— 更早的日期直接报日期，不用 relativeDay 的「已过」。 */
function groupLabel(day, today) {
  return isRecent(day, today) ? relativeDay(day, today) : formatDay(day)
}

/** ISO 时间戳 → `09-24 14:05`（本地时区）；缺失或非法返回空串。 */
function stampText(stamp) {
  const time = formatTime(stamp)
  if (time === '') return ''
  const date = new Date(stamp)
  return `${formatDay(todayISO(date), 'md')} ${time}`
}

export {
  TEXT, LEVEL_OPTIONS, EMPTY_FILTERS, SOURCE_LIMIT, TAG_LIMIT,
  levelOf, parseTags, byRecency, isRecent, groupLabel,
  stampText,
}
