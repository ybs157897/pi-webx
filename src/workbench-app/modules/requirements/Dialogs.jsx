

import { ConfirmDialog, Field, FieldGroup, FormModal, Segmented } from '../../ui.jsx'

import { TEXT, PRIORITY_OPTIONS, STATUS_STEPS } from './model.jsx'

export default function Dialogs({ form, busy, setForm, submitForm, pendingDelete, setPendingDelete, confirmDelete }) {
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
                placeholder={TEXT.titlePlaceholder}
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
                options={STATUS_STEPS.map(step => ({ value: step.value, label: step.label }))}
                value={form.status}
                onChange={next => setForm(current => ({ ...current, status: next }))}
                label={TEXT.fieldStatus}
              />
            </FieldGroup>
            <Field label={TEXT.fieldTags} hint={TEXT.tagsHint}>
              <input
                className="input"
                value={form.tags}
                placeholder="体验, 设计"
                onChange={event => setForm(current => ({ ...current, tags: event.target.value }))}
              />
            </Field>
            <Field label={TEXT.fieldNote} hint={TEXT.noteHint}>
              <textarea
                className="textarea req-note-input"
                value={form.note}
                placeholder={TEXT.notePlaceholder}
                onChange={event => setForm(current => ({ ...current, note: event.target.value }))}
              />
            </Field>
          </>
        )}
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${String(pendingDelete.title ?? '')}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
  </>)
}
