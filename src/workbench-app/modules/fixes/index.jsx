/**
 * 问题修复：过滤面板 + 问题表格的问题列表。顶部快速捕获，四类过滤（搜索 / 状态 /
 * 优先级 / 标签），行内直接切状态，点标题行内展开详情——备注、关联任务、关联日志，
 * 并从详情一键记一条日志（带 `refs: [{ type: 'fixes', id }]` 回链）。
 * 形态按用户定调保持**列表**（不是看板）；工作台 4.4 节的关联与记日志落在详情里。
 * props 见 Dashboard.jsx 顶部说明；本模块额外用到 `navigate`（跳 tasks / logs）与
 * `empty` / `onLoadDemo`（首启空库引导）。根元素带 `data-module="fixes"`。
 * @module src/workbench-app/modules/fixes
 */

import { useMemo, useState } from 'react'
import { api } from '../../api.mjs'

import { byDateDesc, todayISO } from '../../util.mjs'
import './Fixes.css'

import {
  TEXT,
  PRIORITY_OPTIONS,
  STATUS_FILTERS,
  TAG_LIMIT,
  EMPTY_FORM,
  priorityOf,
  statusOf,
  tagsOf,
  linksTo,
  refIdsOf,
  parseTags
} from './model.jsx'

import View from './View.jsx'

export default function Fixes({ data, mutate, notify, navigate, empty = false, onLoadDemo }) {
  const today = todayISO()
  const fixes = Array.isArray(data?.fixes) ? data.fixes : []
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const logs = Array.isArray(data?.logs) ? data.logs : []

  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [priorities, setPriorities] = useState([])
  const [tags, setTags] = useState([])
  const [allTags, setAllTags] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [quick, setQuick] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [form, setForm] = useState(null)
  const [logFor, setLogFor] = useState(null)
  const [logDraft, setLogDraft] = useState({ text: '', level: 'warn', source: 'fixes' })
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)

  const counts = useMemo(() => {
    const next = { all: fixes.length, todo: 0, doing: 0, done: 0 }
    for (const fix of fixes) {
      if (next[fix.status] !== undefined) next[fix.status] += 1
    }
    return next
  }, [fixes])

  const statusOptions = useMemo(() => STATUS_FILTERS.map(option => ({
    value: option.value,
    label: `${option.label} ${counts[option.value] ?? 0}`,
  })), [counts])

  const priorityChips = useMemo(() => PRIORITY_OPTIONS.map(option => ({
    ...option,
    count: fixes.filter(fix => priorityOf(fix.priority).value === option.value).length,
  })), [fixes])

  const tagPool = useMemo(() => {
    const pool = new Map()
    for (const fix of fixes) {
      for (const tag of tagsOf(fix)) pool.set(tag, (pool.get(tag) ?? 0) + 1)
    }
    return [...pool.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }))
  }, [fixes])

  const rows = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return fixes
      .filter(fix => status === 'all' || fix.status === status)
      .filter(fix => priorities.length === 0 || priorities.includes(priorityOf(fix.priority).value))
      .filter(fix => tags.length === 0 || tagsOf(fix).some(tag => tags.includes(tag)))
      .filter(fix => needle === '' || `${fix.title ?? ''} ${fix.note ?? ''}`.toLowerCase().includes(needle))
      .sort(byDateDesc(fix => fix.updatedAt ?? fix.createdAt))
  }, [fixes, keyword, status, priorities, tags])

  const hasFilter = keyword.trim() !== '' || status !== 'all' || priorities.length > 0 || tags.length > 0

  /** 选中的标签始终摆出来，否则被折进「更多标签」的已选项没法取消。 */
  const visibleTags = allTags
    ? tagPool
    : tagPool.filter((tag, index) => index < TAG_LIMIT || tags.includes(tag.value))

  /** 与这条问题互相引用的任务：fix.refs 指向的 + refs 指向本 fix 的。 */
  function tasksOfFix(fix) {
    const outbound = new Set(refIdsOf(fix, 'tasks'))
    return [
      ...tasks.filter(task => outbound.has(task.id)),
      ...tasks.filter(task => !outbound.has(task.id) && linksTo(task, 'fixes', fix.id)),
    ]
  }

  /** 与这条问题互相引用的日志，按时间倒序（没有时间戳的靠日期兜底）。 */
  function logsOfFix(fix) {
    const outbound = new Set(refIdsOf(fix, 'logs'))
    return [
      ...logs.filter(log => outbound.has(log.id)),
      ...logs.filter(log => !outbound.has(log.id) && linksTo(log, 'fixes', fix.id)),
    ].sort(byDateDesc(log => log.createdAt ?? log.date))
  }

  function togglePriority(value) {
    setPriorities(current => (current.includes(value) ? current.filter(item => item !== value) : [...current, value]))
  }

  function toggleTag(value) {
    setTags(current => (current.includes(value) ? current.filter(item => item !== value) : [...current, value]))
  }

  function clearFilters() {
    setKeyword('')
    setStatus('all')
    setPriorities([])
    setTags([])
  }

  /** 快速捕获：只提交标题，其余字段交给服务端默认值（priority=normal、status=todo）。 */
  async function submitQuick(event) {
    event.preventDefault()
    const title = quick.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setQuickBusy(true)
    const ok = await mutate(() => api.addRecord('fixes', { title, note: '', status: 'todo' }), TEXT.created)
    setQuickBusy(false)
    if (ok) setQuick('')
  }

  /** 打开表单：不传记录是新建，传记录是编辑（tags 在表单里是逗号分隔文本）。 */
  function openForm(fix) {
    if (fix === undefined) {
      setForm({ ...EMPTY_FORM })
      return
    }
    setForm({
      id: fix.id,
      title: String(fix.title ?? ''),
      priority: priorityOf(fix.priority).value,
      status: statusOf(fix.status).value,
      note: String(fix.note ?? ''),
      tags: tagsOf(fix).join(', '),
    })
  }

  async function submitForm() {
    const title = form.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    const nextTags = parseTags(form.tags)
    if (nextTags.length > 8) {
      notify(TEXT.tagsLimit, 'warn')
      return
    }
    const fields = {
      title, priority: form.priority, status: form.status, note: form.note, tags: nextTags,
    }
    setBusy(true)
    const ok = await mutate(
      () => (form.id === null ? api.addRecord('fixes', fields) : api.patchRecord('fixes', form.id, fields)),
      form.id === null ? TEXT.created : TEXT.updated,
    )
    setBusy(false)
    if (ok) setForm(null)
  }

  function changeStatus(fix, next) {
    return mutate(() => api.patchRecord('fixes', fix.id, { status: next }), `${TEXT.statusChanged}「${statusOf(next).label}」`)
  }

  /** 记日志：日志落在 logs 模块，refs 回指这条问题（新关联字段的示范用法）。 */
  function openLog(fix) {
    setLogDraft({ text: '', level: 'warn', source: 'fixes' })
    setLogFor(fix)
  }

  async function submitLog() {
    const text = logDraft.text.trim()
    if (text === '') {
      notify(TEXT.needLogText, 'warn')
      return
    }
    const target = logFor
    setBusy(true)
    const ok = await mutate(
      () => api.addRecord('logs', {
        text, level: logDraft.level, source: logDraft.source.trim(), date: today, refs: [{ type: 'fixes', id: target.id }],
      }),
      TEXT.logged,
    )
    setBusy(false)
    if (ok) setLogFor(null)
  }

  async function confirmDelete() {
    const target = pendingDelete
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('fixes', target.id), TEXT.deleted)
    setBusy(false)
    if (ok) {
      setPendingDelete(null)
      setOpenId(current => (current === target.id ? null : current))
    }
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  const subtitle = `${hasFilter ? TEXT.filteredText(rows.length, counts.all) : TEXT.totalText(counts.all)} · ${TEXT.expandHint}`

  return <View {...{
    fixes, empty, onLoadDemo, demoBusy, loadDemo,
    openForm, subtitle, submitQuick, quick, quickBusy,
    setQuick, keyword, setKeyword, statusOptions, status,
    setStatus, priorityChips, priorities, togglePriority, tagPool,
    visibleTags, tags, toggleTag, setAllTags, allTags,
    hasFilter, clearFilters, rows, openId, tasksOfFix,
    logsOfFix, setOpenId, changeStatus, today, setPendingDelete,
    navigate, openLog, form, busy, setForm,
    submitForm, logFor, setLogFor, submitLog, logDraft,
    setLogDraft, pendingDelete, confirmDelete,
  }} />
}
