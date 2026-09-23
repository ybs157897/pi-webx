/**
 * 工作台数据 schema：模块定义、字段校验、默认值。浏览器数据层在每次
 * 写入和旧版 JSON 导入时复用同一份校验。零依赖。
 * @module shared/schema
 */

/** 数组型模块 key（记录直接挂在 state 下）。 */
export const ARRAY_MODULES = ['tasks', 'works', 'hotspots', 'exercises', 'meals', 'finance', 'reviews']

/** 资料+时间轴型模块 key（{ profile, records }）。 */
export const ATOM_MODULES = ['pets', 'relationships']

/** 全部模块 key。 */
export const MODULES = [...ARRAY_MODULES, ...ATOM_MODULES]

/** 模块中文名（AI 工具与提示共用）。 */
export const MODULE_LABELS = {
  tasks: '今日规划',
  works: '工作助理',
  hotspots: '行业热点',
  exercises: '运动打卡',
  meals: '饮食记录',
  finance: '本月收支',
  reviews: '每日复盘',
  pets: '宠物日记',
  relationships: '亲密关系',
}

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
const FIELDS = {
  id: {
    check: v => ID_RE.test(v), cast: v => String(v), message: 'id 格式不正确',
  },
  title: {
    check: v => typeof v === 'string' && v.trim() !== '', cast: v => String(v).trim(), max: 200, message: '需要非空标题',
  },
  text: {
    check: v => typeof v === 'string' && v.trim() !== '', cast: v => String(v).trim(), max: 5000, message: '需要非空文本',
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
  meal: {
    check: v => ['breakfast', 'lunch', 'dinner', 'snack'].includes(v), cast: v => v, message: '餐次只能是 breakfast/lunch/dinner/snack',
  },
  kind: {
    check: v => ['income', 'expense'].includes(v), cast: v => v, message: '类型只能是 income/expense',
  },
  mood: {
    check: v => Number.isInteger(v) && v >= 1 && v <= 5, cast: v => Math.min(5, Math.max(1, Math.round(Number(v)))), message: '心情只能是 1-5 的整数',
  },
  minutes: {
    check: v => Number.isFinite(v) && v >= 1, cast: v => Math.round(Number(v)), max: 1440, message: '分钟数需要是正数',
  },
  calories: {
    check: v => Number.isFinite(v) && v >= 0, cast: v => Math.round(Number(v)), max: 20000, message: '热量需要是非负数字',
  },
  amount: {
    check: v => Number.isFinite(v) && v >= 0, cast: v => Math.round(Number(v) * 100) / 100, max: 1e9, message: '金额需要是非负数字',
  },
  date: {
    check: validDate, cast: v => String(v), message: '日期格式需要是 YYYY-MM-DD',
  },
  optionalDate: {
    check: v => v === null || v === undefined || v === '' || validDate(v), cast: v => (v === null || v === undefined || v === '' ? null : String(v)), message: '日期格式需要是 YYYY-MM-DD 或留空',
  },
  url: {
    check: v => typeof v === 'string', cast: v => String(v).trim(), max: 2000, message: '链接需要是字符串',
  },
  imageUrl: {
    check: v => typeof v === 'string', cast: v => String(v).trim(), max: 8 * 1024 * 1024, message: '图片地址需要是字符串',
  },
  tag: {
    check: v => typeof v === 'string', cast: v => String(v).trim(), max: 40, message: '标签需要是字符串',
  },
}

/** 每个模块的可写字段：类型 → 是否必填 / 默认值。 */
const MODULE_SCHEMA = {
  tasks: {
    title: { ...FIELDS.title, required: true },
    done: { ...FIELDS.boolean, default: false },
    due: { ...FIELDS.optionalDate, default: null },
    priority: { ...FIELDS.priority, default: 'normal' },
    tag: { ...FIELDS.tag, default: '' },
  },
  works: {
    title: { ...FIELDS.title, required: true },
    note: { ...FIELDS.note, default: '' },
    status: { ...FIELDS.status, default: 'todo' },
  },
  hotspots: {
    title: { ...FIELDS.title, required: true },
    source: { ...FIELDS.tag, default: '' },
    url: { ...FIELDS.url, default: '' },
    note: { ...FIELDS.note, default: '' },
    date: { ...FIELDS.date, default: () => todayISO() },
    pinned: { ...FIELDS.boolean, default: false },
  },
  exercises: {
    type: { ...FIELDS.title, required: true },
    minutes: { ...FIELDS.minutes, required: true },
    date: { ...FIELDS.date, default: () => todayISO() },
    note: { ...FIELDS.note, default: '' },
  },
  meals: {
    meal: { ...FIELDS.meal, required: true },
    food: { ...FIELDS.title, required: true },
    calories: { ...FIELDS.calories, required: true },
    date: { ...FIELDS.date, default: () => todayISO() },
    note: { ...FIELDS.note, default: '' },
  },
  finance: {
    kind: { ...FIELDS.kind, required: true },
    amount: { ...FIELDS.amount, required: true },
    category: { ...FIELDS.tag, required: true },
    note: { ...FIELDS.note, default: '' },
    date: { ...FIELDS.date, default: () => todayISO() },
  },
  reviews: {
    date: { ...FIELDS.date, default: () => todayISO() },
    wins: { ...FIELDS.text, required: true },
    lessons: { ...FIELDS.note, default: '' },
    mood: { ...FIELDS.mood, default: 4 },
    tomorrow: { ...FIELDS.note, default: '' },
  },
}

/** 资料卡 profile 字段（pets / relationships 共用形状，各自允许的键略有不同）。 */
const ATOM_PROFILE_SCHEMA = {
  pets: {
    name: { ...FIELDS.title, default: '' },
    species: { ...FIELDS.tag, default: '' },
    birthday: { ...FIELDS.optionalDate, default: null },
    avatarUrl: { ...FIELDS.imageUrl, default: '' },
    note: { ...FIELDS.note, default: '' },
  },
  relationships: {
    name: { ...FIELDS.title, default: '' },
    avatarUrl: { ...FIELDS.imageUrl, default: '' },
    since: { ...FIELDS.optionalDate, default: null },
    note: { ...FIELDS.note, default: '' },
  },
}

/** 时间轴记录字段（两个 atom 模块共用）。 */
const ATOM_RECORD_SCHEMA = {
  title: { ...FIELDS.title, required: true },
  note: { ...FIELDS.note, default: '' },
  date: { ...FIELDS.date, default: () => todayISO() },
  photoUrl: { ...FIELDS.imageUrl, default: '' },
}

/**
 * 校验并清洗一次写入的字段集合。
 * @param module - 模块 key。
 * @param fields - 调用方给出的字段（未知键忽略，必填缺失或类型错误抛错）。
 * @param options - `partial` 为 true 时跳过必填与默认值（更新路径）。
 * @returns 清洗后的字段。
 */
export function validateFields(module, fields, options = {}) {
  const partial = options.partial === true
  const schema = partial ? MODULE_SCHEMA[module] : MODULE_SCHEMA[module]
  if (schema === undefined) throw new Error(`未知模块：${module}`)
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('字段需要是对象')
  }
  const out = {}
  const problems = []
  for (const [key, spec] of Object.entries(schema)) {
    const given = fields[key]
    if (given === undefined || given === null) {
      if (!partial && spec.required) {
        problems.push(`${key} 是必填项`)
        continue
      }
      if (!partial) out[key] = typeof spec.default === 'function' ? spec.default() : spec.default
      continue
    }
    if (!spec.check(given)) {
      problems.push(`${key}：${spec.message}`)
      continue
    }
    const value = spec.cast(given)
    if (spec.max !== undefined && ((typeof value === 'string' && value.length > spec.max) || (typeof value === 'number' && value > spec.max))) {
      problems.push(`${key} 超过 ${spec.max} 字上限`)
      continue
    }
    out[key] = value
  }
  if (problems.length > 0) throw new Error(`${MODULE_LABELS[module] ?? module}数据不合法：${problems.join('；')}`)
  return out
}

/**
 * 校验并清洗资料卡 profile 写入。
 * @param module - `pets` 或 `relationships`。
 * @param fields - 调用方给出的字段。
 * @param options - `partial` 为 true 时只清洗给出的键。
 * @returns 清洗后的 profile 字段。
 */
export function validateAtomProfile(module, fields, options = {}) {
  const schema = ATOM_PROFILE_SCHEMA[module]
  if (schema === undefined) throw new Error(`未知资料模块：${module}`)
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('资料字段需要是对象')
  const out = {}
  const problems = []
  for (const [key, spec] of Object.entries(schema)) {
    const given = fields[key]
    if (given === undefined) {
      if (options.partial !== true) out[key] = typeof spec.default === 'function' ? spec.default() : spec.default
      continue
    }
    if (given === null) {
      out[key] = typeof spec.default === 'function' ? spec.default() : spec.default
      continue
    }
    if (!spec.check(given)) {
      problems.push(`${key}：${spec.message}`)
      continue
    }
    const value = spec.cast(given)
    if (spec.max !== undefined && typeof value === 'string' && value.length > spec.max) {
      problems.push(`${key} 超过 ${spec.max} 字上限`)
      continue
    }
    out[key] = value
  }
  if (problems.length > 0) throw new Error(`${MODULE_LABELS[module]}资料不合法：${problems.join('；')}`)
  return out
}

/**
 * 校验并清洗时间轴记录写入。
 * @param fields - 调用方给出的字段。
 * @param options - `partial` 为 true 时跳过必填与默认值。
 * @returns 清洗后的记录字段。
 */
export function validateAtomRecord(fields, options = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('记录字段需要是对象')
  const out = {}
  const problems = []
  for (const [key, spec] of Object.entries(ATOM_RECORD_SCHEMA)) {
    const given = fields[key]
    if (given === undefined || given === null) {
      if (options.partial !== true && spec.required) {
        problems.push(`${key} 是必填项`)
        continue
      }
      if (options.partial !== true) out[key] = typeof spec.default === 'function' ? spec.default() : spec.default
      continue
    }
    if (!spec.check(given)) {
      problems.push(`${key}：${spec.message}`)
      continue
    }
    const value = spec.cast(given)
    if (spec.max !== undefined && typeof value === 'string' && value.length > spec.max) {
      problems.push(`${key} 超过 ${spec.max} 字上限`)
      continue
    }
    out[key] = value
  }
  if (problems.length > 0) throw new Error(`时间轴记录不合法：${problems.join('；')}`)
  return out
}

/** 新建一份空 state。 */
export function emptyState(profile) {
  const state = { version: 1, profile: { ...profile }, chatLog: [] }
  for (const key of ARRAY_MODULES) state[key] = []
  for (const key of ATOM_MODULES) state[key] = { profile: {}, records: [] }
  return state
}
