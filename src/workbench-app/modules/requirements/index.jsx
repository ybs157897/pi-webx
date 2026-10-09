/**
 * 需求工作区：与代码开发同款双列——左列画布主区（画布 / 记录互斥切换），右列需求对话常驻。
 * 需求记录与待办导入仍由本模块持有，画布是对话与记录的第三个投影视图。
 * 窄屏收单列，「画布 / 需求对话」两个切换按钮换列（对话始终挂载，会话不因换列中断）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api.mjs'
import { api as piApi } from '../../../lib/api'
import { parseTranscriptViewMode } from '../../../lib/transcript/presentation'
import { IconRequirements, IconTasks } from '../../icons.jsx'
import RequirementsChat from './RequirementsChat.jsx'
import RequirementCanvas from './Canvas.jsx'
import Records from './Records.jsx'
import ImportDialog from './ImportDialog.jsx'
import TraceDrawer from './TraceDrawer.jsx'
import { dispatchedRequirementIds } from './model.jsx'
import './Conversation.css'

export default function Requirements(props) {
  const { data, mutate, notify, refresh, navigate, navigationTarget, themeMode, prefs } = props
  // 主区收敛为画布 / 记录两态，画布默认；从待办等入口带 selectedId 进来时直接落记录主区。
  const [mainView, setMainView] = useState(navigationTarget?.selectedId ? 'records' : 'canvas')
  // 记录一旦进过就保持挂载（hidden 切换），搜索与选中不因切回画布丢失——与 codes 的记录宿主同法。
  const [recordsVisited, setRecordsVisited] = useState(Boolean(navigationTarget?.selectedId))
  const [mobileView, setMobileView] = useState('canvas')
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
  // 对话把转写与会话 id 送上来（onTranscript）：画布要按会话过滤本会话产物，画布按钮要算未导入草稿。
  const [transcriptProjection, setTranscriptProjection] = useState(null)
  // 绑定工作区路径（Agent 配置的 workspace），工具栏副标题回显——与 codes 的项目路径同法。
  const [workspacePath, setWorkspacePath] = useState('')
  const operationLock = useRef(false)

  useEffect(() => {
    let active = true
    piApi.moduleAgents()
      .then(({ agents }) => { if (active) setWorkspacePath(agents.find(item => item.id === 'requirements')?.workspace ?? '') })
      .catch(() => { /* 拉不到就保持 fallback 文案，不打断工作区 */ })
    return () => { active = false }
  }, [])

  const handleTranscript = useCallback(projection => {
    setTranscriptProjection(current => current?.transcript === projection.transcript && current?.sessionId === projection.sessionId
      ? current : projection)
  }, [])

  const canvasEntries = transcriptProjection?.transcript?.entries
  const canvasSessionId = transcriptProjection?.sessionId ?? null
  // 末级目录名：副标题只展示这一层（deepseek-harness），完整路径在 title 悬停里。
  const workspaceName = workspacePath ? (workspacePath.split('/').filter(Boolean).pop() ?? workspacePath) : ''
  const canvasRecords = useMemo(() => (data?.requirements ?? [])
    .filter(row => canvasSessionId && row.sourceSessionId === canvasSessionId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), [data?.requirements, canvasSessionId])
  const pendingDrafts = canvasRecords.filter(row => !row.importedAt).length

  useEffect(() => {
    const next = navigationTarget?.selectedId ? 'records' : 'canvas'
    if (next === 'records') setRecordsVisited(true)
    setMainView(next)
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

  return <section className="req-workspace" data-module="requirements" data-testid="req-workspace" data-mobile-view={mobileView}>
    <div className="req-mobile-tabs" role="group" aria-label="需求工作区视图">
      <button type="button" className="btn btn-sm" data-testid="req-show-canvas" aria-pressed={mobileView === 'canvas'} onClick={() => setMobileView('canvas')}>画布</button>
      <button type="button" className="btn btn-sm" data-testid="req-show-chat" aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}>需求对话</button>
    </div>
    <div className="req-workspace-left">
      <header className="req-workspace-toolbar">
        <div className="req-workspace-title">
          <strong>需求画布</strong>
          {/* 副标题只显示末级目录名；完整路径放 title 悬停。 */}
          <span title={workspacePath || undefined} data-testid="req-workspace-root">{workspaceName || '需求 Agent 配置中的工作区'}</span>
        </div>
        <div className="segmented" role="group" aria-label="需求主区">
          <button type="button" className={`segmented-item ${mainView === 'canvas' ? 'is-active' : ''}`} data-testid="req-canvas-tab" aria-pressed={mainView === 'canvas'} onClick={() => setMainView('canvas')}>需求画布{pendingDrafts > 0 ? ` · ${pendingDrafts}` : ''}</button>
          <button type="button" className={`segmented-item ${mainView === 'records' ? 'is-active' : ''}`} data-testid="req-records-tab" aria-pressed={mainView === 'records'} onClick={() => { setRecordsVisited(true); setMainView('records') }}><IconRequirements size={15} />需求记录 · {data?.requirements?.length ?? 0}</button>
        </div>
        <div className="req-workspace-actions">
          <button type="button" className="btn btn-sm" data-testid="req-trace-by-id" onClick={() => setTraceLookupOpen(true)}>按 ID 追踪</button>
          <button type="button" className="btn btn-sm" data-testid="req-open-tasks" onClick={() => openTasks()}><IconTasks size={15} />待办列表</button>
        </div>
      </header>
      {mainView === 'canvas' && <RequirementCanvas
        entries={canvasEntries}
        records={canvasRecords}
        dispatchedIds={dispatchedRequirementIds(canvasEntries, canvasRecords)}
        busy={busy}
        onImport={openImport}
        onOpenTasks={openTasks}
      />}
      {recordsVisited && <div className="req-records-host" hidden={mainView !== 'records'}>
        <Records {...props} mutate={mutate} onImport={openImport} initialSelectedId={navigationTarget?.selectedId ?? ''} />
      </div>}
    </div>
    <aside className="req-chat-column" data-testid="req-chat-column" aria-label="需求助手对话">
      <RequirementsChat themeMode={themeMode} stepsMode={parseTranscriptViewMode(prefs?.transcriptView)} onRefresh={refresh} onTranscript={handleTranscript} />
    </aside>
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
  </section>
}
