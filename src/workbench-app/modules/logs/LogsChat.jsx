/**
 * 日志对话宿主：把 logs Agent 的会话状态交给共享 AIPanel，首页（欢迎语 / 新对话 /
 * 快捷检索）由 Landing.jsx 三件套填进面板插槽。日志没有草稿与记录投影，所以不接
 * `onRefreshData`；附件能力由外壳承担，这里只按契约声明 `supportsImages`。
 */
import { useRef } from 'react'
import AIPanel from '../../shell/AIPanel.jsx'
import { useModuleAgentChat } from '../../agents/useModuleAgentChat.jsx'
import { LogsNewConversation, LogsStarterActions, LogsWelcome } from './Landing.jsx'
import { logsAgentPanel } from './agent-ui.js'

export default function LogsChat({ themeMode, stepsMode, onRefreshData }) {
  const chat = useModuleAgentChat('logs')
  const panelRef = useRef(null)
  const starterPrefix = useRef('')
  const { transcript, localRows, busy, status, modelName, draft, setDraft, send, stop, canStop, stopping, newConversation, retry, dialog, respondToDialog, capability, capabilityError } = chat
  const configError = capabilityError || (capability && !capability.ok ? capability.error || '日志助手未启用，请在 Agent 配置中检查。' : '')

  function chooseStarter(prompt) {
    const content = starterPrefix.current && draft.startsWith(starterPrefix.current) ? draft.slice(starterPrefix.current.length) : draft
    setDraft(prompt + content)
    starterPrefix.current = prompt
    panelRef.current?.querySelector('textarea')?.focus()
  }

  return <section className="logs-conversation" data-testid="logs-conversation" data-agent-id="logs" aria-label="日志检索对话">
    <div className="logs-chat-panel" ref={panelRef}>
      <AIPanel {...logsAgentPanel} embedded supportsImages subtitle="日志助手" transcript={transcript} assistRows={localRows} busy={busy} status={status} modelName={modelName} themeMode={themeMode} stepsMode={stepsMode}
        dialog={dialog} onRespondDialog={respondToDialog} onSend={send} onAction={send} onNew={newConversation} onRetry={retry} onRefreshData={onRefreshData}
        onStop={canStop ? stop : undefined} stopping={stopping} draft={draft} onDraftChange={setDraft}
        emptyState={<LogsWelcome error={configError} />}
        composerLeading={<LogsNewConversation busy={busy} onNew={newConversation} />}
        composerFooter={<LogsStarterActions busy={busy} status={status} modelName={modelName} onChoose={chooseStarter} />} />
    </div>
  </section>
}
