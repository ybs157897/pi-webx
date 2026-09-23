/**
 * 前端通用工具：日期、金额/数值格式化、分组与统计。零依赖。
 * 日期一律按**浏览器本地时区**解释 `YYYY-MM-DD`（不用 `Date.parse` 的 UTC 语义，
 * 否则东八区会出现差一天）。记录里的 ISO 时间戳（createdAt/updatedAt）只用来取时刻。
 * @module src/util
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本机今天，`YYYY-MM-DD`。 */
export function todayISO(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 当前月份，`YYYY-MM`。 */
export function currentMonth(now = new Date()) {
  return todayISO(now).slice(0, 7)
}

/** `YYYY-MM-DD` → 本地零点 Date；非法输入得到 Invalid Date，调用方用 isNaN 判断。 */
export function parseDay(iso) {
  return new Date(`${String(iso ?? '').slice(0, 10)}T00:00:00`)
}

/** 在 `YYYY-MM-DD` 上按本地日历偏移 n 天（n 可为负）。 */
export function addDays(iso, n) {
  const date = parseDay(iso)
  date.setDate(date.getDate() + n)
  return todayISO(date)
}

/** 最近 n 天（含今天）的日期，升序。 */
export function lastNDays(n, today = todayISO()) {
  const days = []
  for (let i = n - 1; i >= 0; i -= 1) days.push(addDays(today, -i))
  return days
}

/** 某月天数。`month` 形如 `YYYY-MM`。 */
export function daysInMonth(month) {
  const [y, m] = String(month).split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

/** 某月全部日期，升序。 */
export function monthDays(month) {
  const total = daysInMonth(month)
  return Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
}

/** 星期几（周一…周日）；非法日期返回空串。 */
export function weekdayCN(iso) {
  const date = parseDay(iso)
  return Number.isNaN(date.getTime()) ? '' : WEEKDAYS[date.getDay()]
}

/**
 * 中文日期显示。
 * @param iso - `YYYY-MM-DD`。
 * @param style - `full` 2026年9月22日 周一 / `short` 9月22日 / `md` 09-22 / `ym` 2026年9月。
 */
export function formatDay(iso, style = 'short') {
  const date = parseDay(iso)
  if (Number.isNaN(date.getTime())) return String(iso ?? '')
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  if (style === 'full') return `${y}年${m}月${d}日 ${weekdayCN(iso)}`
  if (style === 'md') return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  if (style === 'day') return `${d}日`
  if (style === 'ym') return `${y}年${m}月`
  return `${m}月${d}日`
}

/**
 * 两个 `YYYY-MM-DD` 之间相差的天数（`to - from`，按自然日）。
 * @returns 天数；任一日期非法时返回 null。
 */
export function diffDays(from, to = todayISO()) {
  const start = parseDay(from)
  const end = parseDay(to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  return Math.round((end.getTime() - start.getTime()) / 86400000)
}

/** 相对今天的说法：今天/明天/昨天/已过期，其余用短日期。 */
export function relativeDay(iso, today = todayISO()) {
  if (!iso) return ''
  if (iso === today) return '今天'
  if (iso === addDays(today, 1)) return '明天'
  if (iso === addDays(today, -1)) return '昨天'
  if (iso < today) return `已过 ${formatDay(iso)}`
  return formatDay(iso)
}

/** ISO 时间戳 → `HH:mm`；非法输入返回空串。 */
export function formatTime(stamp) {
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** ISO 时间戳 → 今天显示 `HH:mm`，其余显示 `M月D日`。 */
export function formatStamp(stamp, today = todayISO()) {
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return ''
  const day = todayISO(date)
  return day === today ? formatTime(stamp) : formatDay(day)
}

/** 按时段问候。 */
export function greeting(now = new Date()) {
  const hour = now.getHours()
  if (hour < 6) return '夜深了'
  if (hour < 9) return '早上好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

/** 金额：`¥1,234.56`。 */
export function money(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '¥0.00'
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 千分位整数。 */
export function numberText(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0'
}

/** 1–5 分心情的 emoji。 */
export function moodEmoji(mood) {
  return { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '😄' }[Number(mood)] ?? '🙂'
}

/** 1–5 分心情的中文。 */
export function moodLabel(mood) {
  return { 1: '很低落', 2: '有点累', 3: '一般', 4: '还不错', 5: '很棒' }[Number(mood)] ?? '一般'
}

/** 按取值函数求和，非数字按 0 计。 */
export function sumBy(rows, pick) {
  return (rows ?? []).reduce((total, row) => {
    const value = Number(pick(row))
    return total + (Number.isFinite(value) ? value : 0)
  }, 0)
}

/** 按 key 分组，保持首次出现顺序。 */
export function groupBy(rows, keyOf) {
  const groups = new Map()
  for (const row of rows ?? []) {
    const key = keyOf(row)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }
  return groups
}

/** 按日期字段倒序（同日保持原顺序，稳定的比较函数返回 0）。 */
export function byDateDesc(pick) {
  return (a, b) => {
    const left = String(pick(a) ?? '')
    const right = String(pick(b) ?? '')
    if (left === right) return 0
    return left < right ? 1 : -1
  }
}

/** 按日期字段升序。 */
export function byDateAsc(pick) {
  return (a, b) => {
    const left = String(pick(a) ?? '')
    const right = String(pick(b) ?? '')
    if (left === right) return 0
    return left < right ? -1 : 1
  }
}

/** 连续打卡天数：今天打过从今天算，否则昨天打过从昨天算，都没有为 0。 */
export function streakDays(dates, today = todayISO()) {
  const set = new Set(dates ?? [])
  let cursor = set.has(today) ? today : addDays(today, -1)
  if (!set.has(cursor)) return 0
  let count = 0
  while (set.has(cursor)) {
    count += 1
    cursor = addDays(cursor, -1)
  }
  return count
}

/** 截断到区间内。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)))
}

/**
 * 只放行 http(s) 链接：用户或 AI 写的 url 会直接进 `href`，
 * `javascript:` / `data:` 这类会被浏览器执行，必须挡在这里。
 * @param url - 原始链接。
 * @returns 可安全放进 `href` 的链接；不合法时返回空串。
 */
export function safeUrl(url) {
  const text = String(url ?? '').trim()
  return /^https?:\/\//i.test(text) ? text : ''
}

/**
 * 图片地址放行规则：同源相对路径、http(s)、四种支持的栅格图片 data URL。
 * 导入文件中的图片地址也会经过这里，不能让 SVG data URL 进入可点击链接。
 * @param url - 原始图片地址。
 * @returns 可安全放进 `src`/`href` 的地址；不合法时返回空串。
 */
export function safeImageUrl(url) {
  const text = String(url ?? '').trim()
  if (text === '') return ''
  if (text.startsWith('/') && !text.startsWith('//')) return text
  if (/^https?:\/\//i.test(text)) return text
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(text)) return text
  return ''
}

/** 数据列里出现的日期，升序去重。 */
export function uniqueDates(rows, pick) {
  return [...new Set((rows ?? []).map(row => String(pick(row) ?? '').slice(0, 10)).filter(Boolean))].sort()
}
