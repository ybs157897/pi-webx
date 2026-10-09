import { useEffect, useRef, useState } from 'react'
import AIPanel from '../../shell/AIPanel.jsx'
import { useModuleAgentChat } from '../../agents/useModuleAgentChat.jsx'
import { RequirementsNewConversation, RequirementsStarterActions, RequirementsWelcome, alignHintVisible, starterDraft } from './Landing.jsx'

export const requirementsAgentPanel = {
  id: 'requirements',
  title: '需求助手',
  welcomeText: '从一个想法开始，一起聊清楚要解决的问题、使用场景和验收标准。整理好后，你可以确认并导入待办。',
  suggestions: ['我有一个新想法，帮我一步步梳理需求', '我有一段需求文档，想整理成可执行的待办'],
  inputPlaceholder: '说说你想做什么，也可以粘贴已有需求…',
}

export default function RequirementsChat({ themeMode, stepsMode, onRefresh, onTranscript }) {
  const chat = useModuleAgentChat('requirements')
  const [refreshError, setRefreshError] = useState('')
  const panelRef = useRef(null)
  const starterPrefix = useRef('')
  const { sessionId, transcript, localRows, busy, status, modelName, draft, setDraft, send, stop, canStop, stopping, sendDisabled, updateQueue, canNewConversation, newConversation, retry, dialog, respondToDialog, capability, capabilityError } = chat
  const savedTools = (transcript?.entries ?? []).flatMap(entry => entry.kind === 'assistant' ? entry.tools ?? [] : entry.kind === 'toolResult' ? [entry.run] : [])
    .filter(tool => tool.toolName === 'requirements_save_draft' && tool.status === 'success')
    .map(tool => tool.toolCallId).join('|')

  // Both live tool results and restored history refresh the persisted draft projection.
  useEffect(() => {
    if (!sessionId || busy || typeof onRefresh !== 'function') return
    let active = true
    Promise.resolve().then(onRefresh).then(() => { if (active) setRefreshError('') })
      .catch(error => { if (active) setRefreshError(String(error?.message ?? error)) })
    return () => { active = false }
  }, [sessionId, busy, savedTools, onRefresh])

  // 转写与会话 id 送到宿主：需求画布按会话过滤本会话产物，页签徽标据此算未导入草稿数。
  useEffect(() => { onTranscript?.({ transcript, sessionId }) }, [transcript, sessionId, onTranscript])

  async function refreshDrafts() {
    try { await onRefresh?.(); setRefreshError('') }
    catch (error) { setRefreshError(String(error?.message ?? error)) }
  }

  const configError = capabilityError || (capability && !capability.ok ? capability.error || '需求助手未启用，请在 Agent 配置中检查。' : '')
  // 对齐提示：Agent 问完一轮（正文里的 Q1/Q2 清单）而用户还没落笔时露一次。
  const showAlignHint = alignHintVisible(transcript?.entries, busy, draft)

  function chooseStarter(prompt) {
    setDraft(starterDraft(starterPrefix.current, draft, prompt))
    starterPrefix.current = prompt
    panelRef.current?.querySelector('textarea')?.focus()
  }

  return <section className="req-conversation" data-testid="req-conversation" data-agent-id="requirements" aria-label="需求梳理对话">
    <div className="req-chat-panel" ref={panelRef}>
      <AIPanel {...requirementsAgentPanel} embedded supportsImages subtitle="需求助手" transcript={transcript} assistRows={localRows} busy={busy} status={status} modelName={modelName} themeMode={themeMode} stepsMode={stepsMode}
        dialog={dialog} onRespondDialog={respondToDialog} onSend={send} onAction={send} onNew={newConversation} onRetry={retry} onRefreshData={refreshDrafts}
        sendDisabled={sendDisabled} onUpdateQueue={updateQueue} canNewConversation={canNewConversation}
        onStop={canStop ? stop : undefined} stopping={stopping} draft={draft} onDraftChange={setDraft}
        emptyState={<RequirementsWelcome error={configError} busy={busy} onChoose={chooseStarter} />}
        composerLeading={<>
          <RequirementsNewConversation busy={busy || canNewConversation === false} onNew={newConversation} />
          {showAlignHint && <span className="req-align-hint" data-testid="req-align-hint" title="Agent 的待确认清单以 Q1、Q2… 编号，逐条回复即可对齐">逐条回复 Q1、Q2… 编号即可对齐</span>}
          {busy && status === 'live' && <span className="req-waiting-hint" data-testid="req-waiting-hint">正在检索项目材料与需求库，复杂需求的影响分析可能需要几分钟</span>}
        </>}
        composerFooter={<RequirementsStarterActions busy={busy} status={status} modelName={modelName} onChoose={chooseStarter} />} />
    </div>
    {refreshError && <p role="alert" className="req-chat-error" data-testid="req-refresh-error">草稿刷新失败：{refreshError}<button className="btn btn-sm" type="button" onClick={refreshDrafts}>重试</button></p>}
  </section>
}
