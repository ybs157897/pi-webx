import { FIELDS } from '../../workbench/schema-fields.mjs'

export const schema = {
  works: {
    title: { ...FIELDS.title, required: true },
    note: { ...FIELDS.note, default: '' },
    status: { ...FIELDS.status, default: 'todo' },
  },
}
