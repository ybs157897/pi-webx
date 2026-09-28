/**
 * WeKnora-inspired knowledge management: base cards → folder/document list → reading.
 * A document belongs to one base and at most one folder. Existing Markdown notes keep
 * their tags, refs and assistant action; [[title]] links resolve within the current base.
 * Browser-only listeners and link fetches stay in effects for server rendering.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../../api.mjs'
import { Chip, IconButton } from '../../ui.jsx'
import { IconLink, IconStar } from '../../icons.jsx'
import { formatStamp } from '../../util.mjs'

import './Knowledge.css'

import {
  TEXT,
  SOURCE_NONE,
  byUpdatedDesc,
  tagsOf,
  sourceTypesOf,
  rawTitleOf,
  titleOf,
  bodyOf,
  labelOf,
  parseWikiTitles,
  resolveWiki,
  normalizeLinks,
  sourceEntries,
  computeLinks
} from './model.jsx'

import { createKnowledgeActions } from './actions.jsx'

import { createKnowledgeCollections } from './Collections.jsx'

import View from './View.jsx'

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

  const {
    clearFilters, switchStage, openBase, backToBases, openFolder,
    selectNote, backToHome, switchView, openLink, confirmNavigation,
    save, createNote, saveBaseForm, saveFolderForm, confirmBaseDelete,
    confirmFolderDelete, moveSelectedDocument, toggleStar, confirmDelete, loadDemo,
    askAboutNote,
  } = createKnowledgeActions({
    setKeyword, setActiveTag, setActiveSource, setStage, setPref,
    dirty, selected, setPendingNavigation, setSelectedBaseId, setSelectedFolderId,
    selectedId, setSelectedId, rows, setListOpen, navigate,
    pendingNavigation, draft, notify, baseRows, setBusy,
    mutate, setSaved, setLinksToken, selectedBase, selectedBaseId,
    selectedFolderId, pendingId, baseForm, setBaseForm, folderForm,
    baseFolders, setFolderForm, pendingBaseDelete, setPendingBaseDelete, pendingFolderDelete,
    setPendingFolderDelete, pendingDelete, setPendingDelete, onLoadDemo, setDemoBusy,
    askAI, seedId,
  })

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

  const {
    baseList, documentsView,
  } = createKnowledgeCollections({
    bases, baseQuery, setBaseForm, setBaseQuery, empty,
    onLoadDemo, demoBusy, loadDemo, rows, folders,
    openBase, mutate, setPendingBaseDelete, selectedBase, backToBases,
    setFolderForm, selectedFolderId, openFolder, baseRows, folderRows,
    setPendingFolderDelete, baseFolders, subtitle, busy, createNote,
    keyword, setKeyword, activeTag, setActiveTag, tagCounts,
    activeSource, setActiveSource, sourceCounts, sortOrder, setSortOrder,
    layout, setLayout, visible, hasFilter, clearFilters,
    selectNote,
  })

  return <View {...{
    reading, listOpen, baseRows, tocGroups, selectedId,
    selectNote, backToBases, backToHome, selectedBase, setListOpen,
    busy, createNote, view, draft, setDraft,
    selected, stamp, dirty, switchView, starButton,
    setPendingDelete, askAI, askAboutNote, sources, openLink,
    moveSelectedDocument, folderRows, save, wikiLinks, linksSection,
    stage, baseList, documentsView, pendingDelete, confirmDelete,
    pendingNavigation, setPendingNavigation, confirmNavigation, pendingBaseDelete, setPendingBaseDelete,
    confirmBaseDelete, pendingFolderDelete, setPendingFolderDelete, confirmFolderDelete, baseForm,
    saveBaseForm, setBaseForm, folderForm, saveFolderForm, setFolderForm,
    selectedFolderId, baseFolders,
  }} />
}
