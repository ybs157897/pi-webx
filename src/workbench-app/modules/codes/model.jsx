

import { byDateDesc } from '../../util.mjs'

const TEXT = {
  add: '新建开发事项',
  addPlaceholder: '要开发或调整什么？',
  title: '标题',
  project: '项目',
  projectHint: '可留空，比如「pi-webx」',
  status: '状态',
  note: '备注',
  notePlaceholder: '实现要点、验收标准、相关文件…',
  submit: '新建',
  tree: '文件',
  ungrouped: '未分组',
  untitled: '未命名',
  module: '代码开发',
  workspace: '开发工作区',
  projectLabel: '项目',
  lines: '行',
  chars: '字',
  updatedAt: '更新于',
  save: '保存',
  saving: '保存中…',
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  empty: '还没有开发事项',
  emptyHint: '点文件面板右上角的「+」新建第一件事',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据，看看编辑器工作区长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  editorEmpty: '从左侧打开一个事项',
  editorEmptyHint: '选中文件树里的一条，右侧就会打开编辑器',
  delete: '删除',
  deleteConfirm: '删除事项',
  deleteMessage: '确定删除这条开发事项？删除后无法恢复。',
  discardTitle: '有未保存的改动',
  discardMessage: '当前事项还有未保存的改动。保存后再离开，或放弃这些改动。',
  discard: '放弃改动',
  saveAndLeave: '保存并继续',
  added: '已添加事项',
  saved: '已保存',
  unsaved: '未保存',
  deleted: '事项已删除',
  refreshed: '数据已是最新',
  needTitle: '先写下事项标题',
  toggleTree: '文件树',
  refresh: '刷新数据',
  closeTab: '关闭',
}

const STATUS_OPTIONS = [
  { value: 'todo', label: TEXT.todo },
  { value: 'doing', label: TEXT.doing },
  { value: 'done', label: TEXT.done },
]

/** 按最近更新倒序：后动的排在上面（组内排序用它）。 */
const byUpdatedDesc = byDateDesc(row => row.updatedAt ?? row.createdAt)

function statusOf(value) {
  return STATUS_OPTIONS.find(option => option.value === value) ?? STATUS_OPTIONS[0]
}

/** 导入来的旧记录可能缺字段：分组键与标题都过一遍兜底，缺了不至于让文件树塌掉。 */
function projectOf(row) {
  return typeof row.project === 'string' ? row.project.trim() : ''
}

function titleOf(row) {
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  return title === '' ? TEXT.untitled : title
}

/**
 * 脏标记只跟 `saved` 比：保存时 title/project 会 trim，
 * 若跟刷新来的记录比，首尾打过空格的记录会永久显示未保存。
 * 两者都为 null（没打开任何事项）时算干净，否则一进页面就会被拦「放弃改动」。
 */
function sameDraft(a, b) {
  if (a === null || b === null) return a === null && b === null
  return a.title === b.title && a.project === b.project && a.status === b.status && a.note === b.note
}

/** 快捷键提示用：mac 显示 ⌘，其余显示 Ctrl+。 */
const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

export { TEXT, STATUS_OPTIONS, byUpdatedDesc, statusOf, projectOf, titleOf, sameDraft, isMac }
