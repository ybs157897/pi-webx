import { FIELDS } from '../../workbench/schema-fields.mjs'

const ID_RE = /^[\w-]{8,64}$/
const KEY_RE = /^[\w.:-]{1,80}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function date(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function normalizePlanEntries(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('规划需要 1 至 20 条事项')
  const ids = new Set()
  return value.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['taskId', 'expectedUpdatedAt', 'plannedDate', 'startTime', 'endTime', 'kind', 'reason'].includes(key))) {
      throw new Error('规划条目字段不合法')
    }
    if (typeof entry.taskId !== 'string' || !ID_RE.test(entry.taskId) || ids.has(entry.taskId)) throw new Error('规划事项 ID 无效或重复')
    ids.add(entry.taskId)
    if (typeof entry.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(entry.expectedUpdatedAt))) throw new Error('规划缺少事项版本')
    if (!date(entry.plannedDate)) throw new Error('规划日期不合法')
    const start = entry.startTime ?? null
    const end = entry.endTime ?? null
    if ((start === null) !== (end === null) || (start !== null && (!TIME_RE.test(start) || !TIME_RE.test(end) || start >= end))) {
      throw new Error('规划时段需要成对填写且结束时间晚于开始时间')
    }
    if (entry.kind !== undefined && entry.kind !== 'fixed' && entry.kind !== 'flexible') throw new Error('事项类型不合法')
    if (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > 500)) throw new Error('安排理由不合法')
    return {
      taskId: entry.taskId, expectedUpdatedAt: entry.expectedUpdatedAt, plannedDate: entry.plannedDate,
      startTime: start, endTime: end,
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason.trim() }),
    }
  })
}

export const schema = {
  plans: {
    title: { ...FIELDS.title, default: '安排建议' },
    sourceSessionId: { check: value => typeof value === 'string' && value.length > 0 && value.length <= 128, cast: value => value, required: true, message: '来源会话不合法' },
    planKey: { check: value => typeof value === 'string' && KEY_RE.test(value), cast: value => value, required: true, message: '规划标识不合法' },
    entries: { check: value => { try { normalizePlanEntries(value); return true } catch { return false } }, cast: normalizePlanEntries, required: true, message: '规划条目不合法' },
    note: { ...FIELDS.note, default: '' },
    appliedAt: { check: value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value))), cast: value => value, default: null, nullable: true, message: '应用时间不合法' },
  },
}
