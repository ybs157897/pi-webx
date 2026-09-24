/**
 * 问题修复：过滤面板 + 问题表格的问题列表。顶部快速捕获，四类过滤（搜索 / 状态 /
 * 优先级 / 标签），行内直接切状态，点标题行内展开详情——备注、关联任务、关联日志，
 * 并从详情一键记一条日志（带 `refs: [{ type: 'fixes', id }]` 回链）。
 * 形态按用户定调保持**列表**（不是看板）；工作台 4.4 节的关联与记日志落在详情里。
 * props 见 Dashboard.jsx 顶部说明；本模块额外用到 `navigate`（跳 tasks / logs）与
 * `empty` / `onLoadDemo`（首启空库引导）。根元素带 `data-module="fixes"`。
 * @module src/modules/Fixes
 */

import { Fragment, useMemo, useState } from 'react'
import { api } from '../api.mjs'
import {
  Card, Chip, ChipButton, ConfirmDialog, Empty, Field, FieldGroup, FormModal, IconButton, Segmented,
} from '../ui.jsx'
import {
  IconBug, IconChevronRight, IconEdit, IconLogs, IconPlus, IconSearch, IconTasks, IconTrash,
} from '../icons.jsx'
import { byDateDesc, formatDay, formatStamp, relativeDay, todayISO } from '../util.mjs'
import './Fixes.css'

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
  goTasks: '去今日规划',
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

export default function Fixes({ data, mutate, notify, navigate, empty = false, onLoadDemo }) {
  const today = todayISO()
  const fixes = Array.isArray(data?.fixes) ? data.fixes : []
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const logs = Array.isArray(data?.logs) ? data.logs : []

  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [priorities, setPriorities] = useState([])
  const [tags, setTags] = useState([])
  const [allTags, setAllTags] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [quick, setQuick] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [form, setForm] = useState(null)
  const [logFor, setLogFor] = useState(null)
  const [logDraft, setLogDraft] = useState({ text: '', level: 'warn', source: 'fixes' })
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)

  const counts = useMemo(() => {
    const next = { all: fixes.length, todo: 0, doing: 0, done: 0 }
    for (const fix of fixes) {
      if (next[fix.status] !== undefined) next[fix.status] += 1
    }
    return next
  }, [fixes])

  const statusOptions = useMemo(() => STATUS_FILTERS.map(option => ({
    value: option.value,
    label: `${option.label} ${counts[option.value] ?? 0}`,
  })), [counts])

  const priorityChips = useMemo(() => PRIORITY_OPTIONS.map(option => ({
    ...option,
    count: fixes.filter(fix => priorityOf(fix.priority).value === option.value).length,
  })), [fixes])

  const tagPool = useMemo(() => {
    const pool = new Map()
    for (const fix of fixes) {
      for (const tag of tagsOf(fix)) pool.set(tag, (pool.get(tag) ?? 0) + 1)
    }
    return [...pool.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }))
  }, [fixes])

  const rows = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return fixes
      .filter(fix => status === 'all' || fix.status === status)
      .filter(fix => priorities.length === 0 || priorities.includes(priorityOf(fix.priority).value))
      .filter(fix => tags.length === 0 || tagsOf(fix).some(tag => tags.includes(tag)))
      .filter(fix => needle === '' || `${fix.title ?? ''} ${fix.note ?? ''}`.toLowerCase().includes(needle))
      .sort(byDateDesc(fix => fix.updatedAt ?? fix.createdAt))
  }, [fixes, keyword, status, priorities, tags])

  const hasFilter = keyword.trim() !== '' || status !== 'all' || priorities.length > 0 || tags.length > 0

  /** 选中的标签始终摆出来，否则被折进「更多标签」的已选项没法取消。 */
  const visibleTags = allTags
    ? tagPool
    : tagPool.filter((tag, index) => index < TAG_LIMIT || tags.includes(tag.value))

  /** 与这条问题互相引用的任务：fix.refs 指向的 + refs 指向本 fix 的。 */
  function tasksOfFix(fix) {
    const outbound = new Set(refIdsOf(fix, 'tasks'))
    return [
      ...tasks.filter(task => outbound.has(task.id)),
      ...tasks.filter(task => !outbound.has(task.id) && linksTo(task, 'fixes', fix.id)),
    ]
  }

  /** 与这条问题互相引用的日志，按时间倒序（没有时间戳的靠日期兜底）。 */
  function logsOfFix(fix) {
    const outbound = new Set(refIdsOf(fix, 'logs'))
    return [
      ...logs.filter(log => outbound.has(log.id)),
      ...logs.filter(log => !outbound.has(log.id) && linksTo(log, 'fixes', fix.id)),
    ].sort(byDateDesc(log => log.createdAt ?? log.date))
  }

  function togglePriority(value) {
    setPriorities(current => (current.includes(value) ? current.filter(item => item !== value) : [...current, value]))
  }

  function toggleTag(value) {
    setTags(current => (current.includes(value) ? current.filter(item => item !== value) : [...current, value]))
  }

  function clearFilters() {
    setKeyword('')
    setStatus('all')
    setPriorities([])
    setTags([])
  }

  /** 快速捕获：只提交标题，其余字段交给服务端默认值（priority=normal、status=todo）。 */
  async function submitQuick(event) {
    event.preventDefault()
    const title = quick.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setQuickBusy(true)
    const ok = await mutate(() => api.addRecord('fixes', { title, note: '', status: 'todo' }), TEXT.created)
    setQuickBusy(false)
    if (ok) setQuick('')
  }

  /** 打开表单：不传记录是新建，传记录是编辑（tags 在表单里是逗号分隔文本）。 */
  function openForm(fix) {
    if (fix === undefined) {
      setForm({ ...EMPTY_FORM })
      return
    }
    setForm({
      id: fix.id,
      title: String(fix.title ?? ''),
      priority: priorityOf(fix.priority).value,
      status: statusOf(fix.status).value,
      note: String(fix.note ?? ''),
      tags: tagsOf(fix).join(', '),
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
      title, priority: form.priority, status: form.status, note: form.note, tags: nextTags,
    }
    setBusy(true)
    const ok = await mutate(
      () => (form.id === null ? api.addRecord('fixes', fields) : api.patchRecord('fixes', form.id, fields)),
      form.id === null ? TEXT.created : TEXT.updated,
    )
    setBusy(false)
    if (ok) setForm(null)
  }

  function changeStatus(fix, next) {
    return mutate(() => api.patchRecord('fixes', fix.id, { status: next }), `${TEXT.statusChanged}「${statusOf(next).label}」`)
  }

  /** 记日志：日志落在 logs 模块，refs 回指这条问题（新关联字段的示范用法）。 */
  function openLog(fix) {
    setLogDraft({ text: '', level: 'warn', source: 'fixes' })
    setLogFor(fix)
  }

  async function submitLog() {
    const text = logDraft.text.trim()
    if (text === '') {
      notify(TEXT.needLogText, 'warn')
      return
    }
    const target = logFor
    setBusy(true)
    const ok = await mutate(
      () => api.addRecord('logs', {
        text, level: logDraft.level, source: logDraft.source.trim(), date: today, refs: [{ type: 'fixes', id: target.id }],
      }),
      TEXT.logged,
    )
    setBusy(false)
    if (ok) setLogFor(null)
  }

  async function confirmDelete() {
    const target = pendingDelete
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('fixes', target.id), TEXT.deleted)
    setBusy(false)
    if (ok) {
      setPendingDelete(null)
      setOpenId(current => (current === target.id ? null : current))
    }
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  const subtitle = `${hasFilter ? TEXT.filteredText(rows.length, counts.all) : TEXT.totalText(counts.all)} · ${TEXT.expandHint}`

  return (
    <div className="fixes" data-module="fixes">
      {fixes.length === 0 ? (
        <div data-testid="fixes-empty">
          <Card>
            <Empty
              icon={<IconBug size={22} />}
              title={TEXT.empty}
              hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
              action={(
                <div className="fixes-guide-actions">
                  {empty === true && typeof onLoadDemo === 'function' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="fixes-load-demo"
                      disabled={demoBusy}
                      onClick={loadDemo}
                    >
                      {demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => openForm()}>
                    <IconPlus size={15} />
                    {TEXT.create}
                  </button>
                </div>
              )}
            />
          </Card>
        </div>
      ) : (
        <Card
          className="fixes-panel"
          title={TEXT.title}
          subtitle={subtitle}
          action={(
            <button type="button" className="btn btn-sm btn-primary" onClick={() => openForm()}>
              <IconPlus size={15} />
              {TEXT.create}
            </button>
          )}
        >
          <form className="fixes-quick" data-testid="fixes-quick-add" onSubmit={submitQuick}>
            <IconPlus className="fixes-quick-icon" size={15} />
            <input
              className="input"
              value={quick}
              disabled={quickBusy}
              aria-label={TEXT.quickAdd}
              placeholder={TEXT.quickAdd}
              onChange={event => setQuick(event.target.value)}
            />
          </form>

          <div className="fixes-toolbar">
            <div className="fixes-toolbar-row">
              <label className="fixes-search">
                <IconSearch size={15} />
                <input
                  className="fixes-search-input"
                  type="search"
                  value={keyword}
                  placeholder={TEXT.search}
                  aria-label={TEXT.searchLabel}
                  onChange={event => setKeyword(event.target.value)}
                />
              </label>
              <Segmented options={statusOptions} value={status} onChange={setStatus} label={TEXT.filterLabel} />
            </div>

            <div className="fixes-toolbar-row fixes-chips">
              <span className="fixes-chip-label">{TEXT.priorityFilter}</span>
              <div className="fixes-chip-group" role="group" aria-label={TEXT.priorityFilter} data-testid="fixes-priority-filter">
                {priorityChips.map(option => (
                  <ChipButton
                    key={option.value}
                    tone={option.tone}
                    active={priorities.includes(option.value)}
                    title={`${option.label}优先级 ${option.count} 条`}
                    onClick={() => togglePriority(option.value)}
                  >
                    {option.label} {option.count}
                  </ChipButton>
                ))}
              </div>

              {tagPool.length > 0 && (
                <>
                  <span className="fixes-chip-label">{TEXT.tagFilter}</span>
                  <div className="fixes-chip-group" role="group" aria-label={TEXT.tagFilter} data-testid="fixes-tag-filter">
                    {visibleTags.map(tag => (
                      <ChipButton
                        key={tag.value}
                        active={tags.includes(tag.value)}
                        title={`#${tag.value} ${tag.count} 条`}
                        onClick={() => toggleTag(tag.value)}
                      >
                        #{tag.value} {tag.count}
                      </ChipButton>
                    ))}
                  </div>
                  {tagPool.length > TAG_LIMIT && (
                    <button type="button" className="fixes-plain" onClick={() => setAllTags(current => !current)}>
                      {allTags ? TEXT.lessTags : `${TEXT.moreTags} ${tagPool.length}`}
                    </button>
                  )}
                </>
              )}

              {hasFilter && (
                <button type="button" className="fixes-plain fixes-clear" onClick={clearFilters}>{TEXT.clearFilter}</button>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <div data-testid="fixes-filtered-empty">
              <Empty
                icon={<IconSearch size={20} />}
                title={TEXT.filteredEmpty}
                hint={TEXT.filteredEmptyHint}
                action={<button type="button" className="btn" onClick={clearFilters}>{TEXT.clearFilter}</button>}
              />
            </div>
          ) : (
            <div className="table fixes-table" data-testid="fixes-list">
              <div className="table-head">
                <span className="fixes-pri">{TEXT.fieldPriority}</span>
                <span className="fixes-title">{TEXT.fieldTitle}</span>
                <span className="fixes-status">{TEXT.fieldStatus}</span>
                <span className="fixes-tags">{TEXT.fieldTags}</span>
                <span className="fixes-time">{TEXT.colTime}</span>
                <span className="sr-only">{TEXT.colActions}</span>
              </div>

              {rows.map(fix => {
                const priority = priorityOf(fix.priority)
                const fixTags = tagsOf(fix)
                const stamp = fix.updatedAt ?? fix.createdAt
                const expanded = openId === fix.id
                const title = String(fix.title ?? '')
                const note = String(fix.note ?? '').trim()
                const linkedTasks = expanded ? tasksOfFix(fix) : []
                const linkedLogs = expanded ? logsOfFix(fix) : []

                return (
                  <Fragment key={fix.id}>
                    <div className="table-row fixes-row" data-testid="fix-row">
                      <span className="fixes-pri" title={`${TEXT.fieldPriority} ${priority.label}`}>
                        <span className={`fixes-dot ${priority.tone}`} aria-hidden="true" />
                        <span className="sr-only">{TEXT.fieldPriority}</span>
                        {priority.label}
                      </span>
                      <button
                        type="button"
                        className="fixes-title"
                        aria-expanded={expanded}
                        title={title}
                        onClick={() => setOpenId(expanded ? null : fix.id)}
                      >
                        <IconChevronRight className="fixes-caret" size={14} />
                        <span className="fixes-title-text">{title}</span>
                      </button>
                      <span className="fixes-status">
                        <Segmented
                          options={STATUS_OPTIONS}
                          value={statusOf(fix.status).value}
                          onChange={next => changeStatus(fix, next)}
                          label={`「${title}」${TEXT.fieldStatus}`}
                        />
                      </span>
                      <TagChips tags={fixTags} />
                      <time className="fixes-time" dateTime={typeof stamp === 'string' ? stamp : undefined}>
                        {formatStamp(stamp, today)}
                      </time>
                      <span className="fixes-row-actions">
                        <IconButton label={`${TEXT.editAction}「${title}」`} onClick={() => openForm(fix)}>
                          <IconEdit size={16} />
                        </IconButton>
                        <IconButton label={`${TEXT.delete}「${title}」`} tone="danger" onClick={() => setPendingDelete(fix)}>
                          <IconTrash size={16} />
                        </IconButton>
                      </span>
                    </div>

                    {expanded && (
                      <div className="fixes-detail" data-testid="fix-detail">
                        <div className="fixes-detail-meta">
                          <span className="fixes-detail-tags">
                            {fixTags.length === 0
                              ? <span className="fixes-muted">{TEXT.noTags}</span>
                              : fixTags.map(tag => <Chip key={tag}>#{tag}</Chip>)}
                          </span>
                          <span className="fixes-muted xs">
                            {TEXT.createdAt} {formatStamp(fix.createdAt, today)}
                            {' · '}
                            {TEXT.updatedAt} {formatStamp(stamp, today)}
                          </span>
                        </div>

                        <div className="fixes-detail-grid">
                          <section className="fixes-block">
                            <h4 className="fixes-block-title">{TEXT.fieldNote}</h4>
                            {note === ''
                              ? <p className="fixes-muted">{TEXT.noNote}</p>
                              : <p className="fixes-note">{note}</p>}
                          </section>

                          <div className="fixes-side">
                            <section className="fixes-block">
                              <div className="fixes-block-head">
                                <h4 className="fixes-block-title">{TEXT.relatedTasks}</h4>
                                <Chip>{linkedTasks.length}</Chip>
                                <button type="button" className="fixes-plain" onClick={() => navigate('tasks')}>
                                  <IconTasks size={13} />
                                  {TEXT.goTasks}
                                </button>
                              </div>
                              {linkedTasks.length === 0
                                ? (
                                  <p className="fixes-muted">
                                    {TEXT.noTasks}
                                    <span className="fixes-block-hint">{TEXT.noTasksHint}</span>
                                  </p>
                                )
                                : (
                                  <ul className="fixes-links">
                                    {linkedTasks.map(task => (
                                      <li key={task.id}>
                                        <button type="button" className="fixes-link" onClick={() => navigate('tasks')}>
                                          <IconTasks size={14} />
                                          <span className="fixes-link-text">{String(task.title ?? '')}</span>
                                          {task.done === true
                                            ? <Chip tone="ok">{TEXT.taskDone}</Chip>
                                            : <Chip tone="warn">{TEXT.taskTodo}</Chip>}
                                          {typeof task.due === 'string' && task.due !== '' && (
                                            <span className="fixes-link-meta">{relativeDay(task.due, today)}</span>
                                          )}
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                            </section>

                            <section className="fixes-block">
                              <div className="fixes-block-head">
                                <h4 className="fixes-block-title">{TEXT.relatedLogs}</h4>
                                <Chip>{linkedLogs.length}</Chip>
                                <button type="button" className="btn btn-sm" onClick={() => openLog(fix)}>
                                  <IconLogs size={14} />
                                  {TEXT.logAction}
                                </button>
                                <button type="button" className="fixes-plain" onClick={() => navigate('logs')}>
                                  {TEXT.goLogs}
                                </button>
                              </div>
                              {linkedLogs.length === 0
                                ? <p className="fixes-muted">{TEXT.noLogs}</p>
                                : (
                                  <ul className="fixes-links">
                                    {linkedLogs.slice(0, LOG_LIMIT).map(log => (
                                      <li key={log.id} className="fixes-log">
                                        <Chip tone={levelOf(log.level).tone}>{levelOf(log.level).label}</Chip>
                                        <span className="fixes-log-text">{String(log.text ?? '')}</span>
                                        <span className="fixes-link-meta">{formatDay(log.date)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              {linkedLogs.length > LOG_LIMIT && (
                                <p className="fixes-muted xs">{TEXT.moreLogs(linkedLogs.length - LOG_LIMIT)}</p>
                              )}
                            </section>
                          </div>
                        </div>
                      </div>
                    )}
                  </Fragment>
                )
              })}
            </div>
          )}
        </Card>
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
                placeholder="bug, 界面"
                onChange={event => setForm(current => ({ ...current, tags: event.target.value }))}
              />
            </Field>
          </>
        )}
      </FormModal>

      <FormModal
        open={logFor !== null}
        title={TEXT.logTitle}
        submitText={TEXT.logSubmit}
        busy={busy}
        hint={logFor === null ? undefined : `${TEXT.logHint}：「${String(logFor.title ?? '')}」`}
        onClose={() => setLogFor(null)}
        onSubmit={submitLog}
      >
        <Field label={TEXT.logText}>
          <textarea
            className="textarea"
            value={logDraft.text}
            placeholder={TEXT.logPlaceholder}
            onChange={event => setLogDraft(current => ({ ...current, text: event.target.value }))}
          />
        </Field>
        <FieldGroup label={TEXT.logLevel}>
          <Segmented
            options={LOG_LEVELS.map(option => ({ value: option.value, label: option.label }))}
            value={logDraft.level}
            onChange={next => setLogDraft(current => ({ ...current, level: next }))}
            label={TEXT.logLevel}
          />
        </FieldGroup>
        <Field label={TEXT.logSource} hint={TEXT.logSourceHint}>
          <input
            className="input"
            value={logDraft.source}
            onChange={event => setLogDraft(current => ({ ...current, source: event.target.value }))}
          />
        </Field>
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
