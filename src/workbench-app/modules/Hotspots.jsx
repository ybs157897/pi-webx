/**
 * 行业热点：卡片流，置顶钉选、链接可点、可增可删。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Hotspots
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Chip, ConfirmDialog, Empty, Field, FormModal, IconButton } from '../ui.jsx'
import { IconEdit, IconLink, IconPlus, IconStar, IconTrash, IconTrend } from '../icons.jsx'
import { byDateDesc, formatDay, safeUrl, todayISO } from '../util.mjs'

const TEXT = {
  add: '添加热点',
  edit: '编辑热点',
  title: '标题',
  titlePlaceholder: '标题或一句话摘要',
  source: '来源',
  sourcePlaceholder: '公众号 / 网站 / 群聊',
  url: '链接',
  urlHint: '以 http:// 或 https:// 开头才可点击',
  date: '日期',
  note: '备注',
  notePlaceholder: '为什么值得记下来',
  pinned: '置顶',
  save: '保存',
  created: '已添加热点',
  updated: '已更新',
  deleted: '已删除',
  empty: '还没有热点',
  emptyHint: '看到值得留意的消息，就记一张卡片下来',
  summary: '条热点，其中置顶',
  openLink: '打开链接',
  pin: '置顶',
  unpin: '取消置顶',
  deleteConfirm: '删除热点',
  deleteMessage: '确定删除这张卡片？删除后无法恢复。',
  needTitle: '先写标题',
}

/** 新增与编辑共用同一组字段，避免两处表单漂移。 */
function HotspotFields({ value, onChange }) {
  const update = patch => onChange({ ...value, ...patch })
  return (
    <>
      <Field label={TEXT.title}>
        <input
          className="input"
          value={value.title}
          placeholder={TEXT.titlePlaceholder}
          onChange={event => update({ title: event.target.value })}
        />
      </Field>
      <div className="form-row">
        <Field label={TEXT.source}>
          <input
            className="input"
            value={value.source}
            placeholder={TEXT.sourcePlaceholder}
            onChange={event => update({ source: event.target.value })}
          />
        </Field>
        <Field label={TEXT.date}>
          <input
            type="date"
            className="input"
            value={value.date}
            onChange={event => update({ date: event.target.value })}
          />
        </Field>
      </div>
      <Field label={TEXT.url} hint={TEXT.urlHint}>
        <input
          className="input"
          value={value.url}
          placeholder="https://"
          onChange={event => update({ url: event.target.value })}
        />
      </Field>
      <Field label={TEXT.note}>
        <textarea
          className="textarea"
          value={value.note}
          placeholder={TEXT.notePlaceholder}
          onChange={event => update({ note: event.target.value })}
        />
      </Field>
      <label className="row small" style={{ gap: '8px' }}>
        <input
          type="checkbox"
          className="check"
          checked={value.pinned === true}
          onChange={event => update({ pinned: event.target.checked })}
        />
        {TEXT.pinned}
      </label>
    </>
  )
}

export default function Hotspots({ data, mutate, notify }) {
  const today = todayISO()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ title: '', source: '', url: '', note: '', date: today, pinned: false })

  const items = useMemo(() => [...data.hotspots].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned === true ? -1 : 1
    return byDateDesc(item => item.date)(a, b)
  }), [data.hotspots])

  const pinnedCount = data.hotspots.filter(item => item.pinned === true).length

  async function submitAdd() {
    if (draft.title.trim() === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(() => api.addRecord('hotspots', { ...draft, title: draft.title.trim(), date: draft.date === '' ? today : draft.date }), TEXT.created)
    setBusy(false)
    if (ok) {
      setAdding(false)
      setDraft({ title: '', source: '', url: '', note: '', date: today, pinned: false })
    }
  }

  async function submitEdit() {
    if (editing.title.trim() === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('hotspots', editing.id, {
        title: editing.title.trim(),
        source: editing.source,
        url: editing.url,
        note: editing.note,
        date: editing.date === '' ? today : editing.date,
        pinned: editing.pinned === true,
      }),
      TEXT.updated,
    )
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('hotspots', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  function togglePin(item) {
    return mutate(
      () => api.patchRecord('hotspots', item.id, { pinned: item.pinned !== true }),
      item.pinned === true ? '已取消置顶' : '已置顶',
    )
  }

  return (
    <>
      <div className="row-between">
        <p className="small muted">{items.length} {TEXT.summary} {pinnedCount} 条</p>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          <IconPlus size={15} /> {TEXT.add}
        </button>
      </div>

      {items.length === 0
        ? (
          <Card>
            <Empty
              icon={<IconTrend size={22} />}
              title={TEXT.empty}
              hint={TEXT.emptyHint}
              action={<button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>{TEXT.add}</button>}
            />
          </Card>
        )
        : (
          <div className="hot-grid">
            {items.map(item => {
              const href = safeUrl(item.url)
              return (
                <article className={`hot-card ${item.pinned === true ? 'is-pinned' : ''}`} key={item.id}>
                  <div className="row-between">
                    <span className="row-wrap" style={{ gap: '6px' }}>
                      {item.pinned === true && <Chip tone="warn">{TEXT.pinned}</Chip>}
                      {item.source !== '' && <Chip>{item.source}</Chip>}
                    </span>
                    <span className="tiny muted">{formatDay(item.date)}</span>
                  </div>
                  <h3 className="hot-title break">
                    {href === ''
                      ? item.title
                      : <a href={href} target="_blank" rel="noreferrer noopener">{item.title}</a>}
                  </h3>
                  {item.note !== '' && <p className="hot-note">{item.note}</p>}
                  <div className="hot-foot">
                    <IconButton
                      label={item.pinned === true ? TEXT.unpin : TEXT.pin}
                      className={item.pinned === true ? 'is-on' : ''}
                      onClick={() => togglePin(item)}
                    >
                      <IconStar size={16} />
                    </IconButton>
                    {href !== '' && (
                      <IconButton label={TEXT.openLink} onClick={() => window.open(href, '_blank', 'noopener')}>
                        <IconLink size={16} />
                      </IconButton>
                    )}
                    <span className="grow" />
                    <IconButton label={TEXT.edit} onClick={() => setEditing({ ...item })}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label="删除" tone="danger" onClick={() => setPendingDelete(item)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </div>
                </article>
              )
            })}
          </div>
        )}

      <FormModal open={adding} title={TEXT.add} submitText={TEXT.save} busy={busy} onClose={() => setAdding(false)} onSubmit={submitAdd}>
        <HotspotFields value={draft} onChange={setDraft} />
      </FormModal>

      <FormModal open={editing !== null} title={TEXT.edit} submitText={TEXT.save} busy={busy} onClose={() => setEditing(null)} onSubmit={submitEdit}>
        {editing !== null && <HotspotFields value={editing} onChange={setEditing} />}
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${pendingDelete.title}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
