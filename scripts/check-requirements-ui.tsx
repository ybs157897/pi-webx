import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Records from '../src/workbench-app/modules/requirements/Records.jsx'
import ImportDialog, { selectedTaskDrafts } from '../src/workbench-app/modules/requirements/ImportDialog.jsx'
import { RequirementsStarterActions, RequirementsWelcome, alignHintVisible, starterDraft } from '../src/workbench-app/modules/requirements/Landing.jsx'
import { categoryOf } from '../src/workbench-app/modules/requirements/model.jsx'
import Tasks from '../src/workbench-app/modules/tasks/index.jsx'
import { addDays, todayISO } from '../src/workbench-app/util.mjs'

const requirementId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const updatedAt = '2026-09-28T12:00:00.000Z'
const requirement = {
  id: requirementId,
  title: '需求来源',
  status: 'todo',
  priority: 'high',
  category: 'fix',
  note: '## 验收条件\n- 能回到对应需求',
  updatedAt,
  taskDrafts: [
    { title: '任务一', priority: 'high', due: null, tag: '前端' },
    { title: '任务二', priority: 'normal', due: null, tag: '' },
  ],
}

const data = {
  requirements: [requirement],
  tasks: [{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: '未来任务',
    priority: 'normal',
    due: addDays(todayISO(), 2),
    done: false,
    refs: [{ type: 'requirements', id: requirementId }],
  }, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    title: '另一条需求的任务',
    priority: 'low',
    due: todayISO(),
    done: false,
    refs: [{ type: 'requirements', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
  }],
}

const render = (Component: any, props: Record<string, unknown>) => renderToStaticMarkup(createElement(Component, props))
const records = render(Records, {
  data, initialSelectedId: requirementId, onImport: () => {}, navigate: () => {},
})
assert.match(records, /data-testid="req-reader-title"/)
assert.match(records, /data-testid="req-import-open"/)
assert.match(records, /data-testid="req-task"/)
// 分类标签：列表与阅读页都带，取值经 model 映射成中文（fix → 问题修复）。
assert.match(records, /data-testid="req-item-category"[^>]*>问题修复</)
assert.match(records, /data-testid="req-reader-category"[^>]*>问题修复</)
const legacyRecords = render(Records, {
  data: { ...data, requirements: [{ ...requirement, category: undefined }] },
  initialSelectedId: requirementId, onImport: () => {}, navigate: () => {},
})
assert.match(legacyRecords, /data-testid="req-reader-category"[^>]*>新功能</, '旧数据缺 category 按 new 展示')

const dialog = render(ImportDialog, { row: requirement, onClose: () => {}, onConfirm: () => {} })
assert.match(dialog, /data-testid="req-import-dialog"/)
assert.match(dialog, /data-testid="req-import-context"/)
assert.match(dialog, /验收条件/)
assert.match(dialog, /data-testid="req-import-category"[^>]*>问题修复</)
assert.match(dialog, /Agent 默认整理一条待办/)
assert.equal(dialog.split('data-testid="req-import-item"').length - 1, 2)
assert.match(dialog, /确认导入 2 条/)
// 默认单条：没有草稿时预览一条，文案说「这条」，仍可继续增减条目。
const singleDraftDialog = render(ImportDialog, {
  row: { ...requirement, taskDrafts: [] }, onClose: () => {}, onConfirm: () => {},
})
assert.equal(singleDraftDialog.split('data-testid="req-import-item"').length - 1, 1, '没有草稿时默认一条待办')
assert.match(singleDraftDialog, /确认导入这条待办/)
assert.match(singleDraftDialog, /data-testid="req-import-add"/)
const savedDialog = render(ImportDialog, {
  row: requirement, saved: true, error: '待办已保存，但列表刷新失败', onClose: () => {}, onConfirm: () => {},
})
assert.match(savedDialog, /role="alert"[^>]*>待办已保存，但列表刷新失败/)
assert.match(savedDialog, /重新加载待办/)
assert.match(savedDialog, /<fieldset(?=[^>]*data-testid="req-import-item")(?=[^>]*disabled)[^>]*>/)
const conflictDialog = render(ImportDialog, {
  row: requirement, conflict: true, conflictError: '需求已关联待办', onClose: () => {}, onConfirm: () => {}, onReloadLatest: () => {},
})
assert.match(conflictDialog, /data-testid="req-import-conflict-message"/)
assert.match(conflictDialog, /当前预览与服务端记录有冲突/)
assert.match(conflictDialog, /data-testid="req-import-conflict-server-error"[^>]*>服务端说明：需求已关联待办/)
assert.match(conflictDialog, /重新载入会用最新需求草稿替换当前预览/)
assert.match(conflictDialog, /data-testid="req-import-reload-latest"[^>]*>重新载入并预览/)
assert.match(conflictDialog, /<button(?=[^>]*data-testid="req-import-confirm")(?=[^>]*disabled)[^>]*>/)
const reloadFailureDialog = render(ImportDialog, {
  row: requirement, conflict: true, reloadError: '网络连接失败', onClose: () => {}, onConfirm: () => {}, onReloadLatest: () => {},
})
assert.match(reloadFailureDialog, /data-testid="req-import-reload-error"[^>]*>最新需求载入失败[^<]*网络连接失败/)
assert.match(reloadFailureDialog, /data-testid="req-import-reload-latest"[^>]*>重新载入并预览/)
const deletedDialog = render(ImportDialog, {
  row: requirement, deleted: true, onClose: () => {}, onConfirm: () => {},
})
assert.match(deletedDialog, /data-testid="req-import-deleted-message"/)
assert.doesNotMatch(deletedDialog, /data-testid="req-import-confirm"/)
const linkedTasksDialog = render(ImportDialog, {
  row: requirement,
  linkedTasks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '已关联待办', due: null, done: false }],
  onClose: () => {}, onConfirm: () => {}, onViewExistingTasks: () => {},
})
assert.match(linkedTasksDialog, /data-testid="req-import-existing-tasks"/)
assert.match(linkedTasksDialog, /已有 1 条关联待办/)
assert.match(linkedTasksDialog, /data-testid="req-import-view-existing-tasks"[^>]*>查看已有关联待办/)
assert.doesNotMatch(linkedTasksDialog, /data-testid="req-import-confirm"/)
const linkedTasksErrorDialog = render(ImportDialog, {
  row: requirement,
  linkedTasks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '已关联待办', due: null, done: false }],
  viewTasksError: '网络连接失败', onClose: () => {}, onConfirm: () => {}, onViewExistingTasks: () => {},
})
assert.match(linkedTasksErrorDialog, /data-testid="req-import-view-existing-tasks-error"[^>]*>刷新关联待办失败[^<]*网络连接失败/)

const selected = selectedTaskDrafts([
  { selected: true, title: ' 编辑后 ', priority: 'low', due: '', tag: ' 测试 ' },
  { selected: false, title: '', priority: 'normal', due: '', tag: '' },
])
assert.deepEqual(selected, { tasks: [{ title: '编辑后', priority: 'low', due: null, tag: '测试' }] })
assert.equal(selectedTaskDrafts([{ selected: false, title: '', priority: 'normal', due: '', tag: '' }]).error, '至少勾选一条待办')

// 需求描述引导：四件事的提纲 + 可点击示例（示例按钮把整段引导语交给 onChoose 填进输入框）。
const landing = render(RequirementsWelcome, { error: '', onChoose: () => {} })
for (const id of ['req-landing', 'req-guide', 'req-guide-points', 'req-guide-examples', 'req-example-categorize', 'req-example-export']) {
  assert.match(landing, new RegExp(`data-testid="${id}"`), `需求首页缺少 ${id}`)
}
for (const point of ['要解决的问题', '给谁用', '期望的行为', '边界与约束']) {
  assert.match(landing, new RegExp(point), `需求首页引导缺少「${point}」`)
}
assert.match(landing, /data-testid="req-example-categorize"[^>]*>[^<]*一眼看出每条需求属于/)
assert.doesNotMatch(render(RequirementsWelcome, { error: '' }), /data-testid="req-guide-examples"/, '没有填入回调时不渲染点不动的示例按钮')
assert.match(render(RequirementsStarterActions, { busy: false, status: 'live', modelName: 'fixture', onChoose: () => {} }), /data-testid="req-starter-idea"/)

// 点击填入的规则：同一前缀只替换引导语本身，已写进输入框的正文留在末尾。
assert.equal(starterDraft('', '', '帮我梳理：'), '帮我梳理：')
assert.equal(starterDraft('帮我梳理：', '帮我梳理：还要能导出', '先澄清目标：'), '先澄清目标：还要能导出')
assert.equal(starterDraft('帮我梳理：', '用户自己写的内容', '先澄清目标：'), '先澄清目标：用户自己写的内容')

// 对齐提示只在 Agent 回过一轮、回合结束且输入框还空着时出现，不每回合打扰。
const replied = [{ kind: 'user', text: '我想做个导出' }, { kind: 'assistant', text: 'Q1 给谁用？\nQ2 边界是什么？' }]
assert.equal(alignHintVisible(replied, false, ''), true)
assert.equal(alignHintVisible(replied, true, ''), false, '回合进行中不提示')
assert.equal(alignHintVisible(replied, false, '先回答 Q1'), false, '已经落笔不打扰')
assert.equal(alignHintVisible([{ kind: 'user', text: '我想做个导出' }], false, ''), false, '还没有 Agent 回复时不提示')

// 分类映射：四档中文标签，旧数据缺字段按契约缺省 new，未知取值原样显示。
assert.deepEqual(categoryOf('fix'), { value: 'fix', label: '问题修复', tone: 'danger' })
assert.equal(categoryOf('enhancement').label, '体验优化')
assert.equal(categoryOf(undefined).label, '新功能', '旧数据缺 category 缺省 new')
assert.equal(categoryOf('experiment').label, 'experiment', '未知分类原样显示')

const tasks = render(Tasks, {
  data, modules: [{ id: 'requirements', label: '需求管理' }],
  navigationTarget: { scope: 'all', requirementId },
  prefs: { tasksScope: 'today' },
})
assert.match(tasks, /data-testid="task-row"/)
assert.match(tasks, /data-testid="task-requirement-ref"/)
assert.match(tasks, /data-testid="tasks-source-filter"/)
assert.match(tasks, /来自需求「需求来源」 · 1 条待办/)
assert.match(tasks, /data-testid="tasks-source-clear"/)
assert.equal(tasks.split('data-testid="task-row"').length - 1, 1, '来源筛选只显示对应需求的任务')

const unlinkedTasks = render(Tasks, {
  data: { ...data, tasks: data.tasks.slice(1) },
  navigationTarget: { scope: 'all', requirementId }, prefs: { tasksScope: 'all' },
})
assert.match(unlinkedTasks, /这条需求还没有关联待办/)
assert.match(unlinkedTasks, /来自需求「需求来源」 · 0 条待办/)

const ordinaryTasks = render(Tasks, {
  data, modules: [{ id: 'requirements', label: '需求管理' }], prefs: { tasksScope: 'all' },
})
assert.equal(ordinaryTasks.split('data-testid="task-row"').length - 1, 2, '普通待办入口显示全量任务')
assert.doesNotMatch(ordinaryTasks, /data-testid="tasks-source-filter"/)

console.log('requirements UI: selected history, import preview, category badges, landing guidance and future task source passed')
