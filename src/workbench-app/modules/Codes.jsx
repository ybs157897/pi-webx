/**
 * 代码开发：编辑器工作区。左栏是按项目分组的文件树（等宽标题 + 状态 + 未保存圆点），
 * 右栏原地编辑——工具条改标题/项目/状态，等宽区改正文，保存统一走 patchRecord。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Codes
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Chip, ConfirmDialog, Empty, Field, FormModal, IconButton } from '../ui.jsx'
import { IconCode, IconPlus, IconTrash } from '../icons.jsx'
import { byDateDesc, formatStamp, groupBy } from '../util.mjs'

const TEXT = {
  add: '新建开发事项',
  addPlaceholder: '要开发或调整什么？',
  title: '标题',
  project: '项目',
  projectHint: '可留空，比如「pi-webx」',
  status: '状态',
  note: '备注',
  submit: '添加',
  tree: '文件',
  ungrouped: '未分组',
  untitled: '未命名',
  projectLabel: '项目',
  lines: '行数',
  updatedAt: '更新于',
  save: '保存',
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  empty: '还没有开发事项',
  emptyHint: '点卡头右上角的「+」新建第一件事',
  editorEmpty: '从左侧打开一个事项',
  editorEmptyHint: '选中文件树里的一条，右侧就会打开编辑器',
  delete: '删除',
  deleteConfirm: '删除事项',
  deleteMessage: '确定删除这条开发事项？删除后无法恢复。',
  discardTitle: '有未保存的改动',
  discardMessage: '继续操作会丢掉当前未保存的改动，确定放弃吗？',
  discard: '放弃改动',
  added: '已添加事项',
  updated: '事项已更新',
  deleted: '事项已删除',
  needTitle: '先写下事项标题',
}

const STATUS_OPTIONS = [
  { value: 'todo', label: TEXT.todo, tone: 'warn' },
  { value: 'doing', label: TEXT.doing, tone: 'accent' },
  { value: 'done', label: TEXT.done, tone: 'ok' },
]

/** 按最近更新倒序：后动的排在上面。 */
const byUpdatedDesc = byDateDesc(row => row.updatedAt ?? row.createdAt)

function statusOf(value) {
  return STATUS_OPTIONS.find(option => option.value === value) ?? STATUS_OPTIONS[0]
}

/** 快捷键提示用：mac 显示 ⌘，其余显示 Ctrl+。 */
const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

export default function Codes({ data, mutate, notify }) {
  const [activeId, setActiveId] = useState('')
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(null)
  const [newDraft, setNewDraft] = useState({ title: '', project: '' })
  const [adding, setAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  // 切换条目 / 新建前要放弃未保存改动时，把待执行的意图暂存在这里（null 即不弹确认）。
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const seededId = useRef('')
  const pendingNewId = useRef('')

  const active = useMemo(() => data.codes.find(row => row.id === activeId) ?? null, [data.codes, activeId])

  // 只在 activeId 变化时播种：mutate 之后 refresh() 会换掉整个 data，
  // 依赖 active 会让用户正在打的内容被冲掉。第二道闸门等这一行的数据真正到位。
  useEffect(() => {
    if (activeId === seededId.current) return
    if (active === null && activeId !== '') return
    seededId.current = activeId
    const next = active === null
      ? null
      : { title: active.title, project: active.project, status: active.status, note: active.note }
    setDraft(next)
    setSaved(next)
  }, [active, activeId])

  // 脏标记只跟 saved 比：保存时 title/project 会 trim，
  // 若跟刷新来的 active 比，首尾打过空格的记录会永久显示未保存。
  // 两者都为 null（没打开任何条目）时算干净，否则一进页面就会被拦「放弃改动」。
  function sameDraft(a, b) {
    if (a === null || b === null) return a === null && b === null
    return a.title === b.title && a.project === b.project && a.status === b.status && a.note === b.note
  }
  const dirty = !sameDraft(draft, saved)

  // 按 project 分组（空项目归入「未分组」），组内按最近更新倒序，组序沿用数据里的出现顺序。
  const groups = useMemo(() => [...groupBy(data.codes, row => row.project).entries()].map(([project, items]) => ({
    key: project,
    label: project === '' ? TEXT.ungrouped : project,
    items: items.sort(byUpdatedDesc),
  })), [data.codes])

  const lineNumbers = draft === null ? [] : draft.note.split('\n').map((_, index) => index + 1)

  async function save() {
    if (active === null || draft === null) return
    const title = draft.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('codes', active.id, {
        title, project: draft.project.trim(), status: draft.status, note: draft.note,
      }),
      TEXT.updated,
    )
    setBusy(false)
    // 以用户输入为基线，trim 掉的空格不再点亮脏标记。
    if (ok) setSaved({ ...draft })
  }

  /** 新建后自动打开：新记录 id 在 action 内部暂存，mutate 返回时刷新已排队，两个 setState 落在同一次提交。 */
  async function create(values) {
    const title = values.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(async () => {
      const created = await api.addRecord('codes', { title, project: values.project.trim(), status: 'todo', note: '' })
      pendingNewId.current = created.record.id
      return created
    }, TEXT.added)
    setBusy(false)
    if (ok) {
      setAdding(false)
      setNewDraft({ title: '', project: '' })
      setActiveId(pendingNewId.current)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('codes', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) {
      // 删掉正在编辑的那条：落回空状态（active === null 分支兜住）。
      if (activeId === pendingDelete.id) setActiveId('')
      setPendingDelete(null)
    }
  }

  /* 切换拦截：编辑区有未保存改动时先确认放弃，意图暂存进 `pending`，确认后再执行。 */
  function requestOpen(id) {
    if (id === activeId) return
    if (!dirty) {
      setActiveId(id)
      return
    }
    setPending({ kind: 'open', id })
  }

  function requestNew() {
    if (!dirty) {
      setAdding(true)
      return
    }
    setPending({ kind: 'new' })
  }

  function confirmDiscard() {
    const intent = pending
    setPending(null)
    if (intent === null) return
    if (intent.kind === 'open') setActiveId(intent.id)
    else setAdding(true)
  }

  /** ⌘S / Ctrl+S 保存：先拦掉浏览器默认行为（会弹「存储为网页」）。 */
  function onEditorKeyDown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      save()
    }
  }

  return (
    <div className="split" data-testid="codes-split">
      <Card
        className="split-list"
        bodyClassName="split-list-body"
        title={TEXT.tree}
        action={(
          <span data-testid="codes-new">
            <IconButton label={TEXT.add} onClick={() => requestNew()}>
              <IconPlus size={17} />
            </IconButton>
          </span>
        )}
      >
        {groups.length === 0
          ? (
            <div data-testid="codes-tree-empty">
              <Empty icon={<IconCode size={22} />} title={TEXT.empty} hint={TEXT.emptyHint} />
            </div>
          )
          : groups.map(group => (
            <div className="tree-group" key={group.key} data-testid="codes-tree-group">
              <p className="tree-group-head">{group.label}</p>
              {group.items.map(row => (
                <button
                  type="button"
                  key={row.id}
                  data-testid="codes-tree-item"
                  className={`entry-btn tree-item ${row.id === activeId ? 'is-active' : ''}`}
                  aria-pressed={row.id === activeId}
                  onClick={() => requestOpen(row.id)}
                >
                  <span className="tree-name">{row.title}</span>
                  {row.id === activeId && dirty && <span className="dot-dirty" data-testid="codes-dirty-dot" />}
                  <Chip tone={statusOf(row.status).tone}>{statusOf(row.status).label}</Chip>
                </button>
              ))}
            </div>
          ))}
      </Card>

      <Card className="split-main">
        {active === null || draft === null
          ? (
            <div data-testid="codes-editor-empty">
              <Empty icon={<IconCode size={22} />} title={TEXT.editorEmpty} hint={TEXT.editorEmptyHint} />
            </div>
          )
          : (
            <div className="editor" data-testid="codes-editor">
              <div className="editor-tabs">
                <span className="editor-tab is-active" data-testid="codes-tab">
                  <span className="tree-name">{draft.title === '' ? TEXT.untitled : draft.title}</span>
                  {dirty && <span className="dot-dirty" data-testid="codes-tab-dirty" />}
                </span>
                <IconButton label={TEXT.delete} tone="danger" onClick={() => setPendingDelete(active)}>
                  <IconTrash size={16} />
                </IconButton>
              </div>

              <div className="editor-toolbar">
                <Field label={TEXT.title}>
                  <input
                    className="input control-sm"
                    data-testid="codes-title-input"
                    value={draft.title}
                    placeholder={TEXT.addPlaceholder}
                    onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                  />
                </Field>
                <Field label={TEXT.project} hint={TEXT.projectHint}>
                  <input
                    className="input control-sm"
                    data-testid="codes-project-input"
                    value={draft.project}
                    onChange={event => setDraft(current => ({ ...current, project: event.target.value }))}
                  />
                </Field>
                <Field label={TEXT.status}>
                  <select
                    className="select control-sm"
                    data-testid="codes-status-select"
                    value={draft.status}
                    onChange={event => setDraft(current => ({ ...current, status: event.target.value }))}
                  >
                    {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </Field>
              </div>

              {/* textarea 必须 wrap="off"：软换行会让行号与文字错位。 */}
              <div className="editor-area">
                <div className="editor-gutter" aria-hidden="true" data-testid="codes-gutter">
                  {lineNumbers.map((n, i) => <span key={i}>{n}</span>)}
                </div>
                <textarea
                  className="editor-input"
                  data-testid="codes-editor-input"
                  wrap="off"
                  aria-label={TEXT.note}
                  value={draft.note}
                  maxLength={5000}
                  onChange={event => setDraft(current => ({ ...current, note: event.target.value }))}
                  onKeyDown={onEditorKeyDown}
                />
              </div>

              <div className="editor-status" data-testid="codes-statusbar">
                <span>{TEXT.projectLabel} {draft.project === '' ? '—' : draft.project}</span>
                <span>{statusOf(draft.status).label}</span>
                <span data-testid="codes-line-count">{TEXT.lines} {lineNumbers.length}</span>
                <span className="time">{TEXT.updatedAt} {formatStamp(active.updatedAt ?? active.createdAt)}</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-testid="codes-save"
                  disabled={!dirty || draft.title.trim() === '' || busy}
                  onClick={save}
                >
                  {TEXT.save}（{isMac ? '⌘' : 'Ctrl+'}S）
                </button>
              </div>
            </div>
          )}
      </Card>

      <FormModal
        open={adding}
        title={TEXT.add}
        submitText={TEXT.submit}
        busy={busy}
        onClose={() => setAdding(false)}
        onSubmit={() => create(newDraft)}
      >
        <Field label={TEXT.title}>
          <input
            className="input"
            value={newDraft.title}
            placeholder={TEXT.addPlaceholder}
            onChange={event => setNewDraft(current => ({ ...current, title: event.target.value }))}
          />
        </Field>
        <Field label={TEXT.project} hint={TEXT.projectHint}>
          <input
            className="input"
            value={newDraft.project}
            onChange={event => setNewDraft(current => ({ ...current, project: event.target.value }))}
          />
        </Field>
      </FormModal>

      <ConfirmDialog
        open={pending !== null}
        title={TEXT.discardTitle}
        message={TEXT.discardMessage}
        confirmText={TEXT.discard}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={confirmDiscard}
      />

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
