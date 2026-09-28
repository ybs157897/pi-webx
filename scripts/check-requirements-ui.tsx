import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Records from '../src/workbench-app/modules/requirements/Records.jsx'
import ImportDialog, { selectedTaskDrafts } from '../src/workbench-app/modules/requirements/ImportDialog.jsx'
import Tasks from '../src/workbench-app/modules/tasks/index.jsx'
import { addDays, todayISO } from '../src/workbench-app/util.mjs'

const requirementId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const updatedAt = '2026-09-28T12:00:00.000Z'
const requirement = {
  id: requirementId,
  title: '需求来源',
  status: 'todo',
  priority: 'high',
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

const dialog = render(ImportDialog, { row: requirement, onClose: () => {}, onConfirm: () => {} })
assert.match(dialog, /data-testid="req-import-dialog"/)
assert.match(dialog, /data-testid="req-import-context"/)
assert.match(dialog, /验收条件/)
assert.equal(dialog.split('data-testid="req-import-item"').length - 1, 2)
assert.match(dialog, /确认导入 2 条/)
const savedDialog = render(ImportDialog, {
  row: requirement, saved: true, error: '待办已保存，但列表刷新失败', onClose: () => {}, onConfirm: () => {},
})
assert.match(savedDialog, /role="alert"[^>]*>待办已保存，但列表刷新失败/)
assert.match(savedDialog, /重新加载待办/)
assert.match(savedDialog, /<fieldset(?=[^>]*data-testid="req-import-item")(?=[^>]*disabled)[^>]*>/)

const selected = selectedTaskDrafts([
  { selected: true, title: ' 编辑后 ', priority: 'low', due: '', tag: ' 测试 ' },
  { selected: false, title: '', priority: 'normal', due: '', tag: '' },
])
assert.deepEqual(selected, { tasks: [{ title: '编辑后', priority: 'low', due: null, tag: '测试' }] })
assert.equal(selectedTaskDrafts([{ selected: false, title: '', priority: 'normal', due: '', tag: '' }]).error, '至少勾选一条待办')

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

console.log('requirements UI: selected history, import preview and future task source passed')
