import { Field } from '../../ui.jsx'

export default function ScheduleFields({ form, setForm, busy }) {
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }))
  return <div className="works-schedule-fields" data-testid="works-schedule-fields">
    <Field label="工作日期"><input className="input" type="date" data-testid="works-schedule-date" disabled={busy} value={form.scheduledDate} onChange={event => update('scheduledDate', event.target.value)} /></Field>
    <Field label="开始时间"><input className="input" type="time" data-testid="works-schedule-start" disabled={busy} value={form.startTime} onChange={event => update('startTime', event.target.value)} /></Field>
    <Field label="结束时间"><input className="input" type="time" data-testid="works-schedule-end" disabled={busy} value={form.endTime} onChange={event => update('endTime', event.target.value)} /></Field>
    <div className="works-schedule-help"><span>日期与起止时间一起填写；跨天工作请拆成多个时段。</span><button type="button" className="btn btn-sm" data-testid="works-schedule-clear" disabled={busy} onClick={() => setForm(current => ({ ...current, scheduledDate: '', startTime: '', endTime: '' }))}>清除排期</button></div>
  </div>
}
