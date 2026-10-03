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

export default function ModuleAgentPanel({ definition, themeMode, stepsMode, onClose, onRefreshData, embedded = false, cwd }) {
  const { id: agentId, title, welcomeText, suggestions, inputPlaceholder } = definition
  const {
    transcript, localRows, busy, modelName, status,
    send, newConversation, retry, dialog, respondToDialog,
    capability, capabilityError, stop, canStop, stopping, sendDisabled, updateQueue, canNewConversation, draft, setDraft,
  } = useModuleAgentChat(agentId, { cwd })

  return (
    <div className={`agent-panel${embedded ? ' agent-panel-embedded' : ''}`} data-testid="module-agent-panel" data-agent-id={agentId}>
      <AIPanel
        embedded={embedded}
        supportsImages
        title={title}
        subtitle={title}
        welcomeText={welcomeText}
        suggestions={suggestions}
        inputPlaceholder={inputPlaceholder}
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
        canNewConversation={canNewConversation}
        sendDisabled={sendDisabled}
        onUpdateQueue={updateQueue}
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
