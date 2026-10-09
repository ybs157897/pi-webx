import { FIELDS } from '../../workbench/schema-fields.mjs'

const DRAFT_KEYS = new Set(['title', 'priority', 'due', 'tag'])

/** 需求草稿只描述待办字段；创建待办必须由用户确认的导入接口完成。 */
export function normalizeTaskDrafts(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('待办草稿最多 20 条')
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !DRAFT_KEYS.has(key))) {
      throw new Error(`第 ${index + 1} 条待办草稿字段不合法`)
    }
    const title = item.title
    const priority = item.priority ?? 'normal'
    const due = item.due ?? null
    const tag = item.tag ?? ''
    if (!FIELDS.title.check(title) || title.trim().length > FIELDS.title.max) throw new Error(`第 ${index + 1} 条待办需要 1-${FIELDS.title.max} 字标题`)
    if (!FIELDS.priority.check(priority)) throw new Error(`第 ${index + 1} 条待办优先级不合法`)
    if (!FIELDS.optionalDate.check(due)) throw new Error(`第 ${index + 1} 条待办日期不合法`)
    if (!FIELDS.tag.check(tag) || tag.trim().length > FIELDS.tag.max) throw new Error(`第 ${index + 1} 条待办标签超过 ${FIELDS.tag.max} 字`)
    return {
      title: FIELDS.title.cast(title),
      priority: FIELDS.priority.cast(priority),
      due: FIELDS.optionalDate.cast(due),
      tag: FIELDS.tag.cast(tag),
    }
  })
}

export const schema = {
  requirements: {
    title: { ...FIELDS.title, required: true },
    priority: { ...FIELDS.priority, default: 'normal' },
    status: { ...FIELDS.status, default: 'todo' },
    category: { ...FIELDS.category, default: 'new' },
    note: { ...FIELDS.note, default: '' },
    sourceSessionId: { ...FIELDS.recordId, default: '' },
    taskDrafts: {
      check: value => {
        try { normalizeTaskDrafts(value); return true } catch { return false }
      },
      cast: normalizeTaskDrafts,
      default: () => [],
      message: '待办草稿需要是最多 20 条的有效任务数组',
    },
  },
}
