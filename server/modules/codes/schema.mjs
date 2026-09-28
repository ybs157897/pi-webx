import { FIELDS } from '../../workbench/schema-fields.mjs'

export const schema = {
  codes: {
    title: { ...FIELDS.title, required: true },
    project: { ...FIELDS.tag, default: '' },
    status: { ...FIELDS.status, default: 'todo' },
    note: { ...FIELDS.note, default: '' },
  },
}
