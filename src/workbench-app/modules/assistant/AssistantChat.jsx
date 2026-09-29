/**
 * 我的助理对话列：与「今天 / 待办」两个页签共用同一段会话，切换页签不卸载、草稿不丢。
 *
 * 与其它模块的对话列一致的三件事：助理写完待办/草稿后按工具调用指纹回读一次数据；
 * 能力错误与刷新失败各有自己的条；正文沿用 shell/AIPanel 的 embedded 形态。
 * 本版多一处 dock：把方案确认卡挂在输入框上方（AIPanel 的 dock 插槽），
 * 让「助理提了建议」和「确认/取消」发生在同一屏里。
 * @module modules/assistant/AssistantChat
 */

import { useEffect, useState } from 'react'
import { useModuleAgentChat } from '../../agents/useModuleAgentChat.jsx'
import AIPanel from '../../shell/AIPanel.jsx'
import { useAssistantMobileView } from './mobile-view.jsx'
import PlanReview from './PlanReview.jsx'

export const assistantAgentPanel = {
  id: 'assistant',
  title: '我的助理',
  welcomeText: '把事情说给我听：我记成待办，也可以和你一起安排今天。安排建议先给你预览，确认后才写进日程。',
  suggestions: ['帮我把今天理一理', '下午两小时，安排几件事', '记下：周五前交物业费'],
  inputPlaceholder: '想到什么就说，我来安排…',
}

/** 助理真正改了待办或草稿的工具：指纹一变就回读一次列表。 */
const WRITE_TOOLS = ['assistant_capture', 'assistant_propose_plan']

export default function AssistantChat({ data, themeMode, stepsMode, refresh, mutate, notify }) {
  const chat = useModuleAgentChat('assistant')
  const { showChat } = useAssistantMobileView()
  const [refreshError, setRefreshError] = useState('')
  const { sessionId, transcript, localRows, busy, status, modelName, draft, setDraft, send, stop, canStop, stopping, newConversation, retry, dialog, respondToDialog, capability, capabilityError } = chat
  const writes = (transcript?.entries ?? []).flatMap(entry => entry.kind === 'assistant' ? entry.tools ?? [] : entry.kind === 'toolResult' ? [entry.run] : [])
    .filter(tool => WRITE_TOOLS.includes(tool.toolName) && tool.status === 'success')
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

  const plans = Array.isArray(data?.plans) ? data.plans : []
  const pendingPlans = sessionId === null
    ? []
    : plans.filter(plan => plan?.sourceSessionId === sessionId && (plan.appliedAt === null || plan.appliedAt === undefined))
  const docked = pendingPlans.length > 0
  const configError = capabilityError || (capability && !capability.ok ? capability.error || '请在 Agent 配置中检查我的助理设置。' : '')
  return <section className="assistant-chat" data-testid="assistant-agent-chat" data-agent-id="assistant" data-session-id={sessionId ?? ''} data-plan={docked ? 'open' : undefined} aria-label="我的助理对话">
    <div className="assistant-chat-body">
      <div className="assistant-chat-panel"><AIPanel {...assistantAgentPanel} embedded subtitle="收集 · 整理 · 安排" transcript={transcript} assistRows={localRows} busy={busy} status={status} modelName={modelName} themeMode={themeMode} stepsMode={stepsMode}
        dock={docked ? <PlanReview plans={plans} tasks={data?.tasks ?? []} sessionId={sessionId} refresh={refresh} notify={notify} /> : null}
        dialog={dialog} onRespondDialog={respondToDialog} onSend={send} onAction={send} onNew={newConversation} onRetry={retry} onRefreshData={refreshData}
        onStop={canStop ? stop : undefined} stopping={stopping} draft={draft} onDraftChange={setDraft}
        emptyExtra={<p className="assistant-chat-guide">随口记录不必填齐信息；安排建议确认后才写进日程。</p>} /></div>
      {configError && <p role="alert" className="assistant-error" data-testid="assistant-agent-error">{configError}</p>}
      {refreshError && <p role="alert" className="assistant-error" data-testid="assistant-refresh-error">事项刷新失败：{refreshError}<button className="btn btn-sm" type="button" data-testid="assistant-refresh-retry" onClick={refreshData}>重新加载</button></p>}
    </div>
    {docked && (
      <button type="button" className="assistant-plan-peek" data-testid="assistant-plan-peek" onClick={showChat}>
        待确认 {pendingPlans.length} 份安排 ›
      </button>
    )}
  </section>
}
