

import { Chip } from '../../ui.jsx'

const TEXT = {
  title: '问题修复',
  create: '新建问题',
  createSubmit: '创建',
  edit: '编辑问题',
  save: '保存',
  editAction: '编辑',
  delete: '删除',
  deleteConfirm: '删除问题',
  deleteMessage: '确定删除这条问题记录？删除后无法恢复。',
  deleted: '已删除',
  created: '已记录问题',
  updated: '问题已更新',
  statusChanged: '已更新为',
  quickAdd: '描述问题，回车确认',
  needTitle: '先描述一下问题',
  search: '搜索标题或备注…',
  searchLabel: '搜索问题',
  filterLabel: '状态筛选',
  filterAll: '全部',
  todo: '待处理',
  doing: '修复中',
  done: '已修复',
  priorityFilter: '优先级',
  tagFilter: '标签',
  clearFilter: '清空筛选',
  moreTags: '更多标签',
  lessTags: '收起标签',
  expandHint: '点标题展开详情',
  totalText: total => `共 ${total} 条`,
  filteredText: (hits, total) => `筛选出 ${hits} / ${total} 条`,
  moreLogs: count => `还有 ${count} 条`,
  filteredEmpty: '没有匹配的问题',
  filteredEmptyHint: '换个关键词，或清掉几个筛选条件',
  empty: '还没有问题记录',
  emptyHint: '写下第一个问题：标题必填，优先级与标签可以稍后补',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据，看看问题清单长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  fieldTitle: '标题',
  fieldPriority: '优先级',
  fieldStatus: '状态',
  fieldNote: '备注',
  notePlaceholder: '复现步骤、影响面、根因、结论…',
  fieldTags: '标签',
  colTime: '更新时间',
  colActions: '操作',
  tagsHint: '用逗号分隔，最多 8 个',
  tagsLimit: '标签最多 8 个',
  noNote: '这条问题没有备注',
  noTags: '没有标签',
  relatedTasks: '关联任务',
  relatedLogs: '关联日志',
  goTasks: '去我的待办',
  goLogs: '去日志查询',
  noTasks: '没有关联任务',
  noTasksHint: '任务记录的 refs 指向这条问题后，会出现在这里',
  noLogs: '还没有关联日志',
  taskDone: '已完成',
  taskTodo: '待办',
  createdAt: '创建',
  updatedAt: '更新',
  logAction: '记一条日志',
  logTitle: '记一条日志',
  logHint: '日志会以 fixes 为来源，并关联到这条问题',
  logText: '内容',
  logPlaceholder: '这条问题相关的进展、结论…',
  logLevel: '级别',
  logSource: '来源',
  logSourceHint: '默认按模块记成 fixes',
  logSubmit: '记下',
  logged: '已记入日志',
  needLogText: '先写点内容',
}

/** 优先级：色点与文案同源；低用弱文本色（--text-3），高/中借 danger / warn 语义色。 */
const PRIORITY_OPTIONS = [
  { value: 'high', label: '高', tone: 'danger' },
  { value: 'normal', label: '中', tone: 'warn' },
  { value: 'low', label: '低', tone: '' },
]

/** 状态选项：顺序即流转顺序，取值与 schema 的 status 一致。 */
const STATUS_OPTIONS = [
  { value: 'todo', label: TEXT.todo },
  { value: 'doing', label: TEXT.doing },
  { value: 'done', label: TEXT.done },
]

const STATUS_FILTERS = [{ value: 'all', label: TEXT.filterAll }, ...STATUS_OPTIONS]

/** 写日志的级别：默认 warn——问题上下文里记的多是「有风险 / 待观察」的进展。 */
const LOG_LEVELS = [
  { value: 'info', label: '信息', tone: '' },
  { value: 'warn', label: '警告', tone: 'warn' },
  { value: 'error', label: '错误', tone: 'danger' },
]

/** 标签过滤行最多直接摆几个，多出来的折到「更多标签」后面。 */
const TAG_LIMIT = 12

/** 行内标签最多摆两个，剩下的折成 `+n`，行高才不会被标签撑开。 */
const ROW_TAG_LIMIT = 2

/** 详情里的关联日志最多列 5 条，多的只报数并给跳转。 */
const LOG_LIMIT = 5

/** 新建/编辑表单的空值。 */
const EMPTY_FORM = { id: null, title: '', priority: 'normal', status: 'todo', note: '', tags: '' }

/** 优先级取值 → 选项（缺省中优先级）。 */
function priorityOf(value) {
  return PRIORITY_OPTIONS.find(option => option.value === value) ?? PRIORITY_OPTIONS[1]
}

/** 状态取值 → 选项（缺省待处理）。 */
function statusOf(value) {
  return STATUS_OPTIONS.find(option => option.value === value) ?? STATUS_OPTIONS[0]
}

/** 日志级别取值 → 选项（缺省信息）。 */
function levelOf(value) {
  return LOG_LEVELS.find(option => option.value === value) ?? LOG_LEVELS[0]
}

/** 标签数组（老数据可能没有 tags 字段）。 */
function tagsOf(row) {
  return Array.isArray(row?.tags) ? row.tags : []
}

/** 关联数组：`{ type, id }[]`，type 用模块 id。 */
function refsOf(row) {
  return Array.isArray(row?.refs) ? row.refs : []
}

/** refs 的 type 也容忍单数写法（`task` / `log` 同样算 `tasks` / `logs`）。 */
function sameRefType(type, module) {
  const text = String(type ?? '').toLowerCase()
  return text === module || `${text}s` === module
}

/** 一条记录的 refs 是否指向 module#id。 */
function linksTo(row, module, id) {
  return refsOf(row).some(ref => sameRefType(ref.type, module) && ref.id === id)
}

/** 一条记录 refs 里指向 module 的 id 集合（详情要把正反两个方向都算上）。 */
function refIdsOf(row, module) {
  return refsOf(row).filter(ref => sameRefType(ref.type, module)).map(ref => ref.id)
}

/** 逗号（中英文都认）分隔的标签文本 → 去重后的 string[]。 */
function parseTags(text) {
  const parts = String(text ?? '').split(/[，,]/)
  return [...new Set(parts.map(part => part.trim()).filter(part => part !== ''))]
}

/** 行内标签 chips：最多两个 + `+n`；没有标签也要留出这一格的元素，否则后面的列会串位。 */
function TagChips({ tags, limit = ROW_TAG_LIMIT }) {
  const shown = tags.slice(0, limit)
  return (
    <span className="fixes-tags">
      {shown.map(tag => <Chip key={tag}>#{tag}</Chip>)}
      {tags.length > shown.length && (
        <span className="fixes-tags-more" title={tags.join('、')}>
          <Chip>+{tags.length - shown.length}</Chip>
        </span>
      )}
    </span>
  )
}

export {
  TEXT, PRIORITY_OPTIONS, STATUS_OPTIONS, STATUS_FILTERS, LOG_LEVELS,
  TAG_LIMIT, ROW_TAG_LIMIT, LOG_LIMIT, EMPTY_FORM, priorityOf,
  statusOf, levelOf, tagsOf, refsOf, sameRefType,
  linksTo, refIdsOf, parseTags, TagChips,
}
