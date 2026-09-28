import { ConfirmDialog, Field, FieldGroup, FormModal, Segmented } from '../../ui.jsx'
import { TEXT, STATUS_OPTIONS } from './model.jsx'
import ScheduleFields from './ScheduleFields.jsx'

export default function RecordDialogs({ form, busy, setForm, submitForm, pendingDelete, setPendingDelete, confirmDelete }) {
  return <>
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
            <FieldGroup label={TEXT.fieldStatus}>
              <Segmented
                options={STATUS_OPTIONS}
                value={form.status}
                onChange={next => setForm(current => ({ ...current, status: next }))}
                label={TEXT.fieldStatus}
              />
            </FieldGroup>
            <ScheduleFields form={form} setForm={setForm} busy={busy} />
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
                placeholder="前端, 验收"
                onChange={event => setForm(current => ({ ...current, tags: event.target.value }))}
              />
            </Field>
          </>
        )}
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteConfirm}
        message={pendingDelete === null ? '' : `「${pendingDelete.title}」${TEXT.deleteMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
  </>
}
