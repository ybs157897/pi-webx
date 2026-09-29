import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Tasks, { parseQuickAdd } from '../src/workbench-app/modules/tasks/index.jsx'
import Today from '../src/workbench-app/modules/today/index.jsx'
import LifeWorkspace from '../src/workbench-app/modules/life/index.jsx'
import PlanReview from '../src/workbench-app/modules/life/PlanReview.jsx'
import TaskDetails from '../src/workbench-app/modules/tasks/TaskDetails.jsx'
import { todayISO, addDays } from '../src/workbench-app/util.mjs'

const today = todayISO()
const yesterday = addDays(today, -1)
const tomorrow = addDays(today, 1)
const tasks = [
  { id: 'one', title: '交物业费', due: tomorrow, plannedDate: today, startTime: '', endTime: '', durationMinutes: 20, kind: 'flexible', priority: 'high', done: false, originalText: '周五前交物业费', tag: '生活' },
  { id: 'two', title: '看牙', due: '', plannedDate: today, startTime: '14:00', endTime: '15:00', durationMinutes: 30, kind: 'fixed', priority: 'normal', done: false },
  { id: 'three', title: '买猫粮', due: '', plannedDate: null, durationMinutes: 30, kind: 'flexible', priority: 'normal', done: false },
  { id: 'four', title: '取快递', due: '', plannedDate: yesterday, durationMinutes: 15, kind: 'flexible', priority: 'normal', done: false },
  { id: 'five', title: '缴水费', due: '', plannedDate: null, durationMinutes: 10, kind: 'flexible', priority: 'low', done: true },
]
const props = { data: { tasks, requirements: [] }, mutate: async () => true, notify: () => {}, refresh: async () => {}, modules: [], prefs: {}, setPref: () => {} }
const render = (Component: any, extra: Record<string, unknown> = {}) => renderToStaticMarkup(h(Component, { ...props, ...extra }))
const count = (markup: string, fragment: string) => markup.split(fragment).length - 1

assert.equal(parseQuickAdd('买猫粮 #购物', today).due, '', '随手记录不应默认今天截止')
assert.equal(parseQuickAdd('周五交费 @明天', today).due, tomorrow, '明确截止日仍应解析')

const all = render(Tasks)
assert.ok(all.includes('data-module="tasks"') && all.includes('data-testid="tasks-capture"'))
assert.equal(count(all, 'data-testid="task-row"'), 5, '我的待办默认展示全部事项')
assert.ok(all.includes('未安排') && all.includes('即将到期') && all.includes('已完成') && all.includes('data-testid="tasks-search"'))
assert.ok(all.includes('data-testid="task-plan-today"') && all.includes('data-testid="task-details-open"'))

const plan = render(Today)
assert.ok(plan.includes('data-testid="today-planner"') && plan.includes('data-testid="today-date"'))
assert.equal(count(plan, 'data-testid="today-entry"'), 2, '今日规划只列同一日期的事项')
assert.ok(plan.includes('固定安排') && plan.includes('灵活事项') && plan.includes('待处理预计 1 小时 20 分钟'))
assert.ok(plan.includes('data-testid="today-candidates"') && plan.includes('买猫粮'))
assert.ok(plan.includes('data-testid="today-carryover"') && plan.includes('取快递'))

const legacy = { id: 'old', title: '旧待办', done: false, due: null, priority: 'normal', tag: '' }
const legacyList = render(Tasks, { data: { tasks: [legacy], requirements: [] } })
const legacyToday = render(Today, { data: { tasks: [legacy] } })
assert.ok(legacyList.includes('旧待办') && !legacyList.includes('undefined') && !legacyToday.includes('NaN'), '旧事项缺少生活字段仍应安全渲染')
const details = render(TaskDetails, { task: legacy, onClose: () => {} })
assert.ok(details.includes('data-testid="task-details-form"') && details.includes('计划日期') && details.includes('截止日期'))

const chat = h('section', { className: 'life-chat', 'data-testid': 'chat-stub' }, '生活秘书')
const workspace = render(LifeWorkspace, { chat })
assert.ok(workspace.includes('data-testid="life-workspace"') && workspace.includes('data-testid="life-view-panel"'))
assert.ok(workspace.includes('role="tablist"') && workspace.includes('data-testid="life-view-today"') && workspace.includes('data-testid="life-view-tasks"'))
assert.ok(workspace.includes('data-testid="life-view-today" aria-selected="true"') && workspace.includes('data-testid="today-planner"') && workspace.includes('data-testid="chat-stub"'), '默认今日规划与共用秘书对话并列')
assert.ok(!workspace.includes('life-mobile-chat') && !workspace.includes('life-mobile-items'), '生活页签不提供移动端专属内容切换')
const requirementId = 'req-life'
const taskFromRequirement = { ...tasks[2], refs: [{ type: 'requirements', id: requirementId }] }
const fromRequirement = render(LifeWorkspace, {
  chat,
  navigationTarget: { view: 'tasks', scope: 'all', requirementId },
  data: { tasks: [tasks[0], taskFromRequirement], requirements: [{ id: requirementId, title: '生活需求' }] },
})
assert.ok(fromRequirement.includes('data-testid="life-view-tasks" aria-selected="true"') && fromRequirement.includes('data-testid="tasks-source-filter"') && fromRequirement.includes('生活需求'))
assert.equal(count(fromRequirement, 'data-testid="task-row"'), 1, '外部跳转到待办时应用需求来源筛选')
assert.ok(fromRequirement.includes('data-testid="chat-stub"'), '来源跳转仍显示同一秘书对话')

const plans = [{ id: 'draft', sourceSessionId: 'life-session', updatedAt: '2026-09-29T08:00:00Z', appliedAt: null, title: '今天先做两件', entries: [{ taskId: 'one', expectedUpdatedAt: '2026-09-29T07:00:00Z', plannedDate: today, reason: '临近截止日' }] }]
const review = render(PlanReview, { plans, tasks, sessionId: 'life-session' })
assert.ok(review.includes('data-testid="life-plan-card"') && review.includes('data-testid="life-plan-apply"') && review.includes('临近截止日'))
assert.ok(!render(PlanReview, { plans, tasks, sessionId: 'other-session' }).includes('data-testid="life-plan-card"'), '草稿不可跨会话展示')

console.log('check-life-secretary-ui: OK')
