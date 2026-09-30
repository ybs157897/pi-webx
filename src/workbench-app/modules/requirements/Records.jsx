/**
 * 需求记录：搜索、状态过滤、阅读与编辑，作为对话页的历史入口。
 * 选中项按 id 从最新 data 派生；支持从待办来源直接定位，导入交给页面持有者。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api.mjs'
import { Card, Chip, Empty, Segmented } from '../../ui.jsx'
import { IconPlus, IconRequirements, IconSearch } from '../../icons.jsx'

import './Requirements.css'

import Reader from './Reader.jsx'
import {
  TEXT,
  STATUS_STEPS,
  STATUS_FILTERS,
  EMPTY_FORM,
  byUpdatedDesc,
  priorityOf,
  statusOf,
  tagsOf,
  linksTo,
  parseTags
} from './model.jsx'

import Dialogs from './Dialogs.jsx'
import TraceDrawer from './TraceDrawer.jsx'

export default function Records({ data, mutate, notify, refresh, navigate, onImport, initialSelectedId = '', empty = false, onLoadDemo }) {
  const requirements = Array.isArray(data?.requirements) ? data.requirements : []
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []

  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState(initialSelectedId)
  const [form, setForm] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [tracingId, setTracingId] = useState('')
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  // 新建记录的 id 在 action 内部暂存（mutate 只回布尔值），刷新落地后再选中它。
  const pendingId = useRef('')

  // 从待办来源返回时，定位到被引用的那条记录；普通浏览保留当前选择。
  useEffect(() => {
    if (typeof initialSelectedId !== 'string' || initialSelectedId === '') return
    setSelectedId(initialSelectedId)
    setKeyword('')
    setStatus('all')
  }, [initialSelectedId])

  const counts = useMemo(() => {
    const next = { all: requirements.length, todo: 0, doing: 0, done: 0 }
    for (const row of requirements) next[statusOf(row.status).value] += 1
    return next
  }, [requirements])

  const statusFilterOptions = useMemo(
    () => STATUS_FILTERS.map(option => ({ value: option.value, label: `${option.label} ${counts[option.value]}` })),
    [counts],
  )

  const rows = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    // 关键词同时匹配标题与正文；导入来的记录可能缺 note / title，先兜空值再比较。
    return requirements
      .filter(row => status === 'all' || statusOf(row.status).value === status)
      .filter(row => needle === '' || `${String(row.title ?? '')} ${String(row.note ?? '')}`.toLowerCase().includes(needle))
      .sort(byUpdatedDesc)
  }, [requirements, keyword, status])

  // selected 从 data 现算：写操作刷新后 data 是全新数组，缓存对象会立刻陈旧。
  // 过滤只影响列表，不动阅读区——正读着的正文不该因为敲了搜索词就消失。
  const selected = useMemo(
    () => requirements.find(row => row.id === selectedId) ?? null,
    [requirements, selectedId],
  )

  /** 关联任务从任务的来源引用中派生，写操作刷新后同步更新。 */
  const linkedTasks = useMemo(
    () => (selected === null ? [] : tasks.filter(task => linksTo(task, 'requirements', selected.id))),
    [tasks, selected],
  )

  const hasFilter = keyword.trim() !== '' || status !== 'all'
  const stepIndex = selected === null ? -1 : STATUS_STEPS.findIndex(step => step.value === statusOf(selected.status).value)
  const stepBack = stepIndex > 0 ? STATUS_STEPS[stepIndex - 1] : null
  const stepNext = stepIndex >= 0 && stepIndex < STATUS_STEPS.length - 1 ? STATUS_STEPS[stepIndex + 1] : null

  function clearFilters() {
    setKeyword('')
    setStatus('all')
  }

  /** 改状态（阅读区顶部的分段与推进/退回共用）。 */
  function changeStatus(next) {
    const target = statusOf(next)
    if (selected === null) return undefined
    return mutate(
      () => api.patchRecord('requirements', selected.id, { status: target.value }),
      `${TEXT.statusChanged}「${target.label}」`,
    )
  }

  /** 推进/退回一档：两端没有目标档，按钮直接禁用，这里再兜一次。 */
  function move(step) {
    if (step === null) return undefined
    return changeStatus(step.value)
  }

  function toggleStar() {
    if (selected === null) return undefined
    const on = selected.starred === true
    return mutate(
      () => api.patchRecord('requirements', selected.id, { starred: !on }),
      on ? TEXT.unstarred : TEXT.starred,
    )
  }

  /** 打开表单：不传记录是新建，传记录是编辑。 */
  function openForm(row) {
    if (row === undefined) {
      setForm({ ...EMPTY_FORM })
      return
    }
    setForm({
      id: row.id,
      title: String(row.title ?? ''),
      priority: priorityOf(row.priority).value,
      status: statusOf(row.status).value,
      note: String(row.note ?? ''),
      tags: tagsOf(row).join(', '),
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
      title, priority: form.priority, status: form.status, note: form.note.trim(), tags: nextTags,
    }
    const targetId = form.id
    setBusy(true)
    const ok = await mutate(async () => {
      if (targetId === null) {
        const created = await api.addRecord('requirements', fields)
        pendingId.current = String(created?.record?.id ?? '')
        return created
      }
      return api.patchRecord('requirements', targetId, fields)
    }, targetId === null ? TEXT.created : TEXT.updated)
    setBusy(false)
    if (!ok) return
    // 新建后选中新条目，并清掉过滤条件，保证它确实出现在左栏里（否则「选中了却看不见」）。
    if (targetId === null) {
      setSelectedId(pendingId.current)
      clearFilters()
    } else {
      setSelectedId(targetId)
    }
    setForm(null)
  }

  async function confirmDelete() {
    const target = pendingDelete
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('requirements', target.id), TEXT.deleted)
    setBusy(false)
    if (!ok) return
    setPendingDelete(null)
    // 删掉的正是读着的那条：落回未选中，右栏回到空态。
    setSelectedId(current => (current === target.id ? '' : current))
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  const subtitle = hasFilter ? TEXT.filteredText(rows.length, counts.all) : TEXT.totalText(counts.all)

  return (
    <div className="req" data-module="requirements">
      <div className="req-split" data-testid="req-split">
        <Card
          className="req-list-col"
          bodyClassName="req-list-body"
          title={TEXT.list}
          subtitle={subtitle}
          action={(
            <button type="button" className="btn btn-sm btn-primary" data-testid="req-new" onClick={() => openForm()}>
              <IconPlus size={15} />
              {TEXT.create}
            </button>
          )}
        >
          {requirements.length === 0
            ? (
              <div data-testid="req-empty">
                <Empty
                  icon={<IconRequirements size={22} />}
                  title={TEXT.empty}
                  hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
                  action={empty === true && typeof onLoadDemo === 'function'
                    ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="req-load-demo"
                        disabled={demoBusy}
                        onClick={loadDemo}
                      >
                        {demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}
                      </button>
                    )
                    : undefined}
                />
              </div>
            )
            : (
              <>
                <label className="req-search">
                  <IconSearch size={15} />
                  <input
                    className="req-search-input"
                    type="search"
                    value={keyword}
                    placeholder={TEXT.search}
                    aria-label={TEXT.searchLabel}
                    data-testid="req-search"
                    onChange={event => setKeyword(event.target.value)}
                  />
                </label>

                <div className="req-filter" data-testid="req-status-filter">
                  <Segmented
                    options={statusFilterOptions}
                    value={status}
                    onChange={setStatus}
                    label={TEXT.filterLabel}
                  />
                </div>

                {rows.length === 0
                  ? (
                    <div data-testid="req-list-empty">
                      <Empty
                        icon={<IconSearch size={20} />}
                        title={TEXT.listEmpty}
                        hint={TEXT.listEmptyHint}
                        action={<button type="button" className="btn" onClick={clearFilters}>{TEXT.clearFilter}</button>}
                      />
                    </div>
                  )
                  : (
                    <ul className="req-list" data-testid="req-list">
                      {rows.map(row => {
                        const priority = priorityOf(row.priority)
                        const step = statusOf(row.status)
                        const active = selected !== null && row.id === selected.id
                        return (
                          <li className="list-item req-item" key={row.id} data-testid="req-item">
                            <button
                              type="button"
                              className={`req-item-btn ${active ? 'is-active' : ''}`}
                              aria-pressed={active}
                              onClick={() => setSelectedId(row.id)}
                            >
                              <span className="req-item-top">
                                <span className={`req-dot ${priority.tone}`} aria-hidden="true" />
                                <span className="sr-only">{TEXT.priorityLabel} {priority.label}</span>
                                <span className="req-item-title">{String(row.title ?? '')}</span>
                              </span>
                              <span className="req-item-foot">
                                <span className="req-item-tags">
                                  {tagsOf(row).map(tag => <Chip key={tag}>#{tag}</Chip>)}
                                </span>
                                <span className="req-item-status">
                                  <Chip tone={step.tone}>{step.label}</Chip>
                                </span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </>
            )}
        </Card>

        <Card className="req-reader-col">
          <div className="req-reader" data-testid="req-reader">
            {selected === null
              ? (
                <div data-testid="req-reader-empty">
                  <Empty icon={<IconRequirements size={22} />} title={TEXT.readerEmpty} hint={TEXT.readerEmptyHint} />
                </div>
              )
              : (
                <Reader
                  row={selected}
                  linkedTasks={linkedTasks}
                  stepBack={stepBack}
                  stepNext={stepNext}
                  onStatus={changeStatus}
                  onStar={toggleStar}
                  onEdit={() => openForm(selected)}
                  onDelete={() => setPendingDelete(selected)}
                  onMove={move}
                  onNavigate={navigate}
                  onImport={typeof onImport === 'function' ? () => onImport(selected) : undefined}
                  onTrace={() => setTracingId(selected.id)}
                />
              )}
          </div>
        </Card>
      </div>

      <Dialogs {...{ form, busy, setForm, submitForm, pendingDelete, setPendingDelete, confirmDelete }} />
      {tracingId && <TraceDrawer key={tracingId} requirementId={tracingId}
        onClose={() => setTracingId('')} onChanged={() => refresh?.()} />}
    </div>
  )
}
