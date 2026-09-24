/**
 * 今日规划：快速捕获条 + 按紧迫度分组的密集任务列表（Plane 式的日视图）。
 *
 * 三条设计线索：
 * 1. 捕获优先——顶部常驻输入框，回车即落库（默认 `due` 今天、`priority` 普通）；
 *    句尾小语法 `#标签` / `@明天` / `!高` 由本文件纯函数 `parseQuickAdd` 解析，
 *    行内改标题时复用同一套语法，所以截止日/优先级/标签不必另开弹窗。
 * 2. 范围切换——「今天 / 全部」记忆在 `prefs.tasksScope`，切走再回来还在原范围。
 * 3. 一屏闭环——勾选、改标题、星标、删除都在行内；分组头只有小号灰字与计数，
 *    视觉重量留给标题本身。
 *
 * props 见 Dashboard.jsx 顶部说明；本模块额外用到 `prefs`/`setPref`（范围记忆）、
 * `empty`/`onLoadDemo`（首启引导）、`modules`/`navigate`（关联角标跳转）。
 * @module src/modules/Tasks
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import './Tasks.css'
import { api } from '../api.mjs'
import {
  Card, ConfirmDialog, Empty, IconButton, Segmented,
} from '../ui.jsx'
import {
  IconCheck, IconEdit, IconFlame, IconLink, IconPlus, IconStar, IconTasks, IconTrash,
} from '../icons.jsx'
import { addDays, diffDays, formatDay, parseDay, streakDays, todayISO } from '../util.mjs'

const TEXT = {
  added: '已添加待办',
  addPlaceholder: '添加待办，回车快速记录…',
  addButton: '添加',
  hint: '回车即记；句尾可带 #标签、@明天、!高',
  marks: '将记录：',
  scopeLabel: '范围',
  scopeToday: '今天',
  scopeAll: '全部',
  groupOverdue: '已逾期',
  groupToday: '今天',
  groupLater: '以后',
  groupDone: '已完成',
  emptyAll: '还没有待办',
  emptyAllHint: '在上面写一行，回车就记下了',
  emptyToday: '今天没有待办',
  emptyTodayHint: '今天没有到期的，也没有欠着的',
  loadDemo: '灌入演示数据',
  showAll: '看全部',
  noDue: '无日期',
  doneStat: '今天完成',
  doneStatHint: '今天到期的任务里已完成的数量',
  streakStat: '连续记录',
  streakUnit: '天',
  streakHint: '按记录创建日期统计的连续天数',
  edit: '改标题',
  star: '标记星标',
  unstar: '取消星标',
  delete: '删除',
  deleteTitle: '删除任务',
  deleteMessage: '删除后无法恢复。',
  deleted: '已删除',
  done: '完成，干得漂亮',
  undone: '已恢复为待办',
  starred: '已加星标',
  unstarred: '已取消星标',
  updated: '已更新',
  needTitle: '先写下要做什么',
  refs: '关联记录',
}

/** 优先级徽章：高=danger、中=warn、低=默认（中性灰）。 */
const PRIORITY = {
  high: { label: '高', tone: 'danger' },
  normal: { label: '中', tone: 'warn' },
  low: { label: '低', tone: 'plain' },
}

const PRIORITY_WORDS = { 高: 'high', 中: 'normal', 低: 'low' }

/** 排序用的优先级次序（认不出的值按普通处理）。 */
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }

/** 星期词 → `Date.getDay()`：周一 1…周六 6、周日/周天 0。 */
const WEEKDAY_WORDS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

/** 分组顺序：紧迫度从高到低，已完成垫底——勾掉一条不会让上面的组跳位。 */
const GROUPS = [
  { key: 'overdue', label: TEXT.groupOverdue, tone: 'danger' },
  { key: 'today', label: TEXT.groupToday, tone: '' },
  { key: 'later', label: TEXT.groupLater, tone: '' },
  { key: 'done', label: TEXT.groupDone, tone: '' },
]

const SCOPE_OPTIONS = [
  { value: 'today', label: TEXT.scopeToday },
  { value: 'all', label: TEXT.scopeAll },
]

/** 标签色点取色盘：只用设计令牌里的语义色。 */
const TAG_TONES = ['accent', 'ok', 'info', 'warn', 'danger']

/* ------------------------------------------------------------------ 输入解析 */

/**
 * `@词` → 截止日；认不出的词返回 null（按普通文字留在标题里，不静默吞掉）。
 * 支持：今天 / 明天 / 后天 / 周一…周日（含「星期」写法，取最近的一天，今天算）/ YYYY-MM-DD。
 * @param word - `@` 后面的词。
 * @param today - 今天（`YYYY-MM-DD`）。
 * @returns `YYYY-MM-DD` 或 null。
 */
function parseDueWord(word, today) {
  if (word === '今天') return today
  if (word === '明天') return addDays(today, 1)
  if (word === '后天') return addDays(today, 2)
  const week = /^(?:周|星期)([一二三四五六日天])$/.exec(word)
  if (week !== null) return addDays(today, (WEEKDAY_WORDS[week[1]] - parseDay(today).getDay() + 7) % 7)
  // `addDays(x, 0)` 是本地日历回写：合法日期原样返回，非法日期得到 `NaN-NaN-NaN`。
  if (/^\d{4}-\d{2}-\d{2}$/.test(word) && addDays(word, 0) === word) return word
  return null
}

/**
 * 解析快速捕获语法：`写周报 #工作 @周五 !高`（三类标记各认第一个，识别后从标题摘掉，与位置无关）。
 * @param input - 原始输入。
 * @param today - 今天（`YYYY-MM-DD`），注入便于测试。
 * @returns `{ title, priority, tag, due, matched }`；`matched` 标明哪些标记真的出现过——
 *   新建时用默认值兜底（今天到期、普通优先级），行内改标题时只改出现过的字段。
 */
export function parseQuickAdd(input, today = todayISO()) {
  const matched = { priority: false, tag: false, due: false }
  let priority = 'normal'
  let tag = ''
  let due = today
  const words = []
  for (const token of String(input ?? '').trim().split(/\s+/)) {
    if (token === '') continue
    if (!matched.tag && token.startsWith('#') && token.length > 1 && token.length <= 41) {
      tag = token.slice(1)
      matched.tag = true
      continue
    }
    if (!matched.priority && token.startsWith('!')) {
      const value = PRIORITY_WORDS[token.slice(1)]
      if (value !== undefined) {
        priority = value
        matched.priority = true
        continue
      }
    }
    if (!matched.due && token.startsWith('@')) {
      const value = parseDueWord(token.slice(1), today)
      if (value !== null) {
        due = value
        matched.due = true
        continue
      }
    }
    words.push(token)
  }
  return { title: words.join(' '), priority, tag, due, matched }
}

/** 有标记被解析出来（用于输入框下方的即时预览）。 */
function hasMarks(parsed) {
  return parsed.matched.priority || parsed.matched.tag || parsed.matched.due
}

/** 截止日的人话：今天 / 明天 / 具体日期。 */
function dueWord(due, today) {
  if (due === today) return '今天'
  if (due === addDays(today, 1)) return '明天'
  return formatDay(due)
}

/** 添加成功后的提示：把解析出的标记回报一遍，确认小语法真的生效了。 */
function captureToast(parsed, today) {
  const marks = []
  if (parsed.matched.tag) marks.push(`#${parsed.tag}`)
  if (parsed.matched.priority) marks.push(`${PRIORITY[parsed.priority].label}优先级`)
  if (parsed.matched.due && parsed.due !== today) marks.push(formatDay(parsed.due))
  return marks.length === 0 ? TEXT.added : `${TEXT.added} · ${marks.join(' · ')}`
}

/* ------------------------------------------------------------------ 派生数据 */

/** 紧迫度分桶：逾期 → 今天 → 以后（含无日期）→ 已完成。 */
function urgencyOf(task, today) {
  if (task.done === true) return 'done'
  if (typeof task.due !== 'string' || task.due === '') return 'later'
  if (task.due < today) return 'overdue'
  if (task.due === today) return 'today'
  return 'later'
}

/**
 * 范围过滤。`today` 档 = 欠着的（逾期）+ 今天到期 + 没排期的待办；
 * 今天勾掉的仍留在今天档，方便当场反悔。
 */
function inScope(task, scope, today) {
  if (scope === 'all') return true
  if (task.done === true) return task.due === today
  if (typeof task.due !== 'string' || task.due === '') return true
  return task.due <= today
}

/** 星标置顶 → 优先级 → 截止日 → 新建在前（认不出的优先级按普通算）。 */
function compareOpen(a, b) {
  if ((a.starred === true) !== (b.starred === true)) return a.starred === true ? -1 : 1
  const rank = (PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.normal) - (PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.normal)
  if (rank !== 0) return rank
  const left = String(a.due ?? '')
  const right = String(b.due ?? '')
  if (left !== right) return left < right ? -1 : 1
  return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
}

/** 已完成按「最近勾掉的」排前面。 */
function compareDone(a, b) {
  const left = String(a.doneAt ?? a.updatedAt ?? a.createdAt ?? '')
  const right = String(b.doneAt ?? b.updatedAt ?? b.createdAt ?? '')
  if (left === right) return 0
  return left < right ? 1 : -1
}

/** 行内截止日标签：今天=accent、逾期=danger、未来=次要色「N 天后」。 */
function dueLabel(task, today) {
  if (typeof task.due !== 'string' || task.due === '') return { text: TEXT.noDue, tone: 'muted' }
  if (task.done === true) return { text: formatDay(task.due, 'md'), tone: 'muted' }
  const delta = diffDays(today, task.due)
  if (delta === null) return { text: formatDay(task.due, 'md'), tone: 'muted' }
  if (delta === 0) return { text: '今天', tone: 'accent' }
  if (delta < 0) return { text: `逾期 ${-delta} 天`, tone: 'danger' }
  if (delta === 1) return { text: '明天', tone: 'plain' }
  if (delta === 2) return { text: '后天', tone: 'plain' }
  return { text: `${delta} 天后`, tone: 'plain' }
}

/** 同一个标签永远同一个色点（字符和取模，不随机）。 */
function tagTone(tag) {
  let sum = 0
  for (const char of String(tag ?? '')) sum = (sum + char.codePointAt(0)) % 997
  return TAG_TONES[sum % TAG_TONES.length]
}

/** 记录产生的本地日期（连续记录统计用）；时间戳缺失或非法时返回空串。 */
function createdDay(task) {
  const date = new Date(task.createdAt ?? '')
  return Number.isNaN(date.getTime()) ? '' : todayISO(date)
}

/** 第一条关联指向的模块（认得出才给跳转入口）。 */
function firstRefModule(task, modules) {
  const first = Array.isArray(task.refs) ? task.refs[0] : undefined
  if (first === null || first === undefined || typeof first !== 'object') return null
  return (modules ?? []).find(module => module.id === first.type) ?? null
}

/* ------------------------------------------------------------------ 行组件 */

/** 一行任务：勾选 + 标题（双击或按钮进编辑）+ 优先级/截止日/标签/关联 + 星标、删除。 */
function TaskRow({
  task, today, modules, editing, pending, editRef,
  onToggle, onToggleStar, onStartEdit, onEditTitle, onCommitEdit, onCancelEdit, onDelete, onNavigate,
}) {
  const done = task.done === true
  const priority = PRIORITY[task.priority] ?? PRIORITY.normal
  const due = dueLabel(task, today)
  const tag = typeof task.tag === 'string' ? task.tag.trim() : ''
  const refCount = Array.isArray(task.refs) ? task.refs.length : 0
  const linked = firstRefModule(task, modules)
  const isEditing = editing !== null && editing.id === task.id
  const busy = pending === task.id

  return (
    <li className={`task-row ${done ? 'is-done' : ''}`} data-testid="task-row" data-done={done ? 'true' : 'false'}>
      <button
        type="button"
        className="task-check"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `取消完成：${task.title}` : `完成：${task.title}`}
        disabled={busy}
        onClick={() => onToggle(task)}
      >
        {done && <IconCheck size={13} />}
      </button>

      <div className="task-body">
        {isEditing
          ? (
            <input
              ref={editRef}
              className="task-edit"
              value={editing.title}
              aria-label={TEXT.edit}
              onChange={event => onEditTitle(event.target.value)}
              onKeyDown={event => {
                // 中文输入法组词中的回车是「选字」，不能当成保存。
                if (event.nativeEvent?.isComposing === true) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onCommitEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  onCancelEdit()
                }
              }}
              onBlur={onCommitEdit}
            />
          )
          : (
            <p className="task-title" title={task.title} onDoubleClick={() => onStartEdit(task)}>{task.title}</p>
          )}

        <div className="task-meta">
          <span className={`task-prio ${priority.tone}`} title={`${priority.label}优先级`}>
            <span className="task-dot" aria-hidden="true" />
            {priority.label}
          </span>
          <span className={`task-due ${due.tone}`}>{due.text}</span>
          {tag !== '' && (
            <span className="task-tag" title={`#${tag}`}>
              <span className="task-tag-dot" data-tone={tagTone(tag)} aria-hidden="true" />
              <span className="task-tag-text">#{tag}</span>
            </span>
          )}
          {refCount > 0 && (linked === null
            ? (
              <span className="task-refs" title={`${TEXT.refs} ${refCount} 条`}>
                <IconLink size={12} />
                {refCount}
              </span>
            )
            : (
              <button
                type="button"
                className="task-refs is-link"
                title={`${TEXT.refs} ${refCount} 条 · 去${linked.label}`}
                onClick={() => onNavigate(linked.id)}
              >
                <IconLink size={12} />
                {refCount}
              </button>
            ))}
        </div>
      </div>

      <div className="task-actions">
        <IconButton
          label={task.starred === true ? TEXT.unstar : TEXT.star}
          className={`task-star ${task.starred === true ? 'is-on' : ''}`}
          disabled={busy}
          onClick={() => onToggleStar(task)}
        >
          <IconStar size={15} />
        </IconButton>
        <IconButton label={TEXT.edit} disabled={busy} onClick={() => onStartEdit(task)}>
          <IconEdit size={15} />
        </IconButton>
        <IconButton label={TEXT.delete} tone="danger" disabled={busy} onClick={() => onDelete(task)}>
          <IconTrash size={15} />
        </IconButton>
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------ 模块 */

export default function Tasks({
  data, mutate, notify, modules, navigate, prefs, setPref, empty, onLoadDemo,
}) {
  const today = todayISO()
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const [capture, setCapture] = useState('')
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [pending, setPending] = useState('')
  const [localScope, setLocalScope] = useState('today')
  const editRef = useRef(null)
  /** 行内编辑的提交闸门：回车/失焦只算一次，Esc 之后不再提交。 */
  const locked = useRef(false)

  const scope = prefs?.tasksScope === 'all' || prefs?.tasksScope === 'today' ? prefs.tasksScope : localScope
  const parsedCapture = useMemo(() => parseQuickAdd(capture, today), [capture, today])
  const editingId = editing === null ? '' : editing.id

  const counts = useMemo(() => ({
    total: tasks.length,
    open: tasks.filter(task => task.done !== true).length,
  }), [tasks])

  const progress = useMemo(() => {
    const dueToday = tasks.filter(task => task.due === today)
    return { done: dueToday.filter(task => task.done === true).length, total: dueToday.length }
  }, [tasks, today])

  const streak = useMemo(
    () => streakDays(tasks.map(createdDay).filter(day => day !== '')),
    [tasks],
  )

  const groups = useMemo(() => {
    const buckets = new Map(GROUPS.map(group => [group.key, []]))
    for (const task of tasks) {
      if (inScope(task, scope, today)) buckets.get(urgencyOf(task, today)).push(task)
    }
    return GROUPS
      .map(group => ({
        ...group,
        tasks: buckets.get(group.key).sort(group.key === 'done' ? compareDone : compareOpen),
      }))
      .filter(group => group.tasks.length > 0)
  }, [tasks, scope, today])

  // 进编辑就聚焦并全选，重打标题最快；SSR 下没有 window，直接跳过。
  // 依赖只取被编辑行的 id：跟着标题每敲一个字重跑的话会把选择区重置掉。
  useEffect(() => {
    if (typeof window === 'undefined' || editingId === '') return
    const input = editRef.current
    if (input === null || typeof input.select !== 'function') return
    input.focus()
    input.select()
  }, [editingId])

  /** 切换范围：本地先动，再落库（setPref 缺席时纯本地，模块可独立渲染）。 */
  function changeScope(next) {
    setLocalScope(next)
    if (typeof setPref === 'function') setPref('tasksScope', next)
  }

  /** 快速捕获：标题必填，其余走小语法 + 默认值。 */
  async function submitCapture(event) {
    event.preventDefault()
    const parsed = parseQuickAdd(capture, today)
    if (parsed.title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setPending('capture')
    const ok = await mutate(
      () => api.addRecord('tasks', {
        title: parsed.title, priority: parsed.priority, tag: parsed.tag, due: parsed.due,
      }),
      captureToast(parsed, today),
    )
    setPending('')
    if (ok) setCapture('')
  }

  async function toggleDone(task) {
    setPending(task.id)
    await mutate(
      () => api.patchRecord('tasks', task.id, { done: task.done !== true }),
      task.done === true ? TEXT.undone : TEXT.done,
    )
    setPending('')
  }

  async function toggleStar(task) {
    setPending(task.id)
    await mutate(
      () => api.patchRecord('tasks', task.id, { starred: task.starred !== true }),
      task.starred === true ? TEXT.unstarred : TEXT.starred,
    )
    setPending('')
  }

  function startEdit(task) {
    locked.current = false
    setEditing({ id: task.id, title: task.title, source: task })
  }

  function cancelEdit() {
    locked.current = true
    setEditing(null)
  }

  /** 保存标题：行内写的小语法也生效，只提交真正变了的字段。 */
  async function commitEdit() {
    if (editing === null || locked.current) return
    locked.current = true
    const parsed = parseQuickAdd(editing.title, today)
    const source = editing.source
    setEditing(null)
    if (parsed.title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    const patch = {}
    if (parsed.title !== source.title) patch.title = parsed.title
    if (parsed.matched.priority && parsed.priority !== source.priority) patch.priority = parsed.priority
    if (parsed.matched.tag && parsed.tag !== source.tag) patch.tag = parsed.tag
    if (parsed.matched.due && parsed.due !== source.due) patch.due = parsed.due
    if (Object.keys(patch).length === 0) return
    setPending(source.id)
    await mutate(() => api.patchRecord('tasks', source.id, patch), TEXT.updated)
    setPending('')
  }

  async function confirmDelete() {
    const target = deleting
    if (target === null) return
    setPending(target.id)
    const ok = await mutate(() => api.removeRecord('tasks', target.id), TEXT.deleted)
    setPending('')
    if (ok) setDeleting(null)
  }

  const canLoadDemo = empty === true && typeof onLoadDemo === 'function'

  return (
    <div className="tasks" data-module="tasks">
      <div className="tasks-capture">
        <Card bodyClassName="tasks-capture-body">
          <form className="tasks-capture-form" data-testid="tasks-capture" onSubmit={submitCapture}>
            <span className="tasks-capture-icon" aria-hidden="true"><IconPlus size={16} /></span>
            <input
              className="tasks-capture-input"
              value={capture}
              placeholder={TEXT.addPlaceholder}
              aria-label={TEXT.addPlaceholder}
              onChange={event => setCapture(event.target.value)}
              onKeyDown={event => {
                // 输入法组词中的回车只用来选字，别顺手把半截标题提交了。
                if (event.key === 'Enter' && event.nativeEvent?.isComposing === true) event.preventDefault()
              }}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={pending === 'capture'}>
              {TEXT.addButton}
            </button>
          </form>
          <p className="tasks-capture-hint">
            {hasMarks(parsedCapture)
              ? (
                <>
                  <span className="tasks-capture-lead">{TEXT.marks}</span>
                  {parsedCapture.matched.priority && (
                    <span className={`tasks-mark ${PRIORITY[parsedCapture.priority].tone}`}>
                      {PRIORITY[parsedCapture.priority].label}优先级
                    </span>
                  )}
                  {parsedCapture.matched.tag && <span className="tasks-mark accent">#{parsedCapture.tag}</span>}
                  {parsedCapture.matched.due && (
                    <span className={`tasks-mark ${parsedCapture.due < today ? 'danger' : 'plain'}`}>
                      {dueWord(parsedCapture.due, today)}
                    </span>
                  )}
                </>
              )
              : TEXT.hint}
          </p>
        </Card>
      </div>

      <div className="tasks-bar">
        <Segmented options={SCOPE_OPTIONS} value={scope} onChange={changeScope} label={TEXT.scopeLabel} />
        <p className="tasks-bar-count xs">共 {counts.total} 条 · 待办 {counts.open}</p>
      </div>

      {groups.length === 0
        ? (
          <Card>
            <Empty
              icon={<IconTasks size={22} />}
              title={counts.total === 0 ? TEXT.emptyAll : TEXT.emptyToday}
              hint={counts.total === 0 ? TEXT.emptyAllHint : TEXT.emptyTodayHint}
              action={canLoadDemo
                ? <button type="button" className="btn btn-primary" onClick={onLoadDemo}>{TEXT.loadDemo}</button>
                : (counts.total > 0 && scope === 'today'
                  ? <button type="button" className="btn" onClick={() => changeScope('all')}>{TEXT.showAll}</button>
                  : undefined)}
            />
          </Card>
        )
        : (
          <div className="tasks-groups">
            {groups.map(group => (
              <section className="tasks-group" key={group.key}>
                <header className="tasks-group-head">
                  <span className={`tasks-group-title ${group.tone}`}>{group.label}</span>
                  <span className={`tasks-group-count ${group.tone}`}>{group.tasks.length}</span>
                </header>
                <ul className="tasks-list">
                  {group.tasks.map(task => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      today={today}
                      modules={modules}
                      editing={editing}
                      pending={pending}
                      editRef={editRef}
                      onToggle={toggleDone}
                      onToggleStar={toggleStar}
                      onStartEdit={startEdit}
                      onEditTitle={title => setEditing(current => (current === null ? current : { ...current, title }))}
                      onCommitEdit={commitEdit}
                      onCancelEdit={cancelEdit}
                      onDelete={setDeleting}
                      onNavigate={id => { if (typeof navigate === 'function') navigate(id) }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

      <div className="tasks-foot">
        <span className="tasks-foot-item" title={TEXT.doneStatHint}>
          {TEXT.doneStat} <b>{progress.done}/{progress.total}</b>
        </span>
        <span className="tasks-foot-item" title={TEXT.streakHint}>
          <span className="tasks-foot-flame" aria-hidden="true"><IconFlame size={14} /></span>
          {TEXT.streakStat} <b>{streak}</b> {TEXT.streakUnit}
        </span>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={TEXT.deleteTitle}
        message={deleting === null ? '' : `「${deleting.title}」${TEXT.deleteMessage}`}
        busy={deleting !== null && pending === deleting.id}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
