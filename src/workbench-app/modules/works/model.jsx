import { useState } from 'react'

import { Chip, IconButton, Segmented } from '../../ui.jsx'
import { IconEdit, IconLink, IconPlus } from '../../icons.jsx'
import { addDays, formatDay, formatTime, todayISO } from '../../util.mjs'

const TEXT = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  add: '添加',
  addHint: '输入标题，回车建卡',
  search: '搜索标题或备注',
  searchLabel: '搜索工作记录',
  filterLabel: '状态筛选',
  filterAll: '全部',
  viewLabel: '视图切换',
  kanban: '看板',
  list: '列表',
  colTime: '更新时间',
  colActions: '操作',
  newWork: '新建',
  noNote: '—',
  empty: '还没有工作记录',
  emptyHint: '在看板列底点「添加」，写下第一张卡片',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据看看看板长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  filteredEmpty: '没有匹配的记录，换个关键词或状态试试',
  needTitle: '先写下卡片标题',
  created: '已添加',
  moved: '已移动',
  deleted: '已删除',
  deleteConfirm: '删除卡片',
  deleteMessage: '确定删除这条工作记录？删除后无法恢复。',
  refs: '条关联',
  statusOf: '状态',
  deleteOf: '删除',
  editAction: '编辑',
  create: '新建工作记录',
  edit: '编辑工作记录',
  createSubmit: '创建',
  save: '保存',
  saved: '已保存',
  fieldTitle: '标题',
  fieldStatus: '状态',
  fieldNote: '备注',
  fieldTags: '标签',
  notePlaceholder: '这件事的上下文、验收标准、卡点…',
  tagsHint: '用逗号分隔，最多 8 个',
  tagsLimit: '标签最多 8 个',
}

/** 看板列定义：顺序即状态流转顺序，`tone` 是列头圆点与卡片色条用到的语义色。 */
const COLUMNS = [
  { status: 'todo', label: TEXT.todo },
  { status: 'doing', label: TEXT.doing },
  { status: 'done', label: TEXT.done },
]

const STATUS_OPTIONS = COLUMNS.map(column => ({ value: column.status, label: column.label }))

const VIEW_OPTIONS = [
  { value: 'kanban', label: TEXT.kanban },
  { value: 'list', label: TEXT.list },
]

/** 列表视图列宽（`table-head` / `table-row` 共用，写在 style 上）。末列放编辑 + 删除两枚按钮。 */
const LIST_GRID = 'minmax(0, 3fr) 172px minmax(0, 2fr) 150px 92px 76px'

/** 卡片拖拽的自定义 MIME：优先读它，`text/plain` 兼作兜底。 */
const WORK_MIME = 'application/x-work-id'

/** 逗号分隔的标签输入 → 去重数组（中英文逗号都认，与 Fixes 同款解析）。 */
function parseTags(text) {
  const parts = String(text ?? '').split(/[，,]/)
  return [...new Set(parts.map(part => part.trim()).filter(part => part !== ''))]
}

/** 卡片时间：今天显示时刻，昨天显示「昨天」，更早显示短日期（relativeDay 风格）。 */
function shortStamp(stamp) {
  if (typeof stamp !== 'string' || stamp === '') return ''
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return ''
  const day = todayISO(date)
  const today = todayISO()
  if (day === today) return `今天 ${formatTime(stamp)}`
  if (day === addDays(today, -1)) return '昨天'
  return formatDay(day)
}

/** 标签 chips：最多 3 个，多出来的折成 `+n`，卡片高度才可控。 */
function TagChips({ tags }) {
  const list = Array.isArray(tags) ? tags : []
  if (list.length === 0) return null
  const shown = list.slice(0, 3)
  return (
    <span className="works-tags">
      {shown.map(tag => <Chip key={tag}>{tag}</Chip>)}
      {list.length > shown.length && <Chip>+{list.length - shown.length}</Chip>}
    </span>
  )
}

/** 看板卡片：状态色条 + 标题 + 备注两行 + 标签 + 关联数 + 更新时间 + 行内状态分段 + 编辑入口。 */
function WorkCard({ work, dragging, onMove, onEdit, onDragStart, onDragEnd }) {
  const refs = Array.isArray(work.refs) ? work.refs : []
  const note = typeof work.note === 'string' ? work.note.trim() : ''
  return (
    <article
      className={`work-card ${dragging ? 'is-dragging' : ''}`}
      data-testid="work-card"
      data-status={work.status}
      draggable
      onDragStart={event => onDragStart(work, event)}
      onDragEnd={onDragEnd}
    >
      <span className="work-card-bar" aria-hidden="true" />
      <IconButton
        className="work-card-edit"
        label={`${TEXT.editAction}「${work.title}」`}
        onClick={() => onEdit(work)}
      >
        <IconEdit size={15} />
      </IconButton>
      <p className="work-card-title">{work.title}</p>
      {note !== '' && <p className="work-card-note">{note}</p>}
      <TagChips tags={work.tags} />
      <div className="work-card-foot">
        {refs.length > 0 && (
          <span className="work-card-refs" title={`${refs.length} ${TEXT.refs}`}>
            <IconLink size={13} />
            {refs.length}
          </span>
        )}
        <span className="work-card-time">{shortStamp(work.updatedAt ?? work.createdAt)}</span>
      </div>
      <div className="work-card-status">
        <Segmented
          options={STATUS_OPTIONS}
          value={work.status}
          onChange={next => onMove(work, next)}
          label={`「${work.title}」${TEXT.statusOf}`}
        />
      </div>
    </article>
  )
}

/** 列底幽灵卡片：点开变输入框，回车按本列状态建卡，Esc 收起。 */
function QuickAdd({ status, label, onAdd, notify }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    const title = value.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await onAdd(title, status)
    setBusy(false)
    if (ok) setValue('')
  }

  if (!open) {
    return (
      <button
        type="button"
        className="works-add"
        data-testid="works-add"
        title={TEXT.addHint}
        onClick={() => setOpen(true)}
      >
        <IconPlus size={14} />
        {TEXT.add}
      </button>
    )
  }

  return (
    <form className="works-add-form" data-testid="works-add-form" onSubmit={submit}>
      <input
        className="input works-add-input"
        value={value}
        disabled={busy}
        autoFocus
        placeholder={TEXT.addHint}
        aria-label={`在「${label}」添加卡片`}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setValue('')
            setOpen(false)
          }
        }}
      />
    </form>
  )
}

export {
  TEXT, COLUMNS, STATUS_OPTIONS, VIEW_OPTIONS, LIST_GRID,
  WORK_MIME, parseTags, shortStamp, TagChips, WorkCard,
  QuickAdd,
}
