/**
 * 问题修复：单列问题清单，卡头按状态筛选（带数量），行内一步切换状态、编辑、删除。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Fixes
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import {
  Card, Chip, ConfirmDialog, Empty, Field, FormModal, IconButton, Segmented,
} from '../ui.jsx'
import { IconBug, IconEdit, IconTrash } from '../icons.jsx'
import { byDateDesc, formatStamp } from '../util.mjs'

const TEXT = {
  cardTitle: '问题修复',
  todo: '待处理',
  doing: '修复中',
  done: '已修复',
  quickAdd: '描述问题，回车确认',
  filterLabel: '状态筛选',
  filterAll: '全部',
  severity: '严重程度',
  status: '状态',
  title: '标题',
  note: '备注',
  edit: '编辑问题',
  save: '保存',
  deleted: '已删除',
  created: '已记录',
  updated: '已更新',
  empty: '没有问题记录',
  emptyHint: '在上面的输入框里描述一个问题',
  deleteConfirm: '删除问题',
  deleteMessage: '确定删除这条问题记录？删除后无法恢复。',
  needTitle: '先描述一下问题',
  delete: '删除',
}

const SEVERITY_OPTIONS = [
  { value: 'high', label: '高', tone: 'danger' },
  { value: 'normal', label: '中', tone: 'warn' },
  { value: 'low', label: '低', tone: 'ok' },
]

/** 状态选项：顺序即流转顺序，取值与 Codes 的 STATUS_OPTIONS（modules/Codes.jsx:49-53）一致。 */
const STATUS_OPTIONS = [
  { status: 'todo', label: TEXT.todo, tone: 'warn' },
  { status: 'doing', label: TEXT.doing, tone: 'accent' },
  { status: 'done', label: TEXT.done, tone: 'ok' },
]

function severityOf(value) {
  return SEVERITY_OPTIONS.find(option => option.value === value) ?? SEVERITY_OPTIONS[1]
}

function statusOf(value) {
  return STATUS_OPTIONS.find(option => option.status === value) ?? STATUS_OPTIONS[0]
}

export default function Fixes({ data, mutate, notify }) {
  const [quick, setQuick] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [filter, setFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)

  const counts = useMemo(() => {
    const next = { all: data.fixes.length }
    for (const option of STATUS_OPTIONS) {
      next[option.status] = data.fixes.filter(fix => fix.status === option.status).length
    }
    return next
  }, [data.fixes])

  const filterOptions = useMemo(() => ([
    { value: 'all', label: `${TEXT.filterAll} ${counts.all}` },
    ...STATUS_OPTIONS.map(option => ({ value: option.status, label: `${option.label} ${counts[option.status]}` })),
  ]), [counts])

  const rows = useMemo(() => (
    data.fixes
      .filter(fix => filter === 'all' || fix.status === filter)
      .sort(byDateDesc(fix => fix.updatedAt ?? fix.createdAt))
  ), [data.fixes, filter])

  /** 快速添加不传 priority：服务端建记录时给缺失字段补默认值（schema.mjs 的 validateFields），确定落到 normal。 */
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

  function setStatus(fix, next) {
    return mutate(() => api.patchRecord('fixes', fix.id, { status: next }), `已移到「${statusOf(next).label}」`)
  }

  async function saveEdit() {
    const title = editing.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('fixes', editing.id, { title, note: editing.note, priority: editing.priority, status: editing.status }),
      TEXT.updated,
    )
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('fixes', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <Card
        title={TEXT.cardTitle}
        action={<Segmented options={filterOptions} value={filter} onChange={setFilter} label={TEXT.filterLabel} />}
      >
        <form className="quick-add" data-testid="fixes-quick-add" onSubmit={submitQuick}>
          <input
            className="input"
            value={quick}
            disabled={quickBusy}
            aria-label={TEXT.quickAdd}
            placeholder={TEXT.quickAdd}
            onChange={event => setQuick(event.target.value)}
          />
        </form>

        {rows.length === 0
          ? <div data-testid="fixes-empty"><Empty icon={<IconBug size={20} />} title={TEXT.empty} hint={TEXT.emptyHint} /></div>
          : (
            <ul className="list" data-testid="fixes-list">
              {rows.map(fix => {
                const severity = severityOf(fix.priority)
                const status = statusOf(fix.status)
                return (
                  <li className="list-item" data-testid="fixes-row" key={fix.id}>
                    <div className="item-main">
                      <p className="item-title">{fix.title}</p>
                      <div className="item-meta">
                        <Chip tone={status.tone}>{status.label}</Chip>
                        <Chip tone={severity.tone}>{TEXT.severity} {severity.label}</Chip>
                        <span className="time">{formatStamp(fix.updatedAt ?? fix.createdAt)}</span>
                      </div>
                      {fix.note !== '' && <p className="item-note note-preview">{fix.note}</p>}
                    </div>
                    <div className="item-actions always">
                      <select
                        className="select control-sm"
                        data-testid="fixes-status-select"
                        aria-label={`${TEXT.status}：${fix.title}`}
                        value={fix.status}
                        onChange={event => setStatus(fix, event.target.value)}
                      >
                        {STATUS_OPTIONS.map(option => <option key={option.status} value={option.status}>{option.label}</option>)}
                      </select>
                      <IconButton label={TEXT.edit} onClick={() => setEditing({ ...fix })}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label={TEXT.delete} tone="danger" onClick={() => setPendingDelete(fix)}>
                        <IconTrash size={16} />
                      </IconButton>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
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
              <Field label={TEXT.severity}>
                <select
                  className="select"
                  value={editing.priority}
                  onChange={event => setEditing(current => ({ ...current, priority: event.target.value }))}
                >
                  {SEVERITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
              <Field label={TEXT.status}>
                <select
                  className="select"
                  value={editing.status}
                  onChange={event => setEditing(current => ({ ...current, status: event.target.value }))}
                >
                  {STATUS_OPTIONS.map(option => <option key={option.status} value={option.status}>{option.label}</option>)}
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
