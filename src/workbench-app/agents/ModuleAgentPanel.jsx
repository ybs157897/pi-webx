/**
 * 模块 Agent 对话面板：与通用 AIPanel 同一外壳，但会话经模块入口装配
 * （工具面/提示词/Skills 由 config/agents/*.yaml 决定）。面板卸载即断开订阅，
 * 会话历史由服务端会话文件与恢复指针保证。
 * @module agents/ModuleAgentPanel
 */

import AIPanel from '../shell/AIPanel.jsx'
import AgentCapabilities from './AgentCapabilities.jsx'
import { useModuleAgentChat } from './useModuleAgentChat.jsx'
import './ModuleAgentPanel.css'

/** 面板标题：配置侧的名字走 YAML，这里只是 UI 展示名。 */
const AGENT_TITLES = {
  requirements: '需求 Agent',
  codes: '代码 Agent',
  logs: '日志 Agent',
}

export default function ModuleAgentPanel({ agentId, themeMode, stepsMode, onClose, onRefreshData }) {
  const {
    chat, transcript, localRows, busy, modelName, status,
    send, newConversation, retry, dialog, respondToDialog,
    capability, capabilityError,
  } = useModuleAgentChat(agentId)
  const title = AGENT_TITLES[agentId] ?? '模块 Agent'

  return (
    <div className="agent-panel" data-testid="module-agent-panel" data-agent-id={agentId}>
      <AIPanel
        title={title}
        subtitle={title}
        transcript={transcript}
        assistRows={localRows.length === 0 ? [] : localRows}
        busy={busy}
        status={status}
        modelName={modelName}
        themeMode={themeMode}
        stepsMode={stepsMode}
        dialog={dialog}
        onRespondDialog={respondToDialog}
        onSend={send}
        onNew={newConversation}
        onRetry={retry}
        onRefreshData={onRefreshData}
        onAction={send}
        onClose={onClose}
        emptyExtra={<AgentCapabilities capability={capability} error={capabilityError} />}
      />
    </div>
  )
}
