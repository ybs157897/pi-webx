/**
 * 知识库：三栏笔记工作台——左栏（搜索 + 标签过滤 + 条目列表），中栏（标题 / 标签 / 正文
 * 编辑器：⌘S 保存、编辑 / 预览切换，预览走 pi-webx/AssistantMarkdown），右栏（出链 / 反链
 * 面板 + 「问小台」）。记录落在 SQLite 的 knowledge 模块（title 必填、body 长文本、
 * tags/refs/starred 为通用字段），旧数据缺字段全程走默认值，向后兼容。
 *
 * 双链：正文写 [[标题]]，服务端写入时按 title 解析成 refs；编辑器保存时也会预先解析
 * （{type:'knowledge', id}）。重名笔记全部指过去，自己链自己跳过；解析不到的标题不落
 * refs，编辑器脚标提示「尚未解析」。手写进 refs 的跨模块关联（指向任务 / 需求）不是
 * [[解析]] 的产物，保存时原样保留。右栏优先用服务端 GET /api/workbench/links/:module/:id
 * （store.links() 扫描全库，含 pets/relationships 原子记录）；api.links 未接线或请求失败时，
 * 回落到客户端按同一规则扫描 data——链接面板永远有内容，SSR（不跑 effect）也直接渲染
 * 本地推算结果，selection / 视图 / 草稿全部从 props 与 data 派生。
 *
 * props 见 Requirements.jsx 顶部说明；本模块额外用到 `prefs` / `setPref`（记忆选中条目
 * kbSelectedId 与编辑/预览视图 kbView，写失败只是丢偏好、不打断操作）与 `askAI`
 * （「问小台」把笔记送进 AI 副驾；缺省或类型不对时按钮禁用并换提示文案）。渲染期不碰
 * window/document：⌘S 监听与链接拉取都进 effect 并加 typeof window 守卫。
 * 样式在 Knowledge.css，类名一律 `kb-` 前缀，颜色 / 间距 / 字号只取 styles.css 令牌。
 * @module src/modules/Knowledge
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.mjs'
import {
  Card, Chip, ChipButton, ConfirmDialog, Empty, IconButton,
} from '../ui.jsx'
import {
  IconBook, IconLink, IconPlus, IconSearch, IconSparkles, IconStar, IconTrash,
} from '../icons.jsx'
import { byDateDesc, formatStamp } from '../util.mjs'
import AssistantMarkdown from '../pi-webx/AssistantMarkdown.jsx'
import './Knowledge.css'

const TEXT = {
  list: '笔记',
  create: '新建笔记',
  search: '搜索标题、正文或标签…',
  searchLabel: '搜索笔记',
  tagAll: '全部',
  tagLabel: '标签筛选',
  sourceLabel: '来源筛选',
  sourceNone: '无来源',
  sourceFrom: '沉淀自：',
  totalText: total => `共 ${total} 条`,
  filteredText: (hits, total) => `筛选出 ${hits} / ${total} 条`,
  listEmpty: '没有匹配的笔记',
  listEmptyHint: '换个关键词，或清空标签与来源筛选',
  clearFilter: '清空筛选',
  empty: '还没有笔记',
  emptyHint: '其他功能沉淀的结论会出现在这里；也可以手动新建',
  emptyDemoHint: '库里还是空的，可以先灌一份演示数据，看看知识库长什么样',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  editorEmpty: '选一条笔记开始写',
  editorEmptyHint: '在左侧列表点一条，或点右上角新建',
  titlePlaceholder: '笔记标题',
  bodyPlaceholder: '正文支持 markdown；用 [[标题]] 链接到另一篇笔记',
  bodyLabel: '正文',
  fieldTitle: '标题',
  fieldTags: '标签',
  tagsHint: '逗号分隔，最多 8 个',
  save: '保存',
  saveHint: '⌘ / Ctrl + S',
  saved: '已保存',
  saving: '保存中…',
  editView: '编辑',
  previewView: '预览',
  viewLabel: '编辑或预览',
  previewEmpty: '正文为空，预览没有内容',
  dirty: '未保存',
  delete: '删除',
  deleteConfirm: '删除笔记',
  deleteMessage: '确定删除这条笔记？删除后无法恢复。',
  deleted: '笔记已删除',
  created: '已新建笔记',
  star: '加星标',
  unstar: '取消星标',
  starred: '已加星标',
  unstarred: '已取消星标',
  untitled: '未命名笔记',
  newTitle: '未命名笔记',
  needTitle: '先写下笔记标题',
  tagsLimit: '标签最多 8 个',
  bodyLimit: '正文超过 50000 字上限',
  refsLimit: '双链最多 20 条，先删掉几段 [[标题]]',
  links: '链接',
  outgoing: '出链',
  incoming: '反链',
  outgoingCount: count => `出链 ${count}`,
  incomingCount: count => `反链 ${count}`,
  linksNa: '选中一条笔记后，这里显示它的出入链',
  outgoingEmpty: '正文写 [[标题]]，保存后指向的笔记会出现在这里',
  incomingEmpty: '别的记录把 refs 指向这篇笔记后，会出现在这里',
  linkOpen: '打开这条记录',
  askAI: '问小台',
  askAIHint: '把这篇笔记发给 AI 副驾：总结、追问、改写都行',
  askAIUnwired: 'AI 副驾还没接线，暂时不能问',
  wikiResolved: count => `${count} 个双链已解析`,
  wikiUnresolved: count => `${count} 个 [[标题]] 尚未解析`,
  chars: count => `${count} 字`,
  metaUpdated: '更新于',
}

/** 链接面板的模块徽章：镜像服务端 MODULE_LABELS（前端不 import 服务端代码）。 */
const LINK_LABELS = {
  tasks: '今日规划',
  works: '工作助理',
  hotspots: '行业热点',
  exercises: '运动打卡',
  meals: '饮食记录',
  finance: '本月收支',
  reviews: '每日复盘',
  fixes: '问题修复',
  logs: '日志查询',
  requirements: '需求管理',
  codes: '代码开发',
  knowledge: '知识库',
  pets: '宠物日记',
  relationships: '亲密关系',
}

/** 客户端反链扫描范围：全部数组模块 + 两个原子模块的 records（与 store.links() 对齐）。 */
const LINK_SCAN_MODULES = [
  'tasks', 'works', 'hotspots', 'exercises', 'meals', 'finance', 'reviews', 'fixes', 'logs', 'requirements', 'codes', 'knowledge',
]
const LINK_SCAN_ATOMS = ['pets', 'relationships']
const SOURCE_NONE = '__none__'

/** 列表排序：最近碰过的浮到最上面（服务端每次写入都会刷新 updatedAt）。 */
const byUpdatedDesc = byDateDesc(row => row.updatedAt ?? row.createdAt)

/** 标签数组（旧数据可能没有 tags 字段）。 */
function tagsOf(row) {
  return Array.isArray(row?.tags) ? row.tags : []
}

/** 关联数组：`{ type, id }[]`。 */
function refsOf(row) {
  return Array.isArray(row?.refs) ? row.refs : []
}

/** 一条笔记关联到的模块类型：保留首次出现顺序。 */
function sourceTypesOf(row) {
  return [...new Set(refsOf(row).map(ref => String(ref?.type ?? '')).filter(Boolean))]
}

/** 原始标题（搜索与草稿用；空串表示没写标题）。 */
function rawTitleOf(row) {
  return typeof row?.title === 'string' ? row.title : ''
}

/** 展示标题：没写标题的旧记录也不能显示成空白。 */
function titleOf(row) {
  const title = rawTitleOf(row).trim()
  return title === '' ? TEXT.untitled : title
}

/** 正文：旧记录没有 body 字段时按空串处理。 */
function bodyOf(row) {
  return typeof row?.body === 'string' ? row.body : ''
}

/** 徽章上的模块名：认不出的模块 key 原样显示，不猜。 */
function labelOf(module) {
  return LINK_LABELS[module] ?? String(module ?? '')
}

/** 逗号（中英文都认）分隔的标签文本 → 去重后的 string[]。 */
function parseTags(text) {
  const parts = String(text ?? '').split(/[，,]/)
  return [...new Set(parts.map(part => part.trim()).filter(part => part !== ''))]
}

/** [[标题]] 匹配：不跨行、不嵌套、不支持空标题。 */
const WIKI_PATTERN = /\[\[([^\[\]\n]+?)\]\]/g

/**
 * 正文扫描 [[标题]]：去重且保持出现顺序。
 * @param body - 笔记正文。
 * @returns 标题字符串数组。
 */
function parseWikiTitles(body) {
  const titles = []
  for (const match of String(body ?? '').matchAll(WIKI_PATTERN)) {
    const title = match[1].trim()
    if (title !== '' && !titles.includes(title)) titles.push(title)
  }
  return titles
}

/**
 * 标题 → 笔记记录：trim 后精确匹配（不做模糊，避免误链）；重名时全部命中
 * （双链本来就该都指过去），自己链自己跳过。解析不到返回空数组。
 * @param rows - 全部知识库笔记。
 * @param title - [[标题]] 里的标题。
 * @param selfId - 当前笔记 id（自链豁免）。
 * @returns 命中的记录数组。
 */
function resolveWiki(rows, title, selfId) {
  const needle = String(title ?? '').trim()
  if (needle === '') return []
  return rows.filter(row => rawTitleOf(row).trim() === needle && row.id !== selfId)
}

/**
 * 保存时的 refs 组装：[[解析]] 出的知识库链接排在前面，手写的跨模块 refs 原样保留，
 * 按 type+id 去重，总数按 schema 上限截到 20。
 * @param rows - 全部知识库笔记（标题解析用）。
 * @param body - 待保存正文。
 * @param selfId - 当前笔记 id。
 * @param keepRefs - 记录里已有的 refs（挑出非 knowledge 的原样带回）。
 * @returns `{ type, id }[]`。
 */
function buildRefs(rows, body, selfId, keepRefs) {
  const next = []
  for (const title of parseWikiTitles(body)) {
    for (const row of resolveWiki(rows, title, selfId)) {
      if (!next.some(ref => ref.type === 'knowledge' && ref.id === row.id)) {
        next.push({ type: 'knowledge', id: String(row.id) })
      }
    }
  }
  for (const ref of keepRefs) {
    const type = String(ref?.type ?? '')
    if (type === '' || type === 'knowledge') continue
    const id = String(ref?.id ?? '')
    if (!next.some(item => item.type === type && item.id === id)) next.push({ type, id })
  }
  return next.slice(0, 20)
}

/** 链接元组：脏数据过滤，undefined / NaN 不进面板。 */
function normalizeLinks(result) {
  const list = value => (Array.isArray(value) ? value : [])
    .filter(item => item !== null && typeof item === 'object')
    .map(item => ({
      module: String(item.module ?? ''),
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
    }))
  return { outgoing: list(result?.outgoing), incoming: list(result?.incoming) }
}

/** 一条记录在链接列表里的显示标题：logs 用 text 字段。 */
function linkTitleOf(row) {
  return String(row?.title ?? row?.text ?? '')
}

/** 来源条直接消费 refs，即使目标记录已删也保留可识别的模块与 id。 */
function sourceEntries(data, selected) {
  if (selected === null) return []
  return refsOf(selected)
    .filter(ref => typeof ref?.type === 'string' && ref.type !== '' && ref.type !== 'knowledge' && typeof ref.id === 'string' && ref.id !== '')
    .map(ref => {
      const collection = LINK_SCAN_ATOMS.includes(ref.type) ? data?.[ref.type]?.records : data?.[ref.type]
      const target = Array.isArray(collection) ? collection.find(row => row?.id === ref.id) : null
      return { module: ref.type, id: ref.id, title: target === null || target === undefined ? ref.id : linkTitleOf(target) || ref.id }
    })
}

/**
 * 客户端按 store.links() 同样的规则扫一遍 data：出链 = 本条 refs，反链 = 全库指向
 * 本条的记录。api.links 不可用（未接线 / 请求失败）或 SSR 时用它兜底。
 * @param data - 全量 state。
 * @param selected - 当前选中的笔记（null 返回空结果）。
 * @returns `{ outgoing, incoming }`。
 */
function computeLinks(data, selected) {
  if (selected === null) return { outgoing: [], incoming: [] }
  const titles = new Map()
  for (const key of LINK_SCAN_MODULES) {
    const list = Array.isArray(data?.[key]) ? data[key] : []
    for (const row of list) titles.set(`${key}:${String(row?.id ?? '')}`, linkTitleOf(row))
  }
  for (const key of LINK_SCAN_ATOMS) {
    const list = Array.isArray(data?.[key]?.records) ? data[key].records : []
    for (const row of list) titles.set(`${key}:${String(row?.id ?? '')}`, linkTitleOf(row))
  }
  // 出链只留指向还存在记录的引用（与 store.links() 一致：指向已删记录的不入列）。
  const outgoing = []
  for (const ref of refsOf(selected)) {
    const module = String(ref?.type ?? '')
    const id = String(ref?.id ?? '')
    const key = `${module}:${id}`
    if (titles.has(key)) outgoing.push({ module, id, title: titles.get(key) ?? '' })
  }
  const pointsHere = row => refsOf(row).some(
    ref => String(ref?.type ?? '').toLowerCase() === 'knowledge' && ref?.id === selected.id,
  )
  const incoming = []
  for (const key of LINK_SCAN_MODULES) {
    const list = Array.isArray(data?.[key]) ? data[key] : []
    for (const row of list) {
      if (row?.id === selected.id) continue
      if (pointsHere(row)) incoming.push({ module: key, id: String(row.id), title: linkTitleOf(row) })
    }
  }
  for (const key of LINK_SCAN_ATOMS) {
    const list = Array.isArray(data?.[key]?.records) ? data[key].records : []
    for (const row of list) {
      if (pointsHere(row)) incoming.push({ module: key, id: String(row.id), title: linkTitleOf(row) })
    }
  }
  return { outgoing, incoming }
}

export default function Knowledge({
  data, mutate, notify, navigate, prefs = {}, setPref, empty = false, onLoadDemo, askAI,
}) {
  const rows = Array.isArray(data?.knowledge) ? data.knowledge : []
  const [selectedId, setSelectedId] = useState(() => String(prefs?.kbSelectedId ?? ''))
  const [keyword, setKeyword] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [activeSource, setActiveSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  // 草稿三件套照 Codes 的种子模式：saved 是脏标记基线，seedId 认「属于哪条笔记」——
  // mutate 之后 refresh() 会换掉整个 data，认对象会让正在打的内容被冲掉。
  const [seedId, setSeedId] = useState('')
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(null)
  // 链接面板：apiLinks 是服务端结果（null = 还没拉到或不可用，回落 computeLinks）。
  const [apiLinks, setApiLinks] = useState(null)
  const [linksToken, setLinksToken] = useState(0)
  // 新建记录的 id 在 action 内部暂存（mutate 只回布尔值），刷新落地后再选中它。
  const pendingId = useRef('')
  const saveRef = useRef(null)

  const view = prefs?.kbView === 'edit' ? 'edit' : 'preview'
  // selected 从 data 现算：写操作刷新后 data 是全新数组，存对象快照会立刻陈旧。
  const selected = useMemo(() => rows.find(row => row.id === selectedId) ?? null, [rows, selectedId])

  // 种子在渲染期重播（Codes 同款）：换人同一帧换草稿；选中的笔记被删掉时落回空态。
  if (selected !== null && selected.id !== seedId) {
    const next = { title: rawTitleOf(selected), body: bodyOf(selected), tags: tagsOf(selected).join(', ') }
    setSeedId(selected.id)
    setDraft(next)
    setSaved(next)
  } else if (selected === null && seedId !== '') {
    setSeedId('')
    setDraft(null)
    setSaved(null)
  }

  const tagCounts = useMemo(() => {
    const counts = new Map()
    for (const row of rows) {
      for (const tag of tagsOf(row)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
  }, [rows])

  const sourceCounts = useMemo(() => {
    const counts = new Map()
    let none = 0
    for (const row of rows) {
      const types = sourceTypesOf(row)
      if (types.length === 0) none += 1
      for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    return {
      types: [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)),
      none,
    }
  }, [rows])

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    // 关键词同时匹配标题、正文与标签；导入来的记录可能缺字段，先兜空值再比较。
    return rows
      .filter(row => activeTag === '' || tagsOf(row).includes(activeTag))
      .filter(row => activeSource === '' || (activeSource === SOURCE_NONE ? sourceTypesOf(row).length === 0 : sourceTypesOf(row).includes(activeSource)))
      .filter(row => needle === '' || `${rawTitleOf(row)} ${bodyOf(row)} ${tagsOf(row).join(' ')}`.toLowerCase().includes(needle))
      .sort(byUpdatedDesc)
  }, [rows, keyword, activeTag, activeSource])

  // 服务端链接图谱：选中项变化或保存后重拉；不可用时 computeLinks 兜底。
  const localLinks = useMemo(() => computeLinks(data, selected), [data, selected])
  const links = apiLinks ?? localLinks
  const sources = useMemo(() => sourceEntries(data, selected), [data, selected])

  useEffect(() => {
    setApiLinks(null)
    if (typeof window === 'undefined' || selectedId === '' || typeof api.links !== 'function') return undefined
    let cancelled = false
    api.links('knowledge', selectedId)
      .then(result => { if (!cancelled) setApiLinks(normalizeLinks(result)) })
      .catch(() => { if (!cancelled) setApiLinks(null) })
    return () => { cancelled = true }
  }, [selectedId, linksToken])

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

  // 草稿里的 [[标题]] 解析情况：脚标提示，未解析的不落 refs。
  const wikiLinks = useMemo(() => {
    if (draft === null || selected === null) return { hits: [], missing: [] }
    const hits = []
    const missing = []
    for (const title of parseWikiTitles(draft.body)) {
      if (resolveWiki(rows, title, selected.id).length > 0) hits.push(title)
      else missing.push(title)
    }
    return { hits, missing }
  }, [draft, rows, selected])

  const dirty = !(
    (draft === null && saved === null)
    || (draft !== null && saved !== null && draft.title === saved.title && draft.body === saved.body && draft.tags === saved.tags)
  )
  const stamp = selected === null ? '' : formatStamp(selected.updatedAt ?? selected.createdAt)
  const hasFilter = keyword.trim() !== '' || activeTag !== '' || activeSource !== ''
  const subtitle = hasFilter ? TEXT.filteredText(visible.length, rows.length) : TEXT.totalText(rows.length)

  function clearFilters() {
    setKeyword('')
    setActiveTag('')
    setActiveSource('')
  }

  /** 选中条目：本地 state + 偏好记忆（写失败只是丢偏好，不打断操作）。 */
  function selectNote(id) {
    setSelectedId(id)
    if (typeof setPref === 'function') setPref('kbSelectedId', id)
  }

  /** 编辑 / 预览切换：视图偏好照 Works 的写法直接落 prefs。 */
  function switchView(next) {
    if (typeof setPref === 'function') setPref('kbView', next)
  }

  /** 打开一条链接：知识库链接就地选中，跨模块链接跳对应模块。 */
  function openLink(link) {
    if (link.module === 'knowledge') {
      selectNote(link.id)
      return
    }
    if (typeof navigate === 'function') navigate(link.module)
  }

  async function save() {
    if (selected === null || draft === null) return false
    const title = draft.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return false
    }
    const nextTags = parseTags(draft.tags)
    if (nextTags.length > 8) {
      notify(TEXT.tagsLimit, 'warn')
      return false
    }
    const body = draft.body.trim()
    if (body.length > 50000) {
      notify(TEXT.bodyLimit, 'warn')
      return false
    }
    const nextRefs = buildRefs(rows, body, selected.id, refsOf(selected))
    if (nextRefs.length > 20) {
      notify(TEXT.refsLimit, 'warn')
      return false
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('knowledge', selected.id, { title, body, tags: nextTags, refs: nextRefs }),
      TEXT.saved,
    )
    setBusy(false)
    if (!ok) return false
    // 以用户输入为基线，trim 掉的空格不再点亮脏标记。
    setSaved({ ...draft })
    // 保存可能改了 refs：服务端链接图谱跟着重拉一次。
    setLinksToken(token => token + 1)
    return true
  }

  async function createNote() {
    setBusy(true)
    const ok = await mutate(async () => {
      const created = await api.addRecord('knowledge', { title: TEXT.newTitle })
      pendingId.current = String(created?.record?.id ?? '')
      return created
    }, TEXT.created)
    setBusy(false)
    if (!ok) return
    // 新建后选中新条目，并清掉过滤条件，保证它确实出现在左栏里（否则「选中了却看不见」）。
    selectNote(pendingId.current)
    clearFilters()
  }

  function toggleStar() {
    if (selected === null) return undefined
    const on = selected.starred === true
    return mutate(
      () => api.patchRecord('knowledge', selected.id, { starred: !on }),
      on ? TEXT.unstarred : TEXT.starred,
    )
  }

  async function confirmDelete() {
    const target = pendingDelete
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('knowledge', target.id), TEXT.deleted)
    setBusy(false)
    if (!ok) return
    setPendingDelete(null)
    // 删掉的正是读着的那条：落回未选中，编辑器回到空态（种子重播会清掉草稿）。
    if (target.id === selectedId) selectNote('')
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  /** 「问小台」：把当前草稿的标题 + 正文送进 AI 副驾（没接线时按钮是禁用的）。 */
  function askAboutNote() {
    if (typeof askAI !== 'function' || selected === null) return
    const body = draft !== null && seedId === selected.id ? draft.body : bodyOf(selected)
    askAI(`【知识库笔记】${titleOf(selected)}\n\n${body}`)
  }

  return (
    <div className="kb" data-module="knowledge">
      <div className="kb-split" data-testid="kb-split">
        <Card
          className="kb-list-col"
          bodyClassName="kb-list-body"
          title={TEXT.list}
          subtitle={subtitle}
          action={(
            <button type="button" className="kb-new-action" aria-label={TEXT.create} title={TEXT.create} data-testid="kb-new" disabled={busy} onClick={createNote}>
              <IconPlus size={16} />
            </button>
          )}
        >
          {rows.length === 0
            ? (
              <div data-testid="kb-empty">
                <Empty
                  icon={<IconBook size={22} />}
                  title={TEXT.empty}
                  hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
                  action={empty === true && typeof onLoadDemo === 'function'
                    ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="kb-load-demo"
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
                <label className="kb-search">
                  <IconSearch size={15} />
                  <input
                    className="kb-search-input"
                    type="search"
                    value={keyword}
                    placeholder={TEXT.search}
                    aria-label={TEXT.searchLabel}
                    data-testid="kb-search"
                    onChange={event => setKeyword(event.target.value)}
                  />
                </label>

                {tagCounts.length > 0 && (
                  <div className="kb-tags" data-testid="kb-tag-filter" role="group" aria-label={TEXT.tagLabel}>
                    <ChipButton active={activeTag === ''} onClick={() => setActiveTag('')}>
                      {TEXT.tagAll}
                    </ChipButton>
                    {tagCounts.map(([tag, count]) => (
                      <ChipButton
                        key={tag}
                        active={activeTag === tag}
                        title={`#${tag} · ${count} 条`}
                        onClick={() => setActiveTag(activeTag === tag ? '' : tag)}
                      >
                        #{tag}
                        <span className="kb-tag-count">{count}</span>
                      </ChipButton>
                    ))}
                  </div>
                )}

                <div className="kb-source-filter" data-testid="kb-source-filter" role="group" aria-label={TEXT.sourceLabel}>
                  <button type="button" className={`kb-source-chip ${activeSource === '' ? 'is-active' : ''}`} aria-pressed={activeSource === ''} data-testid="kb-source-all" onClick={() => setActiveSource('')}>
                    {TEXT.tagAll}
                  </button>
                  {sourceCounts.types.map(([type, count]) => (
                    <button key={type} type="button" className={`kb-source-chip ${activeSource === type ? 'is-active' : ''}`} aria-pressed={activeSource === type} data-testid={`kb-source-${type}`} title={`${labelOf(type)} · ${count} 条`} onClick={() => setActiveSource(activeSource === type ? '' : type)}>
                      {labelOf(type)}<span className="kb-tag-count">{count}</span>
                    </button>
                  ))}
                  <button type="button" className={`kb-source-chip ${activeSource === SOURCE_NONE ? 'is-active' : ''}`} aria-pressed={activeSource === SOURCE_NONE} data-testid="kb-source-none" onClick={() => setActiveSource(activeSource === SOURCE_NONE ? '' : SOURCE_NONE)}>
                    {TEXT.sourceNone}<span className="kb-tag-count">{sourceCounts.none}</span>
                  </button>
                </div>

                {visible.length === 0
                  ? (
                    <div data-testid="kb-list-empty">
                      <Empty
                        icon={<IconSearch size={20} />}
                        title={TEXT.listEmpty}
                        hint={TEXT.listEmptyHint}
                        action={<button type="button" className="btn" onClick={clearFilters}>{TEXT.clearFilter}</button>}
                      />
                    </div>
                  )
                  : (
                    <ul className="kb-list" data-testid="kb-list">
                      {visible.map(row => {
                        const active = selected !== null && row.id === selected.id
                        const title = rawTitleOf(row).trim()
                        return (
                          <li className="list-item kb-item" key={row.id} data-testid="kb-item">
                            <button
                              type="button"
                              className={`kb-item-btn ${active ? 'is-active' : ''}`}
                              aria-pressed={active}
                              onClick={() => selectNote(row.id)}
                            >
                              <span className="kb-item-top">
                                {row.starred === true && <IconStar className="kb-item-star" size={13} />}
                                <span className="kb-item-title">{title === '' ? TEXT.untitled : title}</span>
                              </span>
                              <span className="kb-item-foot">
                                {sourceTypesOf(row).length > 0 && (
                                  <span className="kb-item-sources" data-testid="kb-item-sources">
                                    {sourceTypesOf(row).map(type => <Chip key={type}>{labelOf(type)}</Chip>)}
                                  </span>
                                )}
                                <span className="kb-item-tags">
                                  {tagsOf(row).map(tag => <Chip key={tag}>#{tag}</Chip>)}
                                </span>
                                <span className="kb-item-time">{formatStamp(row.updatedAt ?? row.createdAt)}</span>
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

        <Card className="kb-editor-col">
          {selected === null || draft === null
            ? (
              <div data-testid="kb-editor-empty">
                <Empty icon={<IconBook size={22} />} title={TEXT.editorEmpty} hint={TEXT.editorEmptyHint} />
              </div>
            )
            : (
              <div className="kb-editor" data-testid="kb-editor">
                <header className="kb-editor-head">
                  <input
                    className="kb-title-input"
                    value={draft.title}
                    placeholder={TEXT.titlePlaceholder}
                    aria-label={TEXT.fieldTitle}
                    data-testid="kb-title-input"
                    onChange={event => setDraft(current => (current === null ? current : { ...current, title: event.target.value }))}
                  />
                  <div className="kb-editor-tools">
                    <IconButton
                      label={selected.starred === true ? TEXT.unstar : TEXT.star}
                      className={`kb-star ${selected.starred === true ? 'is-on' : ''}`}
                      disabled={busy}
                      onClick={toggleStar}
                    >
                      <IconStar size={16} />
                    </IconButton>
                    <button
                      type="button"
                      className="btn btn-sm kb-btn-danger"
                      data-testid="kb-delete"
                      onClick={() => setPendingDelete(selected)}
                    >
                      <IconTrash size={15} />
                      {TEXT.delete}
                    </button>
                  </div>
                </header>

                {sources.length > 0 && (
                  <div className="kb-sources" data-testid="kb-sources">
                    <span className="kb-sources-label">{TEXT.sourceFrom}</span>
                    {sources.map(source => (
                      <button key={`${source.module}:${source.id}`} type="button" className="kb-source-link" data-testid="kb-source-link" title={TEXT.linkOpen} onClick={() => openLink(source)}>
                        {labelOf(source.module)}「{source.title}」
                      </button>
                    ))}
                  </div>
                )}

                <div className="kb-editor-bar">
                  <div className="kb-view" role="group" aria-label={TEXT.viewLabel}>
                    <button
                      type="button"
                      className={`kb-view-btn ${view === 'edit' ? 'is-active' : ''}`}
                      aria-pressed={view === 'edit'}
                      data-testid="kb-view-edit"
                      onClick={() => switchView('edit')}
                    >
                      {TEXT.editView}
                    </button>
                    <button
                      type="button"
                      className={`kb-view-btn ${view === 'preview' ? 'is-active' : ''}`}
                      aria-pressed={view === 'preview'}
                      data-testid="kb-preview"
                      onClick={() => switchView('preview')}
                    >
                      {TEXT.previewView}
                    </button>
                  </div>
                  <input
                    className="input kb-tag-field"
                    value={draft.tags}
                    placeholder={TEXT.fieldTags}
                    aria-label={TEXT.fieldTags}
                    title={TEXT.tagsHint}
                    data-testid="kb-tags-input"
                    onChange={event => setDraft(current => (current === null ? current : { ...current, tags: event.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn btn-primary kb-save"
                    data-testid="kb-save"
                    disabled={busy || !dirty}
                    title={TEXT.saveHint}
                    onClick={save}
                  >
                    {busy ? TEXT.saving : TEXT.save}
                  </button>
                </div>

                {view === 'preview'
                  ? (
                    <div className="kb-preview-body" data-testid="kb-preview-body">
                      {draft.body.trim() === ''
                        ? <p className="kb-muted">{TEXT.previewEmpty}</p>
                        : <AssistantMarkdown text={draft.body} />}
                    </div>
                  )
                  : (
                    <textarea
                      className="textarea kb-body-input"
                      value={draft.body}
                      placeholder={TEXT.bodyPlaceholder}
                      aria-label={TEXT.bodyLabel}
                      data-testid="kb-body-input"
                      onChange={event => setDraft(current => (current === null ? current : { ...current, body: event.target.value }))}
                    />
                  )}

                <footer className="kb-editor-foot">
                  {dirty && <Chip tone="warn">{TEXT.dirty}</Chip>}
                  <span className="kb-foot-text">{TEXT.chars(draft.body.length)}</span>
                  {stamp !== '' && <span className="kb-foot-text">{TEXT.metaUpdated} {stamp}</span>}
                  {wikiLinks.hits.length > 0 && <Chip tone="accent">{TEXT.wikiResolved(wikiLinks.hits.length)}</Chip>}
                  {wikiLinks.missing.length > 0 && (
                    <span className="kb-foot-miss" title={wikiLinks.missing.join('、')}>
                      {TEXT.wikiUnresolved(wikiLinks.missing.length)}
                    </span>
                  )}
                </footer>
              </div>
            )}
        </Card>

        <Card
          className="kb-links-col"
          title={TEXT.links}
          subtitle={selected === null ? undefined : `${TEXT.outgoingCount(links.outgoing.length)} · ${TEXT.incomingCount(links.incoming.length)}`}
        >
          <div className="kb-links" data-testid="kb-backlinks">
            {selected === null
              ? <p className="kb-link-hint">{TEXT.linksNa}</p>
              : (
                <>
                  <section className="kb-link-group" data-testid="kb-outgoing">
                    <h4 className="kb-link-title">{TEXT.outgoing}</h4>
                    {links.outgoing.length === 0
                      ? <p className="kb-link-hint">{TEXT.outgoingEmpty}</p>
                      : (
                        <ul className="kb-link-list">
                          {links.outgoing.map(link => (
                            <li key={`out:${link.module}:${link.id}`}>
                              <button
                                type="button"
                                className="kb-link"
                                data-testid="kb-link"
                                title={TEXT.linkOpen}
                                onClick={() => openLink(link)}
                              >
                                <IconLink className="kb-link-icon" size={13} />
                                <span className="kb-link-text">{link.title === '' ? TEXT.untitled : link.title}</span>
                                {link.module !== 'knowledge' && <Chip>{labelOf(link.module)}</Chip>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                  </section>

                  <section className="kb-link-group" data-testid="kb-incoming">
                    <h4 className="kb-link-title">{TEXT.incoming}</h4>
                    {links.incoming.length === 0
                      ? <p className="kb-link-hint">{TEXT.incomingEmpty}</p>
                      : (
                        <ul className="kb-link-list">
                          {links.incoming.map(link => (
                            <li key={`in:${link.module}:${link.id}`}>
                              <button
                                type="button"
                                className="kb-link"
                                data-testid="kb-link"
                                title={TEXT.linkOpen}
                                onClick={() => openLink(link)}
                              >
                                <IconLink className="kb-link-icon" size={13} />
                                <span className="kb-link-text">{link.title === '' ? TEXT.untitled : link.title}</span>
                                {link.module !== 'knowledge' && <Chip>{labelOf(link.module)}</Chip>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                  </section>
                </>
              )}

            <div className="kb-ask">
              <button
                type="button"
                className="btn kb-ask-btn"
                data-testid="kb-ask-ai"
                disabled={selected === null || typeof askAI !== 'function'}
                title={selected === null ? TEXT.editorEmpty : (typeof askAI === 'function' ? TEXT.askAIHint : TEXT.askAIUnwired)}
                onClick={askAboutNote}
              >
                <IconSparkles size={15} />
                {TEXT.askAI}
              </button>
              <p className="kb-ask-hint">{TEXT.askAIHint}</p>
            </div>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${titleOf(pendingDelete)}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
