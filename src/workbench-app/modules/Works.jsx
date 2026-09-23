/**
 * 工作助理：待办 / 进行中 / 已完成三列看板，状态左右流转，可编辑标题与备注。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Works
 */

import { useState } from 'react'
import { api } from '../api.mjs'
import { ConfirmDialog, Empty, Field, FormModal, IconButton } from '../ui.jsx'
import { IconChevronLeft, IconChevronRight, IconEdit, IconTrash, IconWorks } from '../icons.jsx'
import { byDateDesc, formatStamp } from '../util.mjs'

const TEXT = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  quickAdd: '添加卡片，回车确认',
  edit: '编辑任务',
  title: '标题',
  note: '备注',
  status: '状态',
  save: '保存',
  deleted: '已删除',
  created: '已添加',
  updated: '已更新',
  empty: '这一列还是空的',
  emptyHint: '在下面的输入框里写点什么',
  moveLeft: '移到上一列',
  moveRight: '移到下一列',
  deleteConfirm: '删除任务',
  deleteMessage: '确定删除这条任务？删除后无法恢复。',
  needTitle: '先写下任务标题',
}

/** 看板列定义：顺序即状态流转顺序。 */
const COLUMNS = [
  { status: 'todo', label: TEXT.todo, dot: 'status-todo' },
  { status: 'doing', label: TEXT.doing, dot: 'status-doing' },
  { status: 'done', label: TEXT.done, dot: 'status-done' },
]

const STATUS_ORDER = COLUMNS.map(column => column.status)

/** 列底部的快速添加：回车即建卡，不用开弹窗。 */
function QuickAdd({ status, onAdd, notify }) {
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

  return (
    <form onSubmit={submit}>
      <input
        className="input"
        value={value}
        disabled={busy}
        placeholder={TEXT.quickAdd}
        aria-label={`在「${COLUMNS.find(column => column.status === status).label}」添加卡片`}
        onChange={event => setValue(event.target.value)}
      />
    </form>
  )
}

export default function Works({ data, mutate, notify }) {
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)

  const columns = COLUMNS.map(column => ({
    ...column,
    items: data.works
      .filter(work => work.status === column.status)
      .sort(byDateDesc(work => work.updatedAt ?? work.createdAt)),
  }))

  function addWork(title, status) {
    return mutate(() => api.addRecord('works', { title, note: '', status }), TEXT.created)
  }

  function move(work, direction) {
    const next = STATUS_ORDER[STATUS_ORDER.indexOf(work.status) + direction]
    return mutate(() => api.patchRecord('works', work.id, { status: next }), `已移到「${COLUMNS.find(column => column.status === next).label}」`)
  }

  async function saveEdit() {
    const title = editing.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('works', editing.id, { title, note: editing.note, status: editing.status }),
      TEXT.updated,
    )
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('works', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <div className="kanban">
        {columns.map(column => (
          <section className="kanban-col" key={column.status}>
            <header className="kanban-head">
              <span className={`status-dot-mini ${column.dot}`} />
              {column.label}
              <span className="kanban-count">{column.items.length}</span>
            </header>
            {column.items.length === 0
              ? <Empty icon={<IconWorks size={20} />} title={TEXT.empty} hint={TEXT.emptyHint} />
              : (
                <div className="kanban-list">
                  {column.items.map(work => {
                    const index = STATUS_ORDER.indexOf(work.status)
                    return (
                      <article className="work-card" key={work.id}>
                        <p className="work-card-title">{work.title}</p>
                        {work.note !== '' && <p className="work-card-note">{work.note}</p>}
                        <div className="work-card-foot">
                          <IconButton
                            label={TEXT.moveLeft}
                            disabled={index === 0}
                            onClick={() => move(work, -1)}
                          >
                            <IconChevronLeft size={16} />
                          </IconButton>
                          <IconButton
                            label={TEXT.moveRight}
                            disabled={index === STATUS_ORDER.length - 1}
                            onClick={() => move(work, 1)}
                          >
                            <IconChevronRight size={16} />
                          </IconButton>
                          <IconButton label={TEXT.edit} onClick={() => setEditing({ ...work })}>
                            <IconEdit size={16} />
                          </IconButton>
                          <IconButton label="删除" tone="danger" onClick={() => setPendingDelete(work)}>
                            <IconTrash size={16} />
                          </IconButton>
                          <span className="time">{formatStamp(work.updatedAt ?? work.createdAt)}</span>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            <QuickAdd status={column.status} onAdd={addWork} notify={notify} />
          </section>
        ))}
      </div>

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
            <Field label={TEXT.status}>
              <select
                className="select"
                value={editing.status}
                onChange={event => setEditing(current => ({ ...current, status: event.target.value }))}
              >
                {COLUMNS.map(column => <option key={column.status} value={column.status}>{column.label}</option>)}
              </select>
            </Field>
            <Field label={TEXT.note}>
              <textarea
                className="textarea"
                value={editing.note}
                onChange={event => setEditing(current => ({ ...current, note: event.target.value }))}
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
