/**
 * 饮食记录：今日热量总览 + 近 7 天热量柱状图 + 按餐次分组的明细（增删改）。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Meals
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Chip, ConfirmDialog, Empty, Field, FormModal, IconButton, Stat } from '../ui.jsx'
import { BarChart, CHART_COLORS } from '../charts.jsx'
import { IconEdit, IconMeal, IconPlus, IconTrash } from '../icons.jsx'
import { byDateDesc, formatDay, lastNDays, numberText, sumBy, todayISO } from '../util.mjs'

const TEXT = {
  todayCalories: '今日热量',
  todayCount: '今日记录',
  average: '近 7 天日均',
  kcal: 'kcal',
  meals: '餐',
  chart: '近 7 天热量',
  chartUnit: '千卡',
  chartEmpty: '还没有饮食记录，吃点什么记一笔',
  detail: '餐次明细',
  add: '添加记录',
  edit: '编辑记录',
  meal: '餐次',
  food: '吃了什么',
  foodPlaceholder: '比如：鸡胸肉沙拉',
  calories: '热量（kcal）',
  date: '日期',
  note: '备注',
  save: '保存',
  created: '已记下这一餐',
  updated: '记录已更新',
  deleted: '记录已删除',
  empty: '这一天还没有记录',
  emptyHint: '点右上角「添加记录」记下吃了什么',
  deleteConfirm: '删除记录',
  deleteMessage: '确定删除这条饮食记录？',
  subtotal: '小计',
  needFood: '先写下吃了什么',
  needCalories: '热量要填非负数字',
  todayButton: '回到今天',
}

/** 餐次顺序即分组顺序。 */
const MEALS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
]

const blank = () => ({ meal: 'breakfast', food: '', calories: '', date: todayISO(), note: '' })

/** 新增与编辑共用字段。 */
function RecordFields({ value, onChange }) {
  const update = patch => onChange({ ...value, ...patch })
  return (
    <>
      <div className="form-row">
        <Field label={TEXT.meal}>
          <select className="select" value={value.meal} onChange={event => update({ meal: event.target.value })}>
            {MEALS.map(meal => <option key={meal.value} value={meal.value}>{meal.label}</option>)}
          </select>
        </Field>
        <Field label={TEXT.calories}>
          <input type="number" min="0" step="1" className="input" value={value.calories} onChange={event => update({ calories: event.target.value })} />
        </Field>
      </div>
      <Field label={TEXT.food}>
        <input className="input" value={value.food} placeholder={TEXT.foodPlaceholder} onChange={event => update({ food: event.target.value })} />
      </Field>
      <Field label={TEXT.date}>
        <input type="date" className="input" value={value.date} onChange={event => update({ date: event.target.value })} />
      </Field>
      <Field label={TEXT.note}>
        <textarea className="textarea" value={value.note} onChange={event => update({ note: event.target.value })} />
      </Field>
    </>
  )
}

export default function Meals({ data, mutate, notify }) {
  const today = todayISO()
  const [viewDate, setViewDate] = useState(today)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(blank)

  const view = useMemo(() => {
    const week = lastNDays(7, today)
    const byDay = new Map()
    for (const row of data.meals) {
      byDay.set(row.date, (byDay.get(row.date) ?? 0) + Number(row.calories))
    }
    const dayRows = data.meals.filter(row => row.date === viewDate).sort(byDateDesc(row => row.calories))
    const weekRows = data.meals.filter(row => week.includes(row.date))
    return {
      todayCalories: byDay.get(today) ?? 0,
      todayCount: data.meals.filter(row => row.date === today).length,
      average: weekRows.length === 0 ? 0 : Math.round(sumBy(weekRows, row => row.calories) / 7),
      bars: week.map(day => ({ label: formatDay(day, 'day'), value: byDay.get(day) ?? 0 })),
      groups: MEALS.map(meal => ({
        ...meal,
        rows: dayRows.filter(row => row.meal === meal.value),
        total: sumBy(dayRows.filter(row => row.meal === meal.value), row => row.calories),
      })),
      dayTotal: sumBy(dayRows, row => row.calories),
    }
  }, [data.meals, today, viewDate])

  /** 校验数字字段后交给服务端（热量是非负数）。 */
  function fieldsOf(value) {
    const calories = Number(value.calories)
    if (value.food.trim() === '') {
      notify(TEXT.needFood, 'warn')
      return null
    }
    if (!Number.isFinite(calories) || calories < 0) {
      notify(TEXT.needCalories, 'warn')
      return null
    }
    return { meal: value.meal, food: value.food.trim(), calories, date: value.date === '' ? today : value.date, note: value.note }
  }

  async function submitAdd() {
    const fields = fieldsOf(draft)
    if (fields === null) return
    setBusy(true)
    const ok = await mutate(() => api.addRecord('meals', fields), TEXT.created)
    setBusy(false)
    if (ok) {
      setAdding(false)
      setDraft(blank())
      setViewDate(fields.date)
    }
  }

  async function submitEdit() {
    const fields = fieldsOf(editing)
    if (fields === null) return
    setBusy(true)
    const ok = await mutate(() => api.patchRecord('meals', editing.id, fields), TEXT.updated)
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('meals', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <div className="grid grid-3">
        <Stat icon={<IconMeal size={15} />} label={TEXT.todayCalories} value={numberText(view.todayCalories)} unit={TEXT.kcal} tone="accent" />
        <Stat icon={<IconMeal size={15} />} label={TEXT.todayCount} value={view.todayCount} unit={TEXT.meals} />
        <Stat icon={<IconMeal size={15} />} label={TEXT.average} value={numberText(view.average)} unit={TEXT.kcal} hint="按近 7 天摊平" />
      </div>

      <Card title={TEXT.chart} subtitle={TEXT.kcal}>
        <BarChart bars={view.bars} unit={TEXT.chartUnit} color={CHART_COLORS[2]} empty={TEXT.chartEmpty} />
      </Card>

      <Card
        title={TEXT.detail}
        subtitle={`${formatDay(viewDate, 'full')} · 合计 ${numberText(view.dayTotal)} ${TEXT.kcal}`}
        action={(
          <div className="row-wrap" style={{ gap: '6px' }}>
            <input
              type="date"
              className="input"
              style={{ width: '150px' }}
              value={viewDate}
              aria-label={TEXT.date}
              onChange={event => setViewDate(event.target.value === '' ? today : event.target.value)}
            />
            {viewDate !== today && (
              <button type="button" className="btn btn-sm" onClick={() => setViewDate(today)}>{TEXT.todayButton}</button>
            )}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <IconPlus size={15} /> {TEXT.add}
            </button>
          </div>
        )}
      >
        {/* 这一天一条记录都没有时给一句空状态，而不是摆四段「没有记录」。 */}
        {view.dayTotal === 0
          ? <Empty icon={<IconMeal size={22} />} title={TEXT.empty} hint={TEXT.emptyHint} />
          : view.groups.map(group => (
            <div key={group.value}>
              <div className="group-head">
                <span>{group.label}</span>
                <span className="group-count">{group.rows.length} {TEXT.meals} · {TEXT.subtotal} {numberText(group.total)} {TEXT.kcal}</span>
              </div>
              {group.rows.length === 0
                ? <p className="small muted" style={{ padding: '2px 2px 8px' }}>没有记录</p>
                : (
                  <ul className="list">
                    {group.rows.map(row => (
                      <li className="list-item" key={row.id}>
                        <div className="item-main">
                          <p className="item-title">{row.food}</p>
                          <div className="item-meta">
                            <Chip tone="warn">{row.calories} {TEXT.kcal}</Chip>
                            {row.date !== today && <span>{formatDay(row.date)}</span>}
                          </div>
                          {row.note !== '' && <p className="item-note">{row.note}</p>}
                        </div>
                        <div className="item-actions">
                          <IconButton label={TEXT.edit} onClick={() => setEditing({ ...row, calories: String(row.calories) })}>
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
            </div>
          ))}
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
        message={pendingDelete === null ? '' : `「${pendingDelete.food}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
