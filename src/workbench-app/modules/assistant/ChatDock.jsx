import { IconPanel } from '../../icons.jsx'

export function AssistantChatToggle({ buttonRef, open, pendingCount, controls, onClick }) {
  return <button ref={buttonRef} type="button" className="btn btn-sm assistant-chat-toggle" data-testid="assistant-chat-toggle" aria-expanded={open} aria-controls={controls} onClick={onClick}>
    <IconPanel size={16} />{open ? '收起对话' : '展开对话'}
    {pendingCount > 0 && <span className="assistant-pending-count" data-testid="assistant-chat-pending-count">{pendingCount} 待确认</span>}
  </button>
}

/** Hiding the dock keeps the Agent mounted, including its stream and unsent draft. */
export default function AssistantChatDock({ id, open, children, dockRef, onHide }) {
  return <aside id={id} ref={dockRef} className="assistant-chat-dock" data-testid="assistant-chat-dock" aria-label="助理对话侧栏" hidden={!open} inert={!open}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.target.closest('[role="dialog"]')) return
      event.stopPropagation()
      onHide?.()
    }}>
    {children}
  </aside>
}
