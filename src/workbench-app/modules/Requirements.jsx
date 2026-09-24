/**
 * 需求管理：知识列表形态——左栏搜索 + 条目，右栏阅读区（标题 / meta / 正文 / 底部操作）。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Requirements
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Chip, ConfirmDialog, Empty, Field, FormModal, IconButton } from '../ui.jsx'
import { IconChevronLeft, IconChevronRight, IconEdit, IconPlus, IconRequirements, IconTrash } from '../icons.jsx'
import { byDateDesc, formatStamp } from '../util.mjs'

const TEXT = {
  list: '需求清单',
  add: '添加需求',
  searchPlaceholder: '搜索标题或备注',
  empty: '还没有需求',
  emptyHint: '换个关键词，或点右上角添加第一条',
  readerEmpty: '选一条需求开始阅读',
  readerEmptyHint: '在左侧列表里选一条需求，这里会显示完整内容',
  title: '标题',
  priority: '优先级',
  status: '状态',
  note: '备注',
  noteHint: '可留空，补充背景或验收标准',
  noNote: '（没有备注）',
  updatedAt: '更新于',
  addPlaceholder: '要做什么需求？',
  submit: '添加',
  save: '保存',
  delete: '删除',
  todo: '待评审',
  doing: '开发中',
  done: '已交付',
  advance: '推进到下一状态',
  back: '退回上一状态',
  edit: '编辑需求',
  deleteConfirm: '删除需求',
  deleteMessage: '确定删除这条需求？删除后无法恢复。',
  added: '已添加需求',
  updated: '需求已更新',
  deleted: '需求已删除',
  needTitle: '先写下需求标题',
}

const PRIORITY_OPTIONS = [
  { value: 'high', label: '高', tone: 'danger' },
  { value: 'normal', label: '中', tone: '' },
  { value: 'low', label: '低', tone: 'ok' },
]

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }

/** 左栏同档排序按最近更新倒序（原实现按 createdAt，刚编辑过的需求要浮上来）。 */
const byUpdatedDesc = byDateDesc(row => row.updatedAt ?? row.createdAt)

const STATUS_STEPS = [
  { status: 'todo', label: TEXT.todo, tone: 'warn', dot: 'status-todo' },
  { status: 'doing', label: TEXT.doing, tone: 'accent', dot: 'status-doing' },
  { status: 'done', label: TEXT.done, tone: 'ok', dot: 'status-done' },
]

const STATUS_ORDER = STATUS_STEPS.map(step => step.status)

function priorityOf(value) {
  return PRIORITY_OPTIONS.find(option => option.value === value) ?? PRIORITY_OPTIONS[1]
}

function statusOf(value) {
  return STATUS_STEPS.find(step => step.status === value) ?? STATUS_STEPS[0]
}

export default function Requirements({ data, mutate, notify }) {
  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ title: '', priority: 'normal', note: '' })
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)

  const visible = useMemo(() => {
    // 关键词同时匹配标题与备注；导入来的记录可能缺 note（store.import 只校验必填项、
    // 落库仍是原对象，server/workbench/store.ts:76-83），所以搜索前兜一次空值。
    const word = keyword.trim().toLowerCase()
    const matched = word === ''
      ? data.requirements
      : data.requirements.filter(row => row.title.toLowerCase().includes(word)
        || String(row.note ?? '').toLowerCase().includes(word))
    // 无关键词时分支配的是 data 本身，必须 slice() 后再 sort，否则会原地改到 state 数组。
    return matched
      .slice()
      .sort((a, b) => {
        if (a.priority !== b.priority) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        return byUpdatedDesc(a, b)
      })
  }, [data.requirements, keyword])

  // selected 只存 id、从 data 现算：mutate 之后 data 是全新数组，存对象会立刻陈旧。
  const selected = useMemo(
    () => data.requirements.find(row => row.id === selectedId) ?? null,
    [data.requirements, selectedId],
  )

  // 阅读区推进/退回的边界：两端禁用；未选中时 index 为 -1，两个按钮都不渲染。
  const selectedIndex = STATUS_ORDER.indexOf(selected?.status ?? '')

  async function submit() {
    const title = draft.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.addRecord('requirements', { title, priority: draft.priority, note: draft.note.trim() }),
      TEXT.added,
    )
    setBusy(false)
    if (ok) {
      setDraft(current => ({ ...current, title: '', note: '' }))
      setAdding(false)
    }
  }

  function move(row, direction) {
    const next = STATUS_ORDER[STATUS_ORDER.indexOf(row.status) + direction]
    return mutate(() => api.patchRecord('requirements', row.id, { status: next }), `已移到「${STATUS_STEPS.find(step => step.status === next).label}」`)
  }

  async function saveEdit() {
    const title = editing.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('requirements', editing.id, { title, priority: editing.priority, status: editing.status, note: editing.note }),
      TEXT.updated,
    )
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('requirements', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <div className="split" data-testid="requirements-split">
        <Card
          className="split-list"
          bodyClassName="split-list-body"
          title={TEXT.list}
          action={<IconButton label={TEXT.add} onClick={() => setAdding(true)}><IconPlus size={17} /></IconButton>}
        >
          <input
            className="input control-sm"
            data-testid="requirements-search"
            value={keyword}
            aria-label={TEXT.searchPlaceholder}
            placeholder={TEXT.searchPlaceholder}
            onChange={event => setKeyword(event.target.value)}
          />

          {visible.length === 0
            ? (
              <div data-testid="requirements-list-empty">
                <Empty icon={<IconRequirements size={22} />} title={TEXT.empty} hint={TEXT.emptyHint} />
              </div>
            )
            : (
              <ul className="list" data-testid="requirements-list">
                {visible.map(row => {
                  const priority = priorityOf(row.priority)
                  const status = statusOf(row.status)
                  return (
                    <li className="list-item" key={row.id}>
                      <button
                        type="button"
                        className={`entry-btn ${row.id === selectedId ? 'is-active' : ''}`}
                        data-testid="requirements-item"
                        aria-pressed={row.id === selectedId}
                        onClick={() => setSelectedId(row.id)}
                      >
                        <span className="item-title">{row.title}</span>
                        <span className="item-meta">
                          <Chip tone={priority.tone}>{priority.label}</Chip>
                          <Chip tone={status.tone}>{status.label}</Chip>
                          <span className="time">{formatStamp(row.updatedAt ?? row.createdAt)}</span>
                        </span>
                        {row.note !== '' && <span className="item-note note-preview">{row.note}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
        </Card>

        <Card className="split-main">
          {selected === null
            ? (
              <div data-testid="requirements-reader-empty">
                <Empty icon={<IconRequirements size={22} />} title={TEXT.readerEmpty} hint={TEXT.readerEmptyHint} />
              </div>
            )
            : (
              <div className="reader" data-testid="requirements-reader">
                <h3 className="reader-title" data-testid="requirements-reader-title">{selected.title}</h3>
                <div className="item-meta" data-testid="requirements-reader-meta">
                  <Chip tone={priorityOf(selected.priority).tone}>{TEXT.priority} {priorityOf(selected.priority).label}</Chip>
                  <Chip tone={statusOf(selected.status).tone}>{statusOf(selected.status).label}</Chip>
                  <span className="time">{TEXT.updatedAt} {formatStamp(selected.updatedAt ?? selected.createdAt)}</span>
                </div>
                <div className="reader-body" data-testid="requirements-reader-body">
                  {selected.note === '' ? TEXT.noNote : selected.note}
                </div>
                <div className="reader-actions">
                  <button
                    type="button"
                    className="btn"
                    data-testid="requirements-back"
                    disabled={selectedIndex === 0}
                    onClick={() => move(selected, -1)}
                  >
                    <IconChevronLeft size={16} /> {TEXT.back}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-testid="requirements-advance"
                    disabled={selectedIndex === STATUS_ORDER.length - 1}
                    onClick={() => move(selected, 1)}
                  >
                    {TEXT.advance} <IconChevronRight size={16} />
                  </button>
                  <button type="button" className="btn" data-testid="requirements-edit" onClick={() => setEditing({ ...selected })}>
                    <IconEdit size={16} /> {TEXT.edit}
                  </button>
                  <button type="button" className="btn btn-danger" data-testid="requirements-delete" onClick={() => setPendingDelete(selected)}>
                    <IconTrash size={16} /> {TEXT.delete}
                  </button>
                </div>
              </div>
            )}
        </Card>
      </div>

      <FormModal
        open={adding}
        title={TEXT.add}
        submitText={TEXT.submit}
        busy={busy}
        onClose={() => setAdding(false)}
        onSubmit={submit}
      >
        <Field label={TEXT.title}>
          <input
            className="input"
            value={draft.title}
            placeholder={TEXT.addPlaceholder}
            onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
          />
        </Field>
        <Field label={TEXT.priority}>
          <select
            className="select"
            value={draft.priority}
            onChange={event => setDraft(current => ({ ...current, priority: event.target.value }))}
          >
            {PRIORITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Field>
        <Field label={TEXT.note} hint={TEXT.noteHint}>
          <textarea
            className="textarea"
            value={draft.note}
            onChange={event => setDraft(current => ({ ...current, note: event.target.value }))}
          />
        </Field>
      </FormModal>

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
              <Field label={TEXT.status}>
                <select
                  className="select"
                  value={editing.status}
                  onChange={event => setEditing(current => ({ ...current, status: event.target.value }))}
                >
                  {STATUS_STEPS.map(step => <option key={step.status} value={step.status}>{step.label}</option>)}
                </select>
              </Field>
            </div>
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
