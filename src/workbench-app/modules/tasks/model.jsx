

import { IconButton } from '../../ui.jsx'
import { IconCheck, IconEdit, IconLink, IconStar, IconTrash } from '../../icons.jsx'
import { addDays, diffDays, formatDay, parseDay, todayISO } from '../../util.mjs'

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

export {
  TEXT, PRIORITY, PRIORITY_WORDS, PRIORITY_RANK, WEEKDAY_WORDS,
  GROUPS, SCOPE_OPTIONS, TAG_TONES, parseDueWord, hasMarks,
  dueWord, captureToast, urgencyOf, inScope, compareOpen,
  compareDone, dueLabel, tagTone, createdDay, firstRefModule,
  TaskRow,
}
