/**
 * 我的助理界面验收：壳层（今天 / 待办两页签 + 常驻对话列）、今天时间轴、待办认知分组、
 * 方案确认卡与导航映射。
 *
 * 写法照已退役的 `scripts/check-life-secretary-ui.tsx` / `check-life-navigation.tsx` /
 * `check-works-planning-ui.tsx`：真实组件进 `renderToStaticMarkup`，断言只认 DOM 证据；
 * 展开、点开、确认这些交互分支 SSR 不可达——展开区走单独导出的 `PlanEntries` 直测，
 * 确认失败（409）走源码文本钉结构。跑法：
 * `node --import ./scripts/check-bootstrap.mjs scripts/check-assistant-ui.tsx`
 * （也被 `npm run check:workbench-ui` 以副作用 import 全链带上）。
 *
 * 覆盖：
 *   1. 壳层：页签 aria-selected / 计数徽章 / 面板与对话列并列，navigationTarget 直接落到待办；
 *   2. 今天：fixed/flexible 节点、≥45 分钟呼吸缝、时间待定小节、概览三格、遗留与候选
 *      默认折叠但保留 DOM、空日引导；
 *   3. 待办：快速捕获、认知分组（已逾期 / 今天 / 稍后 / 已完成）、已完成默认折叠、
 *      范围筛选不再出现「已完成」档、原始记录只进详情弹窗；
 *   4. 方案确认卡：docked / applied / 跨会话隔离 / 多份建议；
 *   5. 导航：MODULES 与 resolveWorkbenchNavigation 把 tasks / today 折算到 assistant；
 *   6. 快速捕获语法（parseQuickAdd）语义。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AssistantWorkspace from '../src/workbench-app/modules/assistant/index.jsx'
import PlanReview, { PlanEntries } from '../src/workbench-app/modules/assistant/PlanReview.jsx'
import TaskDetails from '../src/workbench-app/modules/tasks/TaskDetails.jsx'
import { parseQuickAdd } from '../src/workbench-app/modules/tasks/index.jsx'
import { MODULES } from '../src/workbench-app/App.jsx'
import SideNav from '../src/workbench-app/shell/SideNav.jsx'
import { resolveWorkbenchNavigation, recordNavigationLabel } from '../src/workbench-app/shell/navigation.mjs'
import { addDays, todayISO } from '../src/workbench-app/util.mjs'

const today = todayISO()
const yesterday = addDays(today, -1)
const tomorrow = addDays(today, 1)
const REQ = 'req-assistant'

/** 一份覆盖时间轴两态、待定、遗留、候选与认知分组的假数据。 */
const tasks = [
  { id: 'fixed', title: '交物业费', due: tomorrow, plannedDate: today, startTime: '09:00', endTime: '09:20', durationMinutes: 20, kind: 'fixed', priority: 'high', done: false, originalText: '周五前交物业费', tag: '生活' },
  { id: 'flex', title: '看牙', due: '', plannedDate: today, startTime: '14:00', endTime: '15:00', durationMinutes: 60, kind: 'flexible', priority: 'normal', done: false },
  { id: 'undated', title: '给妈妈打电话', due: today, plannedDate: today, durationMinutes: 20, kind: 'flexible', priority: 'normal', done: false },
  { id: 'carry', title: '取快递', due: '', plannedDate: yesterday, durationMinutes: 15, kind: 'flexible', priority: 'normal', done: false },
  { id: 'candidate', title: '买猫粮', due: '', plannedDate: null, durationMinutes: 30, kind: 'flexible', priority: 'normal', done: false },
  { id: 'overdue', title: '还书', due: yesterday, durationMinutes: 10, kind: 'flexible', priority: 'high', done: false },
  { id: 'later', title: '预约体检', due: addDays(today, 5), durationMinutes: 10, kind: 'flexible', priority: 'normal', done: false },
  { id: 'done', title: '缴水费', due: today, durationMinutes: 10, kind: 'flexible', priority: 'low', done: true },
]
const data = { tasks, requirements: [{ id: REQ, title: '生活需求' }], plans: [] }
const props = { data, mutate: async () => true, notify: () => {}, refresh: async () => {}, modules: [], prefs: {}, setPref: () => {} }
const chat = h('section', { className: 'assistant-chat', 'data-testid': 'chat-stub' }, '我的助理')
const render = (Component: any, extra: Record<string, unknown> = {}) => renderToStaticMarkup(h(Component, { ...props, ...extra }))
const count = (markup: string, fragment: string) => markup.split(fragment).length - 1
const sourceOf = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/**
 * 取一个折叠区块（Fold）：`head` 是折叠头、`body` 是折叠体，用来把「默认折叠」钉在
 * 正确的区块上（`hidden` 只有折叠体上有）。
 */
function foldOf(markup: string, testid: string): { head: string; body: string } {
  const at = markup.indexOf(`data-testid="${testid}"`)
  assert.ok(at >= 0, `缺少折叠区块：${testid}`)
  const bodyAt = markup.indexOf('assistant-fold-body', at)
  assert.ok(bodyAt > at, `${testid} 缺折叠体`)
  return { head: markup.slice(at, bodyAt), body: markup.slice(bodyAt, bodyAt + 60) }
}

/* ------------------------------------------------- 1. 壳层：两页签 + 对话列 */

const shell = render(AssistantWorkspace, { chat })
assert.ok(shell.includes('data-testid="assistant-workspace"') && shell.includes('data-testid="assistant-items"'), '壳层缺工作区或内容列')
assert.ok(shell.includes('role="tablist"') && shell.includes('data-testid="assistant-panel"'), '壳层缺页签语义或内容面板')
assert.ok(shell.includes('data-testid="assistant-tab-today" aria-selected="true"') && shell.includes('data-testid="assistant-tab-tasks" aria-selected="false"'), '默认应停在「今天」页签')
assert.ok(shell.includes('>今天<span class="assistant-tab-count">3</span>') && shell.includes('>待办<span class="assistant-tab-count">7</span>'), '页签计数徽章口径应为「今天已排 / 未完成总数」')
assert.ok(shell.includes('data-testid="chat-stub"'), '对话列应由 chat 节点注入到壳层里')

const tasksShell = render(AssistantWorkspace, { chat, navigationTarget: { view: 'tasks' } })
assert.ok(tasksShell.includes('data-testid="assistant-tab-tasks" aria-selected="true"') && tasksShell.includes('data-testid="assistant-tab-today" aria-selected="false"'), 'navigationTarget 应把壳层切到待办页签')

/* ------------------------------------------------- 2. 今天：时间轴与折叠区 */

assert.ok(shell.includes('data-module="today"') && shell.includes('data-testid="today-planner"'), '今天视图缺根标识')
assert.ok(shell.includes('data-testid="today-date"') && shell.includes('data-testid="today-prev-day"') && shell.includes('data-testid="today-next-day"'), '今天视图缺日期切换')
assert.ok(shell.includes('data-testid="assistant-timeline" data-timeline="on"'), '今天应有时间轴且轴上有时段')
assert.equal(count(shell, 'data-testid="today-entry"'), 3, '轴上两件 + 时间待定一件')
assert.equal(count(shell, 'data-testid="assistant-slot"'), 3, '每个时段节点都应有卡片体')
assert.ok(shell.includes('class="assistant-slot is-fixed"') && shell.includes('class="assistant-slot is-flex"'), '固定安排与灵活事项应靠节点符号区分')
assert.ok(shell.includes('data-testid="today-entry-open"') && shell.includes('data-testid="today-entry-complete"') && shell.includes('data-testid="today-entry-remove"'), '时间轴行缺打开 / 完成 / 移除动作')
assert.ok(shell.includes('data-testid="assistant-gap"') && shell.includes('空 4 小时 40 分'), '两件时段之间 280 分钟空档应画呼吸缝')
assert.ok(shell.includes('data-testid="assistant-undated"') && shell.includes('今天，时间待定（1）') && shell.includes('给妈妈打电话'), '没有开始时间的事项应落到「时间待定」小节')
// 「回今天」只在翻到别的日期时才出现，SSR 点不出来——读源码钉住这个入口。
assert.ok(sourceOf('../src/workbench-app/modules/today/index.jsx').includes('data-testid="today-back-to-today"'), '今天视图缺「回今天」入口')

assert.ok(shell.includes('data-testid="assistant-overview"') && shell.includes('data-testid="assistant-overview-pending"'), '概览区缺三格或待安排入口')
assert.ok(shell.includes('3 件已排') && shell.includes('已排 · 预计 1 小时 40 分'), '概览第一格应为当天已排件数与预计用时')
assert.ok(shell.includes('待安排 · 从待办里挑 →') && shell.includes('空闲余量'), '概览缺待安排 / 空闲余量口径')
assert.ok(shell.includes('已完成 0/3'), '概览进度条口径应等于当天已完成 / 已排')

const carry = foldOf(shell, 'today-carryover')
assert.ok(carry.head.includes('aria-expanded="false"') && carry.body.includes('hidden=""'), '遗留事项应默认折叠')
assert.ok(shell.includes('data-testid="assistant-carryover"') && shell.includes('data-testid="today-carryover-reschedule"') && shell.includes('data-testid="today-carryover-defer"') && shell.includes('取快递'), '遗留事项折叠体应保留 DOM 与两个动作')
const pick = foldOf(shell, 'today-candidates')
assert.ok(pick.head.includes('aria-expanded="false"') && pick.body.includes('hidden=""'), '候选事项应默认折叠')
assert.ok(shell.includes('data-testid="assistant-candidates"') && shell.includes('data-testid="today-pick-task"') && shell.includes('data-testid="today-plan-picked"') && shell.includes('买猫粮'), '候选折叠体应内联列表与「安排到今天」')

const empty = render(AssistantWorkspace, { chat: undefined, data: { tasks: [], requirements: [] } })
assert.ok(empty.includes('data-testid="assistant-empty"') && empty.includes('这一天还是空的'), '空日应给引导而不是空轴')
assert.ok(foldOf(empty, 'today-candidates').head.includes('aria-expanded="true"'), '空日应自动展开候选，方便直接挑一件')

/* ------------------------------------------------- 3. 待办：认知分组与折叠 */

const legacy = { id: 'old', title: '旧待办', done: false, due: null, priority: 'normal', tag: '' }
const legacyView = render(AssistantWorkspace, { chat: undefined, navigationTarget: { view: 'tasks' }, data: { tasks: [legacy], requirements: [] } })
assert.ok(legacyView.includes('旧待办') && !legacyView.includes('undefined') && !legacyView.includes('NaN'), '旧事项缺少新字段仍应安全渲染')

assert.ok(tasksShell.includes('data-module="tasks"') && tasksShell.includes('data-testid="tasks-capture"'), '待办视图缺快速捕获条')
assert.equal(count(tasksShell, 'data-testid="task-row"'), 8, '待办默认展示全量事项')
assert.equal(count(tasksShell, 'data-done="false"'), 7, '未完成行应带 data-done=false')
assert.equal(count(tasksShell, 'data-done="true"'), 1, '已完成行应带 data-done=true')
assert.ok(tasksShell.includes('class="task-row assistant-row is-overdue"'), '逾期行应有双类与左缘竖条')
assert.equal(count(tasksShell, 'data-testid="task-plan-today"'), 7, '每条未完成行都应能一键安排到今天')
assert.equal(count(tasksShell, 'data-testid="task-details-open"'), 8, '每条行都应有详情入口')

assert.equal(count(tasksShell, 'data-testid="assistant-group"'), 4, '认知分组应四档齐备')
for (const [key, label] of [['overdue', '已逾期'], ['today', '今天'], ['later', '稍后'], ['done', '已完成']])
  assert.ok(tasksShell.includes(`data-group="${key}"`) && tasksShell.includes(`>${label}</span>`), `待办缺分组：${label}`)
const doneGroupAt = tasksShell.indexOf('data-group="done"')
const doneGroup = tasksShell.slice(doneGroupAt, tasksShell.indexOf('</section>', doneGroupAt))
assert.ok(doneGroup.includes('aria-expanded="false"') && doneGroup.includes('<ul class="tasks-list" hidden="">'), '已完成组应默认折叠且保留 DOM')

const scopeRegion = tasksShell.slice(tasksShell.indexOf('aria-label="范围"'), tasksShell.indexOf('data-testid="tasks-search"'))
for (const label of ['全部', '未安排', '即将到期']) assert.ok(scopeRegion.includes(label), `范围筛选缺档位：${label}`)
assert.ok(!scopeRegion.includes('已完成'), '已完成有专门的组，不该再占范围筛选档位')

assert.ok(!tasksShell.includes('周五前交物业费'), '原始记录不该出现在列表行里')
const details = render(TaskDetails, { task: tasks[0], onClose: () => {} })
assert.ok(details.includes('data-testid="task-details-form"') && details.includes('计划日期') && details.includes('截止日期'), '详情弹窗缺编辑表单')
assert.ok(details.includes('class="assistant-original"') && details.includes('周五前交物业费'), '详情弹窗应用「最初记录」呈现 originalText')

/* ------------------------------------------------- 4. 需求来源跳转落在待办页签 */

const fromRequirement = render(AssistantWorkspace, {
  chat: undefined,
  navigationTarget: { view: 'tasks', requirementId: REQ },
  data: { tasks: [tasks[0], { ...tasks[4], refs: [{ type: 'requirements', id: REQ }] }], requirements: [{ id: REQ, title: '生活需求' }], plans: [] },
})
assert.ok(fromRequirement.includes('data-testid="assistant-tab-tasks" aria-selected="true"'), '需求回链应落在待办页签')
assert.ok(fromRequirement.includes('data-testid="tasks-source-filter"') && fromRequirement.includes('生活需求'), '需求回链应显示来源筛选条')
assert.equal(count(fromRequirement, 'data-testid="task-row"'), 1, '来源筛选只显示对应需求的待办')

/* ------------------------------------------------- 5. 方案确认卡 */

const entries = [
  { taskId: 'fixed', plannedDate: today, startTime: '09:00', endTime: '09:20', reason: '临近截止日' },
  { taskId: 'flex', plannedDate: today, reason: '留出整块时间' },
  { taskId: 'candidate', plannedDate: tomorrow, startTime: '10:00', endTime: '10:30' },
]
const plan = { id: 'draft', sourceSessionId: 'as-session', updatedAt: '2026-09-29T08:00:00Z', appliedAt: null, note: '上午先处理要紧的', entries }
const other = { id: 'older', sourceSessionId: 'as-session', updatedAt: '2026-09-28T08:00:00Z', appliedAt: null, entries: [entries[0]] }
const review = render(PlanReview, { plans: [plan, other], sessionId: 'as-session' })
assert.ok(review.includes('data-testid="assistant-plan-dock"') && review.includes('data-plan-session="as-session"'), '草稿应在对话列的 dock 里过目')
assert.ok(review.includes('data-testid="assistant-plan-expand"') && review.includes('确认前不会改动你的日程'), '确认卡应可展开且默认不改日程')
assert.ok(review.includes('data-testid="assistant-plan-apply"') && review.includes('data-testid="assistant-plan-cancel"'), '确认卡缺确认 / 取消动作')
assert.ok(review.includes('data-testid="assistant-plan-more"') && review.includes('另有 1 份建议'), '多份草稿应能翻到下一份')
assert.ok(review.includes('3 条 · 9月29日 09:00 起'), '确认卡摘要应给条数与起始时间')
assert.equal(render(PlanReview, { plans: [plan, other], sessionId: 'other-session' }), '', '草稿不可跨会话展示')

const applied = render(PlanReview, { plans: [{ ...plan, appliedAt: '2026-09-29T09:00:00Z' }], sessionId: 'as-session' })
assert.ok(applied.includes('data-testid="assistant-plan-applied"') && applied.includes('已加入日程 · 3 条'), '应用过的草稿应挂「已加入日程」等用户收起')

// 展开区（交互不可达）：PlanEntries 按天分组、时段 / 灵活安排与理由直测。
const expanded = render(PlanEntries, { entries, tasks, today })
assert.ok(expanded.includes('今天 · 9月29日') && expanded.includes('明天'), '展开区应按天分组')
assert.equal(count(expanded, 'data-testid="assistant-plan-entry"'), 3, '展开区条数应等于安排条数')
assert.ok(expanded.includes('09:00–09:20') && expanded.includes('10:00–10:30') && expanded.includes('灵活安排'), '展开区应给时段，没时段的写「灵活安排」')
assert.ok(expanded.includes('临近截止日') && expanded.includes('留出整块时间'), '展开区应带上每条的理由')
assert.ok(expanded.includes('20 分钟') && expanded.includes('30 分钟'), '展开区应给每条预计用时')

// 确认失败（含版本过期）是 409 分支，SSR 点不出来——读源码钉结构。
const reviewSource = sourceOf('../src/workbench-app/modules/assistant/PlanReview.jsx')
assert.ok(reviewSource.includes("data-testid=\"assistant-plan-error\"") && reviewSource.includes('方案已过期，请和助理重新确认一次'), '确认失败应给错误条与过期话术')
assert.ok(reviewSource.includes('failure.status === 409') && reviewSource.includes("method === 'POST' ? { expectedUpdatedAt: plan.updatedAt }"), '确认必须带 expectedUpdatedAt 并把 409 映射成重新确认')

/* ------------------------------------------------- 6. 导航：tasks / today 折算到我的助理 */

assert.equal(MODULES.length, 8, '模块注册表应是八项')
assert.deepEqual(MODULES.map(module => module.id), ['dashboard', 'assistant', 'fixes', 'logs', 'requirements', 'codes', 'knowledge', 'agent-settings'])
const nav = renderToStaticMarkup(h(SideNav, {
  modules: MODULES, active: 'assistant', data: { tasks: [{ id: 'a', done: false }, { id: 'b', done: true }] },
  piStatus: 'idle', onNavigate: () => {},
}))
assert.equal(count(nav, 'data-testid="side-nav-assistant"'), 1, '侧栏应有且只有一个「我的助理」入口')
assert.ok(!nav.includes('side-nav-life') && !nav.includes('side-nav-works') && !nav.includes('side-nav-today') && !nav.includes('side-nav-tasks'), '侧栏不该再有生活秘书 / 工作助理 / 子视图入口')
assert.ok(nav.includes('我的助理') && nav.includes('aria-current="page"'), '侧栏应显示并激活我的助理')
assert.ok(nav.includes('nav-badge'), '助理徽章应显示未完成待办数')

assert.deepEqual(resolveWorkbenchNavigation('tasks', { requirementId: REQ }), {
  id: 'assistant', target: { requirementId: REQ, view: 'tasks' },
}, '需求回链的来源筛选应进入我的助理的待办页签')
assert.deepEqual(resolveWorkbenchNavigation('today'), { id: 'assistant', target: { view: 'today' } })
assert.deepEqual(resolveWorkbenchNavigation('requirements', { id: 'r' }), { id: 'requirements', target: { id: 'r' } })
assert.equal(recordNavigationLabel('tasks', MODULES), '我的待办', '搜索结果保留可理解的数据来源名称')
assert.equal(recordNavigationLabel('assistant', MODULES), '我的助理')

/* ------------------------------------------------- 7. 快速捕获语法 */

assert.equal(parseQuickAdd('买猫粮 #购物', today).due, '', '随手记录不应默认今天截止')
assert.equal(parseQuickAdd('周五交费 @明天', today).due, tomorrow, '明确截止日仍应解析')
assert.deepEqual(
  { ...parseQuickAdd('写周报 #工作 !高 @下周一', today), matched: undefined },
  { title: '写周报 @下周一', priority: 'high', tag: '工作', due: '', matched: undefined },
  '认不出的日期词按普通文字留在标题里，不静默吞掉；认出的标记从标题摘掉',
)

console.log('check-assistant-ui: 壳层两页签、今天时间轴、待办认知分组、方案确认卡与导航映射全部通过')
