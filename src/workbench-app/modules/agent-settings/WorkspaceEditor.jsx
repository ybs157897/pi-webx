import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../../lib/api'

export default function WorkspaceEditor({ workspace, workspacePath, workspaceDefaultPath, disabled, error, onChange }) {
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState('')
  const requestRef = useRef(null)
  const generationRef = useRef(0)
  const currentRef = useRef({ workspace, disabled })
  currentRef.current = { workspace, disabled }

  function invalidate() {
    generationRef.current += 1
    requestRef.current?.abort()
    requestRef.current = null
    setPicking(false)
  }

  useEffect(() => {
    invalidate()
    return () => {
      generationRef.current += 1
      requestRef.current?.abort()
    }
  }, [workspace, disabled])

  function useDefault() {
    invalidate()
    setPickError('')
    if (workspace !== null) onChange(null)
  }

  async function pickFolder() {
    if (disabled || picking) return
    const controller = new AbortController()
    const generation = ++generationRef.current
    const sourceWorkspace = workspace
    requestRef.current = controller
    setPicking(true)
    setPickError('')
    try {
      const result = await api.pickDirectory(workspace || workspacePath || workspaceDefaultPath, controller.signal)
      if (generation !== generationRef.current || controller.signal.aborted || currentRef.current.disabled
        || currentRef.current.workspace !== sourceWorkspace) return
      if (result?.path === null) return
      if (typeof result?.path !== 'string' || !result.path.trim()) throw new Error('未收到有效的文件夹路径，请重试。')
      onChange(result.path)
    } catch (pickFailure) {
      if (generation !== generationRef.current || controller.signal.aborted) return
      setPickError(pickFailure instanceof ApiError && pickFailure.status === 501
        ? '当前系统不支持选择文件夹。'
        : pickFailure.message || '选择文件夹失败，请重试。')
    } finally {
      if (generation === generationRef.current) {
        requestRef.current = null
        setPicking(false)
      }
    }
  }

  return <section className="agent-settings-section" data-testid="agent-settings-workspace-section">
    <h2 className="agent-settings-section-title">工作区</h2>
    <p className="small muted">每个 Agent 使用独立目录。工作区变更仅对新对话生效，已有对话保留原工作区。</p>
    <fieldset className="agent-settings-workspace-modes" aria-label="工作区目录来源">
      <label className={workspace === null ? 'is-active' : ''}>
        <input type="radio" name="agent-settings-workspace-mode" checked={workspace === null}
          disabled={disabled} onChange={useDefault} data-testid="agent-settings-workspace-default" />
        <span>使用独立默认目录</span>
      </label>
      <label className={workspace !== null ? 'is-active' : ''}>
        <input type="radio" name="agent-settings-workspace-mode" checked={workspace !== null}
          disabled={disabled || picking} onChange={pickFolder} data-testid="agent-settings-workspace-custom" />
        <span>选择已有目录</span>
      </label>
    </fieldset>
    <label className="field agent-settings-workspace-field" htmlFor="agent-settings-workspace-path">
      <span className="field-label">已选文件夹</span>
      <input id="agent-settings-workspace-path" className="input" type="text"
        value={workspace ?? workspaceDefaultPath} readOnly aria-invalid={Boolean(error)}
        aria-describedby={error ? 'agent-settings-workspace-error' : 'agent-settings-workspace-hint'}
        data-testid="agent-settings-workspace-path" />
    </label>
    <div className="agent-settings-inline-actions">
      <button type="button" className="btn" disabled={disabled || picking} onClick={pickFolder}
        data-testid="agent-settings-workspace-pick">{picking ? '选择中…' : workspace === null ? '选择文件夹' : '更换文件夹'}</button>
      {picking && <button type="button" className="btn" onClick={invalidate}
        data-testid="agent-settings-workspace-cancel">取消选择</button>}
    </div>
    <p id="agent-settings-workspace-hint" className="small muted">通过系统文件夹选择器绑定已有目录；不同 Agent 可以绑定同一个目录，例如需求与代码共享一个项目工作区。</p>
    {picking && <p role="status">等待系统文件夹选择…</p>}
    {pickError && <p className="agent-settings-field-error" role="alert" data-testid="agent-settings-workspace-pick-error">{pickError}</p>}
    {error && <p id="agent-settings-workspace-error" className="agent-settings-field-error" role="alert">{error}</p>}
    <div className="agent-settings-workspace-effective" data-testid="agent-settings-workspace-effective">
      <span className="small muted">当前生效目录</span><code>{workspacePath || workspaceDefaultPath}</code>
    </div>
    {workspace !== null && <div className="agent-settings-workspace-effective">
      <span className="small muted">独立默认目录</span><code>{workspaceDefaultPath}</code>
    </div>}
  </section>
}
