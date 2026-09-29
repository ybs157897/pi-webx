export const AGENT_MODULES = [
  { id: 'life', label: '生活秘书', description: '收集生活事项并规划每天的安排' },
  { id: 'works', label: '工作助理', description: '规划时间与工作安排' },
  { id: 'logs', label: '日志', description: '查询记录并引用证据' },
  { id: 'requirements', label: '需求', description: '梳理与分析需求' },
  { id: 'codes', label: '代码', description: '协助代码开发' },
]

export function copyDraft(view) {
  return {
    workspace: view.workspace,
    prompt: view.prompt,
    model: view.model === null ? null : { ...view.model },
    skills: view.skills.map(skill => ({ ...skill })),
    imports: [],
  }
}

export function validateDraft(draft) {
  const errors = {}
  if (draft.workspace !== null && !draft.workspace?.trim()) errors.workspace = '请输入已有工作区的绝对路径。'
  if (!draft.prompt.trim()) errors.prompt = '提示词不能为空。'
  return errors
}

export function updateBody(view, draft) {
  return {
    revision: view.revision,
    workspace: draft.workspace,
    prompt: draft.prompt,
    model: draft.model,
    skills: draft.skills.map(skill => ({
      key: skill.key,
      selected: skill.selected,
      ...(skill.editable && skill.content !== view.skills.find(item => item.key === skill.key)?.content
        ? { content: skill.content } : {}),
    })),
    ...(draft.imports?.length ? { imports: draft.imports.map(({ files }) => ({ files })) } : {}),
  }
}

export function isDirty(view, draft) {
  if (!view || !draft) return false
  return JSON.stringify(updateBody(view, draft)) !== JSON.stringify(updateBody(view, copyDraft(view)))
}
