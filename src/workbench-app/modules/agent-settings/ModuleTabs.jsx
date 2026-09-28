import { useRef } from 'react'
import { AGENT_MODULES } from './draft'

export default function ModuleTabs({ id, disabled, onChange }) {
  const ref = useRef(null)

  function onKeyDown(event) {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const current = AGENT_MODULES.findIndex(module => module.id === id)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? AGENT_MODULES.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + AGENT_MODULES.length) % AGENT_MODULES.length
    const nextId = AGENT_MODULES[next].id
    ref.current?.querySelector(`[data-agent-id="${nextId}"]`)?.focus()
    onChange(nextId)
  }

  return <div className="agent-settings-module-tabs" id="agent-settings-module" data-testid="agent-settings-module"
    role="tablist" aria-label="模块 Agent" onKeyDown={onKeyDown} ref={ref}>
    {AGENT_MODULES.map(module => <button key={module.id} type="button" role="tab" data-testid="agent-settings-tab"
      data-agent-id={module.id} id={`agent-settings-tab-${module.id}`}
      aria-controls="agent-settings-module-panel" aria-selected={module.id === id}
      tabIndex={module.id === id ? 0 : -1} disabled={disabled}
      className={`agent-settings-module-tab ${module.id === id ? 'is-active' : ''}`}
      onClick={() => onChange(module.id)}>
      <strong>{module.label}</strong><span>{module.description}</span>
    </button>)}
  </div>
}
