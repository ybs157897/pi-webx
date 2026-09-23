/**
 * 本月收支：收入/支出/结余总览 + 本月按日柱状图 + 支出分类环形图 + 流水（增删改）。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Finance
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import {
  Card, Chip, ConfirmDialog, Empty, Field, FieldGroup, FormModal, IconButton, Segmented, Stat,
} from '../ui.jsx'
import { BarChart, CHART_COLORS, DonutChart } from '../charts.jsx'
import { IconEdit, IconPlus, IconTrash, IconWallet } from '../icons.jsx'
import { byDateDesc, currentMonth, formatDay, money, monthDays, numberText, sumBy, todayISO } from '../util.mjs'

const TEXT = {
  income: '本月收入',
  expense: '本月支出',
  balance: '本月结余',
  count: '流水笔数',
  incomeShort: '收入',
  expenseShort: '支出',
  daily: '本月按日',
  dailyUnit: '元',
  dailyEmpty: '这个月还没有流水',
  category: '支出分类占比',
  categoryEmpty: '这个月还没有支出',
  categoryCenter: '支出合计',
  list: '本月流水',
  add: '添加流水',
  edit: '编辑流水',
  kind: '类型',
  amount: '金额（元）',
  categoryLabel: '分类',
  categoryPlaceholder: '餐饮 / 交通 / 工资',
  date: '日期',
  note: '备注',
  save: '保存',
  created: '已记一笔',
  updated: '流水已更新',
  deleted: '流水已删除',
  empty: '这个月还没有流水',
  emptyHint: '点右上角「添加流水」记下第一笔',
  deleteConfirm: '删除流水',
  deleteMessage: '确定删除这条流水？',
  needAmount: '金额要填正数',
  needCategory: '先写下分类',
  thisMonth: '本月',
}

/** 常用分类只做输入建议，具体值仍以用户填写的为准。 */
const CATEGORY_HINTS = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '人情', '学习', '工资', '奖金', '理财', '其他']

const blank = () => ({ kind: 'expense', amount: '', category: '', date: todayISO(), note: '' })

/** 新增与编辑共用字段。 */
function RecordFields({ value, onChange }) {
  const update = patch => onChange({ ...value, ...patch })
  return (
    <>
      <FieldGroup label={TEXT.kind}>
        <Segmented
          label={TEXT.kind}
          value={value.kind}
          onChange={kind => update({ kind })}
          options={[{ value: 'expense', label: TEXT.expenseShort }, { value: 'income', label: TEXT.incomeShort }]}
        />
      </FieldGroup>
      <div className="form-row">
        <Field label={TEXT.amount}>
          <input type="number" min="0" step="0.01" className="input" value={value.amount} onChange={event => update({ amount: event.target.value })} />
        </Field>
        <Field label={TEXT.date}>
          <input type="date" className="input" value={value.date} onChange={event => update({ date: event.target.value })} />
        </Field>
      </div>
      <Field label={TEXT.categoryLabel}>
        <input
          className="input"
          list="finance-categories"
          value={value.category}
          placeholder={TEXT.categoryPlaceholder}
          onChange={event => update({ category: event.target.value })}
        />
      </Field>
      <datalist id="finance-categories">
        {CATEGORY_HINTS.map(name => <option key={name} value={name} />)}
      </datalist>
      <Field label={TEXT.note}>
        <textarea className="textarea" value={value.note} onChange={event => update({ note: event.target.value })} />
      </Field>
    </>
  )
}

export default function Finance({ data, mutate, notify }) {
  const today = todayISO()
  const [viewMonth, setViewMonth] = useState(currentMonth())
  const [metric, setMetric] = useState('expense')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(blank)

  const view = useMemo(() => {
    const rows = data.finance.filter(row => row.date.slice(0, 7) === viewMonth)
    const income = sumBy(rows.filter(row => row.kind === 'income'), row => row.amount)
    const expense = sumBy(rows.filter(row => row.kind === 'expense'), row => row.amount)
    const byDay = new Map()
    for (const row of rows) {
      if (row.kind !== metric) continue
      byDay.set(row.date, (byDay.get(row.date) ?? 0) + Number(row.amount))
    }
    const categories = new Map()
    for (const row of rows) {
      if (row.kind !== 'expense') continue
      categories.set(row.category, (categories.get(row.category) ?? 0) + Number(row.amount))
    }
    return {
      income,
      expense,
      balance: income - expense,
      rows: [...rows].sort(byDateDesc(row => row.date)),
      bars: monthDays(viewMonth).map(day => ({ label: String(Number(day.slice(8))), value: byDay.get(day) ?? 0 })),
      slices: [...categories.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
    }
  }, [data.finance, metric, viewMonth])

  /** 校验数字字段后交给服务端（金额非负）。 */
  function fieldsOf(value) {
    const amount = Number(value.amount)
    if (value.category.trim() === '') {
      notify(TEXT.needCategory, 'warn')
      return null
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      notify(TEXT.needAmount, 'warn')
      return null
    }
    return { kind: value.kind, amount, category: value.category.trim(), date: value.date === '' ? today : value.date, note: value.note }
  }

  async function submitAdd() {
    const fields = fieldsOf(draft)
    if (fields === null) return
    setBusy(true)
    const ok = await mutate(() => api.addRecord('finance', fields), TEXT.created)
    setBusy(false)
    if (ok) {
      setAdding(false)
      setDraft(blank())
      setViewMonth(fields.date.slice(0, 7))
    }
  }

  async function submitEdit() {
    const fields = fieldsOf(editing)
    if (fields === null) return
    setBusy(true)
    const ok = await mutate(() => api.patchRecord('finance', editing.id, fields), TEXT.updated)
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('finance', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <div className="row-between">
        <p className="small muted">{formatDay(`${viewMonth}-01`, 'ym')}的收支情况</p>
        <div className="row-wrap" style={{ gap: '8px' }}>
          <input
            type="month"
            className="input"
            style={{ width: '160px' }}
            value={viewMonth}
            aria-label="查看月份"
            onChange={event => setViewMonth(event.target.value === '' ? currentMonth() : event.target.value)}
          />
          {viewMonth !== currentMonth() && (
            <button type="button" className="btn btn-sm" onClick={() => setViewMonth(currentMonth())}>{TEXT.thisMonth}</button>
          )}
        </div>
      </div>

      <div className="grid grid-4">
        <Stat icon={<IconWallet size={15} />} label={TEXT.income} value={money(view.income)} tone="ok" />
        <Stat icon={<IconWallet size={15} />} label={TEXT.expense} value={money(view.expense)} tone="danger" />
        <Stat icon={<IconWallet size={15} />} label={TEXT.balance} value={money(view.balance)} tone={view.balance >= 0 ? 'ok' : 'danger'} />
        <Stat icon={<IconWallet size={15} />} label={TEXT.count} value={view.rows.length} unit="笔" />
      </div>

      <div className="grid grid-2">
        <Card
          title={TEXT.daily}
          action={(
            <Segmented
              label={TEXT.kind}
              value={metric}
              onChange={setMetric}
              options={[{ value: 'expense', label: TEXT.expenseShort }, { value: 'income', label: TEXT.incomeShort }]}
            />
          )}
        >
          <BarChart
            bars={view.bars}
            unit={TEXT.dailyUnit}
            color={metric === 'expense' ? CHART_COLORS[3] : CHART_COLORS[1]}
            formatValue={value => numberText(value)}
            empty={TEXT.dailyEmpty}
          />
        </Card>
        <Card title={TEXT.category} subtitle={`${formatDay(`${viewMonth}-01`, 'ym')}支出构成`}>
          <DonutChart
            slices={view.slices}
            centerLabel={TEXT.categoryCenter}
            formatValue={value => money(value)}
            empty={TEXT.categoryEmpty}
          />
        </Card>
      </div>

      <Card
        title={TEXT.list}
        subtitle={`${formatDay(`${viewMonth}-01`, 'ym')} · 共 ${view.rows.length} 笔`}
        action={(
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <IconPlus size={15} /> {TEXT.add}
          </button>
        )}
      >
        {view.rows.length === 0
          ? <Empty icon={<IconWallet size={22} />} title={TEXT.empty} hint={TEXT.emptyHint} />
          : (
            <ul className="list">
              {view.rows.map(row => (
                <li className="list-item" key={row.id}>
                  <div className="item-main">
                    <div className="row-between">
                      <p className="item-title">{row.category}</p>
                      <span className={`amount ${row.kind === 'income' ? 'income' : 'expense'}`}>
                        {row.kind === 'income' ? '+' : '−'}{money(row.amount)}
                      </span>
                    </div>
                    <div className="item-meta">
                      <Chip tone={row.kind === 'income' ? 'ok' : 'danger'}>{row.kind === 'income' ? TEXT.incomeShort : TEXT.expenseShort}</Chip>
                      <span>{formatDay(row.date, 'short')}</span>
                      {row.note !== '' && <span className="break">{row.note}</span>}
                    </div>
                  </div>
                  <div className="item-actions">
                    <IconButton label={TEXT.edit} onClick={() => setEditing({ ...row, amount: String(row.amount) })}>
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
        message={pendingDelete === null ? '' : `「${pendingDelete.category} ${money(pendingDelete.amount)}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
