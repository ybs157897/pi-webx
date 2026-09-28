import { logsAgentPanel } from '../modules/logs/index.jsx'

const panels = {
  requirements: { id: 'requirements', title: '需求 Agent' },
  codes: { id: 'codes', title: '代码 Agent' },
  logs: logsAgentPanel,
}

export function moduleAgentPanelDefinition(id) {
  return panels[id] ?? { id, title: '模块 Agent' }
}
