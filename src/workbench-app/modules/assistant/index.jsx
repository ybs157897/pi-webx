/**
 * 我的助理：一份待办、今天的安排，加一段常驻会话，三者共用同一个 Agent 与同一份数据。
 *
 * 内容列与对话列同屏：左列是「今天 / 待办」两个页签（各自的组件仍是 modules/today 与
 * modules/tasks，壳层只做页签、计数与导航），右列是 AssistantChat——对话列由 App 以
 * `chat` 节点注入，与其它模块走同一条注入路径。页签保留 tablist/tab 语义与
 * ←→/Home/End 键盘导航。
 * ≤640px 一次只显示一列，靠 `data-mobile-view` 切换；对话列里的「待确认」细条通过
 * `AssistantMobileView` 把用户切回对话视图。
 * @module modules/assistant
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { todayISO } from '../../util.mjs'
import Tasks from '../tasks/index.jsx'
import Today from '../today/index.jsx'
import { AssistantMobileView } from './mobile-view.jsx'
import './Assistant.css'

/** 稳定空数组：data.tasks 缺席时不让 useMemo 每次重算。 */
const NO_TASKS = []

function requestedView(target) { return target?.view === 'tasks' ? 'tasks' : 'today' }

export default function AssistantWorkspace({ chat, navigationTarget, data, ...props }) {
  const [view, setView] = useState(() => requestedView(navigationTarget))
  const [taskTarget, setTaskTarget] = useState(() => (navigationTarget?.view === 'tasks' ? navigationTarget : null))
  const [mobileView, setMobileView] = useState('items')
  const tabIds = useId()
  const todayTab = useRef(null)
  const tasksTab = useRef(null)
  const tasks = Array.isArray(data?.tasks) ? data.tasks : NO_TASKS
  const today = todayISO()
  // 两个徽章与页签内容是同一份数据的两面：今天 = 当天未完成，待办 = 未完成总数。
  const counts = useMemo(() => ({
    today: tasks.filter(task => task.plannedDate === today && task.done !== true).length,
    open: tasks.filter(task => task.done !== true).length,
  }), [tasks, today])
  const mobile = useMemo(() => ({ showChat: () => setMobileView('chat') }), [])

  // 外部跳转（数据模块回链、命令面板、底部 tab）改视图；本地切页签清掉外部定位。
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

  return <AssistantMobileView.Provider value={mobile}>
    <div className="assistant-workspace" data-testid="assistant-workspace" data-mobile-view={mobileView}>
      <div className="assistant-mobile-tabs" role="group" aria-label="我的助理视图">
        <button type="button" className="btn btn-sm" data-testid="assistant-mobile-items" aria-pressed={mobileView === 'items'} onClick={() => setMobileView('items')}>事项</button>
        <button type="button" className="btn btn-sm" data-testid="assistant-mobile-chat" aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}>对话</button>
      </div>
      <div className="assistant-items" data-testid="assistant-items">
        <div className="assistant-tabs" role="tablist" aria-label="我的助理内容">
          <button ref={todayTab} id={`${tabIds}-today`} type="button" role="tab" className="assistant-tab" data-testid="assistant-tab-today" aria-selected={view === 'today'} aria-controls={`${tabIds}-panel`} tabIndex={view === 'today' ? 0 : -1} onClick={() => select('today')} onKeyDown={onTabKeyDown}>
            今天<span className="assistant-tab-count">{counts.today}</span>
          </button>
          <button ref={tasksTab} id={`${tabIds}-tasks`} type="button" role="tab" className="assistant-tab" data-testid="assistant-tab-tasks" aria-selected={view === 'tasks'} aria-controls={`${tabIds}-panel`} tabIndex={view === 'tasks' ? 0 : -1} onClick={() => select('tasks')} onKeyDown={onTabKeyDown}>
            待办<span className="assistant-tab-count">{counts.open}</span>
          </button>
        </div>
        <div id={`${tabIds}-panel`} className="assistant-panel" role="tabpanel" data-testid="assistant-panel" aria-labelledby={`${tabIds}-${view}`} tabIndex={0}>
          {view === 'today' ? <Today {...props} data={data} onShowTasks={() => select('tasks')} /> : <Tasks {...props} data={data} navigationTarget={taskTarget} />}
        </div>
      </div>
      {chat}
    </div>
  </AssistantMobileView.Provider>
}
