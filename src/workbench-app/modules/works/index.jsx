/**
 * 工作助理：同一批记录的双视图——看板（默认，三列拖拽改状态）/ 列表（密集表格）。
 * 视图选择记忆在 `prefs.worksView`（'kanban' | 'list'），工具栏提供标题/备注搜索与状态过滤。
 * props 见 Dashboard.jsx 顶部说明；额外用到 `prefs` / `setPref`（视图偏好）与
 * `empty` / `onLoadDemo`（首启空库引导）。根元素带 `data-module="works"`。
 *
 * 拖拽走原生 HTML5 drag events：`dataTransfer` 带记录 id，落列即改 status；
 * 每张卡同时给一行内状态 Segmented，无拖拽环境（触屏 / 键盘）也能流转状态。
 * @module src/workbench-app/modules/works
 */

import { useMemo, useState } from 'react'
import { api } from '../../api.mjs'
import {
  Chip,
  ChipButton,
  ConfirmDialog,
  Empty,
  Field,
  FieldGroup,
  FormModal,
  IconButton,
  Segmented
} from '../../ui.jsx'
import { IconEdit, IconPlus, IconSearch, IconTrash, IconWorks } from '../../icons.jsx'
import { byDateDesc } from '../../util.mjs'
import './Works.css'

import {
  TEXT,
  COLUMNS,
  STATUS_OPTIONS,
  VIEW_OPTIONS,
  LIST_GRID,
  WORK_MIME,
  parseTags,
  shortStamp,
  TagChips,
  WorkCard,
  QuickAdd
} from './model.jsx'

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
