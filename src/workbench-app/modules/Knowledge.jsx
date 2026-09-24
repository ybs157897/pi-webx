/**
 * WeKnora-inspired knowledge management: base cards → folder/document list → reading.
 * A document belongs to one base and at most one folder. Existing Markdown notes keep
 * their tags, refs and assistant action; [[title]] links resolve within the current base.
 * Browser-only listeners and link fetches stay in effects for server rendering.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Folder, LayoutGrid, List } from 'lucide-react'
import { api } from '../api.mjs'
import {
  Chip, ConfirmDialog, Empty, IconButton,
} from '../ui.jsx'
import {
  IconBook, IconLink, IconMenu, IconPlus, IconSearch, IconSparkles, IconStar, IconTrash,
} from '../icons.jsx'
import { byDateDesc, formatStamp } from '../util.mjs'
import AssistantMarkdown from '../pi-webx/AssistantMarkdown.jsx'
import './Knowledge.css'

const TEXT = {
  backHome: '文档列表',
  toc: '本库文档',
  create: '新建文档',
  search: '搜索文档标题、正文或标签…',
  searchLabel: '搜索文档',
  sourceFrom: '沉淀自：',
  recent: '最近更新',
  pinned: '星标知识',
  listMore: '显示知识列表',
  listLess: '收起知识列表',
  discardTitle: '放弃未保存的修改？',
  discardMessage: '切换后，这篇文档未保存的内容会丢失。',
  totalText: total => `共 ${total} 条`,
  filteredText: (hits, total) => `筛选出 ${hits} / ${total} 条`,
  empty: '此知识库还没有文档',
  emptyHint: '新建一篇 Markdown 文档，开始整理知识',
  loadDemo: '灌入演示数据',
  loadingDemo: '灌入中…',
  titlePlaceholder: '文档标题',
  bodyPlaceholder: '正文支持 Markdown；用 [[标题]] 链接到另一篇文档',
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
  deleteConfirm: '删除文档',
  deleteMessage: '确定删除这篇文档？删除后无法恢复。',
  deleted: '文档已删除',
  created: '已新建文档',
  star: '加星标',
  untitled: '未命名文档',
  newTitle: '未命名文档',
  needTitle: '先写下文档标题',
  tagsLimit: '标签最多 8 个',
  bodyLimit: '正文超过 50000 字上限',
  refsLimit: '双链最多 20 条，先删掉几段 [[标题]]',
  outgoingCount: count => `引用了 ${count}`,
  incomingCount: count => `被引用 ${count}`,
  outgoingEmpty: '在正文写 [[标题]]，保存后即可引用另一篇文档',
  incomingEmpty: '引用这篇文档的内容会出现在这里',
  linkOpen: '打开这条记录',
  askAI: '问小台',
  askAIHint: '把这篇文档发给 AI 副驾：总结、追问、改写都行',
  askAIUnwired: 'AI 副驾还没接线，暂时不能问',
  wikiResolved: count => `${count} 个双链已解析`,
  wikiUnresolved: count => `${count} 个 [[标题]] 尚未解析`,
  chars: count => `${count} 字`,
  metaUpdated: '更新于',
}

/** 链接 / 来源徽章的模块名：镜像服务端 MODULE_LABELS（前端不 import 服务端代码）。 */
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

/** 卡片摘要：正文剥掉最浅一层 markdown 记号后截一段；空正文返回空串。 */
function snippetOf(row) {
  const text = bodyOf(row).replace(/\[\[|\]\]/g, '').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > 96 ? `${text.slice(0, 96)}…` : text
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
  const bases = Array.isArray(data?.knowledgeBases) ? data.knowledgeBases : []
  const folders = Array.isArray(data?.knowledgeFolders) ? data.knowledgeFolders : []
  const [selectedId, setSelectedId] = useState(() => String(prefs?.kbSelectedId ?? ''))
  const [selectedBaseId, setSelectedBaseId] = useState(() => String(prefs?.kbBaseId ?? ''))
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [stage, setStage] = useState(() => {
    const baseId = String(prefs?.kbBaseId ?? '')
    const noteId = String(prefs?.kbSelectedId ?? '')
    if (prefs?.kbStage === 'reading' && rows.some(row => row.id === noteId && row.knowledgeBaseId === baseId)) return 'reading'
    if (prefs?.kbStage === 'documents' && bases.some(base => base.id === baseId)) return 'documents'
    return 'bases'
  })
  const [baseQuery, setBaseQuery] = useState('')
  const [sortOrder, setSortOrder] = useState('recent')
  const [layout, setLayout] = useState('grid')
  const [baseForm, setBaseForm] = useState(null)
  const [folderForm, setFolderForm] = useState(null)
  const [pendingBaseDelete, setPendingBaseDelete] = useState(null)
  const [pendingFolderDelete, setPendingFolderDelete] = useState(null)
  const [keyword, setKeyword] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [activeSource, setActiveSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingNavigation, setPendingNavigation] = useState(null)
  const [listOpen, setListOpen] = useState(false)
  // 草稿三件套照 Codes 的种子模式：saved 是脏标记基线，seedId 认「属于哪条笔记」——
  // mutate 之后 refresh() 会换掉整个 data，认对象会让正在打的内容被冲掉。
  const [seedId, setSeedId] = useState('')
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(null)
  // 链接分区：apiLinks 是服务端结果（null = 还没拉到或不可用，回落 computeLinks）。
  const [apiLinks, setApiLinks] = useState(null)
  const [linksToken, setLinksToken] = useState(0)
  // 新建记录的 id 在 action 内部暂存（mutate 只回布尔值），刷新落地后再选中它。
  const pendingId = useRef('')
  const saveRef = useRef(null)

  // 阅读态默认预览；已存 edit 偏好的用户保留编辑态。
  const view = prefs?.kbView === 'edit' ? 'edit' : 'preview'
  const selectedBase = bases.find(base => base.id === selectedBaseId) ?? null
  const baseRows = useMemo(() => rows.filter(row => row.knowledgeBaseId === selectedBaseId), [rows, selectedBaseId])
  const baseFolders = useMemo(() => folders.filter(folder => folder.knowledgeBaseId === selectedBaseId), [folders, selectedBaseId])
  // selected 从 data 现算：写操作刷新后 data 是全新数组，存对象快照会立刻陈旧。
  const selected = useMemo(() => rows.find(row => row.id === selectedId) ?? null, [rows, selectedId])
  // 阅读态要求种子已落地：首帧（SSR / 渲染期重播前）draft 还是 null，先落首页那一帧；
  // 种子 setState 会在同一次提交内触发渲染期更新，重播完成后直接以阅读态输出，不闪烁。
  const reading = stage === 'reading' && selected !== null && draft !== null

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
    for (const row of baseRows) {
      for (const tag of tagsOf(row)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
  }, [baseRows])

  const sourceCounts = useMemo(() => {
    const counts = new Map()
    let none = 0
    for (const row of baseRows) {
      const types = sourceTypesOf(row)
      if (types.length === 0) none += 1
      for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    return {
      types: [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)),
      none,
    }
  }, [baseRows])

  const folderRows = useMemo(() => {
    const result = []
    const seen = new Set()
    const walk = (parentId, depth) => {
      for (const folder of baseFolders.filter(item => String(item.parentId ?? '') === parentId).sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'zh'))) {
        if (seen.has(folder.id)) continue
        seen.add(folder.id)
        result.push({ ...folder, depth })
        walk(folder.id, depth + 1)
      }
    }
    walk('', 0)
    return result
  }, [baseFolders])

  const scopedFolderIds = useMemo(() => {
    if (selectedFolderId === '') return new Set(baseFolders.map(folder => folder.id))
    const ids = new Set([selectedFolderId])
    let changed = true
    while (changed) {
      changed = false
      for (const folder of baseFolders) {
        if (!ids.has(folder.id) && ids.has(folder.parentId)) { ids.add(folder.id); changed = true }
      }
    }
    return ids
  }, [baseFolders, selectedFolderId])

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    // 关键词同时匹配标题、正文与标签；导入来的记录可能缺字段，先兜空值再比较。
    const filtering = needle !== '' || activeTag !== '' || activeSource !== ''
    return baseRows
      .filter(row => selectedFolderId === '' || (filtering ? scopedFolderIds.has(row.folderId) : row.folderId === selectedFolderId))
      .filter(row => activeTag === '' || tagsOf(row).includes(activeTag))
      .filter(row => activeSource === '' || (activeSource === SOURCE_NONE ? sourceTypesOf(row).length === 0 : sourceTypesOf(row).includes(activeSource)))
      .filter(row => needle === '' || `${rawTitleOf(row)} ${bodyOf(row)} ${tagsOf(row).join(' ')}`.toLowerCase().includes(needle))
      .sort(sortOrder === 'title' ? (a, b) => titleOf(a).localeCompare(titleOf(b), 'zh') : byUpdatedDesc)
  }, [baseRows, keyword, activeTag, activeSource, selectedFolderId, scopedFolderIds, sortOrder])

  // 来源是出处而不是分类；导航按星标与最近更新组织，不把多来源笔记塞进任意一组。
  const tocGroups = useMemo(() => {
    const sorted = [...baseRows].sort(byUpdatedDesc)
    return [
      { key: 'starred', label: TEXT.pinned, list: sorted.filter(row => row.starred === true) },
      { key: 'recent', label: TEXT.recent, list: sorted.filter(row => row.starred !== true) },
    ].filter(group => group.list.length > 0)
  }, [baseRows])

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
      if (resolveWiki(baseRows, title, selected.id).length > 0) hits.push(title)
      else missing.push(title)
    }
    return { hits, missing }
  }, [draft, baseRows, selected])

  const dirty = !(
    (draft === null && saved === null)
    || (draft !== null && saved !== null && draft.title === saved.title && draft.body === saved.body && draft.tags === saved.tags)
  )
  const stamp = selected === null ? '' : formatStamp(selected.updatedAt ?? selected.createdAt)
  const hasFilter = keyword.trim() !== '' || activeTag !== '' || activeSource !== ''
  const subtitle = hasFilter ? TEXT.filteredText(visible.length, baseRows.length) : TEXT.totalText(visible.length)

  function clearFilters() {
    setKeyword('')
    setActiveTag('')
    setActiveSource('')
  }

  function switchStage(next) {
    setStage(next)
    if (typeof setPref === 'function') setPref('kbStage', next)
  }

  function openBase(id, skipGuard = false) {
    if (!skipGuard && dirty && selected !== null && selected.knowledgeBaseId !== id) {
      setPendingNavigation({ kind: 'base', id })
      return
    }
    setSelectedBaseId(id)
    setSelectedFolderId('')
    switchStage('documents')
    clearFilters()
    if (typeof setPref === 'function') setPref('kbBaseId', id)
  }

  function backToBases() { switchStage('bases') }

  function openFolder(id) {
    setSelectedFolderId(id)
    clearFilters()
  }

  /** 切笔记先处理未保存内容；新笔记单独进入编辑态。 */
  function selectNote(id, skipGuard = false, edit = false) {
    if (!skipGuard && dirty && selectedId !== '' && selectedId !== id) {
      setPendingNavigation({ kind: 'note', id })
      return
    }
    setSelectedId(id)
    const row = rows.find(item => item.id === id)
    if (row?.knowledgeBaseId) {
      setSelectedBaseId(row.knowledgeBaseId)
      setSelectedFolderId(String(row.folderId ?? ''))
      if (typeof setPref === 'function') setPref('kbBaseId', row.knowledgeBaseId)
    }
    switchStage(id === '' ? 'documents' : 'reading')
    setListOpen(false)
    if (typeof setPref === 'function') setPref('kbSelectedId', id)
    if (id !== '') switchView(edit ? 'edit' : 'preview')
  }

  /** 回文档列表保留草稿；换篇时才检查是否丢弃。 */
  function backToHome() {
    switchStage('documents')
  }

  /** 编辑 / 预览切换：视图偏好照 Works 的写法直接落 prefs。 */
  function switchView(next) {
    if (typeof setPref === 'function') setPref('kbView', next)
  }

  /** 打开一条链接：知识库链接就地选中（进阅读态），跨模块链接跳对应模块。 */
  function openLink(link) {
    if (link.module === 'knowledge') {
      selectNote(link.id)
      return
    }
    if (dirty) {
      setPendingNavigation({ kind: 'link', link })
      return
    }
    if (typeof navigate === 'function') navigate(link.module)
  }

  function confirmNavigation() {
    const next = pendingNavigation
    setPendingNavigation(null)
    if (next?.kind === 'note') selectNote(next.id, true)
    if (next?.kind === 'create') createNote(true)
    if (next?.kind === 'base') openBase(next.id, true)
    if (next?.kind === 'link' && typeof navigate === 'function') navigate(next.link.module)
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
    const nextRefs = buildRefs(baseRows, body, selected.id, refsOf(selected))
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

  async function createNote(skipGuard = false) {
    if (selectedBase === null) return
    if (!skipGuard && dirty) {
      setPendingNavigation({ kind: 'create' })
      return
    }
    setBusy(true)
    const ok = await mutate(async () => {
      const created = await api.addRecord('knowledge', { title: TEXT.newTitle, knowledgeBaseId: selectedBaseId, folderId: selectedFolderId })
      pendingId.current = String(created?.record?.id ?? '')
      return created
    }, TEXT.created)
    setBusy(false)
    if (!ok) return
    // 新建后选中并直接落编辑视图（空笔记预览没有意义），清掉过滤保证卡片可见。
    selectNote(pendingId.current, true, true)
    clearFilters()
  }

  async function saveBaseForm() {
    if (baseForm === null) return
    if (!baseForm.id && dirty) { notify('请先保存当前文档，再新建知识库', 'warn'); return }
    const title = baseForm.title.trim()
    if (title === '') { notify('先填写知识库名称', 'warn'); return }
    const description = baseForm.description.trim()
    let createdId = ''
    setBusy(true)
    const ok = await mutate(async () => {
      if (baseForm.id) return api.patchRecord('knowledgeBases', baseForm.id, { title, description })
      const result = await api.addRecord('knowledgeBases', { title, description })
      createdId = String(result?.record?.id ?? '')
      return result
    }, baseForm.id ? '知识库已更新' : '知识库已创建')
    setBusy(false)
    if (!ok) return
    setBaseForm(null)
    if (createdId !== '') openBase(createdId, true)
  }

  async function saveFolderForm() {
    if (folderForm === null || selectedBase === null) return
    const title = folderForm.title.trim()
    if (title === '') { notify('先填写目录名称', 'warn'); return }
    const parentId = folderForm.id ? String(baseFolders.find(item => item.id === folderForm.id)?.parentId ?? '') : selectedFolderId
    if (baseFolders.some(item => item.id !== folderForm.id && item.parentId === parentId && titleOf(item) === title)) {
      notify('同一位置已有这个目录', 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(() => folderForm.id
      ? api.patchRecord('knowledgeFolders', folderForm.id, { title })
      : api.addRecord('knowledgeFolders', { title, knowledgeBaseId: selectedBaseId, parentId }), folderForm.id ? '目录已重命名' : '目录已创建')
    setBusy(false)
    if (ok) setFolderForm(null)
  }

  async function confirmBaseDelete() {
    if (pendingBaseDelete === null) return
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('knowledgeBases', pendingBaseDelete.id), '知识库已删除')
    setBusy(false)
    if (!ok) return
    if (selectedBaseId === pendingBaseDelete.id) {
      setSelectedBaseId('')
      setSelectedId('')
      if (typeof setPref === 'function') { setPref('kbBaseId', ''); setPref('kbSelectedId', '') }
      switchStage('bases')
    }
    setPendingBaseDelete(null)
  }

  async function confirmFolderDelete() {
    if (pendingFolderDelete === null) return
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('knowledgeFolders', pendingFolderDelete.id), '目录已删除')
    setBusy(false)
    if (!ok) return
    setSelectedFolderId(String(pendingFolderDelete.parentId ?? ''))
    setPendingFolderDelete(null)
  }

  async function moveSelectedDocument(folderId) {
    if (selected === null || folderId === String(selected.folderId ?? '')) return
    if (dirty) { notify('请先保存这篇文档，再移动目录', 'warn'); return }
    setBusy(true)
    const ok = await mutate(() => api.patchRecord('knowledge', selected.id, { folderId }), '文档已移动')
    setBusy(false)
    if (ok) setSelectedFolderId(folderId)
  }

  function toggleStar() {
    if (selected === null) return undefined
    const on = selected.starred === true
    return mutate(
      () => api.patchRecord('knowledge', selected.id, { starred: !on }),
      on ? '已取消星标' : '已加星标',
    )
  }

  async function confirmDelete() {
    const target = pendingDelete
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('knowledge', target.id), TEXT.deleted)
    setBusy(false)
    if (!ok) return
    setPendingDelete(null)
    // 删掉的正是读着的那条：清选中回首页（种子重播会清掉草稿）。
    if (target.id === selectedId) selectNote('', true)
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

  const starButton = (
    <IconButton
      label={selected !== null && selected.starred === true ? '取消星标' : TEXT.star}
      className={`kb-star ${selected !== null && selected.starred === true ? 'is-on' : ''}`}
      disabled={busy}
      onClick={toggleStar}
    >
      <IconStar size={16} />
    </IconButton>
  )

  const linksSection = (
    <section className="kb-links" data-testid="kb-backlinks">
      <h3 className="kb-links-heading">相关内容</h3>
      <div className="kb-links-grid">
        <section className="kb-link-group" data-testid="kb-outgoing">
          <h4 className="kb-link-title">{TEXT.outgoingCount(links.outgoing.length)}</h4>
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
          <h4 className="kb-link-title">{TEXT.incomingCount(links.incoming.length)}</h4>
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
      </div>
    </section>
  )

  const visibleBases = bases
    .filter(base => `${titleOf(base)} ${String(base.description ?? '')}`.toLowerCase().includes(baseQuery.trim().toLowerCase()))
    .sort((a, b) => Number(b.starred === true) - Number(a.starred === true) || byUpdatedDesc(a, b))

  const baseList = (
    <div className="kb-base-list" data-testid="kb-bases">
      <div className="kb-base-intro">
        <div>
          <h2>我的知识库</h2>
          <p>按主题管理文档，再用目录和标签整理内容。</p>
        </div>
        <button type="button" className="kb-create" data-testid="kb-new-base" onClick={() => setBaseForm({ id: '', title: '', description: '' })}>
          <IconPlus size={17} />新建知识库
        </button>
      </div>
      {bases.length > 0 && (
        <label className="kb-base-search">
          <IconSearch size={18} />
          <input type="search" value={baseQuery} aria-label="搜索知识库" placeholder="搜索知识库名称或描述" onChange={event => setBaseQuery(event.target.value)} />
        </label>
      )}
      {visibleBases.length === 0
        ? <Empty icon={<IconBook size={26} />} title={bases.length === 0 ? '还没有知识库' : '没有匹配的知识库'} hint={bases.length === 0 ? '创建一个知识库，开始整理文档' : '换个名称试试'} action={empty === true && typeof onLoadDemo === 'function' ? <button type="button" className="btn" data-testid="kb-load-demo" disabled={demoBusy} onClick={loadDemo}>{demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}</button> : undefined} />
        : <div className="kb-base-grid">
          {visibleBases.map(base => {
            const docs = rows.filter(row => row.knowledgeBaseId === base.id)
            const folderCount = folders.filter(folder => folder.knowledgeBaseId === base.id).length
            return <article className="kb-base-card" key={base.id}>
              <button type="button" className="kb-base-open" data-testid="kb-base-item" onClick={() => openBase(base.id)}>
                <span className="kb-base-icon"><IconBook size={22} /></span>
                <span className="kb-base-name">{base.starred === true && <IconStar size={15} className="kb-base-pin" />}{titleOf(base)}</span>
                <span className="kb-base-description">{String(base.description ?? '').trim() || '暂无描述'}</span>
                <span className="kb-base-stats"><span>{docs.length} 篇文档</span><span>{folderCount} 个目录</span></span>
              </button>
              <div className="kb-base-card-actions">
                <span>{formatStamp(base.updatedAt ?? base.createdAt)}</span>
                <button type="button" aria-label={`${base.starred === true ? '取消置顶' : '置顶'}${titleOf(base)}`} onClick={() => mutate(() => api.patchRecord('knowledgeBases', base.id, { starred: base.starred !== true }), base.starred === true ? '已取消置顶' : '已置顶')}>{base.starred === true ? '取消置顶' : '置顶'}</button>
                <button type="button" aria-label={`编辑${titleOf(base)}`} onClick={() => setBaseForm({ id: base.id, title: titleOf(base), description: String(base.description ?? '') })}>编辑</button>
                <button type="button" className="kb-danger-link" aria-label={`删除${titleOf(base)}`} onClick={() => setPendingBaseDelete(base)}>删除</button>
              </div>
            </article>
          })}
        </div>}
    </div>
  )

  const documentsView = selectedBase === null
    ? <Empty icon={<IconBook size={24} />} title="知识库不存在" action={<button type="button" className="btn" onClick={backToBases}>返回知识库</button>} />
    : <div className="kb-documents" data-testid="kb-documents">
      <nav className="kb-breadcrumb" aria-label="当前位置">
        <button type="button" onClick={backToBases}>知识库</button><span>/</span><strong>{titleOf(selectedBase)}</strong>
      </nav>
      <header className="kb-collection-head">
        <div><h2>{titleOf(selectedBase)}</h2><p>{String(selectedBase.description ?? '').trim() || '在此整理和阅读文档'}</p></div>
        <button type="button" className="kb-new-note" onClick={() => setBaseForm({ id: selectedBase.id, title: titleOf(selectedBase), description: String(selectedBase.description ?? '') })}>编辑知识库</button>
      </header>
      <div className="kb-documents-shell">
        <aside className="kb-folder-col">
          <div className="kb-folder-head"><h3>目录</h3><button type="button" aria-label="新建目录" title="新建目录" onClick={() => setFolderForm({ id: '', title: '' })}><IconPlus size={16} /></button></div>
          <nav aria-label="文档目录" className="kb-folder-tree">
            <button type="button" className={`kb-folder-item ${selectedFolderId === '' ? 'is-active' : ''}`} aria-current={selectedFolderId === '' ? 'page' : undefined} onClick={() => openFolder('')}>
              <Folder size={17} /><span>全部文档</span><small>{baseRows.length}</small>
            </button>
            {folderRows.map(folder => <div className="kb-folder-row" key={folder.id}>
              <button type="button" className={`kb-folder-item ${selectedFolderId === folder.id ? 'is-active' : ''}`} style={{ paddingInlineStart: `${12 + folder.depth * 16}px` }} aria-current={selectedFolderId === folder.id ? 'page' : undefined} onClick={() => openFolder(folder.id)}>
                <Folder size={16} /><span>{titleOf(folder)}</span><small>{baseRows.filter(row => row.folderId === folder.id).length}</small>
              </button>
              {selectedFolderId === folder.id && <span className="kb-folder-actions">
                <button type="button" title="重命名目录" aria-label={`重命名${titleOf(folder)}`} onClick={() => setFolderForm({ id: folder.id, title: titleOf(folder) })}>改名</button>
                <button type="button" title="删除目录" aria-label={`删除目录${titleOf(folder)}`} onClick={() => setPendingFolderDelete(folder)}>删除</button>
              </span>}
            </div>)}
          </nav>
        </aside>
        <section className="kb-doc-list" aria-label="文档列表">
          <div className="kb-doc-list-head">
            <div><h3>{selectedFolderId === '' ? '全部文档' : titleOf(baseFolders.find(folder => folder.id === selectedFolderId))}</h3><span>{subtitle}</span></div>
            <button type="button" className="kb-create" data-testid="kb-new" disabled={busy} onClick={() => createNote()}><IconPlus size={16} />{TEXT.create}</button>
          </div>
          <div className="kb-doc-toolbar">
            <label className="kb-doc-search"><IconSearch size={17} /><input type="search" data-testid="kb-search" aria-label={TEXT.searchLabel} placeholder={TEXT.search} value={keyword} onChange={event => setKeyword(event.target.value)} /></label>
            <select aria-label="按标签筛选" data-testid="kb-tag-filter" value={activeTag} onChange={event => setActiveTag(event.target.value)}>
              <option value="">全部标签</option>{tagCounts.map(([tag, count]) => <option key={tag} value={tag}>{tag} · {count}</option>)}
            </select>
            <select aria-label="按来源筛选" data-testid="kb-source-filter" value={activeSource} onChange={event => setActiveSource(event.target.value)}>
              <option value="">全部来源</option>{sourceCounts.types.map(([type, count]) => <option key={type} value={type}>{labelOf(type)} · {count}</option>)}<option value={SOURCE_NONE}>无来源 · {sourceCounts.none}</option>
            </select>
            <select aria-label="文档排序" value={sortOrder} onChange={event => setSortOrder(event.target.value)}><option value="recent">最近更新</option><option value="title">标题 A–Z</option></select>
            <div className="kb-layout-switch" role="group" aria-label="显示方式">
              <button type="button" className={layout === 'grid' ? 'is-active' : ''} aria-label="卡片视图" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid size={17} /></button>
              <button type="button" className={layout === 'list' ? 'is-active' : ''} aria-label="列表视图" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={17} /></button>
            </div>
          </div>
          {visible.length === 0
            ? <div data-testid={baseRows.length === 0 ? 'kb-empty' : 'kb-list-empty'}><Empty icon={<FileText size={24} />} title={baseRows.length === 0 ? TEXT.empty : !hasFilter && selectedFolderId !== '' ? '此目录还没有文档' : '没有匹配的文档'} hint={baseRows.length === 0 ? TEXT.emptyHint : !hasFilter && selectedFolderId !== '' ? '在当前目录新建一篇文档' : '调整关键词、标签或目录后再试'} action={hasFilter ? <button type="button" className="btn" onClick={clearFilters}>清空筛选</button> : undefined} /></div>
            : <div className={`kb-document-grid ${layout === 'list' ? 'is-list' : ''}`} data-testid="kb-cards">
              {visible.map(row => <button type="button" className="kb-document-card" key={row.id} data-testid="kb-item" onClick={() => selectNote(row.id)}>
                <span className="kb-document-card-title"><FileText size={17} />{titleOf(row)}</span>
                <span className="kb-document-card-snippet">{snippetOf(row) || '暂无正文'}</span>
                <span className="kb-document-card-foot"><span>{tagsOf(row).slice(0, 2).map(tag => <span className="kb-document-tag" key={tag}>#{tag}</span>)}</span><time>{formatStamp(row.updatedAt ?? row.createdAt)}</time></span>
              </button>)}
            </div>}
        </section>
      </div>
    </div>

  return (
    <div className="kb" data-module="knowledge">
      {reading ? (
        <div className="kb-split" data-testid="kb-split">
          <aside className={`kb-toc-col ${listOpen ? 'is-open' : ''}`} id="kb-reading-list">
            <div className="kb-toc-head">
              <h2>{TEXT.toc}</h2>
              <span>{TEXT.totalText(baseRows.length)}</span>
            </div>
            <nav className="kb-toc-body kb-toc" data-testid="kb-toc" aria-label={TEXT.toc}>
              {tocGroups.map(group => (
                <section className="kb-toc-group" key={group.key}>
                  <h3 className="kb-toc-group-title">
                    {group.label}
                    <span className="kb-tag-count">{group.list.length}</span>
                  </h3>
                  <ul className="kb-toc-list">
                    {group.list.map(row => {
                      const active = row.id === selectedId
                      return (
                        <li key={row.id}>
                          <button
                            type="button"
                            className={`kb-toc-item ${active ? 'is-active' : ''}`}
                            data-testid="kb-toc-item"
                            aria-current={active ? 'true' : undefined}
                            onClick={() => selectNote(row.id)}
                          >
                            {row.starred === true && <IconStar className="kb-item-star" size={12} />}
                            <span className="kb-toc-item-text">{titleOf(row)}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </nav>
          </aside>

          <article className="kb-read-col">
            <div className="kb-editor" data-testid="kb-editor">
              <div className="kb-read-nav">
                <button type="button" className="kb-back-link" onClick={backToBases}>知识库</button><span className="kb-crumb-separator">/</span>
                <button type="button" className="kb-back-link" aria-label={TEXT.backHome} data-testid="kb-back-home" onClick={backToHome}>{titleOf(selectedBase)}</button>
                <button type="button" className="kb-mobile-list-toggle" aria-expanded={listOpen} aria-controls="kb-reading-list" onClick={() => setListOpen(open => !open)}>
                  <IconMenu size={16} />{listOpen ? TEXT.listLess : TEXT.listMore}
                </button>
                <button type="button" className="kb-new-note" data-testid="kb-new" disabled={busy} onClick={() => createNote()}>
                  <IconPlus size={16} />{TEXT.create}
                </button>
              </div>
              <header className="kb-article-head">
                {view === 'edit'
                  ? (
                    <textarea
                      className="kb-title-input"
                      value={draft.title}
                      rows={1}
                      placeholder={TEXT.titlePlaceholder}
                      aria-label={TEXT.fieldTitle}
                      data-testid="kb-title-input"
                      onChange={event => setDraft(current => (current === null ? current : { ...current, title: event.target.value }))}
                    />
                  )
                  : <h2 className="kb-read-title">{titleOf(selected)}</h2>}
                <div className="kb-article-meta">
                  {stamp !== '' && <span>{TEXT.metaUpdated} {stamp}</span>}
                  <span>{TEXT.chars(draft.body.length)}</span>
                  {view === 'preview' && tagsOf(selected).map(tag => <Chip key={tag}>#{tag}</Chip>)}
                  {dirty && <Chip tone="warn">{TEXT.dirty}</Chip>}
                </div>
              </header>
              <div className="kb-editor-tools">
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
                  {starButton}
                  <button type="button" className="kb-new-action kb-btn-danger" aria-label={TEXT.delete} title={TEXT.delete} data-testid="kb-delete" disabled={busy} onClick={() => setPendingDelete(selected)}>
                    <IconTrash size={15} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm kb-ask-btn"
                    data-testid="kb-ask-ai"
                    disabled={typeof askAI !== 'function'}
                    title={typeof askAI === 'function' ? TEXT.askAIHint : TEXT.askAIUnwired}
                    onClick={askAboutNote}
                  >
                    <IconSparkles size={15} />
                    {TEXT.askAI}
                  </button>
              </div>

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

              <label className="kb-move-field"><Folder size={16} /><span>所在目录</span>
                <select aria-label="移动文档到目录" value={String(selected.folderId ?? '')} disabled={busy} onChange={event => moveSelectedDocument(event.target.value)}>
                  <option value="">全部文档</option>
                  {folderRows.map(folder => <option key={folder.id} value={folder.id}>{'　'.repeat(folder.depth)}{titleOf(folder)}</option>)}
                </select>
              </label>

              {view === 'edit' && (
                <div className="kb-editor-bar">
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
              )}

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
                {wikiLinks.hits.length > 0 && <Chip tone="accent">{TEXT.wikiResolved(wikiLinks.hits.length)}</Chip>}
                {wikiLinks.missing.length > 0 && (
                  <span className="kb-foot-miss" title={wikiLinks.missing.join('、')}>
                    {TEXT.wikiUnresolved(wikiLinks.missing.length)}
                  </span>
                )}
              </footer>

              {linksSection}
            </div>
          </article>
        </div>
      ) : (
        (stage === 'bases' ? baseList : documentsView)
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${titleOf(pendingDelete)}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={pendingNavigation !== null}
        title={TEXT.discardTitle}
        message={TEXT.discardMessage}
        onCancel={() => setPendingNavigation(null)}
        onConfirm={confirmNavigation}
      />
      <ConfirmDialog
        open={pendingBaseDelete !== null}
        title="删除知识库"
        message={pendingBaseDelete === null ? '' : `删除「${titleOf(pendingBaseDelete)}」及其中所有文档和目录？此操作无法恢复。`}
        busy={busy}
        onCancel={() => setPendingBaseDelete(null)}
        onConfirm={confirmBaseDelete}
      />
      <ConfirmDialog
        open={pendingFolderDelete !== null}
        title="删除目录"
        message={pendingFolderDelete === null ? '' : `删除「${titleOf(pendingFolderDelete)}」？目录中有文档或子目录时需先移走。`}
        busy={busy}
        onCancel={() => setPendingFolderDelete(null)}
        onConfirm={confirmFolderDelete}
      />
      {baseForm !== null && <div className="kb-modal-backdrop">
        <form className="kb-modal" role="dialog" aria-modal="true" aria-labelledby="kb-base-form-title" onSubmit={event => { event.preventDefault(); saveBaseForm() }}>
          <h2 id="kb-base-form-title">{baseForm.id ? '编辑知识库' : '新建知识库'}</h2>
          <label>名称<input autoFocus className="input" maxLength={200} value={baseForm.title} onChange={event => setBaseForm(current => ({ ...current, title: event.target.value }))} /></label>
          <label>描述<textarea className="textarea" maxLength={5000} rows={3} value={baseForm.description} onChange={event => setBaseForm(current => ({ ...current, description: event.target.value }))} placeholder="这座知识库收录什么内容？" /></label>
          <div className="kb-modal-actions"><button type="button" className="btn" onClick={() => setBaseForm(null)}>取消</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
        </form>
      </div>}
      {folderForm !== null && <div className="kb-modal-backdrop">
        <form className="kb-modal" role="dialog" aria-modal="true" aria-labelledby="kb-folder-form-title" onSubmit={event => { event.preventDefault(); saveFolderForm() }}>
          <h2 id="kb-folder-form-title">{folderForm.id ? '重命名目录' : '新建目录'}</h2>
          <label>目录名称<input autoFocus className="input" maxLength={200} value={folderForm.title} onChange={event => setFolderForm(current => ({ ...current, title: event.target.value }))} /></label>
          {!folderForm.id && <p className="kb-modal-hint">位置：{selectedFolderId === '' ? '知识库根目录' : titleOf(baseFolders.find(folder => folder.id === selectedFolderId))}</p>}
          <div className="kb-modal-actions"><button type="button" className="btn" onClick={() => setFolderForm(null)}>取消</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
        </form>
      </div>}
    </div>
  )
}
