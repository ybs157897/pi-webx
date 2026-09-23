/**
 * 每日复盘：按日期的记录列表 + 当天表单（收获 / 教训 / 心情 1-5 / 明日打算）。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Reviews
 */

import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, ConfirmDialog, Empty, Field, FieldGroup, Stat } from '../ui.jsx'
import { IconReview, IconTrash } from '../icons.jsx'
import { byDateDesc, formatDay, moodEmoji, moodLabel, relativeDay, sumBy, todayISO } from '../util.mjs'

const TEXT = {
  list: '复盘记录',
  form: '今日复盘',
  date: '日期',
  today: '回到今天',
  wins: '收获',
  winsPlaceholder: '今天做成了什么、什么让你开心',
  lessons: '教训',
  lessonsPlaceholder: '哪里可以做得更好',
  mood: '心情',
  tomorrow: '明日打算',
  tomorrowPlaceholder: '明天最重要的一件事',
  save: '保存复盘',
  saved: '复盘已保存',
  deleted: '复盘已删除',
  delete: '删除这条复盘',
  deleteMessage: '确定删除这条复盘？删除后无法恢复。',
  empty: '还没有复盘记录',
  emptyHint: '每天睡前花两分钟，写三行就够',
  emptyDayHint: '写下今天的三行，明天的你会感谢自己',
  needWins: '至少写一句「收获」',
  count: '已记录',
  average: '平均心情',
  days: '天',
  editing: '正在编辑',
  savedMark: '已保存',
}

const MOODS = [1, 2, 3, 4, 5]

const blank = () => ({ wins: '', lessons: '', mood: 4, tomorrow: '' })

export default function Reviews({ data, mutate, notify }) {
  const today = todayISO()
  const [selected, setSelected] = useState(today)
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const records = useMemo(() => [...data.reviews].sort(byDateDesc(row => row.date)), [data.reviews])
  const current = records.find(row => row.date === selected)
  const currentId = current === undefined ? '' : current.id

  // 只在「换了一天」或「这天的记录从无到有 / 换了另一条」时重填表单。
  // 依赖项刻意用记录 id 而不是整条记录：AI 面板也会刷新 state，
  // 若按记录对象重填，用户正在写的草稿会被一次无关的刷新清空。
  useEffect(() => {
    setForm(current === undefined
      ? blank()
      : { wins: current.wins, lessons: current.lessons, mood: current.mood, tomorrow: current.tomorrow })
  }, [selected, currentId])

  const stats = useMemo(() => ({
    count: records.length,
    average: records.length === 0 ? 0 : sumBy(records, row => row.mood) / records.length,
  }), [records])

  async function save() {
    if (form.wins.trim() === '') {
      notify(TEXT.needWins, 'warn')
      return
    }
    setBusy(true)
    await (current === undefined
      ? mutate(() => api.addRecord('reviews', { ...form, wins: form.wins.trim(), date: selected }), TEXT.saved)
      : mutate(() => api.patchRecord('reviews', current.id, { ...form, wins: form.wins.trim() }), TEXT.saved))
    setBusy(false)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('reviews', current.id), TEXT.deleted)
    setBusy(false)
    if (ok) setConfirming(false)
  }

  return (
    <>
      <div className="grid grid-3">
        <Stat icon={<IconReview size={15} />} label={TEXT.count} value={stats.count} unit={TEXT.days} tone="accent" />
        <Stat icon={<IconReview size={15} />} label={TEXT.average} value={stats.count === 0 ? '—' : stats.average.toFixed(1)} unit={stats.count === 0 ? '' : '/ 5'} />
        <Stat
          icon={<IconReview size={15} />}
          label={TEXT.date}
          value={relativeDay(selected, today)}
          hint={formatDay(selected, 'full')}
        />
      </div>

      <div className="review-grid">
        <Card
          title={TEXT.list}
          subtitle={`共 ${records.length} 天`}
          action={selected !== today
            ? <button type="button" className="btn btn-sm" onClick={() => setSelected(today)}>{TEXT.today}</button>
            : undefined}
        >
          <div className="row" style={{ marginBottom: '10px' }}>
            <input
              type="date"
              className="input"
              value={selected}
              aria-label={TEXT.date}
              onChange={event => setSelected(event.target.value === '' ? today : event.target.value)}
            />
          </div>
          {records.length === 0
            ? <Empty icon={<IconReview size={22} />} title={TEXT.empty} hint={TEXT.emptyHint} />
            : (
              <ul>
                {records.map(record => (
                  <li key={record.id}>
                    <button
                      type="button"
                      className={`review-item ${record.date === selected ? 'is-active' : ''}`}
                      onClick={() => setSelected(record.date)}
                    >
                      <span className="review-emoji" aria-hidden="true">{moodEmoji(record.mood)}</span>
                      <span className="grow">
                        <span className="review-date">{formatDay(record.date)} · {relativeDay(record.date, today)}</span>
                        <span className="review-wins">{record.wins}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </Card>

        <Card
          title={TEXT.form}
          subtitle={`${formatDay(selected, 'full')}${current === undefined ? '' : ` · ${TEXT.savedMark}`}`}
          action={current === undefined
            ? undefined
            : (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirming(true)}>
                <IconTrash size={15} /> 删除
              </button>
            )}
        >
          <form
            className="form"
            onSubmit={event => {
              event.preventDefault()
              save()
            }}
          >
            <Field label={TEXT.wins}>
              <textarea
                className="textarea"
                value={form.wins}
                placeholder={TEXT.winsPlaceholder}
                onChange={event => setForm(current => ({ ...current, wins: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.lessons}>
              <textarea
                className="textarea"
                value={form.lessons}
                placeholder={TEXT.lessonsPlaceholder}
                onChange={event => setForm(current => ({ ...current, lessons: event.target.value }))}
              />
            </Field>
            <FieldGroup label={TEXT.mood}>
              <div className="mood-picker">
                {MOODS.map(mood => (
                  <button
                    key={mood}
                    type="button"
                    className={`mood-option ${form.mood === mood ? 'is-active' : ''}`}
                    aria-label={`心情 ${mood} 分：${moodLabel(mood)}`}
                    aria-pressed={form.mood === mood}
                    title={moodLabel(mood)}
                    onClick={() => setForm(current => ({ ...current, mood }))}
                  >
                    {moodEmoji(mood)}
                  </button>
                ))}
              </div>
            </FieldGroup>
            <Field label={TEXT.tomorrow}>
              <textarea
                className="textarea"
                value={form.tomorrow}
                placeholder={TEXT.tomorrowPlaceholder}
                onChange={event => setForm(current => ({ ...current, tomorrow: event.target.value }))}
              />
            </Field>
            <div className="row-between">
              <p className="small muted">
                {current === undefined ? TEXT.emptyDayHint : TEXT.editing}
              </p>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? '保存中…' : TEXT.save}
              </button>
            </div>
          </form>
        </Card>
      </div>

      <ConfirmDialog
        open={confirming}
        title={TEXT.delete}
        message={TEXT.deleteMessage}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
