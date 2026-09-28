import { useEffect, useRef, useState } from 'react'
import { agentSettingsApi } from './api'

export default function PromptEditor({ id, prompt, model, disabled, error, onChange }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [proposal, setProposal] = useState(null)
  const requestRef = useRef(null)
  const sequenceRef = useRef(0)

  function invalidate() {
    sequenceRef.current += 1
    requestRef.current?.abort()
    requestRef.current = null
    setBusy(false)
    setProposal(null)
    setFailure('')
  }

  useEffect(() => {
    invalidate()
    return () => {
      sequenceRef.current += 1
      requestRef.current?.abort()
    }
  }, [id, prompt, model?.provider, model?.id])

  async function polish() {
    if (!prompt.trim() || busy) return
    const controller = new AbortController()
    const sequence = ++sequenceRef.current
    const original = prompt
    requestRef.current = controller
    setBusy(true)
    setProposal(null)
    setFailure('')
    try {
      const revised = await agentSettingsApi.polish(id, original, model, controller.signal)
      if (sequence === sequenceRef.current && !controller.signal.aborted) {
        setProposal({ original, revised })
      }
    } catch (requestError) {
      if (sequence === sequenceRef.current && !controller.signal.aborted)
        setFailure(requestError.message || '润色失败，请重试。')
    } finally {
      if (sequence === sequenceRef.current) {
        requestRef.current = null
        setBusy(false)
      }
    }
  }

  return <section className="agent-settings-section" data-testid="agent-settings-prompt-section">
    <div className="agent-settings-section-heading">
      <label className="agent-settings-section-title" htmlFor="agent-settings-prompt">系统提示词</label>
      <button type="button" className="btn" disabled={disabled || busy || !prompt.trim()}
        onClick={polish} data-testid="agent-settings-polish">{busy ? '润色中…' : 'AI 润色'}</button>
    </div>
    <textarea id="agent-settings-prompt" className="textarea agent-settings-prompt" value={prompt}
      disabled={disabled} aria-invalid={Boolean(error)}
      aria-describedby={error ? 'agent-settings-prompt-error' : undefined}
      onChange={event => { invalidate(); onChange(event.target.value) }}
      data-testid="agent-settings-prompt" />
    {error && <p id="agent-settings-prompt-error" className="agent-settings-field-error" role="alert">{error}</p>}
    {busy && <div className="agent-settings-inline-status" role="status">
      <span>正在润色提示词…</span>
      <button type="button" className="btn" onClick={invalidate} data-testid="agent-settings-polish-cancel">取消</button>
    </div>}
    {failure && <p className="agent-settings-field-error" role="alert" data-testid="agent-settings-polish-error">{failure}</p>}
    {proposal && <div className="agent-settings-proposal" data-testid="agent-settings-polish-preview">
      <p className="small muted">请检查润色结果，应用后仍需保存配置。</p>
      <div className="agent-settings-proposal-grid">
        <div><h3>原提示词</h3><pre>{proposal.original}</pre></div>
        <div><h3>润色建议</h3><pre>{proposal.revised}</pre></div>
      </div>
      <div className="agent-settings-inline-actions">
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => {
          onChange(proposal.revised); invalidate()
        }} data-testid="agent-settings-polish-apply">应用润色</button>
        <button type="button" className="btn" onClick={invalidate} data-testid="agent-settings-polish-discard">放弃建议</button>
      </div>
    </div>}
  </section>
}
