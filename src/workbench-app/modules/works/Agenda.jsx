import { useMemo, useState } from 'react'
import { scheduleGroups } from './schedule.mjs'
import { todayISO, addDays } from '../../util.mjs'

function dayTitle(date) {
  const today = todayISO()
  const relative = date === today ? '今天' : date === addDays(today, 1) ? '明天' : date < today ? '此前安排' : ''
  return relative ? `${relative} · ${date}` : date
}

export default function Agenda({ works = [], onEdit, onComplete, pending = '' }) {
  const [includeDone, setIncludeDone] = useState(false)
  const { days, unscheduled } = useMemo(() => scheduleGroups(works, includeDone), [works, includeDone])
  const plannedCount = days.reduce((count, group) => count + group.entries.length, 0)
  return <aside className="works-agenda" data-testid="works-agenda" aria-label="工作时间安排">
    <header className="works-agenda-head"><div><h2>工作安排</h2><p>{plannedCount} 项已排期 · {unscheduled.length} 项待安排</p></div>
      <label className="works-agenda-toggle"><input type="checkbox" checked={includeDone} data-testid="works-show-completed" onChange={event => setIncludeDone(event.target.checked)} />已完成</label>
    </header>
    <div className="works-agenda-scroll">
      {days.length === 0 && <div className="works-agenda-empty" data-testid="works-agenda-empty"><strong>把工作放进时间里</strong><p>和助手聊聊目标与空闲时段，保存后的安排会出现在这里。</p></div>}
      {days.map(group => <section className="works-agenda-day" key={group.date} data-testid="works-agenda-day">
        <h3>{dayTitle(group.date)}</h3><ol>
          {group.entries.map(work => <li key={work.id} className={`works-agenda-entry ${work.status === 'done' ? 'is-done' : ''}`} data-testid="works-agenda-entry" data-work-id={work.id}>
            <div className="works-agenda-time"><time>{work.startTime}</time><span>{work.endTime}</span></div>
            <div className="works-agenda-detail"><button type="button" className="works-agenda-title" data-testid="works-agenda-edit" onClick={() => onEdit?.(work)}>{work.title}</button>
              {work.note && <p>{work.note}</p>}
              <button type="button" className="works-agenda-complete" data-testid="works-agenda-complete" disabled={pending !== ''} onClick={() => onComplete?.(work)}>{work.status === 'done' ? '恢复待办' : pending === work.id ? '保存中…' : '标记完成'}</button>
            </div>
          </li>)}
        </ol>
      </section>)}
      {unscheduled.length > 0 && <section className="works-unscheduled" data-testid="works-unscheduled"><h3>待安排</h3><ul>{unscheduled.map(work => <li key={work.id}><button type="button" data-testid="works-unscheduled-edit" onClick={() => onEdit?.(work)}>{work.title}</button></li>)}</ul></section>}
    </div>
  </aside>
}
