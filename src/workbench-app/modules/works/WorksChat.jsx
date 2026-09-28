import { useEffect, useState } from 'react'
import AIPanel from '../../shell/AIPanel.jsx'
import { useModuleAgentChat } from '../../agents/useModuleAgentChat.jsx'

export const worksAgentPanel = {
  id: 'works',
  title: '工作规划助手',
  welcomeText: '告诉我有哪些事情要做、截止时间和可用时段。我会结合你的待办与已有安排，一起决定先做什么、什么时候做。',
  suggestions: ['看看我的待办和已有安排，帮我规划今天的工作', '我想安排本周工作，先帮我理清优先级和可用时间'],
  inputPlaceholder: '例如：明天上午有两个小时，帮我安排手头的工作…',
}

export default function WorksChat({ themeMode, stepsMode, onRefresh }) {
  const chat = useModuleAgentChat('works')
  const [refreshError, setRefreshError] = useState('')
  const { sessionId, transcript, localRows, busy, status, modelName, draft, setDraft, send, stop, canStop, stopping, newConversation, retry, dialog, respondToDialog, capability, capabilityError } = chat
  const writes = (transcript?.entries ?? []).flatMap(entry => entry.kind === 'assistant' ? entry.tools ?? [] : entry.kind === 'toolResult' ? [entry.run] : [])
    .filter(tool => tool.toolName === 'works_schedule' && tool.status === 'success').map(tool => tool.toolCallId).join('|')

  useEffect(() => {
    if (!sessionId || busy || typeof onRefresh !== 'function') return
    let active = true
    Promise.resolve().then(onRefresh).then(() => { if (active) setRefreshError('') })
      .catch(error => { if (active) setRefreshError(String(error?.message ?? error)) })
    return () => { active = false }
  }, [sessionId, busy, writes, onRefresh])

  async function refresh() {
    try { await onRefresh?.(); setRefreshError('') }
    catch (error) { setRefreshError(String(error?.message ?? error)) }
  }

  const configError = capabilityError || (capability && !capability.ok ? capability.error || '请在 Agent 配置中检查工作助理设置。' : '')
  return <section className="works-chat" data-testid="works-agent-chat" data-agent-id="works" aria-label="工作规划对话">
    <div className="works-chat-panel"><AIPanel {...worksAgentPanel} embedded subtitle="工作规划助手" transcript={transcript} assistRows={localRows} busy={busy} status={status} modelName={modelName} themeMode={themeMode} stepsMode={stepsMode}
      dialog={dialog} onRespondDialog={respondToDialog} onSend={send} onAction={send} onNew={newConversation} onRetry={retry} onRefreshData={refresh}
      onStop={canStop ? stop : undefined} stopping={stopping} draft={draft} onDraftChange={setDraft}
      emptyExtra={configError ? <p role="alert" className="works-planning-error" data-testid="works-agent-error">{configError}</p> : <p className="works-chat-guide">理清事情 · 确定优先级 · 排进可用时间</p>} /></div>
    {refreshError && <p role="alert" className="works-planning-error" data-testid="works-refresh-error">安排刷新失败：{refreshError}<button className="btn btn-sm" type="button" data-testid="works-refresh-retry" onClick={refresh}>重新加载</button></p>}
  </section>
}
