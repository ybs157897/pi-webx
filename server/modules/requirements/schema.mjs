import { FIELDS } from '../../workbench/schema-fields.mjs'

export const schema = {
  requirements: {
    title: { ...FIELDS.title, required: true },
    priority: { ...FIELDS.priority, default: 'normal' },
    status: { ...FIELDS.status, default: 'todo' },
    note: { ...FIELDS.note, default: '' },
  },
}
