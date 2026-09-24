/**
 * 日志查询：对话框式检索（关键词 / 级别 / 来源 / 日期区间）与记录，
 * 结果按日期倒序分组浏览，可删除。条件只在点「查询」时生效。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Logs
 */

import { useId, useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Chip, ConfirmDialog, Empty, Field, FormModal, IconButton, Modal } from '../ui.jsx'
import { IconLogs, IconPlus, IconTrash } from '../icons.jsx'
import { byDateDesc, formatDay, relativeDay, todayISO } from '../util.mjs'

const TEXT = {
  list: '日志记录',
  query: '查询日志',
  queryTitle: '查询日志',
  record: '记录日志',
  recordTitle: '记录日志',
  filterTitle: '当前条件',
  keyword: '关键词',
  searchPlaceholder: '按关键词搜索内容或来源…',
  level: '级别',
  source: '来源',
  sourceHint: '可留空，比如「pi-webx」',
  from: '开始日期',
  to: '结束日期',
  reset: '重置',
  hits: '命中',
  clearFilter: '清除条件',
  filterAll: '全部',
  empty: '没有匹配的日志',
  emptyHint: '换个关键词或级别，或先记录一条',
  delete: '删除',
  deleteConfirm: '删除日志',
  deleteMessage: '确定删除这条日志？删除后无法恢复。',
  content: '内容',
  contentPlaceholder: '发生了什么、改了什么、结论是什么',
  date: '日期',
  submit: '记录',
  added: '已记录',
  deleted: '日志已删除',
  needContent: '先写点内容',
}

const LEVEL_OPTIONS = [
  { value: 'info', label: '信息', tone: '' },
  { value: 'warn', label: '警告', tone: 'warn' },
  { value: 'error', label: '错误', tone: 'danger' },
]

const FILTERS = [{ value: 'all', label: TEXT.filterAll }, ...LEVEL_OPTIONS]

/** 空查询条件：`level: 'all'` 与空串都表示「不筛」。 */
const EMPTY_QUERY = { keyword: '', level: 'all', source: '', from: '', to: '' }

function levelOf(value) {
  return LEVEL_OPTIONS.find(option => option.value === value) ?? LEVEL_OPTIONS[0]
}

export default function Logs({ data, mutate, notify }) {
  const today = todayISO()
  const [draft, setDraft] = useState({ text: '', level: 'info', source: '', date: today })
  const [queryDraft, setQueryDraft] = useState(EMPTY_QUERY)
  const [applied, setApplied] = useState(EMPTY_QUERY)
  const [queryOpen, setQueryOpen] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const queryFormId = useId()

  /**
   * 关键词同时匹配内容与来源、来源按小写包含、日期为闭区间（空边界忽略），
   * 命中后再按日期倒序分组。
   */
  const { matched, groups } = useMemo(() => {
    const keyword = applied.keyword.trim().toLowerCase()
    const source = applied.source.trim().toLowerCase()
    const matched = data.logs.filter(log => {
      if (applied.level !== 'all' && log.level !== applied.level) return false
      if (keyword !== '' && !(log.text.toLowerCase().includes(keyword) || log.source.toLowerCase().includes(keyword))) return false
      if (source !== '' && !log.source.toLowerCase().includes(source)) return false
      if (applied.from !== '' && log.date < applied.from) return false
      if (applied.to !== '' && log.date > applied.to) return false
      return true
    })
    const buckets = new Map()
    for (const log of [...matched].sort(byDateDesc(log => log.date))) {
      const bucket = buckets.get(log.date)
      if (bucket === undefined) buckets.set(log.date, [log])
      else bucket.push(log)
    }
    return { matched, groups: [...buckets.entries()].map(([key, logs]) => ({ key, logs })) }
  }, [data.logs, applied])

  const hasFilter = applied.keyword !== ''
    || applied.level !== 'all'
    || applied.source !== ''
    || applied.from !== ''
    || applied.to !== ''

  function applyQuery(event) {
    event.preventDefault()
    setApplied(queryDraft)
    setQueryOpen(false)
  }

  function resetDraft() {
    setQueryDraft(EMPTY_QUERY)
  }

  function clearFilter() {
    setApplied(EMPTY_QUERY)
    setQueryDraft(EMPTY_QUERY)
  }

  async function submitRecord() {
    const text = draft.text.trim()
    if (text === '') {
      notify(TEXT.needContent, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.addRecord('logs', { text, level: draft.level, source: draft.source.trim(), date: draft.date }),
      TEXT.added,
    )
    setBusy(false)
    // 只清空内容与来源，级别与日期保留：连续补记同一天同一来源的日志更省事。
    if (ok) {
      setDraft(current => ({ ...current, text: '', source: '' }))
      setRecordOpen(false)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('logs', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  return (
    <>
      <Card
        title={TEXT.list}
        action={(
          <>
            <button type="button" className="btn" data-testid="logs-query-open" onClick={() => setQueryOpen(true)}>
              <IconLogs size={16} /> {TEXT.query}
            </button>
            <button type="button" className="btn btn-primary" data-testid="logs-record-open" onClick={() => setRecordOpen(true)}>
              <IconPlus size={16} /> {TEXT.record}
            </button>
          </>
        )}
      >
        {hasFilter && (
          <div className="filter-bar" data-testid="logs-filter-bar">
            <span className="small muted">{TEXT.filterTitle}</span>
            {applied.keyword !== '' && <Chip>{TEXT.keyword} {applied.keyword}</Chip>}
            {applied.level !== 'all' && <Chip tone={levelOf(applied.level).tone}>{levelOf(applied.level).label}</Chip>}
            {applied.source !== '' && <Chip>#{applied.source}</Chip>}
            {(applied.from !== '' || applied.to !== '') && <Chip>{applied.from || '…'} – {applied.to || '…'}</Chip>}
            <span className="chip accent" data-testid="logs-hit-count">{TEXT.hits} {matched.length}</span>
            <button type="button" className="btn btn-sm" data-testid="logs-clear-filter" onClick={clearFilter}>{TEXT.clearFilter}</button>
          </div>
        )}

        {groups.length === 0
          ? <div data-testid="logs-empty"><Empty icon={<IconLogs size={22} />} title={TEXT.empty} hint={TEXT.emptyHint} /></div>
          : groups.map(group => (
            <div key={group.key} data-testid="logs-group">
              <div className="group-head">
                <span>{formatDay(group.key)}</span>
                {group.key === today && <Chip tone="accent">今天</Chip>}
                <span className="group-count">{group.logs.length}</span>
              </div>
              <ul className="list" data-testid="logs-list">
                {group.logs.map(log => {
                  const level = levelOf(log.level)
                  return (
                    <li className="list-item" data-testid="logs-item" key={log.id}>
                      <div className="item-main">
                        <p className="item-title">{log.text}</p>
                        <div className="item-meta">
                          <Chip tone={level.tone}>{level.label}</Chip>
                          {log.source !== '' && <Chip>#{log.source}</Chip>}
                          <span>{relativeDay(log.date, today)}</span>
                        </div>
                      </div>
                      <div className="item-actions">
                        <IconButton label={TEXT.delete} tone="danger" onClick={() => setPendingDelete(log)}>
                          <IconTrash size={16} />
                        </IconButton>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
      </Card>

      <Modal
        wide
        open={queryOpen}
        title={TEXT.queryTitle}
        onClose={() => setQueryOpen(false)}
        footer={(
          <>
            <button type="button" className="btn" data-testid="logs-query-reset" onClick={resetDraft}>{TEXT.reset}</button>
            <button type="submit" form={queryFormId} className="btn btn-primary" data-testid="logs-query-submit">{TEXT.query}</button>
          </>
        )}
      >
        <form id={queryFormId} className="form" data-testid="logs-query-form" onSubmit={applyQuery}>
          <Field label={TEXT.keyword}>
            <input
              className="input"
              data-testid="logs-query-keyword"
              value={queryDraft.keyword}
              placeholder={TEXT.searchPlaceholder}
              onChange={event => setQueryDraft(current => ({ ...current, keyword: event.target.value }))}
            />
          </Field>
          <div className="form-row">
            <Field label={TEXT.level}>
              <select
                className="select"
                data-testid="logs-query-level"
                value={queryDraft.level}
                onChange={event => setQueryDraft(current => ({ ...current, level: event.target.value }))}
              >
                {FILTERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label={TEXT.source} hint={TEXT.sourceHint}>
              <input
                className="input"
                data-testid="logs-query-source"
                value={queryDraft.source}
                onChange={event => setQueryDraft(current => ({ ...current, source: event.target.value }))}
              />
            </Field>
          </div>
          <div className="form-row">
            <Field label={TEXT.from}>
              <input
                type="date"
                className="input"
                data-testid="logs-query-from"
                value={queryDraft.from}
                onChange={event => setQueryDraft(current => ({ ...current, from: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.to}>
              <input
                type="date"
                className="input"
                data-testid="logs-query-to"
                value={queryDraft.to}
                onChange={event => setQueryDraft(current => ({ ...current, to: event.target.value }))}
              />
            </Field>
          </div>
        </form>
      </Modal>

      <FormModal
        open={recordOpen}
        title={TEXT.recordTitle}
        submitText={TEXT.submit}
        busy={busy}
        onClose={() => setRecordOpen(false)}
        onSubmit={submitRecord}
      >
        <div data-testid="logs-record-form">
          <Field label={TEXT.content}>
            <textarea
              className="textarea"
              data-testid="logs-record-text"
              value={draft.text}
              placeholder={TEXT.contentPlaceholder}
              onChange={event => setDraft(current => ({ ...current, text: event.target.value }))}
            />
          </Field>
          <div className="form-row">
            <Field label={TEXT.level}>
              <select
                className="select"
                data-testid="logs-record-level"
                value={draft.level}
                onChange={event => setDraft(current => ({ ...current, level: event.target.value }))}
              >
                {LEVEL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label={TEXT.source} hint={TEXT.sourceHint}>
              <input
                className="input"
                data-testid="logs-record-source"
                value={draft.source}
                onChange={event => setDraft(current => ({ ...current, source: event.target.value }))}
              />
            </Field>
          </div>
          <Field label={TEXT.date}>
            <input
              type="date"
              className="input"
              data-testid="logs-record-date"
              value={draft.date}
              onChange={event => setDraft(current => ({ ...current, date: event.target.value }))}
            />
          </Field>
        </div>
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : TEXT.deleteMessage}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
