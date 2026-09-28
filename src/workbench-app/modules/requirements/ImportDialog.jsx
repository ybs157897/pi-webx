import { useEffect, useId, useRef, useState } from 'react'
import AssistantMarkdown from '../../pi-webx/AssistantMarkdown.jsx'
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
export default function ImportDialog({ row, busy = false, saved = false, error: serverError = '', onClose, onConfirm }) {
  const dialogRef = useRef(null)
  const firstInputRef = useRef(null)
  const nextKey = useRef(1)
  const titleId = useId()
  const [drafts, setDrafts] = useState(() => initialDrafts(row))
  const [error, setError] = useState('')
  const open = row !== null && row !== undefined
  const alreadyImported = open && (Boolean(row.importedAt) || (Array.isArray(row.importedTaskIds) && row.importedTaskIds.length > 0))
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
    if (busy || alreadyImported) return
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
          </div>
          <button type="button" className="icon-btn" data-testid="req-import-close" aria-label="关闭导入预览" disabled={busy} onClick={close}>×</button>
        </header>

        {alreadyImported
          ? <p className="req-import-notice" data-testid="req-import-already">这条需求已经导入待办。关联任务可在需求记录里查看。</p>
          : (
            <form id="req-import-form" onSubmit={submit}>
              <p className="req-import-help">检查拆分结果，取消不需要的条目，也可以修改或新增。确认后会一起加入待办列表。</p>
              {String(row.note ?? '').trim() !== '' && (
                <details className="req-import-context" data-testid="req-import-context">
                  <summary>查看完整需求与验收条件</summary>
                  <div className="req-import-context-body"><AssistantMarkdown text={String(row.note)} /></div>
                </details>
              )}
              <div className="req-import-list" data-testid="req-import-list">
                {drafts.map((draft, index) => (
                  <fieldset className="req-import-item" key={draft.key} disabled={busy || saved} data-testid="req-import-item">
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
              <button type="button" className="btn btn-sm req-import-add" data-testid="req-import-add" disabled={busy || saved || drafts.length >= MAX_TASKS} onClick={addDraft}>+ 添加待办</button>
              {(error !== '' || serverError !== '') && <p className="req-import-error" role="alert">{error || serverError}</p>}
            </form>
          )}

        <footer className="req-import-foot">
          <button type="button" className="btn" data-testid="req-import-cancel" disabled={busy} onClick={close}>{alreadyImported ? '关闭' : '取消'}</button>
          {!alreadyImported && (
            <button type="submit" form="req-import-form" className="btn btn-primary" disabled={busy || selectedCount === 0} data-testid="req-import-confirm">
              {busy ? (saved ? '加载中…' : '导入中…') : saved ? '重新加载待办' : `确认导入 ${selectedCount} 条`}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
