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
 * @module src/workbench-app/modules/logs
 */

import { useId, useMemo, useState } from 'react'
import { api } from '../../api.mjs'

import { IconLogs, IconPlus, IconSparkles } from '../../icons.jsx'
import { groupBy, todayISO } from '../../util.mjs'
import './Logs.css'

export { logsAgentPanel } from './agent-ui.js'

import { TEXT, EMPTY_FILTERS, SOURCE_LIMIT, TAG_LIMIT, levelOf, parseTags, byRecency } from './model.jsx'

import View from './View.jsx'

export default function Logs({ data, mutate, notify, empty = false, onLoadDemo, openAgent }) {
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

  const agentReady = typeof openAgent === 'function'

  const headActions = (
    <>
      <button
        type="button"
        className="btn logs-agent-btn"
        data-testid="logs-agent-open"
        disabled={!agentReady}
        title={agentReady ? TEXT.askAgent : TEXT.askAgentUnavailable}
        onClick={() => { if (agentReady) openAgent('logs') }}
      >
        <IconSparkles size={16} /> {TEXT.askAgent}
      </button>
      <button type="button" className="btn" data-testid="logs-query-open" onClick={openQuery}>
        <IconLogs size={16} /> {TEXT.query}
      </button>
      <button type="button" className="btn btn-primary" data-testid="logs-record-open" onClick={openRecord}>
        <IconPlus size={16} /> {TEXT.record}
      </button>
    </>
  )

  return <View {...{
    logs, empty, onLoadDemo, demoBusy, loadDemo,
    openRecord, hasFilter, rows, headActions, filters,
    setFilters, levelCounts, toggleLevel, sourcePool, visibleSources,
    pickSource, setAllSources, allSources, levels, clearFilters,
    groups, today, openId, setOpenId, setPendingDelete,
    queryOpen, setQueryOpen, setQueryDraft, queryFormId, submitQuery,
    queryDraft, recordOpen, busy, setRecordOpen, submitRecord,
    record, setRecord, pendingDelete, confirmDelete,
  }} />
}
