/** 数据模块的链接落到所属页面；tasks 仍是数据键，life 是导航入口。 */
export function resolveWorkbenchNavigation(id, target = null) {
  if (id === 'tasks' || id === 'today') {
    return { id: 'life', target: { ...(target ?? {}), view: id } }
  }
  return { id, target }
}

export function recordNavigationLabel(id, modules) {
  if (id === 'tasks') return '我的待办'
  return modules.find(module => module.id === id)?.label ?? id
}
