/**
 * 工作台数据 schema：模块定义、字段校验、默认值。浏览器数据层在每次
 * 写入和旧版 JSON 导入时复用同一份校验。零依赖。
 * @module shared/schema
 */

/** 数组型模块 key（记录直接挂在 state 下）。 */
export const ARRAY_MODULES = ['tasks', 'works', 'hotspots', 'exercises', 'meals', 'finance', 'reviews', 'fixes', 'logs', 'requirements', 'codes', 'knowledge', 'knowledgeBases', 'knowledgeFolders']

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
  fixes: '问题修复',
  logs: '日志查询',
  requirements: '需求管理',
  codes: '代码开发',
  knowledge: '知识库',
  knowledgeBases: '知识库',
  knowledgeFolders: '知识目录',
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
  level: {
    check: v => ['info', 'warn', 'error'].includes(v), cast: v => (['info', 'warn', 'error'].includes(v) ? v : 'info'), message: '级别只能是 info/warn/error',
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
const COMMON_FIELDS = {
  tags: { ...FIELDS.tags, default: () => [] },
  refs: { ...FIELDS.refs, default: () => [] },
  starred: { ...FIELDS.starred, default: false },
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
  fixes: {
    title: { ...FIELDS.title, required: true },
    priority: { ...FIELDS.priority, default: 'normal' },
    status: { ...FIELDS.status, default: 'todo' },
    note: { ...FIELDS.note, default: '' },
  },
  logs: {
    text: { ...FIELDS.text, required: true },
    level: { ...FIELDS.level, default: 'info' },
    source: { ...FIELDS.tag, default: '' },
    date: { ...FIELDS.date, default: () => todayISO() },
  },
  requirements: {
    title: { ...FIELDS.title, required: true },
    priority: { ...FIELDS.priority, default: 'normal' },
    status: { ...FIELDS.status, default: 'todo' },
    note: { ...FIELDS.note, default: '' },
  },
  codes: {
    title: { ...FIELDS.title, required: true },
    project: { ...FIELDS.tag, default: '' },
    status: { ...FIELDS.status, default: 'todo' },
    note: { ...FIELDS.note, default: '' },
  },
  knowledge: {
    title: { ...FIELDS.title, required: true },
    body: { ...FIELDS.body, default: '' },
    knowledgeBaseId: { ...FIELDS.recordId, default: '' },
    folderId: { ...FIELDS.recordId, default: '' },
  },
  knowledgeBases: {
    title: { ...FIELDS.title, required: true },
    description: { ...FIELDS.note, default: '' },
  },
  knowledgeFolders: {
    title: { ...FIELDS.title, required: true },
    knowledgeBaseId: { ...FIELDS.recordId, required: true },
    parentId: { ...FIELDS.recordId, default: '' },
  },
}

/** 通用字段合入每个数组模块（在 MODULE_SCHEMA 定义之后统一注入，避免逐模块重复）。 */
for (const schema of Object.values(MODULE_SCHEMA)) Object.assign(schema, COMMON_FIELDS)

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

/**
 * 生成一份演示数据：首启空库时可选灌入，让用户第一眼看到「有数据的产品」而不是空壳。
 * 数据故意做成互相引用的（需求→任务→问题→日志，知识笔记两两 [[双链]]），演示关联视图与命令面板搜索。
 * 日期相对 today 计算，任何日子灌入都像「最近几天」。
 * @param now - 今天，用于推算演示记录的日期。
 * @returns 完整 state。
 */
export function demoState(now = new Date()) {
  const today = todayISO(now)
  const yesterday = todayISO(new Date(now.getTime() - 86400000))
  const before = todayISO(new Date(now.getTime() - 2 * 86400000))
  const state = emptyState({ name: 'Yin', motto: '把日子过成想要的样子' })
  const id = seed => `${seed}0000-0000-4000-8000-0000000000${seed}`.slice(0, 36)

  state.requirements = [
    {
      id: id('11a'), title: '工作台支持暗色模式', priority: 'high', status: 'doing',
      note: '## 动机\n深夜干活时白色界面刺眼，希望跟随系统并可手动覆盖。\n\n## 验收\n- 顶栏一键切换，记住选择\n- 表格与看板在两主题下都清晰',
      tags: ['体验', '设计'], createdAt: `${before}T09:12:00.000Z`, updatedAt: `${today}T08:40:00.000Z`,
    },
    {
      id: id('11b'), title: 'AI 副驾可以帮记一条任务', priority: 'normal', status: 'todo',
      note: '对话里说「存为今日任务」就落库，不用切到今日规划再手输。',
      tags: ['AI'], createdAt: `${yesterday}T14:20:00.000Z`, updatedAt: `${yesterday}T14:20:00.000Z`,
    },
    {
      id: id('11c'), title: '日志支持按来源过滤', priority: 'low', status: 'done',
      note: '开发日志来源有 server / workbench / agent，检索时要能只看其中一个。',
      tags: ['日志'], createdAt: `${before}T20:05:00.000Z`, updatedAt: `${before}T21:00:00.000Z`,
    },
  ]

  state.tasks = [
    { id: id('22a'), title: '把暗色模式的令牌补全', done: false, due: today, priority: 'high', tag: '设计', tags: ['设计'], refs: [{ type: 'requirements', id: id('11a') }] },
    { id: id('22b'), title: '评审「AI 帮记任务」的交互稿', done: false, due: today, priority: 'normal', tag: 'AI', tags: ['AI'], refs: [{ type: 'requirements', id: id('11b') }] },
    { id: id('22c'), title: '写周报：本周工作台进展', done: false, due: yesterday, priority: 'high', tag: '汇报', tags: ['汇报'] },
    { id: id('22d'), title: '清理 dist 目录的旧产物', done: true, due: yesterday, priority: 'low', tag: '杂务', tags: ['杂务'] },
  ]

  state.works = [
    { id: id('33a'), title: '指挥台外壳重构', note: '顶栏 + 左导航 + AI 副驾 + 命令面板', status: 'doing', tags: ['前端'], refs: [] },
    { id: id('33b'), title: 'SQLite 关联字段落地', note: 'tags / refs / starred 与搜索端点', status: 'done', tags: ['后端'], refs: [] },
    { id: id('33c'), title: '模块逐个重塑验收', note: '7 个模块按新规格过一遍 ego 截图', status: 'todo', tags: ['验收'], refs: [] },
  ]

  state.fixes = [
    {
      id: id('44a'), title: 'AI 面板断线后不会自愈', priority: 'high', status: 'doing',
      note: 'localStorage 里的旧 session id 服务端已不存在时要自动开新会话。',
      tags: ['bug', 'AI'], refs: [{ type: 'tasks', id: id('22a') }],
    },
    {
      id: id('44b'), title: '侧栏品牌名与用户名连写', priority: 'normal', status: 'done',
      note: '「AI 个人工作台老 Yin」中间要分隔。',
      tags: ['bug', '界面'], refs: [],
    },
    {
      id: id('44c'), title: '导入旧 JSON 后时间戳丢失', priority: 'low', status: 'todo',
      note: '补入库时统一补 createdAt/updatedAt。',
      tags: ['数据'], refs: [],
    },
  ]

  state.logs = [
    { id: id('55a'), text: '指挥台外壳写完，顶栏 ⌘K 命令面板可用', level: 'info', source: 'workbench', date: today, tags: ['前端'] },
    { id: id('55b'), text: 'AI 副驾自愈逻辑生效：旧会话失效后 3 秒内自动重开', level: 'info', source: 'workbench', date: today, tags: ['AI'] },
    { id: id('55c'), text: '日志来源过滤偶发漏掉 agent 前缀，已定位到转义', level: 'warn', source: 'server', date: yesterday, tags: ['日志'] },
    { id: id('55d'), text: '暗色令牌对比度不达标：text-2 在 surface-1 上偏灰', level: 'warn', source: 'design', date: yesterday, tags: ['设计'] },
    { id: id('55e'), text: '旧版 JSON 导入失败回滚正常，事务生效', level: 'info', source: 'server', date: before, tags: ['数据'] },
    { id: id('55f'), text: '一次全量刷新导致列表滚动位置跳动（已改为局部更新）', level: 'error', source: 'workbench', date: before, tags: ['前端'] },
  ]

  state.codes = [
    {
      id: id('66a'), title: '命令面板组件', project: 'pi-webx', status: 'doing',
      note: 'shell/CommandPalette.jsx\n\n- 全局搜索跳模块\n- 快捷操作：切换主题 / 打开设置\n- ↑↓ 选择，Enter 执行',
      tags: ['前端'], refs: [],
    },
    {
      id: id('66b'), title: '搜索端点', project: 'pi-webx', status: 'done',
      note: 'GET /api/workbench/search?q=\n\nLIKE 转义 + 模块聚合，返回带摘要的结果。',
      tags: ['后端'], refs: [],
    },
    {
      id: id('66c'), title: '主页 widget 板', project: 'pi-webx', status: 'todo',
      note: '三列网格：进度 / 待办 / 问题 / 日志。',
      tags: ['前端'], refs: [],
    },
  ]

  // 4 条互相 [[链接]] 的知识笔记：正文里的 [[标题]] 与 refs 一一对应，
  // 另有一条引用需求/任务，让搜索与双向链接一开盘就有数据。
  state.knowledge = [
    {
      id: id('77a'), title: '工作台双链笔记规范',
      body: '正文里写双方括号括起的标题就能互相引用，保存时自动解析成 refs。\n\n- 字段细节：[[SQLite 关联字段]]\n- 实战复盘：[[暗色模式落地]]',
      tags: ['规范', '工作台'],
      refs: [{ type: 'knowledge', id: id('77b') }, { type: 'knowledge', id: id('77c') }],
      createdAt: `${before}T10:05:00.000Z`, updatedAt: `${today}T09:30:00.000Z`,
    },
    {
      id: id('77b'), title: 'SQLite 关联字段',
      body: 'tags / refs / starred 三个通用字段由 COMMON_FIELDS 统一注入，各模块零重复。\n\n约定出处：[[工作台双链笔记规范]]。',
      tags: ['后端', '数据'],
      refs: [{ type: 'knowledge', id: id('77a') }],
      createdAt: `${before}T16:40:00.000Z`, updatedAt: `${yesterday}T11:20:00.000Z`,
    },
    {
      id: id('77c'), title: '暗色模式落地',
      body: '令牌全部收进 styles.css，亮暗两主题共用一套变量。\n\n设计依据：[[工作台双链笔记规范]]；存储细节：[[SQLite 关联字段]]。',
      tags: ['设计', '前端'],
      refs: [
        { type: 'knowledge', id: id('77a') },
        { type: 'knowledge', id: id('77b') },
        { type: 'requirements', id: id('11a') },
        { type: 'tasks', id: id('22a') },
      ],
      createdAt: `${yesterday}T20:15:00.000Z`, updatedAt: `${today}T08:55:00.000Z`,
    },
    {
      id: id('77d'), title: '问小台使用笔记',
      body: '右栏「问小台」把当前笔记送进 AI 副驾追问。\n\n配合 [[暗色模式落地]] 一起读效果更好。',
      tags: ['AI'],
      refs: [{ type: 'knowledge', id: id('77c') }],
      createdAt: `${today}T07:45:00.000Z`, updatedAt: `${today}T07:45:00.000Z`,
    },
  ]

  return state
}
