/**
 * 运动打卡：今日/本周总览 + 近 14 天分钟折线图 + 记录列表（增删改）。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Exercises
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Chip, ConfirmDialog, Empty, Field, FormModal, IconButton, Stat } from '../ui.jsx'
import { LineChart } from '../charts.jsx'
import { IconEdit, IconFlame, IconPlus, IconRun, IconTrash } from '../icons.jsx'
import { byDateDesc, formatDay, lastNDays, numberText, streakDays, sumBy, todayISO } from '../util.mjs'

const TEXT = {
  today: '今日运动',
  week: '本周运动',
  weekDays: '本周打卡',
  streak: '连续打卡',
  minutes: '分钟',
  days: '天',
  chart: '近 14 天运动分钟',
  chartEmpty: '还没有运动记录，今天动一动？',
  list: '打卡记录',
  add: '添加记录',
  edit: '编辑记录',
  type: '运动类型',
  typePlaceholder: '跑步 / 游泳 / 力量训练',
  minutesLabel: '时长（分钟）',
  date: '日期',
  note: '备注',
  save: '保存',
  created: '已打卡，继续保持',
  updated: '记录已更新',
  deleted: '记录已删除',
  empty: '还没有打卡记录',
  emptyHint: '今天动了多久？记一笔，图表就长出来了',
  deleteConfirm: '删除记录',
  deleteMessage: '确定删除这条运动记录？',
  needType: '先写下运动类型',
  needMinutes: '分钟数要大于 0',
}

const blank = () => ({ type: '', minutes: '', date: todayISO(), note: '' })

/** 新增与编辑共用字段。 */
function RecordFields({ value, onChange }) {
  const update = patch => onChange({ ...value, ...patch })
  return (
    <>
      <Field label={TEXT.type}>
        <input className="input" value={value.type} placeholder={TEXT.typePlaceholder} onChange={event => update({ type: event.target.value })} />
      </Field>
      <div className="form-row">
        <Field label={TEXT.minutesLabel}>
          <input type="number" min="1" step="1" className="input" value={value.minutes} onChange={event => update({ minutes: event.target.value })} />
        </Field>
        <Field label={TEXT.date}>
          <input type="date" className="input" value={value.date} onChange={event => update({ date: event.target.value })} />
        </Field>
      </div>
      <Field label={TEXT.note}>
        <textarea className="textarea" value={value.note} onChange={event => update({ note: event.target.value })} />
      </Field>
    </>
  )
}

export default function Exercises({ data, mutate, notify }) {
  const today = todayISO()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(blank)

  const view = useMemo(() => {
    const week = lastNDays(7, today)
    const byDay = new Map()
    for (const row of data.exercises) {
      byDay.set(row.date, (byDay.get(row.date) ?? 0) + Number(row.minutes))
    }
    return {
      todayMinutes: byDay.get(today) ?? 0,
      weekMinutes: sumBy(data.exercises.filter(row => week.includes(row.date)), row => row.minutes),
      weekDays: week.filter(day => byDay.has(day)).length,
      streak: streakDays([...byDay.keys()], today),
      points: lastNDays(14, today).map(day => ({ label: formatDay(day, 'day'), value: byDay.get(day) ?? 0 })),
      records: [...data.exercises].sort(byDateDesc(row => row.date)),
    }
  }, [data.exercises, today])

  /** 校验数字字段后交给服务端（分钟数是正数，schema 会再校验一次）。 */
  function fieldsOf(value) {
    const minutes = Number(value.minutes)
    if (value.type.trim() === '') {
      notify(TEXT.needType, 'warn')
      return null
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      notify(TEXT.needMinutes, 'warn')
      return null
    }
    return { type: value.type.trim(), minutes, date: value.date === '' ? today : value.date, note: value.note }
  }

  async function submitAdd() {
    const fields = fieldsOf(draft)
    if (fields === null) return
    setBusy(true)
    const ok = await mutate(() => api.addRecord('exercises', fields), TEXT.created)
    setBusy(false)
    if (ok) {
      setAdding(false)
      setDraft(blank())
    }
  }

  async function submitEdit() {
    const fields = fieldsOf(editing)
    if (fields === null) return
    setBusy(true)
    const ok = await mutate(() => api.patchRecord('exercises', editing.id, fields), TEXT.updated)
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('exercises', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <div className="grid grid-4">
        <Stat icon={<IconRun size={15} />} label={TEXT.today} value={numberText(view.todayMinutes)} unit={TEXT.minutes} tone="accent" />
        <Stat icon={<IconRun size={15} />} label={TEXT.week} value={numberText(view.weekMinutes)} unit={TEXT.minutes} />
        <Stat icon={<IconRun size={15} />} label={TEXT.weekDays} value={view.weekDays} unit={TEXT.days} />
        <Stat icon={<IconFlame size={15} />} label={TEXT.streak} value={view.streak} unit={TEXT.days} tone={view.streak > 0 ? 'ok' : ''} />
      </div>

      <Card title={TEXT.chart} subtitle={TEXT.minutes}>
        <LineChart points={view.points} unit={TEXT.minutes} empty={TEXT.chartEmpty} />
      </Card>

      <Card
        title={TEXT.list}
        subtitle={`共 ${view.records.length} 条`}
        action={(
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <IconPlus size={15} /> {TEXT.add}
          </button>
        )}
      >
        {view.records.length === 0
          ? <Empty icon={<IconRun size={22} />} title={TEXT.empty} hint={TEXT.emptyHint} />
          : (
            <ul className="list">
              {view.records.map(row => (
                <li className="list-item" key={row.id}>
                  <div className="item-main">
                    <p className="item-title">{row.type}</p>
                    <div className="item-meta">
                      <Chip tone="accent">{row.minutes} {TEXT.minutes}</Chip>
                      <span>{formatDay(row.date, 'full')}</span>
                    </div>
                    {row.note !== '' && <p className="item-note">{row.note}</p>}
                  </div>
                  <div className="item-actions">
                    <IconButton label={TEXT.edit} onClick={() => setEditing({ ...row, minutes: String(row.minutes) })}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label="删除" tone="danger" onClick={() => setPendingDelete(row)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>

      <FormModal open={adding} title={TEXT.add} submitText={TEXT.save} busy={busy} onClose={() => setAdding(false)} onSubmit={submitAdd}>
        <RecordFields value={draft} onChange={setDraft} />
      </FormModal>

      <FormModal open={editing !== null} title={TEXT.edit} submitText={TEXT.save} busy={busy} onClose={() => setEditing(null)} onSubmit={submitEdit}>
        {editing !== null && <RecordFields value={editing} onChange={setEditing} />}
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${pendingDelete.type} ${pendingDelete.minutes} ${TEXT.minutes}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
