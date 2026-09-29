import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODULES } from '../src/workbench-app/App.jsx'
import SideNav from '../src/workbench-app/shell/SideNav.jsx'
import { resolveWorkbenchNavigation, recordNavigationLabel } from '../src/workbench-app/shell/navigation.mjs'

const nav = renderToStaticMarkup(h(SideNav, {
  modules: MODULES, active: 'life', data: { tasks: [{ id: 'a', done: false }, { id: 'b', done: true }] },
  piStatus: 'idle', onNavigate: () => {},
}))
assert.equal((nav.match(/data-testid="side-nav-life"/g) ?? []).length, 1)
assert.ok(!nav.includes('data-testid="side-nav-today"') && !nav.includes('data-testid="side-nav-tasks"'), '侧栏只保留生活秘书，两个子视图在页面内')
assert.ok(nav.includes('生活秘书') && nav.includes('aria-current="page"'))
assert.deepEqual(resolveWorkbenchNavigation('tasks', { scope: 'all', requirementId: 'requirement-1' }), {
  id: 'life', target: { view: 'tasks', scope: 'all', requirementId: 'requirement-1' },
}, '需求导入的来源筛选应进入生活秘书的待办页签')
assert.deepEqual(resolveWorkbenchNavigation('today'), { id: 'life', target: { view: 'today' } })
assert.equal(recordNavigationLabel('tasks', MODULES), '我的待办', '搜索结果保留可理解的数据来源名称')
assert.deepEqual(resolveWorkbenchNavigation('requirements', { id: 'r' }), { id: 'requirements', target: { id: 'r' } })
console.log('life navigation: single parent menu, record targets and source filters passed')
