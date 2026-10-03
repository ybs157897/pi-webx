/** 需求菜单直达独立对话；需求记录与待办导入仍由本模块持有。 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api.mjs'
import { parseTranscriptViewMode } from '../../../lib/transcript/presentation'
import { IconRequirements, IconTasks } from '../../icons.jsx'
import RequirementsChat from './RequirementsChat.jsx'
import Records from './Records.jsx'
import ImportDialog from './ImportDialog.jsx'
import TraceDrawer from './TraceDrawer.jsx'
import './Conversation.css'

export default function Requirements(props) {
  const { data, mutate, notify, refresh, navigate, navigationTarget, themeMode, prefs } = props
  const [view, setView] = useState(navigationTarget?.selectedId ? 'records' : 'chat')
  const [importing, setImporting] = useState(null)
  const [busy, setBusy] = useState(false)
  const [importError, setImportError] = useState('')
  const [savedImport, setSavedImport] = useState(false)
  const [importConflict, setImportConflict] = useState(false)
  const [conflictError, setConflictError] = useState('')
  const [importDeleted, setImportDeleted] = useState(false)
  const [reloadError, setReloadError] = useState('')
  const [importLinkedTasks, setImportLinkedTasks] = useState([])
  const [viewTasksError, setViewTasksError] = useState('')
  const [importGeneration, setImportGeneration] = useState(0)
  const [traceLookupOpen, setTraceLookupOpen] = useState(false)
  const operationLock = useRef(false)

  useEffect(() => {
    setView(navigationTarget?.selectedId ? 'records' : 'chat')
  }, [navigationTarget])

  function openImport(row) {
    setImportError('')
    setSavedImport(false)
    setImportConflict(false)
    setConflictError('')
    setImportDeleted(false)
    setReloadError('')
    setViewTasksError('')
    const requirementId = row?.id
    const tasks = Array.isArray(data?.tasks) ? data.tasks : []
    setImportLinkedTasks(tasks
      .filter(task => Array.isArray(task?.refs)
        && task.refs.some(ref => ref?.type === 'requirements' && ref?.id === requirementId))
      .map(task => ({ id: task.id, title: String(task.title ?? ''), due: task.due ?? null, done: Boolean(task.done) })))
    setImporting(row)
  }

  function openTasks(requirementId) {
    navigate?.('tasks', { scope: 'all', requirementId })
  }

  async function confirmImport(body) {
    if (!importing || operationLock.current || importConflict || importDeleted || importLinkedTasks.length > 0
      || Boolean(importing.importedAt) || (Array.isArray(importing.importedTaskIds) && importing.importedTaskIds.length > 0)) return
    operationLock.current = true
    setBusy(true)
    setImportError('')
    let saved = savedImport
    try {
      if (!saved) {
        await api.importRequirement(importing.id, body)
        saved = true
        setSavedImport(true)
      }
      await refresh?.()
      notify?.('需求已导入待办')
      const id = importing.id
      setImporting(null)
      openTasks(id)
    } catch (error) {
      if (saved) {
        const message = `待办已保存，但列表刷新失败。点击「重新加载待办」重试：${String(error?.message ?? error)}`
        setImportError(message)
        notify?.(message, 'error')
      } else if (error?.status === 409) {
        setImportConflict(true)
        setConflictError(String(error?.message ?? error))
        setImportDeleted(false)
        setReloadError('')
        const message = '需求导入遇到服务端冲突。请重新载入并预览后再继续。'
        notify?.(message, 'error')
      } else if (error?.status === 404) {
        setImportConflict(false)
        setConflictError('')
        setImportDeleted(true)
        setImportLinkedTasks([])
        setReloadError('')
        notify?.('这条需求已被删除，无法继续导入。', 'error')
      } else {
        const message = String(error?.message ?? error)
        setImportError(message)
        notify?.(message, 'error')
      }
    } finally {
      operationLock.current = false
      setBusy(false)
    }
  }

  async function reloadLatestRequirement() {
    if (!importing || operationLock.current) return
    operationLock.current = true
    setBusy(true)
    setReloadError('')
    try {
      const latest = await api.getRequirementImportContext(importing.id)
      if (!latest.record) {
        setImportConflict(false)
        setConflictError('')
        setImportDeleted(true)
        setImportLinkedTasks([])
        setImportError('')
        return
      }

      setImporting(latest.record)
      setImportLinkedTasks(latest.linkedTasks)
      setImportGeneration(generation => generation + 1)
      setImportConflict(false)
      setConflictError('')
      setImportDeleted(false)
      setSavedImport(false)
      setImportError('')
      setReloadError('')
    } catch (error) {
      // GET /state returning 404 is a failed reload, not proof that the
      // requirement is missing. Only a valid state without this id means deleted.
      setReloadError(String(error?.message ?? error))
    } finally {
      operationLock.current = false
      setBusy(false)
    }
  }

  async function viewExistingTasks() {
    if (!importing || operationLock.current) return
    operationLock.current = true
    setBusy(true)
    setViewTasksError('')
    try {
      await refresh?.()
      const requirementId = importing.id
      setImporting(null)
      openTasks(requirementId)
    } catch (error) {
      setViewTasksError(String(error?.message ?? error))
    } finally {
      operationLock.current = false
      setBusy(false)
    }
  }

  return <div className="req-workspace" data-module="requirements" data-testid="req-workspace">
    <div className="req-workspace-toolbar">
      <div className="segmented" role="group" aria-label="需求工作区">
        <button type="button" className={`segmented-item ${view === 'chat' ? 'is-active' : ''}`} data-testid="req-chat-tab" aria-pressed={view === 'chat'} onClick={() => setView('chat')}>需求对话</button>
        <button type="button" className={`segmented-item ${view === 'records' ? 'is-active' : ''}`} data-testid="req-records-tab" aria-pressed={view === 'records'} onClick={() => setView('records')}><IconRequirements size={15} />需求记录 · {data?.requirements?.length ?? 0}</button>
      </div>
      <div className="req-workspace-actions">
        <button type="button" className="btn btn-sm" data-testid="req-trace-by-id" onClick={() => setTraceLookupOpen(true)}>按 ID 追踪</button>
        <button type="button" className="btn btn-sm" data-testid="req-open-tasks" onClick={() => openTasks()}><IconTasks size={15} />待办列表</button>
      </div>
    </div>
    <div className="req-conversation-host" hidden={view !== 'chat'}>
      <RequirementsChat data={data} themeMode={themeMode} stepsMode={parseTranscriptViewMode(prefs?.transcriptView)} onRefresh={refresh} onImport={openImport} onOpenTasks={openTasks} />
    </div>
    {view === 'records' && <div className="req-records-host"><Records {...props} mutate={mutate} onImport={openImport} initialSelectedId={navigationTarget?.selectedId ?? ''} /></div>}
    {importing && <ImportDialog
      key={`${importing.id}:${importing.updatedAt ?? ''}:${importGeneration}`}
      row={importing}
      busy={busy}
      saved={savedImport}
      conflict={importConflict}
      conflictError={conflictError}
      deleted={importDeleted}
      linkedTasks={importLinkedTasks}
      error={importError}
      reloadError={reloadError}
      viewTasksError={viewTasksError}
      onClose={() => { if (!busy && !operationLock.current) setImporting(null) }}
      onConfirm={confirmImport}
      onReloadLatest={reloadLatestRequirement}
      onViewExistingTasks={viewExistingTasks}
    />}
    {traceLookupOpen && <TraceDrawer requirementId="" onClose={() => setTraceLookupOpen(false)} onChanged={() => refresh?.()} />}
  </div>
}
