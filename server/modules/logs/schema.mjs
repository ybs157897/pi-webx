import { FIELDS, todayISO } from '../../workbench/schema-fields.mjs'

export const schema = {
  logs: {
    text: { ...FIELDS.text, required: true },
    level: { ...FIELDS.level, default: 'info' },
    source: { ...FIELDS.tag, default: '' },
    date: { ...FIELDS.date, default: () => todayISO() },
  },
}
