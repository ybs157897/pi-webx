import { useEffect, useRef, useState } from 'react'
import AIPanel from '../../shell/AIPanel.jsx'
import { useModuleAgentChat } from '../../agents/useModuleAgentChat.jsx'
import { RequirementsNewConversation, RequirementsStarterActions, RequirementsWelcome } from './Landing.jsx'

export const requirementsAgentPanel = {
  id: 'requirements',
  title: '需求助手',
  welcomeText: '从一个想法开始，一起聊清楚要解决的问题、使用场景和验收标准。整理好后，你可以确认并导入待办。',
  suggestions: ['我有一个新想法，帮我一步步梳理需求', '我有一段需求文档，想整理成可执行的待办'],
  inputPlaceholder: '说说你想做什么，也可以粘贴已有需求…',
}

export default function RequirementsChat({ data, themeMode, stepsMode, onRefresh, onImport, onOpenTasks }) {
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

  async function refreshDrafts() {
    try { await onRefresh?.(); setRefreshError('') }
    catch (error) { setRefreshError(String(error?.message ?? error)) }
  }

  const records = (data?.requirements ?? []).filter(row => sessionId && row.sourceSessionId === sessionId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const configError = capabilityError || (capability && !capability.ok ? capability.error || '需求助手未启用，请在 Agent 配置中检查。' : '')

  function chooseStarter(prompt) {
    const content = starterPrefix.current && draft.startsWith(starterPrefix.current) ? draft.slice(starterPrefix.current.length) : draft
    setDraft(prompt + content)
    starterPrefix.current = prompt
    panelRef.current?.querySelector('textarea')?.focus()
  }

  return <section className="req-conversation" data-testid="req-conversation" data-agent-id="requirements" aria-label="需求梳理对话">
    <div className="req-chat-panel" ref={panelRef}>
      <AIPanel {...requirementsAgentPanel} embedded supportsImages subtitle="需求助手" transcript={transcript} assistRows={localRows} busy={busy} status={status} modelName={modelName} themeMode={themeMode} stepsMode={stepsMode}
        dialog={dialog} onRespondDialog={respondToDialog} onSend={send} onAction={send} onNew={newConversation} onRetry={retry} onRefreshData={refreshDrafts}
        sendDisabled={sendDisabled} onUpdateQueue={updateQueue} canNewConversation={canNewConversation}
        onStop={canStop ? stop : undefined} stopping={stopping} draft={draft} onDraftChange={setDraft}
        emptyState={<RequirementsWelcome error={configError} />}
        composerLeading={<RequirementsNewConversation busy={busy || canNewConversation === false} onNew={newConversation} />}
        composerFooter={<RequirementsStarterActions busy={busy} status={status} modelName={modelName} onChoose={chooseStarter} />} />
    </div>
    {refreshError && <p role="alert" className="req-chat-error" data-testid="req-refresh-error">草稿刷新失败：{refreshError}<button className="btn btn-sm" type="button" onClick={refreshDrafts}>重试</button></p>}
    {records.length > 0 && <div className="req-drafts" aria-label="本次对话的需求草稿" data-testid="req-session-drafts">
      {records.map(row => <div className="req-draft" key={row.id} data-testid="req-draft">
        <div><span className="req-draft-label">{row.importedAt ? '已导入待办' : '需求草稿已整理'}</span><strong>{row.title}</strong><span className="req-draft-count">{row.taskDrafts?.length ?? 0} 项待办{row.importedAt ? ' · 可在待办中跟进' : ' · 预览并确认后导入'}</span></div>
        <button type="button" className="btn btn-primary btn-sm" data-testid="req-draft-import" disabled={busy} onClick={() => row.importedAt ? onOpenTasks(row.id) : onImport(row)}>{row.importedAt ? '查看待办' : '预览并导入待办'}</button>
      </div>)}
    </div>}
  </section>
}
