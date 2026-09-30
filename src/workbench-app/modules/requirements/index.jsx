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
  const [traceLookupOpen, setTraceLookupOpen] = useState(false)
  const importLock = useRef(false)

  useEffect(() => {
    setView(navigationTarget?.selectedId ? 'records' : 'chat')
  }, [navigationTarget])

  function openImport(row) {
    setImportError('')
    setSavedImport(false)
    setImporting(row)
  }

  function openTasks(requirementId) {
    navigate?.('tasks', { scope: 'all', requirementId })
  }

  async function confirmImport(body) {
    if (!importing || importLock.current) return
    importLock.current = true
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
      const message = saved
        ? `待办已保存，但列表刷新失败。点击「重新加载待办」重试：${String(error?.message ?? error)}`
        : String(error?.message ?? error)
      setImportError(message)
      notify?.(message, 'error')
    } finally {
      importLock.current = false
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
    {importing && <ImportDialog key={importing.id} row={importing} busy={busy} saved={savedImport} error={importError} onClose={() => { if (!busy) setImporting(null) }} onConfirm={confirmImport} />}
    {traceLookupOpen && <TraceDrawer requirementId="" onClose={() => setTraceLookupOpen(false)} onChanged={() => refresh?.()} />}
  </div>
}
