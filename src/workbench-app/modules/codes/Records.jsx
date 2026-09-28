/**
 * 代码开发：IDE 工作区（code-server 概念）——左侧活动栏 + 文件树面板，右侧编辑器
 * （tab 条 / 工具条 / 行号槽 + 等宽编辑区 / 底部状态栏）。一条事项 = 一张开发卡：
 * 标题即事项名，project 决定它在文件树里的分组，note 才是编辑器正文。
 *
 * 数据纪律：编辑只改本地 draft（`saved` 是脏标记的比较基线），点「保存」或按 ⌘S 才走
 * `mutate(() => api.patchRecord('codes', id, …), '已保存')`；切换 tab / 新建 / 关 tab 前
 * 若有未保存改动，一律先问（保存并继续 / 放弃改动 / 取消）。草稿在渲染期按「属于哪条事项」重播：
 * 换人立刻换内容（不留一帧上一条的正文），而 mutate 后的 refresh 只换 data 里的对象、不换 id，
 * 正在打的内容不会被冲掉。多 tab 只是「这次打开过的事项」，不落库、也不写偏好。
 *
 * props 见 Dashboard.jsx 顶部说明（额外用到 `refresh` / `empty` / `onLoadDemo`）；
 * 根元素带 `data-module="codes"`。⌘S 监听只进 effect 并加 `window` 守卫，渲染期不读浏览器对象。
 * @module src/workbench-app/modules/codes
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api.mjs'
import { useMediaQuery } from '../../ui.jsx'

import { formatStamp, groupBy } from '../../util.mjs'
import './Codes.css'

import { TEXT, byUpdatedDesc, statusOf, projectOf, sameDraft } from './model.jsx'

import View from './View.jsx'

export default function Codes({ data, mutate, notify, refresh, empty = false, onLoadDemo }) {
  // 打开过的事项（tab 条的数据源）与当前 tab 分成两份 state：关掉一个 tab 不该丢掉 activeId 之外的东西。
  const [openIds, setOpenIds] = useState([])
  const [activeId, setActiveId] = useState('')
  // 草稿只认「属于哪条事项」：换人时下面渲染期就重播，不留一帧「新 tab 挂着上一条正文」。
  const [seedId, setSeedId] = useState('')
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(null)
  const [newDraft, setNewDraft] = useState({ title: '', project: '', status: 'todo', note: '' })
  const [adding, setAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  // 切换 / 新建 / 关 tab 前若有未保存改动，把待执行的意图暂存在这里（null 即不弹确认）。
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [treeOpen, setTreeOpen] = useState(true)
  const saveRef = useRef(null)
  const gutterRef = useRef(null)
  const pendingNewId = useRef('')
  const narrow = useMediaQuery('(max-width: 899px)')

  const rows = Array.isArray(data?.codes) ? data.codes : []
  const active = rows.find(row => row.id === activeId) ?? null

  // 播种走「渲染期派生」而不是 effect：打开的事项换人时同一帧就把草稿换成新的一条。
  // 认的是 id 不是对象——mutate 之后 refresh() 会换掉整个 data，认对象会让正在打的内容被冲掉；
  // activeId 指向的记录还没到（刚建完等刷新）时先不动，等它真的到位。
  if (active === null && activeId === '' && seedId !== '') {
    setSeedId('')
    setDraft(null)
    setSaved(null)
  } else if (active !== null && active.id !== seedId) {
    const next = {
      title: active.title ?? '',
      project: active.project ?? '',
      status: statusOf(active.status).value,
      note: typeof active.note === 'string' ? active.note : '',
    }
    setSeedId(active.id)
    setDraft(next)
    setSaved(next)
  }

  // 窄屏（<900px）右侧编辑区更值钱，文件树默认收起；宽屏恢复展开。
  useEffect(() => {
    setTreeOpen(!narrow)
  }, [narrow])

  // ⌘S 只挂一个 window 监听：draft 每次按键都变，直接进 deps 会反复订阅/退订。
  useEffect(() => {
    saveRef.current = save
  })

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onKeyDown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveRef.current?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const dirty = !sameDraft(draft, saved)

  // 按 project 分组（空项目归入「未分组」），组内按最近更新倒序，组序沿用数据里的出现顺序。
  const groups = useMemo(() => [...groupBy(rows, projectOf).entries()].map(([project, items]) => ({
    key: project,
    label: project === '' ? TEXT.ungrouped : project,
    items: items.sort(byUpdatedDesc),
  })), [rows])

  // tab 条只认还在库里的记录：别处删掉的事项，tab 跟着消失。
  const openItems = useMemo(
    () => openIds.map(id => rows.find(row => row.id === id) ?? null).filter(row => row !== null),
    [openIds, rows],
  )

  const lineNumbers = draft === null ? [] : draft.note.split('\n').map((_, index) => index + 1)
  const draftTitle = draft === null ? '' : (draft.title.trim() === '' ? TEXT.untitled : draft.title.trim())
  const updatedText = active === null ? '' : formatStamp(active.updatedAt ?? active.createdAt)

  /** 打开事项：已经开过就只切过去，否则往 tab 条尾部追加一个。 */
  function openTab(id) {
    setOpenIds(ids => (ids.includes(id) ? ids : [...ids, id]))
    setActiveId(id)
  }

  /** 关 tab：当前 tab 让给右邻，没有右邻再退左邻，都没有就回到编辑器空态。 */
  function closeTab(id) {
    const index = openIds.indexOf(id)
    const rest = openIds.filter(openId => openId !== id)
    setOpenIds(rest)
    if (id !== activeId) return
    setActiveId(rest[Math.min(index, rest.length - 1)] ?? '')
  }

  /** 确认框里的三选一落回各自意图。 */
  function runIntent(intent) {
    if (intent === null) return
    if (intent.kind === 'open') openTab(intent.id)
    else if (intent.kind === 'close') closeTab(intent.id)
    else if (intent.kind === 'new') setAdding(true)
  }

  async function save() {
    if (active === null || draft === null || !dirty) return false
    const title = draft.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return false
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('codes', active.id, {
        title, project: draft.project.trim(), status: statusOf(draft.status).value, note: draft.note,
      }),
      TEXT.saved,
    )
    setBusy(false)
    // 以用户输入为基线，trim 掉的空格不再点亮脏标记。
    if (ok) setSaved({ ...draft })
    return ok
  }

  /** 保存并继续：存不下（标题空 / 请求失败）就停在原地，别把用户的改动丢掉。 */
  async function saveIntent() {
    const intent = pending
    const ok = await save()
    if (!ok) return
    setPending(null)
    runIntent(intent)
  }

  function discardIntent() {
    const intent = pending
    setPending(null)
    runIntent(intent)
  }

  /** 新建后自动打开：新记录 id 在 action 内部暂存，mutate 返回时刷新已排队，两个 setState 落在同一次提交。 */
  async function create(values) {
    const title = values.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(async () => {
      const created = await api.addRecord('codes', {
        title,
        project: values.project.trim(),
        status: statusOf(values.status).value,
        note: values.note,
      })
      pendingNewId.current = created.record.id
      return created
    }, TEXT.added)
    setBusy(false)
    if (!ok) return
    setAdding(false)
    setNewDraft({ title: '', project: '', status: 'todo', note: '' })
    openTab(pendingNewId.current)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('codes', pendingDelete.id), TEXT.deleted)
    setBusy(false)
    if (!ok) return
    if (activeId === pendingDelete.id) closeTab(pendingDelete.id)
    else setOpenIds(ids => ids.filter(id => id !== pendingDelete.id))
    setPendingDelete(null)
  }

  /* 切换拦截：编辑区有未保存改动时先确认，意图暂存进 `pending`，确认后再执行。 */
  function requestOpen(id) {
    if (id === activeId) return
    if (!dirty) {
      openTab(id)
      return
    }
    setPending({ kind: 'open', id })
  }

  function requestNew() {
    if (!dirty) {
      setAdding(true)
      return
    }
    setPending({ kind: 'new' })
  }

  /** 关掉别的 tab 不会碰 draft，只有关当前这条才要拦。 */
  function requestClose(id) {
    if (id === activeId && dirty) {
      setPending({ kind: 'close', id })
      return
    }
    closeTab(id)
  }

  async function refreshData() {
    if (typeof refresh !== 'function') return
    try {
      await refresh()
      notify(TEXT.refreshed, 'ok')
    } catch (error) {
      notify(String(error?.message ?? error), 'error')
    }
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  /** 行号槽与 textarea 是两套滚动容器，同步只能靠手写：把 textarea 的 scrollTop 抄给槽。 */
  function syncGutter(event) {
    const gutter = gutterRef.current
    if (gutter !== null) gutter.scrollTop = event.currentTarget.scrollTop
  }

  return <View {...{
    treeOpen, setTreeOpen, refreshData, draftTitle, rows,
    requestNew, empty, onLoadDemo, demoBusy, loadDemo,
    groups, activeId, requestOpen, dirty, setPendingDelete,
    active, draft, openItems, requestClose, setDraft,
    busy, save, gutterRef, lineNumbers, syncGutter,
    updatedText, adding, setAdding, create, newDraft,
    setNewDraft, pending, setPending, discardIntent, saveIntent,
    pendingDelete, confirmDelete,
  }} />
}
