/** 工作台模块共用字段、校验器及日期默认值。 */
/** 本机今天，格式 YYYY-MM-DD。 */
export function todayISO(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_RE = /^[\w-]{8,64}$/

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** 字段校验器：返回清洗后的值，不合法抛出中文错误。 */
export const FIELDS = {
  id: {
    check: v => ID_RE.test(v), cast: v => String(v), message: 'id 格式不正确',
  },
  title: {
    check: v => typeof v === 'string' && v.trim() !== '', cast: v => String(v).trim(), max: 200, message: '需要非空标题',
  },
  text: {
    check: v => typeof v === 'string' && v.trim() !== '', cast: v => String(v).trim(), max: 5000, message: '需要非空文本',
  },
  body: {
    check: v => typeof v === 'string', cast: v => String(v), max: 50000, message: '正文必须是字符串',
  },
  note: {
    check: v => typeof v === 'string', cast: v => String(v), max: 5000, message: '备注必须是字符串',
  },
  boolean: {
    check: v => typeof v === 'boolean', cast: v => v === true, message: '需要布尔值',
  },
  priority: {
    check: v => ['low', 'normal', 'high'].includes(v), cast: v => (['low', 'normal', 'high'].includes(v) ? v : 'normal'), message: '优先级只能是 low/normal/high',
  },
  status: {
    check: v => ['todo', 'doing', 'done'].includes(v), cast: v => (['todo', 'doing', 'done'].includes(v) ? v : 'todo'), message: '状态只能是 todo/doing/done',
  },
  category: {
    check: v => ['new', 'change', 'fix', 'enhancement'].includes(v), cast: v => (['new', 'change', 'fix', 'enhancement'].includes(v) ? v : 'new'), message: '需求分类只能是 new/change/fix/enhancement',
  },
  level: {
    check: v => ['info', 'warn', 'error'].includes(v), cast: v => (['info', 'warn', 'error'].includes(v) ? v : 'info'), message: '级别只能是 info/warn/error',
  },
  date: {
    check: validDate, cast: v => String(v), message: '日期格式需要是 YYYY-MM-DD',
  },
  optionalDate: {
    check: v => v === null || v === undefined || v === '' || validDate(v), cast: v => (v === null || v === undefined || v === '' ? null : String(v)), message: '日期格式需要是 YYYY-MM-DD 或留空',
  },
  recordId: {
    check: v => typeof v === 'string' && (v === '' || ID_RE.test(v)), cast: v => String(v), message: '关联 ID 格式不正确',
  },
  tag: {
    check: v => typeof v === 'string', cast: v => String(v).trim(), max: 40, message: '标签需要是字符串',
  },
  tags: {
    check: v => Array.isArray(v) && v.length <= 8 && v.every(item => typeof item === 'string' && item.trim() !== '' && item.length <= 40),
    cast: v => [...new Set(v.map(item => String(item).trim()))], max: 8, message: '标签需要是最多 8 个非空字符串',
  },
  refs: {
    check: v => Array.isArray(v) && v.length <= 20 && v.every(item => item !== null && typeof item === 'object' && typeof item.type === 'string' && typeof item.id === 'string' && item.id.length <= 64),
    cast: v => v.map(item => ({ type: String(item.type), id: String(item.id) })),
    max: 20, message: '关联需要是 { type, id } 数组（最多 20 条）',
  },
  starred: {
    check: v => typeof v === 'boolean', cast: v => v === true, message: '置顶需要是布尔值',
  },
}

/** 全部数组模块通用的关联/分组/置顶字段：旧数据导入时走默认值路径，天然向后兼容。 */
export const COMMON_FIELDS = {
  tags: { ...FIELDS.tags, default: () => [] },
  refs: { ...FIELDS.refs, default: () => [] },
  starred: { ...FIELDS.starred, default: false },
}

