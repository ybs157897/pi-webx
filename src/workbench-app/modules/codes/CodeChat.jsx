import ModuleAgentPanel from '../../agents/ModuleAgentPanel.jsx'
import { IconCode } from '../../icons.jsx'

const definition = {
  id: 'codes',
  title: '代码 Agent',
  welcomeText: '和你一起阅读、理解与修改当前项目。对话按项目分别保留。',
  suggestions: ['梳理这个项目的目录和入口', '解释项目的核心模块'],
  inputPlaceholder: '描述要阅读或修改的代码…',
}

export default function CodeChat({ root, ...props }) {
  if (root) return <ModuleAgentPanel key={root} definition={definition} cwd={root} embedded {...props} />
  return <div className="codes-chat-empty" data-testid="codes-chat-awaiting-project">
    <header><IconCode size={19} /><strong>代码 Agent</strong></header>
    <div><p>等待工作区就绪</p><span>编辑器会自动打开代码 Agent 配置中的目录。需要更换目录时，请前往 Agent 配置页。</span></div>
    <label className="codes-chat-inactive">代码对话<textarea disabled rows={2} placeholder="工作区就绪后开始对话" /></label>
  </div>
}
