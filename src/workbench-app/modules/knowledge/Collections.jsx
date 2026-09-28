
import { FileText, Folder, LayoutGrid, List } from 'lucide-react'
import { api } from '../../api.mjs'
import { Empty } from '../../ui.jsx'
import { IconBook, IconPlus, IconSearch, IconStar } from '../../icons.jsx'
import { formatStamp } from '../../util.mjs'

import { TEXT, SOURCE_NONE, byUpdatedDesc, tagsOf, titleOf, snippetOf, labelOf } from './model.jsx'

export function createKnowledgeCollections({
  bases, baseQuery, setBaseForm, setBaseQuery, empty,
  onLoadDemo, demoBusy, loadDemo, rows, folders,
  openBase, mutate, setPendingBaseDelete, selectedBase, backToBases,
  setFolderForm, selectedFolderId, openFolder, baseRows, folderRows,
  setPendingFolderDelete, baseFolders, subtitle, busy, createNote,
  keyword, setKeyword, activeTag, setActiveTag, tagCounts,
  activeSource, setActiveSource, sourceCounts, sortOrder, setSortOrder,
  layout, setLayout, visible, hasFilter, clearFilters,
  selectNote,
}) {
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
  return { baseList, documentsView }
}
