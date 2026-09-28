import { useEffect, useRef, useState } from 'react'
import { AgentSettingsActions, AgentSettingsEditor } from './Editor.jsx'
import { useAgentSettings } from './useAgentSettings.js'
import './styles.css'

export function navigationDecision({ saving, dirty, pending }) {
  if (saving || pending) return 'blocked'
  return dirty ? 'confirm' : 'allow'
}

export default function AgentSettingsPage({ registerNavigationGuard, onNavigateConfirmed }) {
  const [id, setId] = useState('logs')
  const [pending, setPending] = useState(null)
  const rootRef = useRef(null)
  const previousFocus = useRef(null)
  const state = useAgentSettings(id)

  useEffect(() => {
    rootRef.current?.querySelector('#agent-settings-module [role="tab"][aria-selected="true"]')?.focus()
  }, [])

  useEffect(() => {
    if (pending) rootRef.current?.querySelector('[data-testid="agent-settings-keep-editing"]')?.focus()
  }, [pending])

  useEffect(() => registerNavigationGuard?.(nextId => {
    const decision = navigationDecision({ saving: state.isSaving(), dirty: state.dirty, pending })
    if (decision === 'confirm') {
      previousFocus.current = typeof document === 'undefined' ? null : document.activeElement
      setPending({ kind: 'navigate', id: nextId })
    }
    return decision === 'allow'
  }), [registerNavigationGuard, state.dirty, state.isSaving, pending])

  useEffect(() => {
    if (typeof window === 'undefined' || (!state.dirty && !state.saving)) return undefined
    const warn = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state.dirty, state.saving])

  function requestModule(nextId) {
    if (nextId === id) return
    const decision = navigationDecision({ saving: state.isSaving(), dirty: state.dirty, pending })
    if (decision === 'blocked') return
    if (decision === 'confirm') {
      previousFocus.current = typeof document === 'undefined' ? null : document.activeElement
      setPending({ kind: 'switch', id: nextId })
    } else setId(nextId)
  }

  function cancelPending() {
    setPending(null)
    if (typeof document !== 'undefined') {
      const focusTarget = previousFocus.current
      requestAnimationFrame(() => {
        if (focusTarget?.isConnected) focusTarget.focus()
        else rootRef.current?.querySelector('#agent-settings-module [role="tab"][aria-selected="true"]')?.focus()
      })
    }
  }

  function confirmPending() {
    if (!pending || state.isSaving()) return
    if (pending.kind === 'switch') setId(pending.id)
    else onNavigateConfirmed?.(pending.id)
    setPending(null)
  }

  return (
    <section className="agent-settings-page" data-module="agent-settings" data-testid="agent-settings-page" ref={rootRef}>
      <div className="agent-settings-form">
        <AgentSettingsEditor id={id} {...state} pending={pending}
          onModuleChange={requestModule} onEdit={state.edit} onReload={state.reload}
          onConfirmPending={confirmPending} onCancelPending={cancelPending} />
        {state.view && state.draft && <AgentSettingsActions dirty={state.dirty} saving={state.saving}
          pending={pending} onSave={state.save} />}
      </div>
    </section>
  )
}
