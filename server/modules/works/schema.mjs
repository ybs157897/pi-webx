import { FIELDS } from '../../workbench/schema-fields.mjs'

export const schema = {
  works: {
    title: { ...FIELDS.title, required: true },
    note: { ...FIELDS.note, default: '' },
    status: { ...FIELDS.status, default: 'todo' },
    scheduledDate: { ...FIELDS.optionalDate, default: null },
    startTime: {
      check: value => value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
      cast: value => value === '' ? null : value,
      default: null,
      message: '开始时间需要是 HH:mm 或留空',
    },
    endTime: {
      check: value => value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
      cast: value => value === '' ? null : value,
      default: null,
      message: '结束时间需要是 HH:mm 或留空',
    },
  },
}
