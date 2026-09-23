/**
 * 今日规划：添加/勾选/删除任务，优先级、标签、截止日，按日期分组。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Tasks
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import {
  Card, Chip, ChipButton, ConfirmDialog, Empty, Field, FormModal, IconButton,
} from '../ui.jsx'
import { ProgressRing } from '../charts.jsx'
import { IconCalendar, IconEdit, IconPlus, IconTasks, IconTrash } from '../icons.jsx'
import { byDateDesc, formatDay, formatStamp, relativeDay, todayISO } from '../util.mjs'

const TEXT = {
  add: '添加任务',
  addPlaceholder: '要做点什么？',
  title: '标题',
  priority: '优先级',
  tag: '标签',
  tagHint: '可留空，比如「工作」',
  due: '截止日',
  dueHint: '留空表示不设截止日',
  submit: '添加',
  progress: '完成进度',
  ringLabel: '全部任务完成度',
  open: '待办中',
  done: '已完成',
  todayDue: '今日到期',
  list: '任务清单',
  filterAll: '全部',
  filterOpen: '未完成',
  filterDone: '已完成',
  empty: '还没有任务',
  emptyHint: '在上面写下第一件要做的事',
  emptyFiltered: '这个筛选下没有任务',
  noDue: '无截止日期',
  overdue: '需要补上',
  edit: '编辑任务',
  save: '保存',
  deleteConfirm: '删除任务',
  deleteMessage: '确定删除这条任务？删除后无法恢复。',
  doneAt: '完成于',
  added: '已添加任务',
  updated: '任务已更新',
  deleted: '任务已删除',
  needTitle: '先写下要做什么',
}

const PRIORITY_OPTIONS = [
  { value: 'high', label: '高', tone: 'danger' },
  { value: 'normal', label: '中', tone: '' },
  { value: 'low', label: '低', tone: 'ok' },
]

const FILTERS = [
  { value: 'all', label: TEXT.filterAll },
  { value: 'open', label: TEXT.filterOpen },
  { value: 'done', label: TEXT.filterDone },
]

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }
/** 同优先级按创建时间倒序：后加的排在上面。 */
const byCreatedDesc = byDateDesc(task => task.createdAt)

function priorityOf(value) {
  return PRIORITY_OPTIONS.find(option => option.value === value) ?? PRIORITY_OPTIONS[1]
}

export default function Tasks({ data, mutate, notify }) {
  const today = todayISO()
  const [draft, setDraft] = useState({ title: '', priority: 'normal', tag: '', due: today })
  const [filter, setFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)

  const stats = useMemo(() => {
    const total = data.tasks.length
    const done = data.tasks.filter(task => task.done === true).length
    return {
      total,
      done,
      open: total - done,
      dueToday: data.tasks.filter(task => task.due === today && task.done !== true).length,
    }
  }, [data.tasks, today])

  const groups = useMemo(() => {
    const list = data.tasks.filter(task => (
      filter === 'all' || (filter === 'done' ? task.done === true : task.done !== true)
    ))
    const buckets = new Map()
    for (const task of list) {
      const key = task.due ?? 'none'
      const bucket = buckets.get(key)
      if (bucket === undefined) buckets.set(key, [task])
      else bucket.push(task)
    }
    const keys = [...buckets.keys()].sort((a, b) => {
      if (a === 'none') return 1
      if (b === 'none') return -1
      return a < b ? -1 : 1
    })
    return keys.map(key => ({
      key,
      label: key === 'none' ? TEXT.noDue : relativeDay(key, today),
      overdue: key !== 'none' && key < today && buckets.get(key).some(task => task.done !== true),
      tasks: buckets.get(key).sort((a, b) => {
        if (a.done !== b.done) return a.done === true ? 1 : -1
        if (a.priority !== b.priority) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        return byCreatedDesc(a, b)
      }),
    }))
  }, [data.tasks, filter, today])

  /** 提交新任务：标题必填，其余按表单默认值交给服务端校验。 */
  async function submit(event) {
    event.preventDefault()
    const title = draft.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.addRecord('tasks', { title, priority: draft.priority, tag: draft.tag.trim(), due: draft.due === '' ? null : draft.due }),
      TEXT.added,
    )
    setBusy(false)
    if (ok) setDraft(current => ({ ...current, title: '', tag: '' }))
  }

  /** 勾选完成/取消完成。 */
  function toggle(task) {
    return mutate(() => api.patchRecord('tasks', task.id, { done: task.done !== true }), task.done === true ? '已恢复为待办' : '完成，干得漂亮')
  }

  /** 保存编辑：只提交表单里的四个可改字段。 */
  async function saveEdit() {
    const title = editing.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('tasks', editing.id, {
        title, priority: editing.priority, tag: editing.tag, due: editing.due === '' ? null : editing.due,
      }),
      TEXT.updated,
    )
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('tasks', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <div className="grid grid-hero">
        <Card title={TEXT.add} subtitle={TEXT.dueHint}>
          <form className="form" onSubmit={submit}>
            <Field label={TEXT.title}>
              <input
                className="input"
                value={draft.title}
                placeholder={TEXT.addPlaceholder}
                onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
              />
            </Field>
            <div className="form-row">
              <Field label={TEXT.priority}>
                <select
                  className="select"
                  value={draft.priority}
                  onChange={event => setDraft(current => ({ ...current, priority: event.target.value }))}
                >
                  {PRIORITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
              <Field label={TEXT.tag} hint={TEXT.tagHint}>
                <input
                  className="input"
                  value={draft.tag}
                  onChange={event => setDraft(current => ({ ...current, tag: event.target.value }))}
                />
              </Field>
            </div>
            <Field label={TEXT.due}>
              <input
                type="date"
                className="input"
                value={draft.due}
                onChange={event => setDraft(current => ({ ...current, due: event.target.value }))}
              />
            </Field>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              <IconPlus size={16} /> {TEXT.submit}
            </button>
          </form>
        </Card>

        <Card title={TEXT.progress}>
          <div className="row" style={{ gap: '20px' }}>
            <ProgressRing value={stats.done} max={stats.total} label={TEXT.ringLabel} />
            <div className="stack grow" style={{ gap: '10px' }}>
              <div className="stat"><p className="stat-label">{TEXT.open}</p><p className="stat-value">{stats.open}</p></div>
              <div className="stat"><p className="stat-label">{TEXT.done}</p><p className="stat-value" style={{ color: 'var(--ok)' }}>{stats.done}</p></div>
              <div className="stat"><p className="stat-label">{TEXT.todayDue}</p><p className="stat-value" style={{ color: stats.dueToday > 0 ? 'var(--warn)' : 'var(--text)' }}>{stats.dueToday}</p></div>
            </div>
          </div>
        </Card>
      </div>

      <Card
        title={TEXT.list}
        action={(
          <div className="row-wrap" style={{ gap: '6px' }}>
            {FILTERS.map(item => (
              <ChipButton key={item.value} active={filter === item.value} onClick={() => setFilter(item.value)}>
                {item.label}
              </ChipButton>
            ))}
          </div>
        )}
      >
        {groups.length === 0
          ? (
            <Empty
              icon={<IconTasks size={22} />}
              title={filter === 'all' ? TEXT.empty : TEXT.emptyFiltered}
              hint={filter === 'all' ? TEXT.emptyHint : undefined}
            />
          )
          : groups.map(group => (
            <div key={group.key}>
              <div className="group-head">
                <span>{group.label}</span>
                {group.overdue && <Chip tone="danger">{TEXT.overdue}</Chip>}
                <span className="group-count">{group.tasks.filter(task => task.done === true).length}/{group.tasks.length}</span>
              </div>
              <ul className="list">
                {group.tasks.map(task => (
                  <li className="list-item" key={task.id}>
                    <input
                      type="checkbox"
                      className="check"
                      checked={task.done === true}
                      aria-label={task.done === true ? `取消完成：${task.title}` : `完成：${task.title}`}
                      onChange={() => toggle(task)}
                    />
                    <div className="item-main">
                      <p className={`item-title ${task.done === true ? 'is-done' : ''}`}>{task.title}</p>
                      <div className="item-meta">
                        <Chip tone={priorityOf(task.priority).tone}>{priorityOf(task.priority).label}优先级</Chip>
                        {task.tag !== '' && <Chip>#{task.tag}</Chip>}
                        {task.due !== null && <span><IconCalendar size={12} /> {formatDay(task.due)}</span>}
                        {task.done === true && typeof task.doneAt === 'string' && <span>{TEXT.doneAt} {formatStamp(task.doneAt, today)}</span>}
                      </div>
                    </div>
                    <div className="item-actions">
                      <IconButton label={TEXT.edit} onClick={() => setEditing({ ...task, due: task.due ?? '' })}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label="删除" tone="danger" onClick={() => setPendingDelete(task)}>
                        <IconTrash size={16} />
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </Card>

      <FormModal
        open={editing !== null}
        title={TEXT.edit}
        submitText={TEXT.save}
        busy={busy}
        onClose={() => setEditing(null)}
        onSubmit={saveEdit}
      >
        {editing !== null && (
          <>
            <Field label={TEXT.title}>
              <input
                className="input"
                value={editing.title}
                onChange={event => setEditing(current => ({ ...current, title: event.target.value }))}
              />
            </Field>
            <div className="form-row">
              <Field label={TEXT.priority}>
                <select
                  className="select"
                  value={editing.priority}
                  onChange={event => setEditing(current => ({ ...current, priority: event.target.value }))}
                >
                  {PRIORITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
              <Field label={TEXT.tag}>
                <input
                  className="input"
                  value={editing.tag}
                  onChange={event => setEditing(current => ({ ...current, tag: event.target.value }))}
                />
              </Field>
            </div>
            <Field label={TEXT.due} hint={TEXT.dueHint}>
              <input
                type="date"
                className="input"
                value={editing.due}
                onChange={event => setEditing(current => ({ ...current, due: event.target.value }))}
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
    </>
  )
}
