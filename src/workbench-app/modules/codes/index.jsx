import { useCallback, useEffect, useRef, useState } from 'react'
import { parseTranscriptViewMode } from '../../../lib/transcript/presentation'
import Records from './Records.jsx'
import CodeChat from './CodeChat.jsx'
import { readIdeState } from './ide-state.mjs'
import { readConfiguredCodeWorkspace } from './workspace-binding.mjs'
import './Workspace.css'

const EMPTY_IDE = { root: null, path: null, dirty: false, saving: false, workspaceId: null }

/** web-idea owns files and editor state; this module owns the embedded service and chat layout. */
export default function Codes(props) {
  const { notify, refresh, prefs, themeMode, registerNavigationGuard } = props
  const frame = useRef(null)
  const [service, setService] = useState({ phase: 'loading', error: '' })
  const [attempt, setAttempt] = useState(0)
  const [ide, setIde] = useState(EMPTY_IDE)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [recordsVisited, setRecordsVisited] = useState(false)
  const [mobileView, setMobileView] = useState('editor')

  useEffect(() => {
    const abort = new AbortController()
    setService({ phase: 'loading', error: '' })
    fetch('/api/codes/ide/start', { method: 'POST', signal: abort.signal })
      .then(async response => {
        const result = await response.json()
        if (!response.ok || !result.ready) throw new Error(result.error || '编辑器服务暂不可用')
        setService({ phase: 'ready', error: '' })
      })
      .catch(error => {
        if (!abort.signal.aborted) setService({ phase: 'error', error: error.message })
      })
    return () => abort.abort()
  }, [attempt])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const abort = new AbortController()
    const receive = event => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
      if (event.data?.type === 'web-idea:open-request') {
        const { requestId } = event.data
        if (typeof requestId !== 'string') return
        const respond = result => {
          if (!abort.signal.aborted) event.source.postMessage({ type: 'web-idea:open-result', requestId, ...result }, event.origin)
        }
        readConfiguredCodeWorkspace({ signal: abort.signal })
          .then(path => respond({ root: path }))
          .catch(error => respond({ error: error.message }))
        return
      }
      const state = readIdeState(event.data)
      if (state) setIde(state)
    }
    window.addEventListener('message', receive)
    return () => { abort.abort(); window.removeEventListener('message', receive) }
  }, [])

  const guard = useCallback(() => {
    if (!ide.dirty && !ide.saving) return true
    notify?.(ide.saving ? '文件正在保存，请保存完成后切换。' : '文件仍有未保存修改，请先在编辑器中保存。', 'warn')
    return false
  }, [ide.dirty, ide.saving, notify])
  useEffect(() => registerNavigationGuard?.(guard), [guard, registerNavigationGuard])

  return (
    <section className="codes-workspace" data-module="codes" data-testid="codes-workspace" data-mobile-view={mobileView}>
      <div className="codes-mobile-tabs" role="group" aria-label="代码开发视图">
        <button className="btn btn-sm" type="button" data-testid="codes-show-editor" aria-pressed={mobileView === 'editor'} onClick={() => setMobileView('editor')}>编辑器</button>
        <button className="btn btn-sm" type="button" data-testid="codes-show-chat" aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}>代码对话</button>
      </div>
      <div className="codes-workspace-left" data-testid="codes-ide-panel">
        <header className="codes-workspace-toolbar">
          <div className="codes-workspace-title">
            <strong>web-idea</strong>
            <span title={ide.root ?? ''} data-testid="codes-project-root">{ide.root ?? '代码 Agent 配置中的工作区'}</span>
          </div>
          <button className="btn btn-sm" type="button" data-testid="codes-records-toggle" aria-pressed={recordsOpen}
            onClick={() => { setRecordsVisited(true); setRecordsOpen(open => !open) }}>
            {recordsOpen ? '返回编辑器' : '开发事项'}
          </button>
        </header>
        <div className="codes-ide-host" hidden={recordsOpen}>
          {service.phase === 'ready'
            ? <iframe ref={frame} className="codes-ide-frame" title="web-idea 代码编辑器" data-testid="codes-ide-frame" src="/api/codes/ide/" />
            : <div className="codes-service-state" data-testid="codes-ide-state" role="status">
              <strong>{service.phase === 'loading' ? '正在打开代码编辑器…' : '编辑器暂时无法启动'}</strong>
              {service.error && <><p>{service.error}</p><p>首次使用请在 pi-webx 目录运行 <code>npm run setup:web-idea</code>。</p>
                <button className="btn" type="button" data-testid="codes-ide-retry" onClick={() => setAttempt(value => value + 1)}>重试连接</button></>}
            </div>}
        </div>
        {recordsVisited && <div className="codes-records-host" hidden={!recordsOpen} data-testid="codes-records"><Records {...props} /></div>}
      </div>
      <aside className="codes-chat-column" data-testid="codes-chat-panel" aria-label="代码 Agent 对话">
        <CodeChat root={ide.root} themeMode={themeMode} stepsMode={parseTranscriptViewMode(prefs?.transcriptView)} onRefreshData={refresh} />
      </aside>
    </section>
  )
}
