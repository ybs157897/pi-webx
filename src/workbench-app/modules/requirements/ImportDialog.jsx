import { useEffect, useId, useRef, useState } from 'react'
import AssistantMarkdown from '../../pi-webx/AssistantMarkdown.jsx'
import CategoryBadge from './CategoryBadge.jsx'
import './ImportDialog.css'

const MAX_TASKS = 20
const PRIORITIES = [
  { value: 'high', label: '高' },
  { value: 'normal', label: '中' },
  { value: 'low', label: '低' },
]

function draftRow(draft = {}, index = 0) {
  return {
    key: index,
    selected: true,
    title: String(draft.title ?? ''),
    priority: PRIORITIES.some(option => option.value === draft.priority) ? draft.priority : 'normal',
    due: typeof draft.due === 'string' ? draft.due : '',
    tag: String(draft.tag ?? ''),
  }
}

function initialDrafts(row) {
  const saved = Array.isArray(row?.taskDrafts) ? row.taskDrafts : []
  return saved.length === 0
    ? [draftRow({ title: row?.title, priority: row?.priority })]
    : saved.slice(0, MAX_TASKS).map(draftRow)
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** 默认单条待办：一条时文案说「这条」，多条才报数，不出现「确认导入 1 条」这种半截话。 */
function confirmLabel(count) {
  return count === 1 ? '确认导入这条待办' : `确认导入 ${count} 条`
}

/** 只提交用户明确勾选的草稿；旧需求可以手写，正文不自动解析成待办。 */
export function selectedTaskDrafts(drafts) {
  const selected = drafts.filter(draft => draft.selected)
  if (selected.length === 0) return { error: '至少勾选一条待办' }
  if (selected.length > MAX_TASKS) return { error: `一次最多导入 ${MAX_TASKS} 条待办` }
  const tasks = []
  for (const draft of selected) {
    const title = draft.title.trim()
    const tag = draft.tag.trim()
    const due = draft.due.trim()
    if (title === '' || title.length > 200) return { error: '每条待办都要有标题，且不超过 200 字' }
    if (tag.length > 40) return { error: '标签不能超过 40 字' }
    if (due !== '' && !validDate(due)) return { error: '截止日期需要是真实的日期' }
    tasks.push({ title, priority: draft.priority, due: due === '' ? null : due, tag })
  }
  return { tasks }
}

/** 显式预览、编辑、勾选并确认一次性导入需求待办。 */
export default function ImportDialog({
  row,
  busy = false,
  saved = false,
  conflict = false,
  conflictError = '',
  deleted = false,
  linkedTasks = [],
  error: serverError = '',
  reloadError = '',
  viewTasksError = '',
  onClose,
  onConfirm,
  onReloadLatest,
  onViewExistingTasks,
}) {
  const dialogRef = useRef(null)
  const firstInputRef = useRef(null)
  const nextKey = useRef(1)
  const titleId = useId()
  const [drafts, setDrafts] = useState(() => initialDrafts(row))
  const [error, setError] = useState('')
  const open = row !== null && row !== undefined
  const alreadyImported = open && (Boolean(row.importedAt) || (Array.isArray(row.importedTaskIds) && row.importedTaskIds.length > 0))
  const hasExistingTasks = alreadyImported || (Array.isArray(linkedTasks) && linkedTasks.length > 0)
  const existingTaskCount = Array.isArray(linkedTasks) && linkedTasks.length > 0
    ? linkedTasks.length
    : Array.isArray(row?.importedTaskIds) ? row.importedTaskIds.length : 0
  const selectedCount = drafts.filter(draft => draft.selected).length

  useEffect(() => {
    if (!open || typeof document === 'undefined' || typeof HTMLElement === 'undefined') return undefined
    setDrafts(initialDrafts(row))
    nextKey.current = Math.max(1, (Array.isArray(row.taskDrafts) ? row.taskDrafts.length : 0))
    setError('')
    const previousFocus = document.activeElement
    if (alreadyImported) dialogRef.current?.focus()
    else firstInputRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [row?.id, row?.updatedAt, open])

  useEffect(() => {
    if (open && busy) dialogRef.current?.focus()
  }, [open, busy])

  if (!open) return null

  function close() {
    if (!busy && typeof onClose === 'function') onClose()
  }

  function changeDraft(key, field, value) {
    setDrafts(current => current.map(draft => draft.key === key ? { ...draft, [field]: value } : draft))
    setError('')
  }

  function addDraft() {
    if (drafts.length >= MAX_TASKS) return
    const key = nextKey.current++
    setDrafts(current => [...current, draftRow({}, key)])
    setError('')
  }

  function removeDraft(key) {
    setDrafts(current => current.filter(draft => draft.key !== key))
    setError('')
  }

  function submit(event) {
    event.preventDefault()
    if (busy || conflict || deleted || hasExistingTasks) return
    const result = selectedTaskDrafts(drafts)
    if (result.error) {
      setError(result.error)
      return
    }
    if (typeof onConfirm === 'function') onConfirm({ expectedUpdatedAt: row.updatedAt, tasks: result.tasks })
  }

  function handleKeys(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...dialogRef.current.querySelectorAll('button, input, select, summary, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0)
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (document.activeElement === dialogRef.current) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-backdrop req-import-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div
        ref={dialogRef}
        className="req-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="req-import-dialog"
        onKeyDown={handleKeys}
      >
        <header className="req-import-head">
          <div>
            <p className="req-import-kicker">需求 → 待办</p>
            <h2 id={titleId}>拆分并导入待办</h2>
            <p className="req-import-source">来源：{String(row.title ?? '')}</p>
            <p className="req-import-meta">分类：<CategoryBadge value={row.category} testid="req-import-category" /></p>
          </div>
          <button type="button" className="icon-btn" data-testid="req-import-close" aria-label="关闭导入预览" disabled={busy} onClick={close}>×</button>
        </header>

        {hasExistingTasks && !deleted
          ? <div className="req-import-notice" data-testid="req-import-existing-tasks">
              <p data-testid="req-import-already">这条需求已有{existingTaskCount > 0 ? ` ${existingTaskCount} 条` : ''}关联待办，不能重复导入。</p>
              <p>查看待办会先刷新列表，再按这条需求筛选。</p>
            </div>
          : (
            <form id="req-import-form" onSubmit={submit}>
              {deleted && <p className="req-import-notice req-import-error" role="alert" data-testid="req-import-deleted-message">这条需求已被删除，无法继续导入。当前预览和编辑仍保留；关闭后可返回需求列表。</p>}
              <p className="req-import-help">Agent 默认整理一条待办；可以改标题、取消勾选，也可以新增更多条目。确认后会一起加入待办列表。</p>
              {conflict && <div className="req-import-conflict" role="alert" data-testid="req-import-conflict-message">
                <p>当前预览与服务端记录有冲突。你的编辑仍保留。重新载入会用最新需求草稿替换当前预览；载入后仍需再次确认导入。</p>
                {conflictError !== '' && <p data-testid="req-import-conflict-server-error">服务端说明：{conflictError}</p>}
              </div>}
              {reloadError !== '' && <p className="req-import-error" role="alert" data-testid="req-import-reload-error">最新需求载入失败，当前编辑仍保留。{reloadError}</p>}
              {String(row.note ?? '').trim() !== '' && (
                <details className="req-import-context" data-testid="req-import-context">
                  <summary>查看完整需求与验收条件</summary>
                  <div className="req-import-context-body"><AssistantMarkdown text={String(row.note)} /></div>
                </details>
              )}
              <div className="req-import-list" data-testid="req-import-list">
                {drafts.map((draft, index) => (
                  <fieldset className="req-import-item" key={draft.key} disabled={busy || saved || deleted} data-testid="req-import-item">
                    <legend>待办 {index + 1}</legend>
                    <div className="req-import-item-top">
                      <label className="req-import-check">
                        <input type="checkbox" data-testid="req-import-select" checked={draft.selected} onChange={event => changeDraft(draft.key, 'selected', event.target.checked)} />
                        导入这条
                      </label>
                      <button type="button" className="req-import-remove" data-testid="req-import-remove" aria-label={`移除待办 ${index + 1}`} onClick={() => removeDraft(draft.key)}>移除</button>
                    </div>
                    <label className="req-import-field req-import-title">
                      <span>标题</span>
                      <input
                        ref={index === 0 ? firstInputRef : undefined}
                        className="input"
                        data-testid="req-import-title"
                        value={draft.title}
                        maxLength={200}
                        placeholder="需要完成什么？"
                        onChange={event => changeDraft(draft.key, 'title', event.target.value)}
                      />
                    </label>
                    <div className="req-import-fields">
                      <label className="req-import-field">
                        <span>优先级</span>
                        <select className="input" data-testid="req-import-priority" value={draft.priority} onChange={event => changeDraft(draft.key, 'priority', event.target.value)}>
                          {PRIORITIES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                      <label className="req-import-field">
                        <span>截止日期</span>
                        <input className="input" data-testid="req-import-due" type="date" value={draft.due} onChange={event => changeDraft(draft.key, 'due', event.target.value)} />
                      </label>
                      <label className="req-import-field">
                        <span>标签</span>
                        <input className="input" data-testid="req-import-tag" value={draft.tag} maxLength={40} placeholder="可选" onChange={event => changeDraft(draft.key, 'tag', event.target.value)} />
                      </label>
                    </div>
                  </fieldset>
                ))}
              </div>
              <button type="button" className="btn btn-sm req-import-add" data-testid="req-import-add" disabled={busy || saved || deleted || drafts.length >= MAX_TASKS} onClick={addDraft}>+ 添加待办</button>
              {(error !== '' || serverError !== '') && <p className="req-import-error" role="alert" data-testid="req-import-error">{error || serverError}</p>}
            </form>
          )}
        {viewTasksError !== '' && <p className="req-import-error" role="alert" data-testid="req-import-view-existing-tasks-error">刷新关联待办失败，仍停留在当前窗口。{viewTasksError}</p>}

        <footer className="req-import-foot">
          <button type="button" className="btn" data-testid="req-import-cancel" disabled={busy} onClick={close}>{hasExistingTasks || deleted ? '关闭' : '取消'}</button>
          {conflict && !deleted && !alreadyImported && (
            <button type="button" className="btn" data-testid="req-import-reload-latest" disabled={busy} onClick={() => onReloadLatest?.()}>重新载入并预览</button>
          )}
          {hasExistingTasks && !deleted && (
            <button type="button" className="btn" data-testid="req-import-view-existing-tasks" disabled={busy} onClick={() => onViewExistingTasks?.()}>查看已有关联待办</button>
          )}
          {!hasExistingTasks && !deleted && (
            <button type="submit" form="req-import-form" className="btn btn-primary" disabled={busy || conflict || selectedCount === 0} data-testid="req-import-confirm">
              {busy ? (saved ? '加载中…' : '导入中…') : saved ? '重新加载待办' : confirmLabel(selectedCount)}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
