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
    transcript, localRows, busy, modelName, status,
    send, newConversation, retry, dialog, respondToDialog,
    capability, capabilityError, stop, canStop, stopping, draft, setDraft,
  } = useModuleAgentChat(agentId)
  const title = AGENT_TITLES[agentId] ?? '模块 Agent'

  return (
    <div className="agent-panel" data-testid="module-agent-panel" data-agent-id={agentId}>
      <AIPanel
        title={title}
        subtitle={title}
        welcomeText="查询已接入的日志和问题清单，按来源与时间核对证据。"
        suggestions={['查找最近的错误日志', '有哪些尚未解决的问题？', '根据日志分析问题原因']}
        inputPlaceholder="描述要查询的日志或问题…（Enter 发送）"
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
        onStop={canStop ? stop : undefined}
        stopping={stopping}
        draft={draft}
        onDraftChange={setDraft}
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
