

import { byDateDesc } from '../../util.mjs'

const TEXT = {
  list: '需求清单',
  create: '新建需求',
  createSubmit: '创建',
  edit: '编辑需求',
  editAction: '编辑',
  save: '保存',
  delete: '删除',
  deleteConfirm: '删除需求',
  deleteMessage: '确定删除这条需求？删除后无法恢复。',
  deleted: '需求已删除',
  created: '已记录需求',
  updated: '需求已更新',
  statusChanged: '已更新为',
  star: '加星标',
  unstar: '取消星标',
  starred: '已加星标',
  unstarred: '已取消星标',
  search: '搜索标题或备注…',
  searchLabel: '搜索需求',
  filterLabel: '状态筛选',
  filterAll: '全部',
  todo: '待启动',
  doing: '推进中',
  done: '业务完成',
  clearFilter: '清空筛选',
  totalText: total => `共 ${total} 条`,
  filteredText: (hits, total) => `筛选出 ${hits} / ${total} 条`,
  listEmpty: '没有匹配的需求',
  listEmptyHint: '换个关键词，或把状态切回「全部」',
  empty: '还没有需求记录',
  emptyHint: '写下第一条需求：标题必填，正文支持 markdown',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据，看看需求知识库长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  readerEmpty: '选一条需求开始阅读',
  readerEmptyHint: '在左侧列表点一条：正文、关联任务与状态流转都在这里',
  priorityLabel: '优先级',
  fieldTitle: '标题',
  titlePlaceholder: '这个需求要解决什么？',
  fieldPriority: '优先级',
  fieldStatus: '状态',
  fieldTags: '标签',
  tagsHint: '用逗号分隔，最多 8 个',
  tagsLimit: '标签最多 8 个',
  fieldNote: '正文',
  noteHint: 'markdown 正文：标题、列表、代码块、链接都会渲染',
  notePlaceholder: '## 背景\n\n- 验收标准 1\n- 验收标准 2',
  noNote: '（还没有内容，点右上角编辑）',
  noTags: '没有标签',
  metaCreated: '创建',
  metaUpdated: '更新',
  relatedTasks: '关联任务',
  noTasks: '还没有关联任务',
  noTasksHint: '选择「拆分并导入待办」，确认后即可在这里跟进',
  goTasks: '去我的待办',
  taskDone: '已完成',
  taskTodo: '待办',
  back: '退回',
  advance: '推进',
  backTo: label => `退回「${label}」`,
  advanceTo: label => `推进到「${label}」`,
  backLimit: '已经是第一档',
  advanceLimit: '已经是最后一档',
  needTitle: '先写下需求标题',
}

/** 优先级：色点与 chip 文案同源；低优先用弱文本色，高/中借 danger / warn 语义色。 */
const PRIORITY_OPTIONS = [
  { value: 'high', label: '高', tone: 'danger' },
  { value: 'normal', label: '中', tone: 'warn' },
  { value: 'low', label: '低', tone: '' },
]

/** 状态三档：取值即 schema 的 status，顺序即流转顺序，label 是知识库语境的展示名。 */
const STATUS_STEPS = [
  { value: 'todo', label: TEXT.todo, tone: 'warn' },
  { value: 'doing', label: TEXT.doing, tone: 'accent' },
  { value: 'done', label: TEXT.done, tone: 'ok' },
]

/** 分类四档：取值即 schema 的 category，中文标签是需求库语境的展示名。 */
const CATEGORY_OPTIONS = [
  { value: 'new', label: '新功能', tone: 'accent' },
  { value: 'change', label: '需求变更', tone: 'warn' },
  { value: 'fix', label: '问题修复', tone: 'danger' },
  { value: 'enhancement', label: '体验优化', tone: 'ok' },
]

const STATUS_FILTERS = [{ value: 'all', label: TEXT.filterAll }, ...STATUS_STEPS]

/** 新建/编辑表单的空值：`id` 为 null 表示新建（tags 在表单里是逗号分隔文本）。 */
const EMPTY_FORM = { id: null, title: '', priority: 'normal', status: 'todo', note: '', tags: '' }

/** 列表排序：最近碰过的浮到最上面（服务端每次写入都会刷新 updatedAt）。 */
const byUpdatedDesc = byDateDesc(row => row.updatedAt ?? row.createdAt)

/** 优先级取值 → 选项（缺省中优先级）。 */
function priorityOf(value) {
  return PRIORITY_OPTIONS.find(option => option.value === value) ?? PRIORITY_OPTIONS[1]
}

/** 状态取值 → 档位（缺省待启动）；过滤、计数、流转都先过它，脏数据不会各处分叉。 */
function statusOf(value) {
  return STATUS_STEPS.find(step => step.value === value) ?? STATUS_STEPS[0]
}

/** 标签数组（老数据可能没有 tags 字段）。 */
function tagsOf(row) {
  return Array.isArray(row?.tags) ? row.tags : []
}

/**
 * 分类取值 → 展示档位。旧数据可能没有 category 字段，按后端契约缺省 new；
 * 未知取值原样显示（不静默改写成 new，也不吞掉服务端的新档位）。
 */
function categoryOf(value) {
  const text = String(value ?? '').trim()
  if (text === '') return CATEGORY_OPTIONS[0]
  return CATEGORY_OPTIONS.find(option => option.value === text) ?? { value: text, label: text, tone: '' }
}

/** 关联数组：`{ type, id }[]`，type 用模块 id。 */
function refsOf(row) {
  return Array.isArray(row?.refs) ? row.refs : []
}

/** 一条记录的 refs 是否指向 module#id；singular / plural 写法都认。 */
function linksTo(row, module, id) {
  const text = String(module ?? '').toLowerCase()
  return refsOf(row).some(ref => {
    const type = String(ref?.type ?? '').toLowerCase()
    return (type === text || `${type}s` === text) && ref?.id === id
  })
}

/** 逗号（中英文都认）分隔的标签文本 → 去重后的 string[]。 */
function parseTags(text) {
  const parts = String(text ?? '').split(/[，,]/)
  return [...new Set(parts.map(part => part.trim()).filter(part => part !== ''))]
}

/** 从会话转写里找成功的 chatroom_send，其参数全文提及的需求记录 id 视为已转交。 */
function dispatchedRequirementIds(entries, rows) {
  const ids = new Set()
  if (!Array.isArray(entries)) return ids
  for (const entry of entries) {
    const runs = entry?.kind === 'assistant' ? entry.tools ?? [] : entry?.kind === 'toolResult' ? [entry.run] : []
    for (const run of runs) {
      if (run?.toolName !== 'chatroom_send' || run.status !== 'success') continue
      const text = JSON.stringify(run.args ?? '')
      for (const row of rows ?? []) if (row?.id && text.includes(row.id)) ids.add(row.id)
    }
  }
  return ids
}

export {
  TEXT, PRIORITY_OPTIONS, STATUS_STEPS, STATUS_FILTERS, CATEGORY_OPTIONS, EMPTY_FORM,
  byUpdatedDesc, priorityOf, statusOf, categoryOf, tagsOf, refsOf,
  linksTo, parseTags, dispatchedRequirementIds,
}
