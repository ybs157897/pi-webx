/** 数据模块的链接落到所属页面：tasks / today 仍是数据与 URL 口径，页面归「我的助理」。 */
export function resolveWorkbenchNavigation(id, target = null) {
  if (id === 'tasks' || id === 'today') {
    return { id: 'assistant', target: { ...(target ?? {}), view: id } }
  }
  return { id, target }
}

export function recordNavigationLabel(id, modules) {
  if (id === 'tasks') return '我的待办'
  return modules.find(module => module.id === id)?.label ?? id
}
