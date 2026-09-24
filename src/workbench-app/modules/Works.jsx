/**
 * 工作助理：同一批记录的双视图——看板（默认，三列拖拽改状态）/ 列表（密集表格）。
 * 视图选择记忆在 `prefs.worksView`（'kanban' | 'list'），工具栏提供标题/备注搜索与状态过滤。
 * props 见 Dashboard.jsx 顶部说明；额外用到 `prefs` / `setPref`（视图偏好）与
 * `empty` / `onLoadDemo`（首启空库引导）。根元素带 `data-module="works"`。
 *
 * 拖拽走原生 HTML5 drag events：`dataTransfer` 带记录 id，落列即改 status；
 * 每张卡同时给一行内状态 Segmented，无拖拽环境（触屏 / 键盘）也能流转状态。
 * @module src/modules/Works
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import {
  Chip, ChipButton, ConfirmDialog, Empty, Field, FieldGroup, FormModal, IconButton, Segmented,
} from '../ui.jsx'
import { IconEdit, IconLink, IconPlus, IconSearch, IconTrash, IconWorks } from '../icons.jsx'
import { addDays, byDateDesc, formatDay, formatTime, todayISO } from '../util.mjs'
import './Works.css'

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

export default function Works({ data, mutate, notify, prefs = {}, setPref, empty = false, onLoadDemo }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [form, setForm] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [dragId, setDragId] = useState('')
  const [dropStatus, setDropStatus] = useState('')

  const view = prefs.worksView === 'list' ? 'list' : 'kanban'
  const keyword = query.trim().toLowerCase()
  const total = data.works.length

  const counts = useMemo(() => {
    const next = { all: total }
    for (const column of COLUMNS) {
      next[column.status] = data.works.filter(work => work.status === column.status).length
    }
    return next
  }, [data.works, total])

  const rows = useMemo(() => (
    data.works
      .filter(work => {
        if (filter !== 'all' && work.status !== filter) return false
        if (keyword === '') return true
        return `${work.title ?? ''} ${work.note ?? ''}`.toLowerCase().includes(keyword)
      })
      .sort(byDateDesc(work => work.updatedAt ?? work.createdAt))
  ), [data.works, filter, keyword])

  const columns = useMemo(() => (
    COLUMNS.map(column => ({ ...column, items: rows.filter(work => work.status === column.status) }))
  ), [rows])

  const filterOptions = useMemo(() => ([
    { value: 'all', label: `${TEXT.filterAll} ${counts.all}` },
    ...COLUMNS.map(column => ({ value: column.status, label: `${column.label} ${counts[column.status]}` })),
  ]), [counts])

  function addWork(title, status) {
    return mutate(() => api.addRecord('works', { title, note: '', status }), TEXT.created)
  }

  /**
   * 打开表单：不传 work 是新建（默认落在待办），传 work 是编辑——标签折成逗号分隔文本。
   * 两个视图共用同一个表单，入口分别是卡片 hover 编辑按钮 / 列表行编辑按钮 / 工具栏「新建」。
   */
  function openForm(work) {
    setForm(work === undefined
      ? { id: null, title: '', note: '', status: 'todo', tags: '' }
      : {
        id: work.id,
        title: work.title,
        note: typeof work.note === 'string' ? work.note : '',
        status: work.status,
        tags: (Array.isArray(work.tags) ? work.tags : []).join(', '),
      })
  }

  /** 表单提交：标题必填、标签最多 8 个（与 schema.mjs 的 tags 上限一致），新建 / 编辑同一条通路。 */
  async function submitForm() {
    const title = form.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    const nextTags = parseTags(form.tags)
    if (nextTags.length > 8) {
      notify(TEXT.tagsLimit, 'warn')
      return
    }
    const fields = { title, note: form.note, status: form.status, tags: nextTags }
    setBusy(true)
    const ok = await mutate(
      () => (form.id === null ? api.addRecord('works', fields) : api.patchRecord('works', form.id, fields)),
      form.id === null ? TEXT.created : TEXT.saved,
    )
    setBusy(false)
    if (ok) setForm(null)
  }

  /**
   * 改状态：状态没变（行内分段点了当前项、拖回原列）是空操作——不发请求、不刷新、
   * 不提示，避免把没动的卡片 updatedAt 顶上去、在列表里跳位。
   */
  function move(work, status) {
    if (work.status === status) return Promise.resolve(true)
    return mutate(() => api.patchRecord('works', work.id, { status }), TEXT.moved)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('works', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  /** 开始拖拽：记录 id（状态里留一份，`dataTransfer` 给落点读）。 */
  function startDrag(work, event) {
    setDragId(work.id)
    const transfer = event.dataTransfer
    if (transfer === null || transfer === undefined) return
    transfer.effectAllowed = 'move'
    transfer.setData(WORK_MIME, work.id)
    transfer.setData('text/plain', work.id)
  }

  function finishDrag() {
    setDragId('')
    setDropStatus('')
  }

  /** 拖过列：只有本模块的卡片在拖时才认；高亮目标列。 */
  function hoverColumn(status, event) {
    if (dragId === '') return
    event.preventDefault()
    const transfer = event.dataTransfer
    if (transfer !== null && transfer !== undefined) transfer.dropEffect = 'move'
    if (dropStatus !== status) setDropStatus(status)
  }

  /** 离开列：移到自己子元素上不算离开（relatedTarget 还在列内就忽略）。 */
  function leaveColumn(status, event) {
    if (event.currentTarget.contains(event.relatedTarget)) return
    setDropStatus(current => (current === status ? '' : current))
  }

  function dropOn(status, event) {
    event.preventDefault()
    const transfer = event.dataTransfer
    const carried = transfer === null || transfer === undefined
      ? ''
      : (transfer.getData(WORK_MIME) || transfer.getData('text/plain'))
    const id = carried === '' ? dragId : carried
    finishDrag()
    if (id === '') return
    const work = data.works.find(item => item.id === id)
    if (work === undefined || work.status === status) return
    move(work, status)
  }

  return (
    <div className="works" data-module="works">
      <div className="works-toolbar" data-testid="works-toolbar">
        <label className="works-search">
          <IconSearch size={15} />
          <input
            className="works-search-input"
            type="search"
            value={query}
            placeholder={TEXT.search}
            aria-label={TEXT.searchLabel}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        <div className="works-filters" role="group" aria-label={TEXT.filterLabel}>
          {filterOptions.map(option => (
            <ChipButton
              key={option.value}
              active={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </ChipButton>
          ))}
        </div>
        <div className="works-views">
          {view === 'list' && (
            <button type="button" className="btn" data-testid="works-new" onClick={() => openForm()}>
              <IconPlus size={14} />
              {TEXT.newWork}
            </button>
          )}
          <Segmented
            options={VIEW_OPTIONS}
            value={view}
            onChange={value => setPref('worksView', value)}
            label={TEXT.viewLabel}
          />
        </div>
      </div>

      {total === 0 && (
        <div className="works-guide" data-testid="works-empty">
          <Empty
            icon={<IconWorks size={22} />}
            title={TEXT.empty}
            hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
            action={empty === true ? (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="works-load-demo"
                disabled={demoBusy}
                onClick={loadDemo}
              >
                {demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}
              </button>
            ) : undefined}
          />
        </div>
      )}

      {total > 0 && rows.length === 0 && (
        <p className="works-blank" data-testid="works-filtered-empty">{TEXT.filteredEmpty}</p>
      )}

      {view === 'kanban' ? (
        <div className="works-board" data-testid="works-board">
          {columns.map(column => (
            <section
              key={column.status}
              className={`works-col ${dropStatus === column.status ? 'is-drop' : ''}`}
              data-status={column.status}
              data-testid="works-col"
              aria-label={column.label}
              onDragOver={event => hoverColumn(column.status, event)}
              onDragLeave={event => leaveColumn(column.status, event)}
              onDrop={event => dropOn(column.status, event)}
            >
              <header className="works-col-head">
                <span className="works-col-dot" aria-hidden="true" />
                <span className="works-col-name">{column.label}</span>
                <Chip>{column.items.length}</Chip>
              </header>
              <div className="works-col-body">
                {column.items.map(work => (
                  <WorkCard
                    key={work.id}
                    work={work}
                    dragging={dragId === work.id}
                    onMove={move}
                    onEdit={openForm}
                    onDragStart={startDrag}
                    onDragEnd={finishDrag}
                  />
                ))}
              </div>
              <QuickAdd status={column.status} label={column.label} onAdd={addWork} notify={notify} />
            </section>
          ))}
        </div>
      ) : (
        <div className="works-table-scroll">
          <div className="table works-table" data-testid="works-table">
            <div className="table-head" style={{ gridTemplateColumns: LIST_GRID }}>
              <span>{TEXT.fieldTitle}</span>
              <span>{TEXT.fieldStatus}</span>
              <span>{TEXT.fieldNote}</span>
              <span>{TEXT.fieldTags}</span>
              <span>{TEXT.colTime}</span>
              <span className="sr-only">{TEXT.colActions}</span>
            </div>
            {rows.map(work => (
              <div className="table-row" data-testid="work-row" key={work.id} style={{ gridTemplateColumns: LIST_GRID }}>
                <span className="cell-title ellipsis" title={work.title}>{work.title}</span>
                <span className="works-cell-status">
                  <Segmented
                    options={STATUS_OPTIONS}
                    value={work.status}
                    onChange={next => move(work, next)}
                    label={`「${work.title}」${TEXT.statusOf}`}
                  />
                </span>
                <span className="cell-sub ellipsis" title={work.note ?? ''}>
                  {typeof work.note === 'string' && work.note.trim() !== '' ? work.note : TEXT.noNote}
                </span>
                <TagChips tags={work.tags} />
                <span className="cell-sub">{shortStamp(work.updatedAt ?? work.createdAt)}</span>
                <span className="works-row-actions">
                  <IconButton
                    label={`${TEXT.editAction}「${work.title}」`}
                    onClick={() => openForm(work)}
                  >
                    <IconEdit size={15} />
                  </IconButton>
                  <IconButton
                    label={`${TEXT.deleteOf}「${work.title}」`}
                    tone="danger"
                    onClick={() => setPendingDelete(work)}
                  >
                    <IconTrash size={15} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <FormModal
        open={form !== null}
        title={form === null || form.id === null ? TEXT.create : TEXT.edit}
        submitText={form === null || form.id === null ? TEXT.createSubmit : TEXT.save}
        busy={busy}
        onClose={() => setForm(null)}
        onSubmit={submitForm}
      >
        {form !== null && (
          <>
            <Field label={TEXT.fieldTitle}>
              <input
                className="input"
                value={form.title}
                onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
              />
            </Field>
            <FieldGroup label={TEXT.fieldStatus}>
              <Segmented
                options={STATUS_OPTIONS}
                value={form.status}
                onChange={next => setForm(current => ({ ...current, status: next }))}
                label={TEXT.fieldStatus}
              />
            </FieldGroup>
            <Field label={TEXT.fieldNote}>
              <textarea
                className="textarea"
                value={form.note}
                placeholder={TEXT.notePlaceholder}
                onChange={event => setForm(current => ({ ...current, note: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.fieldTags} hint={TEXT.tagsHint}>
              <input
                className="input"
                value={form.tags}
                placeholder="前端, 验收"
                onChange={event => setForm(current => ({ ...current, tags: event.target.value }))}
              />
            </Field>
          </>
        )}
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${pendingDelete.title}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
