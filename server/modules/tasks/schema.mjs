import { FIELDS } from '../../workbench/schema-fields.mjs'

export const schema = {
  tasks: {
    title: { ...FIELDS.title, required: true },
    done: { ...FIELDS.boolean, default: false },
    due: { ...FIELDS.optionalDate, default: null, nullable: true },
    note: { ...FIELDS.note, default: '' },
    originalText: { ...FIELDS.note, default: '' },
    // 生活秘书收集的幂等来源随任务导出；HTTP 通用写入口禁止客户端伪造。
    captureSessionId: { check: value => typeof value === 'string' && value.length > 0 && value.length <= 128, cast: value => value, message: '收集会话不合法' },
    captureEntryKey: { check: value => typeof value === 'string' && /^[\w.:-]{1,80}$/.test(value), cast: value => value, message: '收集标识不合法' },
    captureFingerprint: { check: value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), cast: value => value, message: '收集指纹不合法' },
    durationMinutes: {
      check: value => Number.isInteger(value) && value >= 1 && value <= 1440,
      cast: value => value, default: 30, message: '预计时长需要是 1 至 1440 分钟',
    },
    kind: {
      check: value => value === 'fixed' || value === 'flexible',
      cast: value => value, default: 'flexible', message: '事项类型只能是 fixed 或 flexible',
    },
    plannedDate: { ...FIELDS.optionalDate, default: null, nullable: true },
    startTime: {
      check: value => value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
      cast: value => value, default: null, nullable: true, message: '开始时间需要是 HH:mm 或留空',
    },
    endTime: {
      check: value => value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
      cast: value => value, default: null, nullable: true, message: '结束时间需要是 HH:mm 或留空',
    },
    priority: { ...FIELDS.priority, default: 'normal' },
    tag: { ...FIELDS.tag, default: '' },
  },
}
