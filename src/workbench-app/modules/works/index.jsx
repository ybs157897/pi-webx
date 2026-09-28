/** 工作规划对话和真实排期共用 works 数据，旧看板/列表保留为工作清单。 */
import { useEffect, useState } from 'react'
import { parseTranscriptViewMode } from '../../../lib/transcript/presentation'
import { api } from '../../api.mjs'
import WorksChat from './WorksChat.jsx'
import Agenda from './Agenda.jsx'
import Records from './Records.jsx'
import './Planning.css'

export default function Works(props) {
  const { data, refresh, mutate, themeMode, prefs, navigationTarget } = props
  const [view, setView] = useState('planning')
  const [mobileView, setMobileView] = useState('chat')
  const [editId, setEditId] = useState(null)
  const [pending, setPending] = useState('')
  const works = Array.isArray(data?.works) ? data.works : []

  useEffect(() => { setView('planning'); setEditId(null) }, [navigationTarget])

  function editWork(work) {
    setEditId(work.id)
    setView('records')
  }

  async function complete(work) {
    if (pending) return
    setPending(work.id)
    try { await mutate?.(() => api.patchRecord('works', work.id, { status: work.status === 'done' ? 'todo' : 'done' }), work.status === 'done' ? '工作已恢复待办' : '工作已完成') }
    finally { setPending('') }
  }

  return <div className="works-planner" data-module="works" data-testid="works-planner">
    <div className="works-planner-toolbar">
      <div className="segmented" role="group" aria-label="工作助理视图">
        <button type="button" className={`segmented-item ${view === 'planning' ? 'is-active' : ''}`} data-testid="works-planning-tab" aria-pressed={view === 'planning'} onClick={() => setView('planning')}>规划工作</button>
        <button type="button" className={`segmented-item ${view === 'records' ? 'is-active' : ''}`} data-testid="works-records-tab" aria-pressed={view === 'records'} onClick={() => { setEditId(null); setView('records') }}>工作清单 · {works.length}</button>
      </div>
      <span className="works-time-hint">按本机时间安排工作</span>
    </div>
    <div className="works-planning-surface" data-testid="works-planning-surface" data-mobile-view={mobileView} hidden={view !== 'planning'}>
      <div className="works-mobile-tabs" role="group" aria-label="规划内容">
        <button className="btn btn-sm" type="button" aria-pressed={mobileView === 'chat'} data-testid="works-mobile-chat" onClick={() => setMobileView('chat')}>对话规划</button>
        <button className="btn btn-sm" type="button" aria-pressed={mobileView === 'agenda'} data-testid="works-mobile-agenda" onClick={() => setMobileView('agenda')}>查看安排</button>
      </div>
      <WorksChat themeMode={themeMode} stepsMode={parseTranscriptViewMode(prefs?.transcriptView)} onRefresh={refresh} />
      <Agenda works={works} onEdit={editWork} onComplete={complete} pending={pending} />
    </div>
    {view === 'records' && <div className="works-records-host"><Records {...props} initialEditId={editId} /></div>}
  </div>
}
