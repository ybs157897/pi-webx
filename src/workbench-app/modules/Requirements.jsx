/**
 * 需求管理：知识列表——左栏（搜索 + 状态过滤 + 条目列表），右栏阅读区
 * （标题 / 状态分段 / 优先级 / 星标与编辑删除 → markdown 正文 → 元信息 → 关联任务 → 推进退回）。
 *
 * 形态按用户定调保留**左右两栏**：左栏找、右栏读（不是看板、不是表格）。状态取值仍是 schema 的
 * todo/doing/done，只在展示层映射成「待启动 / 推进中 / 已交付」，旧数据天然兼容。选中态只存 id
 * （初值空串），`selected` 从 `data.requirements` 现算：写操作后 data 是全新数组，存对象快照会
 * 立刻陈旧；现算也让 SSR（不跑 effect）能直接渲染出选中分支。
 * 「关联任务」读 `data.tasks` 里 refs 指向本需求的记录（工作台 4.6 的溯源方向），点一条跳
 * 「今日规划」；反方向的「关联到任务」按 P3 暂不做。样式在 Requirements.css，类名带 `req-` 前缀，
 * 免得与并行重塑的其它模块抢 `.split` 这类通用类名。
 * props 见 Dashboard.jsx 顶部说明；本模块额外用到 `navigate`（跳 tasks）与 `empty` / `onLoadDemo`
 * （首启空库引导）——SSR 断言里这三者可能缺省，调用前一律判类型。根元素带 `data-module="requirements"`。
 * @module src/modules/Requirements
 */

import { useMemo, useRef, useState } from 'react'
import { api } from '../api.mjs'
import {
  Card, Chip, ConfirmDialog, Empty, Field, FieldGroup, FormModal, IconButton, Segmented,
} from '../ui.jsx'
import {
  IconChevronLeft, IconChevronRight, IconEdit, IconPlus, IconRequirements,
  IconSearch, IconStar, IconTasks, IconTrash,
} from '../icons.jsx'
import { byDateDesc, formatStamp } from '../util.mjs'
import AssistantMarkdown from '../pi-webx/AssistantMarkdown.jsx'
import './Requirements.css'

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
  done: '已交付',
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
  noTasksHint: '任务记录把 refs 指向这条需求后，会出现在这里',
  goTasks: '去今日规划',
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

export default function Requirements({ data, mutate, notify, navigate, empty = false, onLoadDemo }) {
  const requirements = Array.isArray(data?.requirements) ? data.requirements : []
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []

  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState('')
  const [form, setForm] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  // 新建记录的 id 在 action 内部暂存（mutate 只回布尔值），刷新落地后再选中它。
  const pendingId = useRef('')

  const counts = useMemo(() => {
    const next = { all: requirements.length, todo: 0, doing: 0, done: 0 }
    for (const row of requirements) next[statusOf(row.status).value] += 1
    return next
  }, [requirements])

  const statusFilterOptions = useMemo(
    () => STATUS_FILTERS.map(option => ({ value: option.value, label: `${option.label} ${counts[option.value]}` })),
    [counts],
  )

  const rows = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    // 关键词同时匹配标题与正文；导入来的记录可能缺 note / title，先兜空值再比较。
    return requirements
      .filter(row => status === 'all' || statusOf(row.status).value === status)
      .filter(row => needle === '' || `${String(row.title ?? '')} ${String(row.note ?? '')}`.toLowerCase().includes(needle))
      .sort(byUpdatedDesc)
  }, [requirements, keyword, status])

  // selected 从 data 现算：写操作刷新后 data 是全新数组，缓存对象会立刻陈旧。
  // 过滤只影响列表，不动阅读区——正读着的正文不该因为敲了搜索词就消失。
  const selected = useMemo(
    () => requirements.find(row => row.id === selectedId) ?? null,
    [requirements, selectedId],
  )

  /** 关联任务：tasks 里 refs 指向这条需求的记录（只有一个方向，反方向按 P3 暂不做）。 */
  const linkedTasks = useMemo(
    () => (selected === null ? [] : tasks.filter(task => linksTo(task, 'requirements', selected.id))),
    [tasks, selected],
  )

  const hasFilter = keyword.trim() !== '' || status !== 'all'
  const stepIndex = selected === null ? -1 : STATUS_STEPS.findIndex(step => step.value === statusOf(selected.status).value)
  const stepBack = stepIndex > 0 ? STATUS_STEPS[stepIndex - 1] : null
  const stepNext = stepIndex >= 0 && stepIndex < STATUS_STEPS.length - 1 ? STATUS_STEPS[stepIndex + 1] : null

  function clearFilters() {
    setKeyword('')
    setStatus('all')
  }

  /** 改状态（阅读区顶部的分段与推进/退回共用）。 */
  function changeStatus(next) {
    const target = statusOf(next)
    if (selected === null) return undefined
    return mutate(
      () => api.patchRecord('requirements', selected.id, { status: target.value }),
      `${TEXT.statusChanged}「${target.label}」`,
    )
  }

  /** 推进/退回一档：两端没有目标档，按钮直接禁用，这里再兜一次。 */
  function move(step) {
    if (step === null) return undefined
    return changeStatus(step.value)
  }

  function toggleStar() {
    if (selected === null) return undefined
    const on = selected.starred === true
    return mutate(
      () => api.patchRecord('requirements', selected.id, { starred: !on }),
      on ? TEXT.unstarred : TEXT.starred,
    )
  }

  /** 打开表单：不传记录是新建，传记录是编辑。 */
  function openForm(row) {
    if (row === undefined) {
      setForm({ ...EMPTY_FORM })
      return
    }
    setForm({
      id: row.id,
      title: String(row.title ?? ''),
      priority: priorityOf(row.priority).value,
      status: statusOf(row.status).value,
      note: String(row.note ?? ''),
      tags: tagsOf(row).join(', '),
    })
  }

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
    const fields = {
      title, priority: form.priority, status: form.status, note: form.note.trim(), tags: nextTags,
    }
    const targetId = form.id
    setBusy(true)
    const ok = await mutate(async () => {
      if (targetId === null) {
        const created = await api.addRecord('requirements', fields)
        pendingId.current = String(created?.record?.id ?? '')
        return created
      }
      return api.patchRecord('requirements', targetId, fields)
    }, targetId === null ? TEXT.created : TEXT.updated)
    setBusy(false)
    if (!ok) return
    // 新建后选中新条目，并清掉过滤条件，保证它确实出现在左栏里（否则「选中了却看不见」）。
    if (targetId === null) {
      setSelectedId(pendingId.current)
      clearFilters()
    } else {
      setSelectedId(targetId)
    }
    setForm(null)
  }

  async function confirmDelete() {
    const target = pendingDelete
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('requirements', target.id), TEXT.deleted)
    setBusy(false)
    if (!ok) return
    setPendingDelete(null)
    // 删掉的正是读着的那条：落回未选中，右栏回到空态。
    setSelectedId(current => (current === target.id ? '' : current))
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  const subtitle = hasFilter ? TEXT.filteredText(rows.length, counts.all) : TEXT.totalText(counts.all)

  return (
    <div className="req" data-module="requirements">
      <div className="req-split" data-testid="req-split">
        <Card
          className="req-list-col"
          bodyClassName="req-list-body"
          title={TEXT.list}
          subtitle={subtitle}
          action={(
            <button type="button" className="btn btn-sm btn-primary" data-testid="req-new" onClick={() => openForm()}>
              <IconPlus size={15} />
              {TEXT.create}
            </button>
          )}
        >
          {requirements.length === 0
            ? (
              <div data-testid="req-empty">
                <Empty
                  icon={<IconRequirements size={22} />}
                  title={TEXT.empty}
                  hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
                  action={empty === true && typeof onLoadDemo === 'function'
                    ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="req-load-demo"
                        disabled={demoBusy}
                        onClick={loadDemo}
                      >
                        {demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}
                      </button>
                    )
                    : undefined}
                />
              </div>
            )
            : (
              <>
                <label className="req-search">
                  <IconSearch size={15} />
                  <input
                    className="req-search-input"
                    type="search"
                    value={keyword}
                    placeholder={TEXT.search}
                    aria-label={TEXT.searchLabel}
                    data-testid="req-search"
                    onChange={event => setKeyword(event.target.value)}
                  />
                </label>

                <div className="req-filter" data-testid="req-status-filter">
                  <Segmented
                    options={statusFilterOptions}
                    value={status}
                    onChange={setStatus}
                    label={TEXT.filterLabel}
                  />
                </div>

                {rows.length === 0
                  ? (
                    <div data-testid="req-list-empty">
                      <Empty
                        icon={<IconSearch size={20} />}
                        title={TEXT.listEmpty}
                        hint={TEXT.listEmptyHint}
                        action={<button type="button" className="btn" onClick={clearFilters}>{TEXT.clearFilter}</button>}
                      />
                    </div>
                  )
                  : (
                    <ul className="req-list" data-testid="req-list">
                      {rows.map(row => {
                        const priority = priorityOf(row.priority)
                        const step = statusOf(row.status)
                        const active = selected !== null && row.id === selected.id
                        return (
                          <li className="list-item req-item" key={row.id} data-testid="req-item">
                            <button
                              type="button"
                              className={`req-item-btn ${active ? 'is-active' : ''}`}
                              aria-pressed={active}
                              onClick={() => setSelectedId(row.id)}
                            >
                              <span className="req-item-top">
                                <span className={`req-dot ${priority.tone}`} aria-hidden="true" />
                                <span className="sr-only">{TEXT.priorityLabel} {priority.label}</span>
                                <span className="req-item-title">{String(row.title ?? '')}</span>
                              </span>
                              <span className="req-item-foot">
                                <span className="req-item-tags">
                                  {tagsOf(row).map(tag => <Chip key={tag}>#{tag}</Chip>)}
                                </span>
                                <span className="req-item-status">
                                  <Chip tone={step.tone}>{step.label}</Chip>
                                </span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </>
            )}
        </Card>

        <Card className="req-reader-col">
          <div className="req-reader" data-testid="req-reader">
            {selected === null
              ? (
                <div data-testid="req-reader-empty">
                  <Empty icon={<IconRequirements size={22} />} title={TEXT.readerEmpty} hint={TEXT.readerEmptyHint} />
                </div>
              )
              : (
                <Reader
                  row={selected}
                  linkedTasks={linkedTasks}
                  stepBack={stepBack}
                  stepNext={stepNext}
                  onStatus={changeStatus}
                  onStar={toggleStar}
                  onEdit={() => openForm(selected)}
                  onDelete={() => setPendingDelete(selected)}
                  onMove={move}
                  onNavigate={navigate}
                />
              )}
          </div>
        </Card>
      </div>

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
                placeholder={TEXT.titlePlaceholder}
                onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
              />
            </Field>
            <FieldGroup label={TEXT.fieldPriority}>
              <Segmented
                options={PRIORITY_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
                value={form.priority}
                onChange={next => setForm(current => ({ ...current, priority: next }))}
                label={TEXT.fieldPriority}
              />
            </FieldGroup>
            <FieldGroup label={TEXT.fieldStatus}>
              <Segmented
                options={STATUS_STEPS.map(step => ({ value: step.value, label: step.label }))}
                value={form.status}
                onChange={next => setForm(current => ({ ...current, status: next }))}
                label={TEXT.fieldStatus}
              />
            </FieldGroup>
            <Field label={TEXT.fieldTags} hint={TEXT.tagsHint}>
              <input
                className="input"
                value={form.tags}
                placeholder="体验, 设计"
                onChange={event => setForm(current => ({ ...current, tags: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.fieldNote} hint={TEXT.noteHint}>
              <textarea
                className="textarea req-note-input"
                value={form.note}
                placeholder={TEXT.notePlaceholder}
                onChange={event => setForm(current => ({ ...current, note: event.target.value }))}
              />
            </Field>
          </>
        )}
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${String(pendingDelete.title ?? '')}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

/**
 * 阅读区：一条需求的完整读视图。拆出来只为让主组件里的分支读起来还是「两栏 + 弹窗」，
 * 状态与回调仍由主组件持有（selected 现算，子组件不碰 data）。
 * @param props - `row` 选中记录；`linkedTasks` 已算好的关联任务；`stepBack` / `stepNext`
 *   相邻档位（null = 边界，按钮禁用）；其余是写操作与跳转回调。
 * @returns 阅读区元素。
 */
function Reader({ row, linkedTasks, stepBack, stepNext, onStatus, onStar, onEdit, onDelete, onMove, onNavigate }) {
  const priority = priorityOf(row.priority)
  const step = statusOf(row.status)
  const tags = tagsOf(row)
  const title = String(row.title ?? '')
  const note = String(row.note ?? '').trim()
  const starred = row.starred === true
  // 导入来的记录可能没有时间戳：有才渲染，别留下「创建 」这样的半截文案。
  const created = typeof row.createdAt === 'string' ? row.createdAt : ''
  const updated = typeof row.updatedAt === 'string' ? row.updatedAt : created

  function goTasks() {
    if (typeof onNavigate === 'function') onNavigate('tasks')
  }

  return (
    <>
      <header className="req-reader-head">
        <h2 className="req-reader-title" data-testid="req-reader-title">{title}</h2>
        <div className="req-reader-tools">
          <span className="req-star-slot" data-testid="req-star">
            <IconButton
              label={starred ? TEXT.unstar : TEXT.star}
              className={`req-star ${starred ? 'is-on' : ''}`}
              onClick={onStar}
            >
              <IconStar size={17} />
            </IconButton>
          </span>
          <button type="button" className="btn btn-sm" data-testid="req-edit" onClick={onEdit}>
            <IconEdit size={15} />
            {TEXT.editAction}
          </button>
          <button
            type="button"
            className="btn btn-sm req-btn-danger"
            data-testid="req-delete"
            onClick={onDelete}
          >
            <IconTrash size={15} />
            {TEXT.delete}
          </button>
        </div>
      </header>

      <div className="req-reader-badges">
        <Segmented
          options={STATUS_STEPS.map(item => ({ value: item.value, label: item.label }))}
          value={step.value}
          onChange={onStatus}
          label={`「${title}」${TEXT.fieldStatus}`}
        />
        <Chip tone={priority.tone}>{TEXT.priorityLabel} {priority.label}</Chip>
      </div>

      <div className="req-reader-meta" data-testid="req-reader-meta">
        <span className="req-reader-tags">
          {tags.length === 0
            ? <span className="req-muted">{TEXT.noTags}</span>
            : tags.map(tag => <Chip key={tag}>#{tag}</Chip>)}
        </span>
        {(created !== '' || updated !== '') && (
          <span className="req-times">
            {created !== '' && `${TEXT.metaCreated} ${formatStamp(created)}`}
            {created !== '' && updated !== '' && ' · '}
            {updated !== '' && `${TEXT.metaUpdated} ${formatStamp(updated)}`}
          </span>
        )}
      </div>

      <div className="req-reader-body" data-testid="req-reader-body">
        {note === ''
          ? <p className="req-note-empty">{TEXT.noNote}</p>
          : <AssistantMarkdown text={note} />}
      </div>

      <section className="req-section" data-testid="req-related">
        <div className="req-section-head">
          <h3 className="req-section-title">{TEXT.relatedTasks}</h3>
          <Chip>{linkedTasks.length}</Chip>
          {linkedTasks.length > 0 && typeof onNavigate === 'function' && (
            <button type="button" className="req-plain" onClick={goTasks}>
              {TEXT.goTasks}
              <IconChevronRight size={13} />
            </button>
          )}
        </div>
        {linkedTasks.length === 0
          ? (
            <p className="req-muted">
              {TEXT.noTasks}
              <span className="req-hint">{TEXT.noTasksHint}</span>
            </p>
          )
          : (
            <ul className="req-tasks">
              {linkedTasks.map(task => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="req-task"
                    data-testid="req-task"
                    onClick={goTasks}
                  >
                    <IconTasks className="req-task-icon" size={15} />
                    <span className="req-task-title">{String(task.title ?? '')}</span>
                    {task.done === true
                      ? <Chip tone="ok">{TEXT.taskDone}</Chip>
                      : <Chip tone="warn">{TEXT.taskTodo}</Chip>}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <div className="req-actions">
        <button
          type="button"
          className="btn"
          data-testid="req-back"
          disabled={stepBack === null}
          title={stepBack === null ? undefined : TEXT.backTo(stepBack.label)}
          aria-label={stepBack === null ? `${TEXT.back}（${TEXT.backLimit}）` : TEXT.backTo(stepBack.label)}
          onClick={() => onMove(stepBack)}
        >
          <IconChevronLeft size={16} />
          {TEXT.back}
        </button>
        <button
          type="button"
          className="btn btn-primary req-advance"
          data-testid="req-advance"
          disabled={stepNext === null}
          title={stepNext === null ? undefined : TEXT.advanceTo(stepNext.label)}
          aria-label={stepNext === null ? `${TEXT.advance}（${TEXT.advanceLimit}）` : TEXT.advanceTo(stepNext.label)}
          onClick={() => onMove(stepNext)}
        >
          {TEXT.advance}
          <IconChevronRight size={16} />
        </button>
      </div>
    </>
  )
}
