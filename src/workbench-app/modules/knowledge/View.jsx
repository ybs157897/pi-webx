
import { Folder } from 'lucide-react'

import { Chip, ConfirmDialog } from '../../ui.jsx'
import { IconMenu, IconPlus, IconSparkles, IconStar, IconTrash } from '../../icons.jsx'

import AssistantMarkdown from '../../pi-webx/AssistantMarkdown.jsx'

import { TEXT, tagsOf, titleOf, labelOf } from './model.jsx'

export default function View({
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
}) {
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
