

import { byDateDesc } from '../../util.mjs'

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
  tasks: '我的待办',
  plans: '安排建议',
  fixes: '问题修复',
  logs: '日志查询',
  requirements: '需求管理',
  codes: '代码开发',
  knowledge: '知识库',
}

/** 客户端反链扫描范围：全部数组模块（与 store.links() 对齐）。 */
const LINK_SCAN_MODULES = [
  'tasks', 'plans', 'fixes', 'logs', 'requirements', 'codes', 'knowledge',
]
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
      const collection = data?.[ref.type]
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
  return { outgoing, incoming }
}

export {
  TEXT, LINK_LABELS, LINK_SCAN_MODULES, SOURCE_NONE, byUpdatedDesc,
  tagsOf, refsOf, sourceTypesOf, rawTitleOf, titleOf,
  bodyOf, snippetOf, labelOf, parseTags, WIKI_PATTERN,
  parseWikiTitles, resolveWiki, buildRefs, normalizeLinks, linkTitleOf,
  sourceEntries, computeLinks,
}
