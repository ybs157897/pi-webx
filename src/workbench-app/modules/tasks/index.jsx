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
 * @module src/workbench-app/modules/tasks
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import './Tasks.css'
import { api } from '../../api.mjs'
import { Card, ConfirmDialog, Empty, Segmented } from '../../ui.jsx'
import { IconFlame, IconPlus, IconTasks } from '../../icons.jsx'
import { streakDays, todayISO } from '../../util.mjs'

import {
  TEXT,
  PRIORITY,
  GROUPS,
  SCOPE_OPTIONS,
  parseQuickAdd,
  hasMarks,
  dueWord,
  captureToast,
  urgencyOf,
  inScope,
  compareOpen,
  compareDone,
  createdDay,
  TaskRow
} from './model.jsx'
export { parseQuickAdd } from './model.jsx'

export default function Tasks({
  data, mutate, notify, modules, navigate, navigationTarget, prefs, setPref, empty, onLoadDemo,
}) {
  const today = todayISO()
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const requirements = Array.isArray(data?.requirements) ? data.requirements : []
  const [capture, setCapture] = useState('')
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [pending, setPending] = useState('')
  const [localScope, setLocalScope] = useState('today')
  const [scopeOverride, setScopeOverride] = useState(navigationTarget?.scope === 'all' ? 'all' : null)
  const [sourceRequirementId, setSourceRequirementId] = useState(typeof navigationTarget?.requirementId === 'string' ? navigationTarget.requirementId : '')
  const handledNavigation = useRef(null)
  const editRef = useRef(null)
  /** 行内编辑的提交闸门：回车/失焦只算一次，Esc 之后不再提交。 */
  const locked = useRef(false)

  const scope = scopeOverride ?? (prefs?.tasksScope === 'all' || prefs?.tasksScope === 'today' ? prefs.tasksScope : localScope)
  const parsedCapture = useMemo(() => parseQuickAdd(capture, today), [capture, today])
  const editingId = editing === null ? '' : editing.id
  const sourceRequirement = requirements.find(row => row.id === sourceRequirementId)
  const sourceTasks = useMemo(() => sourceRequirementId === '' ? tasks : tasks.filter(task =>
    Array.isArray(task.refs) && task.refs.some(ref => ref?.type === 'requirements' && ref.id === sourceRequirementId)
  ), [tasks, sourceRequirementId])

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
    for (const task of sourceTasks) {
      if (inScope(task, scope, today)) buckets.get(urgencyOf(task, today)).push(task)
    }
    return GROUPS
      .map(group => ({
        ...group,
        tasks: buckets.get(group.key).sort(group.key === 'done' ? compareDone : compareOpen),
      }))
      .filter(group => group.tasks.length > 0)
  }, [sourceTasks, scope, today])

  // 进编辑就聚焦并全选，重打标题最快；SSR 下没有 window，直接跳过。
  // 依赖只取被编辑行的 id：跟着标题每敲一个字重跑的话会把选择区重置掉。
  useEffect(() => {
    if (typeof window === 'undefined' || editingId === '') return
    const input = editRef.current
    if (input === null || typeof input.select !== 'function') return
    input.focus()
    input.select()
  }, [editingId])

  // 需求导入后进入全量视图，并只显示这条需求关联的待办；普通菜单入口清除来源。
  useEffect(() => {
    if (handledNavigation.current === navigationTarget) return
    handledNavigation.current = navigationTarget
    setSourceRequirementId(typeof navigationTarget?.requirementId === 'string' ? navigationTarget.requirementId : '')
    if (navigationTarget?.scope !== 'all') return
    setScopeOverride('all')
    setLocalScope('all')
    if (typeof setPref === 'function' && prefs?.tasksScope !== 'all') setPref('tasksScope', 'all')
  }, [navigationTarget, prefs?.tasksScope, setPref])

  /** 切换范围：本地先动，再落库（setPref 缺席时纯本地，模块可独立渲染）。 */
  function changeScope(next) {
    setScopeOverride(next)
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
    if (ok) {
      setCapture('')
      setSourceRequirementId('')
    }
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
  const sourceFiltered = sourceRequirementId !== ''
  const sourceTitle = String(sourceRequirement?.title ?? '这条需求')
  const sourceEmpty = sourceFiltered && sourceTasks.length === 0
  const emptyTitle = sourceEmpty ? '这条需求还没有关联待办'
    : sourceFiltered && scope === 'today' ? '今天没有这条需求的待办'
      : counts.total === 0 ? TEXT.emptyAll : TEXT.emptyToday
  const emptyHint = sourceEmpty ? '确认导入后会显示在这里，也可以清除筛选查看全部待办'
    : sourceFiltered && scope === 'today' ? '切到「全部」查看这条需求未来到期的待办'
      : counts.total === 0 ? TEXT.emptyAllHint : TEXT.emptyTodayHint

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

      {sourceFiltered && (
        <div className="tasks-source-filter" data-testid="tasks-source-filter">
          <span>来自需求「{sourceTitle}」 · {sourceTasks.length} 条待办</span>
          <button type="button" className="btn btn-sm" data-testid="tasks-source-clear" onClick={() => setSourceRequirementId('')}>清除筛选</button>
        </div>
      )}

      <div className="tasks-bar">
        <Segmented options={SCOPE_OPTIONS} value={scope} onChange={changeScope} label={TEXT.scopeLabel} />
        <p className="tasks-bar-count xs">{sourceFiltered ? '全库共 ' : '共 '}{counts.total} 条 · 待办 {counts.open}</p>
      </div>

      {groups.length === 0
        ? (
          <Card>
            <Empty
              icon={<IconTasks size={22} />}
              title={emptyTitle}
              hint={emptyHint}
              action={sourceFiltered
                ? <button type="button" className="btn" onClick={sourceEmpty ? () => setSourceRequirementId('') : () => changeScope('all')}>{sourceEmpty ? '查看全部待办' : '查看这条需求的全部待办'}</button>
                : canLoadDemo
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
                      onNavigate={(id, target) => { if (typeof navigate === 'function') navigate(id, target) }}
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
