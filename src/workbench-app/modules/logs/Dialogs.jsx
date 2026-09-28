import { ChipButton, ConfirmDialog, Field, FieldGroup, FormModal, Modal, Segmented } from '../../ui.jsx'

export { logsAgentPanel } from './agent-ui.js'

import { TEXT, LEVEL_OPTIONS, EMPTY_FILTERS } from './model.jsx'

export default function Dialogs({
  queryOpen, setQueryOpen, setQueryDraft, queryFormId, submitQuery,
  queryDraft, levelCounts, sourcePool, recordOpen, busy,
  setRecordOpen, submitRecord, record, setRecord, pendingDelete,
  setPendingDelete, confirmDelete,
}) {
  return (<>
<Modal
        wide
        open={queryOpen}
        title={TEXT.queryTitle}
        onClose={() => setQueryOpen(false)}
        footer={(
          <>
            <button
              type="button"
              className="btn"
              data-testid="logs-query-reset"
              onClick={() => setQueryDraft(EMPTY_FILTERS)}
            >
              {TEXT.reset}
            </button>
            <button type="submit" form={queryFormId} className="btn btn-primary" data-testid="logs-query-submit">
              {TEXT.submitQuery}
            </button>
          </>
        )}
      >
        <form
          id={queryFormId}
          className="form"
          data-testid="logs-query-form"
          onSubmit={event => {
            event.preventDefault()
            submitQuery()
          }}
        >
          <Field label={TEXT.keyword}>
            <input
              className="input"
              data-testid="logs-query-keyword"
              value={queryDraft.keyword}
              placeholder={TEXT.keywordPlaceholder}
              onChange={event => setQueryDraft(current => ({ ...current, keyword: event.target.value }))}
            />
          </Field>

          <FieldGroup label={TEXT.level} hint={TEXT.levelHint}>
            <div className="logs-chip-group" data-testid="logs-query-levels">
              {LEVEL_OPTIONS.map(option => (
                <ChipButton
                  key={option.value}
                  tone={option.tone}
                  active={queryDraft.levels.includes(option.value)}
                  onClick={() => setQueryDraft(current => ({
                    ...current,
                    levels: current.levels.includes(option.value)
                      ? current.levels.filter(item => item !== option.value)
                      : [...current.levels, option.value],
                  }))}
                >
                  {option.label} {levelCounts[option.value]}
                </ChipButton>
              ))}
            </div>
          </FieldGroup>

          <div className="form-row">
            <Field label={TEXT.source}>
              <select
                className="select"
                data-testid="logs-query-source"
                value={queryDraft.source}
                onChange={event => setQueryDraft(current => ({ ...current, source: event.target.value }))}
              >
                <option value="">{TEXT.sourceAll}</option>
                {sourcePool.map(item => <option key={item.value} value={item.value}>{item.value}</option>)}
              </select>
            </Field>
            <Field label={TEXT.from}>
              <input
                type="date"
                className="input"
                data-testid="logs-query-from"
                value={queryDraft.from}
                onChange={event => setQueryDraft(current => ({ ...current, from: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.to}>
              <input
                type="date"
                className="input"
                data-testid="logs-query-to"
                value={queryDraft.to}
                onChange={event => setQueryDraft(current => ({ ...current, to: event.target.value }))}
              />
            </Field>
          </div>

          <p className="form-hint">{TEXT.queryHint}</p>
        </form>
      </Modal>

      <FormModal
        open={recordOpen}
        title={TEXT.recordTitle}
        submitText={TEXT.submitRecord}
        busy={busy}
        hint={TEXT.recordHint}
        onClose={() => setRecordOpen(false)}
        onSubmit={submitRecord}
      >
        <div data-testid="logs-record-form">
          <Field label={TEXT.content}>
            <textarea
              className="textarea"
              data-testid="logs-record-text"
              value={record.text}
              placeholder={TEXT.contentPlaceholder}
              onChange={event => setRecord(current => ({ ...current, text: event.target.value }))}
            />
          </Field>

          <FieldGroup label={TEXT.level}>
            <div data-testid="logs-record-level">
              <Segmented
                options={LEVEL_OPTIONS}
                value={record.level}
                label={TEXT.level}
                onChange={value => setRecord(current => ({ ...current, level: value }))}
              />
            </div>
          </FieldGroup>

          <div className="form-row">
            <Field label={TEXT.source} hint={TEXT.sourcePlaceholder}>
              <input
                className="input"
                data-testid="logs-record-source"
                list="logs-record-sources"
                value={record.source}
                onChange={event => setRecord(current => ({ ...current, source: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.date} hint={TEXT.dateHint}>
              <input
                type="date"
                className="input"
                data-testid="logs-record-date"
                value={record.date}
                onChange={event => setRecord(current => ({ ...current, date: event.target.value }))}
              />
            </Field>
          </div>

          <Field label={TEXT.tags} hint={TEXT.tagsHint}>
            <input
              className="input"
              data-testid="logs-record-tags"
              value={record.tags}
              placeholder={TEXT.tagsPlaceholder}
              onChange={event => setRecord(current => ({ ...current, tags: event.target.value }))}
            />
          </Field>

          <datalist id="logs-record-sources">
            {sourcePool.map(item => <option key={item.value} value={item.value} />)}
          </datalist>
        </div>
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : TEXT.deleteMessage}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
  </>)
}
