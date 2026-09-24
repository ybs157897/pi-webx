/**
 * 代码开发：IDE 工作区（code-server 概念）——左侧活动栏 + 文件树面板，右侧编辑器
 * （tab 条 / 工具条 / 行号槽 + 等宽编辑区 / 底部状态栏）。一条事项 = 一张开发卡：
 * 标题即事项名，project 决定它在文件树里的分组，note 才是编辑器正文。
 *
 * 数据纪律：编辑只改本地 draft（`saved` 是脏标记的比较基线），点「保存」或按 ⌘S 才走
 * `mutate(() => api.patchRecord('codes', id, …), '已保存')`；切换 tab / 新建 / 关 tab 前
 * 若有未保存改动，一律先问（保存并继续 / 放弃改动 / 取消）。草稿在渲染期按「属于哪条事项」重播：
 * 换人立刻换内容（不留一帧上一条的正文），而 mutate 后的 refresh 只换 data 里的对象、不换 id，
 * 正在打的内容不会被冲掉。多 tab 只是「这次打开过的事项」，不落库、也不写偏好。
 *
 * props 见 Dashboard.jsx 顶部说明（额外用到 `refresh` / `empty` / `onLoadDemo`）；
 * 根元素带 `data-module="codes"`。⌘S 监听只进 effect 并加 `window` 守卫，渲染期不读浏览器对象。
 * @module src/modules/Codes
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.mjs'
import {
  ConfirmDialog, Empty, Field, FieldGroup, FormModal, IconButton, Modal, Segmented, useMediaQuery,
} from '../ui.jsx'
import { IconClose, IconCode, IconPlus, IconRefresh, IconTrash } from '../icons.jsx'
import { byDateDesc, formatStamp, groupBy } from '../util.mjs'
import './Codes.css'

const TEXT = {
  add: '新建开发事项',
  addPlaceholder: '要开发或调整什么？',
  title: '标题',
  project: '项目',
  projectHint: '可留空，比如「pi-webx」',
  status: '状态',
  note: '备注',
  notePlaceholder: '实现要点、验收标准、相关文件…',
  submit: '新建',
  tree: '文件',
  ungrouped: '未分组',
  untitled: '未命名',
  module: '代码开发',
  workspace: '开发工作区',
  projectLabel: '项目',
  lines: '行',
  chars: '字',
  updatedAt: '更新于',
  save: '保存',
  saving: '保存中…',
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  empty: '还没有开发事项',
  emptyHint: '点文件面板右上角的「+」新建第一件事',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据，看看编辑器工作区长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  editorEmpty: '从左侧打开一个事项',
  editorEmptyHint: '选中文件树里的一条，右侧就会打开编辑器',
  delete: '删除',
  deleteConfirm: '删除事项',
  deleteMessage: '确定删除这条开发事项？删除后无法恢复。',
  discardTitle: '有未保存的改动',
  discardMessage: '当前事项还有未保存的改动。保存后再离开，或放弃这些改动。',
  discard: '放弃改动',
  saveAndLeave: '保存并继续',
  added: '已添加事项',
  saved: '已保存',
  unsaved: '未保存',
  deleted: '事项已删除',
  refreshed: '数据已是最新',
  needTitle: '先写下事项标题',
  toggleTree: '文件树',
  refresh: '刷新数据',
  closeTab: '关闭',
}

const STATUS_OPTIONS = [
  { value: 'todo', label: TEXT.todo },
  { value: 'doing', label: TEXT.doing },
  { value: 'done', label: TEXT.done },
]

/** 按最近更新倒序：后动的排在上面（组内排序用它）。 */
const byUpdatedDesc = byDateDesc(row => row.updatedAt ?? row.createdAt)

function statusOf(value) {
  return STATUS_OPTIONS.find(option => option.value === value) ?? STATUS_OPTIONS[0]
}

/** 导入来的旧记录可能缺字段：分组键与标题都过一遍兜底，缺了不至于让文件树塌掉。 */
function projectOf(row) {
  return typeof row.project === 'string' ? row.project.trim() : ''
}

function titleOf(row) {
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  return title === '' ? TEXT.untitled : title
}

/**
 * 脏标记只跟 `saved` 比：保存时 title/project 会 trim，
 * 若跟刷新来的记录比，首尾打过空格的记录会永久显示未保存。
 * 两者都为 null（没打开任何事项）时算干净，否则一进页面就会被拦「放弃改动」。
 */
function sameDraft(a, b) {
  if (a === null || b === null) return a === null && b === null
  return a.title === b.title && a.project === b.project && a.status === b.status && a.note === b.note
}

/** 快捷键提示用：mac 显示 ⌘，其余显示 Ctrl+。 */
const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

export default function Codes({ data, mutate, notify, refresh, empty = false, onLoadDemo }) {
  // 打开过的事项（tab 条的数据源）与当前 tab 分成两份 state：关掉一个 tab 不该丢掉 activeId 之外的东西。
  const [openIds, setOpenIds] = useState([])
  const [activeId, setActiveId] = useState('')
  // 草稿只认「属于哪条事项」：换人时下面渲染期就重播，不留一帧「新 tab 挂着上一条正文」。
  const [seedId, setSeedId] = useState('')
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(null)
  const [newDraft, setNewDraft] = useState({ title: '', project: '', status: 'todo', note: '' })
  const [adding, setAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  // 切换 / 新建 / 关 tab 前若有未保存改动，把待执行的意图暂存在这里（null 即不弹确认）。
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [treeOpen, setTreeOpen] = useState(true)
  const saveRef = useRef(null)
  const gutterRef = useRef(null)
  const pendingNewId = useRef('')
  const narrow = useMediaQuery('(max-width: 899px)')

  const rows = Array.isArray(data?.codes) ? data.codes : []
  const active = rows.find(row => row.id === activeId) ?? null

  // 播种走「渲染期派生」而不是 effect：打开的事项换人时同一帧就把草稿换成新的一条。
  // 认的是 id 不是对象——mutate 之后 refresh() 会换掉整个 data，认对象会让正在打的内容被冲掉；
  // activeId 指向的记录还没到（刚建完等刷新）时先不动，等它真的到位。
  if (active === null && activeId === '' && seedId !== '') {
    setSeedId('')
    setDraft(null)
    setSaved(null)
  } else if (active !== null && active.id !== seedId) {
    const next = {
      title: active.title ?? '',
      project: active.project ?? '',
      status: statusOf(active.status).value,
      note: typeof active.note === 'string' ? active.note : '',
    }
    setSeedId(active.id)
    setDraft(next)
    setSaved(next)
  }

  // 窄屏（<900px）右侧编辑区更值钱，文件树默认收起；宽屏恢复展开。
  useEffect(() => {
    setTreeOpen(!narrow)
  }, [narrow])

  // ⌘S 只挂一个 window 监听：draft 每次按键都变，直接进 deps 会反复订阅/退订。
  useEffect(() => {
    saveRef.current = save
  })

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onKeyDown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveRef.current?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const dirty = !sameDraft(draft, saved)

  // 按 project 分组（空项目归入「未分组」），组内按最近更新倒序，组序沿用数据里的出现顺序。
  const groups = useMemo(() => [...groupBy(rows, projectOf).entries()].map(([project, items]) => ({
    key: project,
    label: project === '' ? TEXT.ungrouped : project,
    items: items.sort(byUpdatedDesc),
  })), [rows])

  // tab 条只认还在库里的记录：别处删掉的事项，tab 跟着消失。
  const openItems = useMemo(
    () => openIds.map(id => rows.find(row => row.id === id) ?? null).filter(row => row !== null),
    [openIds, rows],
  )

  const lineNumbers = draft === null ? [] : draft.note.split('\n').map((_, index) => index + 1)
  const draftTitle = draft === null ? '' : (draft.title.trim() === '' ? TEXT.untitled : draft.title.trim())
  const updatedText = active === null ? '' : formatStamp(active.updatedAt ?? active.createdAt)

  /** 打开事项：已经开过就只切过去，否则往 tab 条尾部追加一个。 */
  function openTab(id) {
    setOpenIds(ids => (ids.includes(id) ? ids : [...ids, id]))
    setActiveId(id)
  }

  /** 关 tab：当前 tab 让给右邻，没有右邻再退左邻，都没有就回到编辑器空态。 */
  function closeTab(id) {
    const index = openIds.indexOf(id)
    const rest = openIds.filter(openId => openId !== id)
    setOpenIds(rest)
    if (id !== activeId) return
    setActiveId(rest[Math.min(index, rest.length - 1)] ?? '')
  }

  /** 确认框里的三选一落回各自意图。 */
  function runIntent(intent) {
    if (intent === null) return
    if (intent.kind === 'open') openTab(intent.id)
    else if (intent.kind === 'close') closeTab(intent.id)
    else if (intent.kind === 'new') setAdding(true)
  }

  async function save() {
    if (active === null || draft === null || !dirty) return false
    const title = draft.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return false
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('codes', active.id, {
        title, project: draft.project.trim(), status: statusOf(draft.status).value, note: draft.note,
      }),
      TEXT.saved,
    )
    setBusy(false)
    // 以用户输入为基线，trim 掉的空格不再点亮脏标记。
    if (ok) setSaved({ ...draft })
    return ok
  }

  /** 保存并继续：存不下（标题空 / 请求失败）就停在原地，别把用户的改动丢掉。 */
  async function saveIntent() {
    const intent = pending
    const ok = await save()
    if (!ok) return
    setPending(null)
    runIntent(intent)
  }

  function discardIntent() {
    const intent = pending
    setPending(null)
    runIntent(intent)
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
      const created = await api.addRecord('codes', {
        title,
        project: values.project.trim(),
        status: statusOf(values.status).value,
        note: values.note,
      })
      pendingNewId.current = created.record.id
      return created
    }, TEXT.added)
    setBusy(false)
    if (!ok) return
    setAdding(false)
    setNewDraft({ title: '', project: '', status: 'todo', note: '' })
    openTab(pendingNewId.current)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('codes', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (!ok) return
    if (activeId === pendingDelete.id) closeTab(pendingDelete.id)
    else setOpenIds(ids => ids.filter(id => id !== pendingDelete.id))
    setPendingDelete(null)
  }

  /* 切换拦截：编辑区有未保存改动时先确认，意图暂存进 `pending`，确认后再执行。 */
  function requestOpen(id) {
    if (id === activeId) return
    if (!dirty) {
      openTab(id)
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

  /** 关掉别的 tab 不会碰 draft，只有关当前这条才要拦。 */
  function requestClose(id) {
    if (id === activeId && dirty) {
      setPending({ kind: 'close', id })
      return
    }
    closeTab(id)
  }

  async function refreshData() {
    if (typeof refresh !== 'function') return
    try {
      await refresh()
      notify(TEXT.refreshed, 'ok')
    } catch (error) {
      notify(String(error?.message ?? error), 'error')
    }
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  /** 行号槽与 textarea 是两套滚动容器，同步只能靠手写：把 textarea 的 scrollTop 抄给槽。 */
  function syncGutter(event) {
    const gutter = gutterRef.current
    if (gutter !== null) gutter.scrollTop = event.currentTarget.scrollTop
  }

  return (
    <div className="codes-shell" data-module="codes" data-tree={treeOpen ? 'open' : 'closed'}>
      <div className="codes-activity" role="toolbar" aria-label={TEXT.workspace}>
        <IconButton
          label={TEXT.toggleTree}
          className={`codes-act ${treeOpen ? 'is-active' : ''}`}
          onClick={() => setTreeOpen(open => !open)}
        >
          <IconCode size={18} />
        </IconButton>
        <IconButton label={TEXT.refresh} className="codes-act" onClick={refreshData}>
          <IconRefresh size={18} />
        </IconButton>
        <span className="codes-activity-title ellipsis">{draftTitle === '' ? TEXT.module : draftTitle}</span>
      </div>

      <aside className="codes-explorer" aria-label={TEXT.tree} data-testid="codes-tree-panel">
        <div className="codes-explorer-head">
          <h3 className="codes-explorer-title">{TEXT.tree}</h3>
          <span className="codes-explorer-count" data-testid="codes-count">{rows.length}</span>
          <span data-testid="codes-new">
            <IconButton label={TEXT.add} onClick={() => requestNew()}>
              <IconPlus size={17} />
            </IconButton>
          </span>
        </div>

        <div className="codes-tree">
          {rows.length === 0
            ? (
              <div className="codes-blank" data-testid="codes-tree-empty">
                <Empty
                  icon={<IconCode size={22} />}
                  title={TEXT.empty}
                  hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
                  action={empty === true && typeof onLoadDemo === 'function'
                    ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="codes-load-demo"
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
            : groups.map(group => (
              <div className="tree-group" key={group.key} data-testid="codes-tree-group">
                <p className="tree-group-head">{group.label}</p>
                {group.items.map(row => (
                  <div
                    className={`codes-item ${row.id === activeId ? 'is-active' : ''}`}
                    key={row.id}
                    data-testid="code-item"
                  >
                    <button
                      type="button"
                      data-testid="codes-tree-item"
                      className="tree-item"
                      data-status={statusOf(row.status).value}
                      aria-pressed={row.id === activeId}
                      onClick={() => requestOpen(row.id)}
                    >
                      <span className="tree-name">{titleOf(row)}</span>
                      {row.id === activeId && dirty && <span className="dot-dirty" data-testid="codes-dirty-dot" />}
                      <span className="tree-dot" aria-hidden="true" />
                    </button>
                    <IconButton
                      label={`${TEXT.delete}「${titleOf(row)}」`}
                      className="codes-item-del"
                      onClick={() => setPendingDelete(row)}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </aside>

      <section className="codes-editor" aria-label={TEXT.workspace}>
        {active === null || draft === null
          ? (
            <div className="codes-blank-editor" data-testid="codes-editor-empty">
              <Empty icon={<IconCode size={22} />} title={TEXT.editorEmpty} hint={TEXT.editorEmptyHint} />
            </div>
          )
          : (
            <div className="codes-frame" data-testid="codes-editor">
              <div className="editor-tabs" role="tablist" aria-label={TEXT.tree}>
                {openItems.map(row => {
                  const isActive = row.id === activeId
                  return (
                    <div
                      key={row.id}
                      role="presentation"
                      className={`editor-tab ${isActive ? 'is-active' : ''}`}
                      data-testid="codes-tab"
                    >
                      <button
                        type="button"
                        role="tab"
                        className="editor-tab-name"
                        data-testid="codes-tab-name"
                        aria-selected={isActive}
                        onClick={() => requestOpen(row.id)}
                      >
                        {isActive ? draftTitle : titleOf(row)}
                      </button>
                      {isActive && dirty && <span className="dot-dirty" data-testid="codes-tab-dirty" />}
                      <IconButton
                        label={`${TEXT.closeTab}「${titleOf(row)}」`}
                        className="editor-tab-close"
                        onClick={() => requestClose(row.id)}
                      >
                        <IconClose size={14} />
                      </IconButton>
                    </div>
                  )
                })}
              </div>

              <div className="editor-toolbar">
                <Field label={TEXT.title} className="toolbar-title">
                  <input
                    className="input"
                    data-testid="codes-title-input"
                    value={draft.title}
                    placeholder={TEXT.addPlaceholder}
                    onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                  />
                </Field>
                <Field label={TEXT.project} className="toolbar-project">
                  <input
                    className="input"
                    data-testid="codes-project-input"
                    value={draft.project}
                    onChange={event => setDraft(current => ({ ...current, project: event.target.value }))}
                  />
                </Field>
                <FieldGroup label={TEXT.status} className="toolbar-status">
                  <span data-testid="codes-status-select">
                    <Segmented
                      label={TEXT.status}
                      options={STATUS_OPTIONS}
                      value={draft.status}
                      onChange={value => setDraft(current => ({ ...current, status: value }))}
                    />
                  </span>
                </FieldGroup>
                <div className="editor-actions">
                  <IconButton label={TEXT.delete} tone="danger" onClick={() => setPendingDelete(active)}>
                    <IconTrash size={16} />
                  </IconButton>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    data-testid="codes-save"
                    disabled={!dirty || draft.title.trim() === '' || busy}
                    onClick={save}
                  >
                    {busy ? TEXT.saving : `${TEXT.save}（${isMac ? '⌘' : 'Ctrl+'}S）`}
                  </button>
                </div>
              </div>

              {/* textarea 必须 wrap="off"：软换行会让行号与文字错位。 */}
              <div className="editor-area">
                <div className="editor-gutter" aria-hidden="true" data-testid="codes-gutter" ref={gutterRef}>
                  {lineNumbers.map(n => <span key={n}>{n}</span>)}
                </div>
                <textarea
                  className="editor-input"
                  data-testid="codes-editor-input"
                  wrap="off"
                  aria-label={TEXT.note}
                  value={draft.note}
                  maxLength={5000}
                  spellCheck={false}
                  onChange={event => setDraft(current => ({ ...current, note: event.target.value }))}
                  onScroll={syncGutter}
                />
              </div>

              <div className="editor-status" data-testid="codes-statusbar">
                <span className="editor-status-title" data-testid="codes-statusbar-title">{draftTitle}</span>
                <span className="editor-status-item">{TEXT.projectLabel} {draft.project.trim() === '' ? '—' : draft.project.trim()}</span>
                <span className="editor-status-item" data-status={statusOf(draft.status).value}>{statusOf(draft.status).label}</span>
                <span className="editor-status-item" data-testid="codes-line-count">{TEXT.lines} {lineNumbers.length}</span>
                <span className="editor-status-item" data-testid="codes-char-count">{TEXT.chars} {draft.note.length}</span>
                {updatedText !== '' && (
                  <span className="editor-status-item editor-status-time">{TEXT.updatedAt} {updatedText}</span>
                )}
                <span
                  className={`editor-status-save ${dirty ? 'is-dirty' : ''}`}
                  data-testid="codes-save-state"
                >
                  {busy ? TEXT.saving : (dirty ? TEXT.unsaved : TEXT.saved)}
                </span>
              </div>
            </div>
          )}
      </section>

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
        <FieldGroup label={TEXT.status}>
          <Segmented
            label={TEXT.status}
            options={STATUS_OPTIONS}
            value={newDraft.status}
            onChange={value => setNewDraft(current => ({ ...current, status: value }))}
          />
        </FieldGroup>
        <Field label={TEXT.note}>
          <textarea
            className="textarea"
            value={newDraft.note}
            maxLength={5000}
            placeholder={TEXT.notePlaceholder}
            onChange={event => setNewDraft(current => ({ ...current, note: event.target.value }))}
          />
        </Field>
      </FormModal>

      <Modal
        open={pending !== null}
        title={TEXT.discardTitle}
        onClose={() => setPending(null)}
        footer={(
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setPending(null)}>
              取消
            </button>
            <button type="button" className="btn" data-testid="codes-discard" disabled={busy} onClick={discardIntent}>
              {TEXT.discard}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="codes-save-intent"
              disabled={busy || draft === null || draft.title.trim() === ''}
              onClick={saveIntent}
            >
              {TEXT.saveAndLeave}
            </button>
          </>
        )}
      >
        <p className="confirm-message">{TEXT.discardMessage}</p>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${titleOf(pendingDelete)}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
