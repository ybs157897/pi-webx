import { useEffect, useState } from 'react'
import AIPanel from '../../shell/AIPanel.jsx'
import { useModuleAgentChat } from '../../agents/useModuleAgentChat.jsx'
import PlanReview from './PlanReview.jsx'

export const lifeAgentPanel = {
  id: 'life',
  title: '生活秘书',
  welcomeText: '想到什么就告诉我。我会帮你记下、整理，再结合你的时间安排；具体安排会先给你预览。',
  suggestions: ['帮我记下：买猫粮、周五前交物业费、找时间预约洗牙', '看看我的待办，和我一起安排今天，留出休息和路上的时间'],
  inputPlaceholder: '例如：下午有两小时，帮我安排几件生活里的事…',
}

/** 两个生活页面挂在同一个 Workspace 下，切换视图保留此会话与输入草稿。 */
export default function LifeChat({ data, themeMode, stepsMode, refresh, mutate, notify }) {
  const chat = useModuleAgentChat('life')
  const [refreshError, setRefreshError] = useState('')
  const { sessionId, transcript, localRows, busy, status, modelName, draft, setDraft, send, stop, canStop, stopping, newConversation, retry, dialog, respondToDialog, capability, capabilityError } = chat
  const writes = (transcript?.entries ?? []).flatMap(entry => entry.kind === 'assistant' ? entry.tools ?? [] : entry.kind === 'toolResult' ? [entry.run] : [])
    .filter(tool => ['life_capture', 'life_propose_plan'].includes(tool.toolName) && tool.status === 'success')
    .map(tool => tool.toolCallId).join('|')

  useEffect(() => {
    if (!sessionId || busy || typeof refresh !== 'function') return
    let active = true
    Promise.resolve().then(refresh).then(() => { if (active) setRefreshError('') })
      .catch(error => { if (active) setRefreshError(String(error?.message ?? error)) })
    return () => { active = false }
  }, [sessionId, busy, writes, refresh])

  async function refreshData() {
    try { await refresh?.(); setRefreshError('') }
    catch (error) { setRefreshError(String(error?.message ?? error)) }
  }

  const configError = capabilityError || (capability && !capability.ok ? capability.error || '请在 Agent 配置中检查生活秘书设置。' : '')
  return <section className="life-chat" data-testid="life-agent-chat" data-agent-id="life" data-session-id={sessionId ?? ''} aria-label="生活秘书对话">
    <div className="life-chat-panel"><AIPanel {...lifeAgentPanel} embedded subtitle="收集 · 整理 · 安排" transcript={transcript} assistRows={localRows} busy={busy} status={status} modelName={modelName} themeMode={themeMode} stepsMode={stepsMode}
      dialog={dialog} onRespondDialog={respondToDialog} onSend={send} onAction={send} onNew={newConversation} onRetry={retry} onRefreshData={refreshData}
      onStop={canStop ? stop : undefined} stopping={stopping} draft={draft} onDraftChange={setDraft}
      emptyExtra={<p className="life-chat-guide">随手记录不必填齐信息；安排预览确认后生效。</p>} /></div>
    {configError && <p role="alert" className="life-error" data-testid="life-agent-error">{configError}</p>}
    {refreshError && <p role="alert" className="life-error" data-testid="life-refresh-error">事项刷新失败：{refreshError}<button className="btn btn-sm" type="button" data-testid="life-refresh-retry" onClick={refreshData}>重新加载</button></p>}
    <PlanReview plans={data?.lifePlans ?? []} tasks={data?.tasks ?? []} sessionId={sessionId} mutate={mutate} refresh={refresh} notify={notify} />
  </section>
}
