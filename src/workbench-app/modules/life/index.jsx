import { useEffect, useId, useRef, useState } from 'react'
import Tasks from '../tasks/index.jsx'
import Today from '../today/index.jsx'
import './Life.css'

function requestedView(target) { return target?.view === 'tasks' ? 'tasks' : 'today' }

/** One life secretary, with two record views and one conversation kept mounted. */
export default function LifeWorkspace({ chat, navigationTarget, ...props }) {
  const [view, setView] = useState(() => requestedView(navigationTarget))
  const [taskTarget, setTaskTarget] = useState(() => navigationTarget?.view === 'tasks' ? navigationTarget : null)
  const tabIds = useId()
  const todayTab = useRef(null)
  const tasksTab = useRef(null)

  useEffect(() => {
    if (!navigationTarget) return
    setView(requestedView(navigationTarget))
    setTaskTarget(navigationTarget.view === 'tasks' ? navigationTarget : null)
  }, [navigationTarget])

  function select(next, focus = false) {
    setView(next)
    setTaskTarget(null)
    if (focus) (next === 'today' ? todayTab : tasksTab).current?.focus()
  }

  function onTabKeyDown(event) {
    let next
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = view === 'today' ? 'tasks' : 'today'
    else if (event.key === 'Home') next = 'today'
    else if (event.key === 'End') next = 'tasks'
    else return
    event.preventDefault()
    select(next, true)
  }

  return <div className="life-workspace" data-testid="life-workspace">
    <div className="life-items" data-testid="life-items">
      <div className="life-view-tabs" role="tablist" aria-label="生活秘书内容">
        <button ref={todayTab} id={`${tabIds}-today`} type="button" role="tab" data-testid="life-view-today" aria-selected={view === 'today'} aria-controls={`${tabIds}-panel`} tabIndex={view === 'today' ? 0 : -1} onClick={() => select('today')} onKeyDown={onTabKeyDown}>今日规划</button>
        <button ref={tasksTab} id={`${tabIds}-tasks`} type="button" role="tab" data-testid="life-view-tasks" aria-selected={view === 'tasks'} aria-controls={`${tabIds}-panel`} tabIndex={view === 'tasks' ? 0 : -1} onClick={() => select('tasks')} onKeyDown={onTabKeyDown}>我的待办</button>
      </div>
      <div id={`${tabIds}-panel`} className="life-view-panel" role="tabpanel" data-testid="life-view-panel" aria-labelledby={`${tabIds}-${view}`} tabIndex={0}>
        {view === 'today' ? <Today {...props} /> : <Tasks {...props} navigationTarget={taskTarget} />}
      </div>
    </div>
    {chat}
  </div>
}
