import { logsAgentPanel } from '../modules/logs/index.jsx'
import { requirementsAgentPanel } from '../modules/requirements/RequirementsChat.jsx'
import { worksAgentPanel } from '../modules/works/WorksChat.jsx'

const panels = {
  requirements: requirementsAgentPanel,
  works: worksAgentPanel,
  codes: { id: 'codes', title: '代码 Agent' },
  logs: logsAgentPanel,
}

export function moduleAgentPanelDefinition(id) {
  return panels[id] ?? { id, title: '模块 Agent' }
}
