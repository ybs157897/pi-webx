

import {
  ConfirmDialog,
  Empty,
  Field,
  FieldGroup,
  FormModal,
  IconButton,
  Modal,
  Segmented
} from '../../ui.jsx'
import { IconClose, IconCode, IconPlus, IconRefresh, IconTrash } from '../../icons.jsx'

import { TEXT, STATUS_OPTIONS, statusOf, titleOf, isMac } from './model.jsx'

export default function View({
  treeOpen, setTreeOpen, refreshData, draftTitle, rows,
  requestNew, empty, onLoadDemo, demoBusy, loadDemo,
  groups, activeId, requestOpen, dirty, setPendingDelete,
  active, draft, openItems, requestClose, setDraft,
  busy, save, gutterRef, lineNumbers, syncGutter,
  updatedText, adding, setAdding, create, newDraft,
  setNewDraft, pending, setPending, discardIntent, saveIntent,
  pendingDelete, confirmDelete,
}) {
  return (
    <div className="codes-shell" data-module="codes" data-tree={treeOpen ? 'open' : 'closed'}>
      <div className="codes-activity" role="toolbar" aria-label={TEXT.workspace}>
        <IconButton
          label={TEXT.toggleTree}
          className={`codes-act ${treeOpen ? 'is-active' : ''}`}
          onClick={() => setTreeOpen(open => !open)}
        >
          <IconCode size={18} />
        </IconButton>
        <IconButton label={TEXT.refresh} className="codes-act" onClick={refreshData}>
          <IconRefresh size={18} />
        </IconButton>
        <span className="codes-activity-title ellipsis">{draftTitle === '' ? TEXT.module : draftTitle}</span>
      </div>

      <aside className="codes-explorer" aria-label={TEXT.tree} data-testid="codes-tree-panel">
        <div className="codes-explorer-head">
          <h3 className="codes-explorer-title">{TEXT.tree}</h3>
          <span className="codes-explorer-count" data-testid="codes-count">{rows.length}</span>
          <span data-testid="codes-new">
            <IconButton label={TEXT.add} onClick={() => requestNew()}>
              <IconPlus size={17} />
            </IconButton>
          </span>
        </div>

        <div className="codes-tree">
          {rows.length === 0
            ? (
              <div className="codes-blank" data-testid="codes-tree-empty">
                <Empty
                  icon={<IconCode size={22} />}
                  title={TEXT.empty}
                  hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
                  action={empty === true && typeof onLoadDemo === 'function'
                    ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="codes-load-demo"
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
            : groups.map(group => (
              <div className="tree-group" key={group.key} data-testid="codes-tree-group">
                <p className="tree-group-head">{group.label}</p>
                {group.items.map(row => (
                  <div
                    className={`codes-item ${row.id === activeId ? 'is-active' : ''}`}
                    key={row.id}
                    data-testid="code-item"
                  >
                    <button
                      type="button"
                      data-testid="codes-tree-item"
                      className="tree-item"
                      data-status={statusOf(row.status).value}
                      aria-pressed={row.id === activeId}
                      onClick={() => requestOpen(row.id)}
                    >
                      <span className="tree-name">{titleOf(row)}</span>
                      {row.id === activeId && dirty && <span className="dot-dirty" data-testid="codes-dirty-dot" />}
                      <span className="tree-dot" aria-hidden="true" />
                    </button>
                    <IconButton
                      label={`${TEXT.delete}「${titleOf(row)}」`}
                      className="codes-item-del"
                      onClick={() => setPendingDelete(row)}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </aside>

      <section className="codes-editor" aria-label={TEXT.workspace}>
        {active === null || draft === null
          ? (
            <div className="codes-blank-editor" data-testid="codes-editor-empty">
              <Empty icon={<IconCode size={22} />} title={TEXT.editorEmpty} hint={TEXT.editorEmptyHint} />
            </div>
          )
          : (
            <div className="codes-frame" data-testid="codes-editor">
              <div className="editor-tabs" role="tablist" aria-label={TEXT.tree}>
                {openItems.map(row => {
                  const isActive = row.id === activeId
                  return (
                    <div
                      key={row.id}
                      role="presentation"
                      className={`editor-tab ${isActive ? 'is-active' : ''}`}
                      data-testid="codes-tab"
                    >
                      <button
                        type="button"
                        role="tab"
                        className="editor-tab-name"
                        data-testid="codes-tab-name"
                        aria-selected={isActive}
                        onClick={() => requestOpen(row.id)}
                      >
                        {isActive ? draftTitle : titleOf(row)}
                      </button>
                      {isActive && dirty && <span className="dot-dirty" data-testid="codes-tab-dirty" />}
                      <IconButton
                        label={`${TEXT.closeTab}「${titleOf(row)}」`}
                        className="editor-tab-close"
                        onClick={() => requestClose(row.id)}
                      >
                        <IconClose size={14} />
                      </IconButton>
                    </div>
                  )
                })}
              </div>

              <div className="editor-toolbar">
                <Field label={TEXT.title} className="toolbar-title">
                  <input
                    className="input"
                    data-testid="codes-title-input"
                    value={draft.title}
                    placeholder={TEXT.addPlaceholder}
                    onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                  />
                </Field>
                <Field label={TEXT.project} className="toolbar-project">
                  <input
                    className="input"
                    data-testid="codes-project-input"
                    value={draft.project}
                    onChange={event => setDraft(current => ({ ...current, project: event.target.value }))}
                  />
                </Field>
                <FieldGroup label={TEXT.status} className="toolbar-status">
                  <span data-testid="codes-status-select">
                    <Segmented
                      label={TEXT.status}
                      options={STATUS_OPTIONS}
                      value={draft.status}
                      onChange={value => setDraft(current => ({ ...current, status: value }))}
                    />
                  </span>
                </FieldGroup>
                <div className="editor-actions">
                  <IconButton label={TEXT.delete} tone="danger" onClick={() => setPendingDelete(active)}>
                    <IconTrash size={16} />
                  </IconButton>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    data-testid="codes-save"
                    disabled={!dirty || draft.title.trim() === '' || busy}
                    onClick={save}
                  >
                    {busy ? TEXT.saving : `${TEXT.save}（${isMac ? '⌘' : 'Ctrl+'}S）`}
                  </button>
                </div>
              </div>

              {/* textarea 必须 wrap="off"：软换行会让行号与文字错位。 */}
              <div className="editor-area">
                <div className="editor-gutter" aria-hidden="true" data-testid="codes-gutter" ref={gutterRef}>
                  {lineNumbers.map(n => <span key={n}>{n}</span>)}
                </div>
                <textarea
                  className="editor-input"
                  data-testid="codes-editor-input"
                  wrap="off"
                  aria-label={TEXT.note}
                  value={draft.note}
                  maxLength={5000}
                  spellCheck={false}
                  onChange={event => setDraft(current => ({ ...current, note: event.target.value }))}
                  onScroll={syncGutter}
                />
              </div>

              <div className="editor-status" data-testid="codes-statusbar">
                <span className="editor-status-title" data-testid="codes-statusbar-title">{draftTitle}</span>
                <span className="editor-status-item">{TEXT.projectLabel} {draft.project.trim() === '' ? '—' : draft.project.trim()}</span>
                <span className="editor-status-item" data-status={statusOf(draft.status).value}>{statusOf(draft.status).label}</span>
                <span className="editor-status-item" data-testid="codes-line-count">{TEXT.lines} {lineNumbers.length}</span>
                <span className="editor-status-item" data-testid="codes-char-count">{TEXT.chars} {draft.note.length}</span>
                {updatedText !== '' && (
                  <span className="editor-status-item editor-status-time">{TEXT.updatedAt} {updatedText}</span>
                )}
                <span
                  className={`editor-status-save ${dirty ? 'is-dirty' : ''}`}
                  data-testid="codes-save-state"
                >
                  {busy ? TEXT.saving : (dirty ? TEXT.unsaved : TEXT.saved)}
                </span>
              </div>
            </div>
          )}
      </section>

      <FormModal
        open={adding}
        title={TEXT.add}
        submitText={TEXT.submit}
        busy={busy}
        onClose={() => setAdding(false)}
        onSubmit={() => create(newDraft)}
      >
        <Field label={TEXT.title}>
          <input
            className="input"
            value={newDraft.title}
            placeholder={TEXT.addPlaceholder}
            onChange={event => setNewDraft(current => ({ ...current, title: event.target.value }))}
          />
        </Field>
        <Field label={TEXT.project} hint={TEXT.projectHint}>
          <input
            className="input"
            value={newDraft.project}
            onChange={event => setNewDraft(current => ({ ...current, project: event.target.value }))}
          />
        </Field>
        <FieldGroup label={TEXT.status}>
          <Segmented
            label={TEXT.status}
            options={STATUS_OPTIONS}
            value={newDraft.status}
            onChange={value => setNewDraft(current => ({ ...current, status: value }))}
          />
        </FieldGroup>
        <Field label={TEXT.note}>
          <textarea
            className="textarea"
            value={newDraft.note}
            maxLength={5000}
            placeholder={TEXT.notePlaceholder}
            onChange={event => setNewDraft(current => ({ ...current, note: event.target.value }))}
          />
        </Field>
      </FormModal>

      <Modal
        open={pending !== null}
        title={TEXT.discardTitle}
        onClose={() => setPending(null)}
        footer={(
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setPending(null)}>
              取消
            </button>
            <button type="button" className="btn" data-testid="codes-discard" disabled={busy} onClick={discardIntent}>
              {TEXT.discard}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="codes-save-intent"
              disabled={busy || draft === null || draft.title.trim() === ''}
              onClick={saveIntent}
            >
              {TEXT.saveAndLeave}
            </button>
          </>
        )}
      >
        <p className="confirm-message">{TEXT.discardMessage}</p>
      </Modal>

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
