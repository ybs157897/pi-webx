import { ConfirmDialog, Field, FieldGroup, FormModal, Segmented } from '../../ui.jsx'

import { TEXT, PRIORITY_OPTIONS, STATUS_OPTIONS, LOG_LEVELS } from './model.jsx'

export default function Dialogs({
  form, busy, setForm, submitForm, logFor,
  setLogFor, submitLog, logDraft, setLogDraft, pendingDelete,
  setPendingDelete, confirmDelete,
}) {
  return (<>
<FormModal
        open={form !== null}
        title={form === null || form.id === null ? TEXT.create : TEXT.edit}
        submitText={form === null || form.id === null ? TEXT.createSubmit : TEXT.save}
        busy={busy}
        onClose={() => setForm(null)}
        onSubmit={submitForm}
      >
        {form !== null && (
          <>
            <Field label={TEXT.fieldTitle}>
              <input
                className="input"
                value={form.title}
                onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
              />
            </Field>
            <FieldGroup label={TEXT.fieldPriority}>
              <Segmented
                options={PRIORITY_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
                value={form.priority}
                onChange={next => setForm(current => ({ ...current, priority: next }))}
                label={TEXT.fieldPriority}
              />
            </FieldGroup>
            <FieldGroup label={TEXT.fieldStatus}>
              <Segmented
                options={STATUS_OPTIONS}
                value={form.status}
                onChange={next => setForm(current => ({ ...current, status: next }))}
                label={TEXT.fieldStatus}
              />
            </FieldGroup>
            <Field label={TEXT.fieldNote}>
              <textarea
                className="textarea"
                value={form.note}
                placeholder={TEXT.notePlaceholder}
                onChange={event => setForm(current => ({ ...current, note: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.fieldTags} hint={TEXT.tagsHint}>
              <input
                className="input"
                value={form.tags}
                placeholder="bug, 界面"
                onChange={event => setForm(current => ({ ...current, tags: event.target.value }))}
              />
            </Field>
          </>
        )}
      </FormModal>

      <FormModal
        open={logFor !== null}
        title={TEXT.logTitle}
        submitText={TEXT.logSubmit}
        busy={busy}
        hint={logFor === null ? undefined : `${TEXT.logHint}：「${String(logFor.title ?? '')}」`}
        onClose={() => setLogFor(null)}
        onSubmit={submitLog}
      >
        <Field label={TEXT.logText}>
          <textarea
            className="textarea"
            value={logDraft.text}
            placeholder={TEXT.logPlaceholder}
            onChange={event => setLogDraft(current => ({ ...current, text: event.target.value }))}
          />
        </Field>
        <FieldGroup label={TEXT.logLevel}>
          <Segmented
            options={LOG_LEVELS.map(option => ({ value: option.value, label: option.label }))}
            value={logDraft.level}
            onChange={next => setLogDraft(current => ({ ...current, level: next }))}
            label={TEXT.logLevel}
          />
        </FieldGroup>
        <Field label={TEXT.logSource} hint={TEXT.logSourceHint}>
          <input
            className="input"
            value={logDraft.source}
            onChange={event => setLogDraft(current => ({ ...current, source: event.target.value }))}
          />
        </Field>
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${pendingDelete.title}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
  </>)
}
