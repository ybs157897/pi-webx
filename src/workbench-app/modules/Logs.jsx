/**
 * 日志查询 —— 检索中心：主界面是一张密集的结果表，操作入口只有两个对话框
 * （「查询日志」下条件、「记录日志」落一条）——形态是用户定调过的，必须保留。
 *
 * 表格概念取自 amir20/dozzle 的日志流：最左一条 4px 级别色条（info=accent /
 * warn=warn / error=danger）、时间列（今天只报时刻）、来源 chip、正文两行截断，
 * 点正文展开全文并露出级别 / 标签 / 记录时刻；结果按 `date` + `createdAt` 倒序、
 * 按日分组（今天 / 昨天 / 9月20日）。
 *
 * 条件只有一份 state：工具行的实时搜索、级别 / 来源 chips 与查询对话框写的是同一份
 * 条件，条件条（表格上方）集中展示生效条件、命中数与「清空条件」。过滤全在前端做，
 * 不新增服务端端点；日期与级别一律做「记录自身字段」的判定，不猜时间戳。
 * 写操作一律 `mutate(action, okText)`；props 契约见 App.jsx，本模块用到 `empty` /
 * `onLoadDemo`（首启空库引导）。根元素带 `data-module="logs"`。
 * @module src/modules/Logs
 */

import { Fragment, useId, useMemo, useState } from 'react'
import { api } from '../api.mjs'
import {
  Card, Chip, ChipButton, ConfirmDialog, Empty, Field, FieldGroup, FormModal, IconButton, Modal, Segmented,
} from '../ui.jsx'
import { IconChevronRight, IconLogs, IconPlus, IconSearch, IconTrash } from '../icons.jsx'
import { addDays, formatDay, formatTime, groupBy, relativeDay, todayISO } from '../util.mjs'
import './Logs.css'

const TEXT = {
  list: '日志记录',
  query: '查询日志',
  queryTitle: '查询日志',
  queryHint: '条件只在点「查询」时生效；工具行里的搜索与 chips 改的是同一份条件。',
  record: '记录日志',
  recordTitle: '记录日志',
  recordHint: '内容必填；来源与标签可以留空，之后能按它们检索。',
  keyword: '关键字',
  keywordPlaceholder: '搜内容或来源…',
  keywordLabel: '日志搜索',
  level: '级别',
  levelHint: '可多选；不选表示全部级别',
  source: '来源',
  sourceAll: '全部来源',
  from: '开始日期',
  to: '结束日期',
  range: '日期',
  reset: '重置',
  submitQuery: '查询',
  submitRecord: '记录',
  hits: '命中',
  total: total => `共 ${total} 条`,
  filtered: (hits, total) => `筛选出 ${hits} / ${total} 条`,
  expandHint: '点正文展开全文',
  expand: '展开全文',
  collapse: '收起全文',
  condLabel: '当前条件',
  clearFilter: '清空条件',
  moreSources: '更多来源',
  lessSources: '收起来源',
  time: '时间',
  content: '内容',
  actions: '操作',
  empty: '还没有日志',
  emptyHint: '日志是检索的原料：记下「做了什么、改了什么、结论是什么」',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据，看看检索中心长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  filteredEmpty: '没有匹配的日志',
  filteredEmptyHint: '换个关键字，或放宽级别与日期范围',
  contentPlaceholder: '发生了什么、改了什么、结论是什么',
  date: '日期',
  dateHint: '默认今天',
  tags: '标签',
  tagsPlaceholder: '前端, 数据',
  tagsHint: '用逗号分隔，最多 8 个',
  tagsLimit: '标签最多 8 个',
  sourcePlaceholder: '可留空，比如「pi-webx」',
  recordedAt: '记录于',
  noSource: '无来源',
  delete: '删除',
  deleteConfirm: '删除日志',
  deleteMessage: '确定删除这条日志？删除后无法恢复。',
  deleted: '日志已删除',
  added: '已记录日志',
  needContent: '先写点内容',
  rangeInvalid: '开始日期晚于结束日期',
}

/** 级别：颜色（色条与 chip 同源）、文案、分段控件选项都用这一份。 */
const LEVEL_OPTIONS = [
  { value: 'info', label: '信息', tone: '' },
  { value: 'warn', label: '警告', tone: 'warn' },
  { value: 'error', label: '错误', tone: 'danger' },
]

/** 空条件：`levels` 为空数组与 `source`/`from`/`to` 为空串都表示「不筛」。 */
const EMPTY_FILTERS = { keyword: '', levels: [], source: '', from: '', to: '' }

/** 工具行直接摆几个来源 chip，多出来的折到「更多来源」后面。 */
const SOURCE_LIMIT = 8

/** 标签上限（与其它模块一致）。 */
const TAG_LIMIT = 8

/** 未知级别一律按 info 处理：色条、chip、计数都不会漏样式。 */
function levelOf(value) {
  return LEVEL_OPTIONS.find(option => option.value === value) ?? LEVEL_OPTIONS[0]
}

/** 标签草稿 → 标签数组：中英文逗号都认，去重去空。 */
function parseTags(text) {
  const parts = String(text ?? '').split(/[，,]/)
  return [...new Set(parts.map(part => part.trim()).filter(part => part !== ''))]
}

/** 记录自身字段的倒序：先比 `date`，再比 `createdAt`（缺时间戳的排在当天末尾）。 */
function byRecency(a, b) {
  const left = String(a?.date ?? '')
  const right = String(b?.date ?? '')
  if (left !== right) return left < right ? 1 : -1
  const aStamp = String(a?.createdAt ?? '')
  const bStamp = String(b?.createdAt ?? '')
  if (aStamp === bStamp) return 0
  return aStamp < bStamp ? 1 : -1
}

/** 最近两天（今天 / 昨天）才用相对说法，组头里也顺手补一个完整日期。 */
function isRecent(day, today) {
  return day === today || day === addDays(today, -1)
}

/** 组头文案：今天 / 昨天 / 9月20日 —— 更早的日期直接报日期，不用 relativeDay 的「已过」。 */
function groupLabel(day, today) {
  return isRecent(day, today) ? relativeDay(day, today) : formatDay(day)
}

/** ISO 时间戳 → `09-24 14:05`（本地时区）；缺失或非法返回空串。 */
function stampText(stamp) {
  const time = formatTime(stamp)
  if (time === '') return ''
  const date = new Date(stamp)
  return `${formatDay(todayISO(date), 'md')} ${time}`
}

export default function Logs({ data, mutate, notify, empty = false, onLoadDemo }) {
  const today = todayISO()
  const logs = Array.isArray(data?.logs) ? data.logs : []

  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [queryDraft, setQueryDraft] = useState(EMPTY_FILTERS)
  const [record, setRecord] = useState({ text: '', level: 'info', source: '', date: today, tags: '' })
  const [openId, setOpenId] = useState(null)
  const [allSources, setAllSources] = useState(false)
  const [queryOpen, setQueryOpen] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const queryFormId = useId()

  /** 关键字 / 来源 / 日期围出来的底集：级别计数与结果都从它派生（级别 chip 只筛最后一层）。 */
  const base = useMemo(() => {
    const needle = filters.keyword.trim().toLowerCase()
    return logs.filter(log => {
      // 来源按 trim 后比较：工具行与查询对话框里的取值都来自来源池（已 trim）。
      if (filters.source !== '' && String(log.source ?? '').trim() !== filters.source) return false
      if (filters.from !== '' && String(log.date ?? '') < filters.from) return false
      if (filters.to !== '' && String(log.date ?? '') > filters.to) return false
      if (needle === '') return true
      return `${log.text ?? ''} ${log.source ?? ''}`.toLowerCase().includes(needle)
    })
  }, [logs, filters.keyword, filters.source, filters.from, filters.to])

  const levelCounts = useMemo(() => {
    const counts = { info: 0, warn: 0, error: 0 }
    for (const log of base) counts[levelOf(log.level).value] += 1
    return counts
  }, [base])

  const rows = useMemo(() => base
    .filter(log => filters.levels.length === 0 || filters.levels.includes(levelOf(log.level).value))
    .sort(byRecency), [base, filters.levels])

  /** 分组直接吃已排序的 rows：groupBy 保持插入顺序，所以组也是日期倒序。 */
  const groups = useMemo(
    () => [...groupBy(rows, log => String(log.date ?? '')).entries()]
      .map(([key, items]) => ({ key, items })),
    [rows],
  )

  /** 来源池按出现次数排序；来源是记录自由填写的标签，不预设枚举。 */
  const sourcePool = useMemo(() => {
    const pool = new Map()
    for (const log of logs) {
      const value = String(log.source ?? '').trim()
      if (value === '') continue
      pool.set(value, (pool.get(value) ?? 0) + 1)
    }
    return [...pool.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }))
  }, [logs])

  /** 已选来源始终摆出来，否则被折进「更多来源」的选项没法取消。 */
  const visibleSources = allSources
    ? sourcePool
    : sourcePool.filter((item, index) => index < SOURCE_LIMIT || item.value === filters.source)

  const hasFilter = filters.keyword.trim() !== ''
    || filters.levels.length > 0
    || filters.source !== ''
    || filters.from !== ''
    || filters.to !== ''

  const levels = filters.levels.map(levelOf)

  function toggleLevel(value) {
    setFilters(current => ({
      ...current,
      levels: current.levels.includes(value)
        ? current.levels.filter(item => item !== value)
        : [...current.levels, value],
    }))
  }

  /** 来源 chip 是单选：点已选中的那颗即取消。 */
  function pickSource(value) {
    setFilters(current => ({ ...current, source: current.source === value ? '' : value }))
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS)
  }

  function openQuery() {
    setQueryDraft({ ...filters, levels: [...filters.levels] })
    setQueryOpen(true)
  }

  function submitQuery() {
    if (queryDraft.from !== '' && queryDraft.to !== '' && queryDraft.from > queryDraft.to) {
      notify(TEXT.rangeInvalid, 'warn')
      return
    }
    setFilters({ ...queryDraft, keyword: queryDraft.keyword.trim(), levels: [...queryDraft.levels] })
    setQueryOpen(false)
  }

  function openRecord() {
    setRecord(current => ({ ...current, date: current.date === '' ? today : current.date }))
    setRecordOpen(true)
  }

  async function submitRecord() {
    const text = record.text.trim()
    if (text === '') {
      notify(TEXT.needContent, 'warn')
      return
    }
    const tags = parseTags(record.tags)
    if (tags.length > TAG_LIMIT) {
      notify(TEXT.tagsLimit, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.addRecord('logs', {
        text, level: record.level, source: record.source.trim(), date: record.date, tags,
      }),
      TEXT.added,
    )
    setBusy(false)
    // 只清内容 / 来源 / 标签，级别与日期保留：连续补记同一天的东西更省事。
    if (ok) {
      setRecord(current => ({ ...current, text: '', source: '', tags: '' }))
      setRecordOpen(false)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('logs', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  const headActions = (
    <>
      <button type="button" className="btn" data-testid="logs-query-open" onClick={openQuery}>
        <IconLogs size={16} /> {TEXT.query}
      </button>
      <button type="button" className="btn btn-primary" data-testid="logs-record-open" onClick={openRecord}>
        <IconPlus size={16} /> {TEXT.record}
      </button>
    </>
  )

  return (
    <div className="logs" data-module="logs">
      {logs.length === 0 ? (
        <Card>
          <div data-testid="logs-empty">
            <Empty
              icon={<IconLogs size={22} />}
              title={TEXT.empty}
              hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
              action={(
                <div className="logs-guide-actions">
                  {empty === true && typeof onLoadDemo === 'function' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="logs-load-demo"
                      disabled={demoBusy}
                      onClick={loadDemo}
                    >
                      {demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}
                    </button>
                  )}
                  <button type="button" className="btn" data-testid="logs-record-open-empty" onClick={openRecord}>
                    <IconPlus size={15} />
                    {TEXT.record}
                  </button>
                </div>
              )}
            />
          </div>
        </Card>
      ) : (
        <Card
          title={TEXT.list}
          subtitle={`${hasFilter ? TEXT.filtered(rows.length, logs.length) : TEXT.total(logs.length)} · ${TEXT.expandHint}`}
          action={headActions}
        >
          <div className="logs-toolbar">
            <div className="logs-toolbar-row">
              <label className="logs-search">
                <IconSearch size={15} />
                <input
                  className="logs-search-input"
                  type="search"
                  value={filters.keyword}
                  placeholder={TEXT.keywordPlaceholder}
                  aria-label={TEXT.keywordLabel}
                  onChange={event => setFilters(current => ({ ...current, keyword: event.target.value }))}
                />
              </label>
              <div className="logs-chip-group" role="group" aria-label={TEXT.level} data-testid="logs-level-filter">
                {LEVEL_OPTIONS.map(option => (
                  <ChipButton
                    key={option.value}
                    tone={option.tone}
                    active={filters.levels.includes(option.value)}
                    title={`${option.label} ${levelCounts[option.value]} 条`}
                    onClick={() => toggleLevel(option.value)}
                  >
                    {option.label} {levelCounts[option.value]}
                  </ChipButton>
                ))}
              </div>
            </div>

            {sourcePool.length > 0 && (
              <div className="logs-toolbar-row">
                <span className="logs-chip-label">{TEXT.source}</span>
                <div className="logs-chip-group" role="group" aria-label={TEXT.source} data-testid="logs-source-filter">
                  {visibleSources.map(item => (
                    <ChipButton
                      key={item.value}
                      active={filters.source === item.value}
                      title={`#${item.value} ${item.count} 条`}
                      onClick={() => pickSource(item.value)}
                    >
                      #{item.value} {item.count}
                    </ChipButton>
                  ))}
                </div>
                {sourcePool.length > SOURCE_LIMIT && (
                  <button type="button" className="logs-plain" onClick={() => setAllSources(current => !current)}>
                    {allSources ? TEXT.lessSources : `${TEXT.moreSources} ${sourcePool.length}`}
                  </button>
                )}
              </div>
            )}
          </div>

          {hasFilter && (
            <div className="logs-cond" data-testid="logs-filter-bar">
              <span className="logs-cond-label">{TEXT.condLabel}</span>
              {filters.keyword.trim() !== '' && <Chip>{TEXT.keyword} {filters.keyword.trim()}</Chip>}
              {levels.map(level => <Chip key={level.value} tone={level.tone}>{level.label}</Chip>)}
              {filters.source !== '' && <Chip>#{filters.source}</Chip>}
              {(filters.from !== '' || filters.to !== '') && (
                <Chip>{TEXT.range} {filters.from === '' ? '…' : formatDay(filters.from)} – {filters.to === '' ? '…' : formatDay(filters.to)}</Chip>
              )}
              <span className="chip accent" data-testid="logs-hit-count">{TEXT.hits} {rows.length}</span>
              <button type="button" className="logs-plain" data-testid="logs-clear-filter" onClick={clearFilters}>
                {TEXT.clearFilter}
              </button>
            </div>
          )}

          {rows.length === 0 ? (
            <div data-testid="logs-filtered-empty">
              <Empty
                icon={<IconSearch size={20} />}
                title={TEXT.filteredEmpty}
                hint={TEXT.filteredEmptyHint}
                action={<button type="button" className="btn" onClick={clearFilters}>{TEXT.clearFilter}</button>}
              />
            </div>
          ) : (
            <div className="table logs-table" data-testid="logs-list">
              <div className="table-head">
                <span className="logs-bar-head" aria-hidden="true" />
                <span>{TEXT.time}</span>
                <span>{TEXT.source}</span>
                <span>{TEXT.content}</span>
                <span className="sr-only">{TEXT.actions}</span>
              </div>

              {groups.map(group => (
                <Fragment key={group.key}>
                  <div className="logs-group-head" data-testid="logs-group">
                    <span className="logs-group-label">{groupLabel(group.key, today)}</span>
                    {isRecent(group.key, today) && (
                      <span className="logs-group-date">{formatDay(group.key, 'full')}</span>
                    )}
                    <span className="logs-group-count">{group.items.length}</span>
                  </div>

                  {group.items.map((log, index) => {
                    const level = levelOf(log.level)
                    const tags = Array.isArray(log.tags) ? log.tags : []
                    const source = String(log.source ?? '').trim()
                    const time = formatTime(log.createdAt)
                    const isToday = group.key === today
                    const expanded = openId === log.id
                    const stamp = stampText(log.createdAt)
                    // 组尾行去掉实线，分组之间只留组头那条虚线。
                    const groupEnd = index === group.items.length - 1

                    return (
                      <div
                        className={`table-row logs-row ${expanded ? 'is-open' : ''} ${groupEnd ? 'is-group-end' : ''}`}
                        data-testid="log-row"
                        data-level={level.value}
                        data-date={group.key}
                        key={log.id}
                      >
                        <span className="logs-bar-cell">
                          <span className={`logs-bar ${level.value}`} aria-hidden="true" />
                          <span className="sr-only">{level.label}</span>
                        </span>

                        <time className="logs-time" dateTime={typeof log.createdAt === 'string' ? log.createdAt : undefined}>
                          {isToday && time !== ''
                            ? <span className="logs-time-hm">{time}</span>
                            : <span className="logs-time-day">{isToday ? '今天' : formatDay(group.key)}</span>}
                          {isToday === false && time !== '' && <span className="logs-time-hm">{time}</span>}
                        </time>

                        <span className="logs-source">
                          {source === '' ? <span className="logs-muted">{TEXT.noSource}</span> : (
                            <Chip><span className="logs-source-text">#{source}</span></Chip>
                          )}
                        </span>

                        <div className="logs-text">
                          <button
                            type="button"
                            className="logs-text-btn"
                            aria-expanded={expanded}
                            title={expanded ? TEXT.collapse : TEXT.expand}
                            onClick={() => setOpenId(current => (current === log.id ? null : log.id))}
                          >
                            <span className="logs-text-body">{log.text}</span>
                            <IconChevronRight className="logs-text-caret" size={14} />
                          </button>
                          {expanded && (
                            <div className="logs-detail" data-testid="log-detail">
                              <Chip tone={level.tone}>{level.label}</Chip>
                              {tags.map(tag => <Chip key={tag}>#{tag}</Chip>)}
                              {stamp !== '' && <span className="logs-detail-stamp">{TEXT.recordedAt} {stamp}</span>}
                            </div>
                          )}
                        </div>

                        <span className="logs-actions">
                          <IconButton
                            label={`${TEXT.delete}「${String(log.text ?? '').slice(0, 12)}」`}
                            tone="danger"
                            onClick={() => setPendingDelete(log)}
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        </span>
                      </div>
                    )
                  })}
                </Fragment>
              ))}
            </div>
          )}
        </Card>
      )}

      <Modal
        wide
        open={queryOpen}
        title={TEXT.queryTitle}
        onClose={() => setQueryOpen(false)}
        footer={(
          <>
            <button
              type="button"
              className="btn"
              data-testid="logs-query-reset"
              onClick={() => setQueryDraft(EMPTY_FILTERS)}
            >
              {TEXT.reset}
            </button>
            <button type="submit" form={queryFormId} className="btn btn-primary" data-testid="logs-query-submit">
              {TEXT.submitQuery}
            </button>
          </>
        )}
      >
        <form
          id={queryFormId}
          className="form"
          data-testid="logs-query-form"
          onSubmit={event => {
            event.preventDefault()
            submitQuery()
          }}
        >
          <Field label={TEXT.keyword}>
            <input
              className="input"
              data-testid="logs-query-keyword"
              value={queryDraft.keyword}
              placeholder={TEXT.keywordPlaceholder}
              onChange={event => setQueryDraft(current => ({ ...current, keyword: event.target.value }))}
            />
          </Field>

          <FieldGroup label={TEXT.level} hint={TEXT.levelHint}>
            <div className="logs-chip-group" data-testid="logs-query-levels">
              {LEVEL_OPTIONS.map(option => (
                <ChipButton
                  key={option.value}
                  tone={option.tone}
                  active={queryDraft.levels.includes(option.value)}
                  onClick={() => setQueryDraft(current => ({
                    ...current,
                    levels: current.levels.includes(option.value)
                      ? current.levels.filter(item => item !== option.value)
                      : [...current.levels, option.value],
                  }))}
                >
                  {option.label} {levelCounts[option.value]}
                </ChipButton>
              ))}
            </div>
          </FieldGroup>

          <div className="form-row">
            <Field label={TEXT.source}>
              <select
                className="select"
                data-testid="logs-query-source"
                value={queryDraft.source}
                onChange={event => setQueryDraft(current => ({ ...current, source: event.target.value }))}
              >
                <option value="">{TEXT.sourceAll}</option>
                {sourcePool.map(item => <option key={item.value} value={item.value}>{item.value}</option>)}
              </select>
            </Field>
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

          <p className="form-hint">{TEXT.queryHint}</p>
        </form>
      </Modal>

      <FormModal
        open={recordOpen}
        title={TEXT.recordTitle}
        submitText={TEXT.submitRecord}
        busy={busy}
        hint={TEXT.recordHint}
        onClose={() => setRecordOpen(false)}
        onSubmit={submitRecord}
      >
        <div data-testid="logs-record-form">
          <Field label={TEXT.content}>
            <textarea
              className="textarea"
              data-testid="logs-record-text"
              value={record.text}
              placeholder={TEXT.contentPlaceholder}
              onChange={event => setRecord(current => ({ ...current, text: event.target.value }))}
            />
          </Field>

          <FieldGroup label={TEXT.level}>
            <div data-testid="logs-record-level">
              <Segmented
                options={LEVEL_OPTIONS}
                value={record.level}
                label={TEXT.level}
                onChange={value => setRecord(current => ({ ...current, level: value }))}
              />
            </div>
          </FieldGroup>

          <div className="form-row">
            <Field label={TEXT.source} hint={TEXT.sourcePlaceholder}>
              <input
                className="input"
                data-testid="logs-record-source"
                list="logs-record-sources"
                value={record.source}
                onChange={event => setRecord(current => ({ ...current, source: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.date} hint={TEXT.dateHint}>
              <input
                type="date"
                className="input"
                data-testid="logs-record-date"
                value={record.date}
                onChange={event => setRecord(current => ({ ...current, date: event.target.value }))}
              />
            </Field>
          </div>

          <Field label={TEXT.tags} hint={TEXT.tagsHint}>
            <input
              className="input"
              data-testid="logs-record-tags"
              value={record.tags}
              placeholder={TEXT.tagsPlaceholder}
              onChange={event => setRecord(current => ({ ...current, tags: event.target.value }))}
            />
          </Field>

          <datalist id="logs-record-sources">
            {sourcePool.map(item => <option key={item.value} value={item.value} />)}
          </datalist>
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
    </div>
  )
}
