import { FIELDS } from '../../workbench/schema-fields.mjs'

export const schema = {
  tasks: {
    title: { ...FIELDS.title, required: true },
    done: { ...FIELDS.boolean, default: false },
    due: { ...FIELDS.optionalDate, default: null },
    priority: { ...FIELDS.priority, default: 'normal' },
    tag: { ...FIELDS.tag, default: '' },
  },
}
