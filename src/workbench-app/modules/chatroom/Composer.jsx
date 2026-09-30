/** 内部群聊输入区：@ 选择、回复锚点和发送反馈。 */
export default function ChatroomComposer({
  members = [], body = '', onBodyChange = () => {}, onCaretChange = () => {}, onKeyDown = () => {},
  onMentionButton = () => {}, mentionOpen = false, mentionOptions = [], activeMentionIndex = 0,
  onSelectMention = () => {}, replyingTo = null, onCancelReply = () => {},
  sending = false, sendError = '', onRetrySend = () => {}, onDismissSendError = () => {},
  canRetrySend = false,
  onSend = () => {}, textareaRef, topicTitle = '新话题', hasCurrentTopic = false, taskRouteActive = false,
  taskNeedsRecipient = false, targetAgentName = '', onNewTopic = () => {}, routeReady = true,
}) {
  const canSend = body.trim().length > 0 && members.length > 0 && routeReady && !sending
  return <form className="chatroom-composer" data-testid="chatroom-composer" onSubmit={event => { event.preventDefault(); onSend() }}>
    <div className="chatroom-composer-route" data-testid="chatroom-composer-route">
      <span>{!routeReady ? '正在恢复当前话题…' : taskRouteActive && taskNeedsRecipient && !targetAgentName
        ? `补充到任务：${topicTitle} · 请先 @ 一位任务成员`
        : hasCurrentTopic ? `${taskRouteActive ? '补充到任务' : '继续话题'}${targetAgentName ? ` · ${targetAgentName}` : ''}：${topicTitle}`
          : '发送后开始新话题'}</span>
      {hasCurrentTopic && <button type="button" onClick={onNewTopic} data-testid="chatroom-clear-topic">清除并新建话题</button>}
    </div>
    {replyingTo && <div className="chatroom-reply-target" data-testid="chatroom-reply-target">
      <div>
        <strong>回复 {replyingTo.senderName || '群成员'}</strong>
        <p>{String(replyingTo.body || '').slice(0, 100)}</p>
      </div>
      <button type="button" onClick={onCancelReply} aria-label="取消回复" data-testid="chatroom-cancel-reply">×</button>
    </div>}
    {sendError && <div className="chatroom-send-error" role="alert" data-testid="chatroom-send-error">
      <span>{sendError}</span>
      {canRetrySend && <button type="button" onClick={onRetrySend} disabled={sending || members.length === 0} data-testid="chatroom-send-retry">重试上一条</button>}
      <button type="button" onClick={onDismissSendError} aria-label="关闭发送错误" data-testid="chatroom-send-error-dismiss">×</button>
    </div>}
    {mentionOpen && <div className="chatroom-mention-menu" id="chatroom-mention-menu" role="listbox" aria-label="点名成员" data-testid="chatroom-mention-menu">
      {mentionOptions.length > 0 ? mentionOptions.map((member, index) => <button
        type="button" role="option" id={`chatroom-mention-${member.id}`} key={member.id}
        aria-selected={index === activeMentionIndex}
        className={index === activeMentionIndex ? 'is-active' : ''}
        onMouseDown={event => event.preventDefault()}
        onClick={() => onSelectMention(member)} data-testid="chatroom-mention-option"
      >
        <span className="chatroom-mention-option-avatar" aria-hidden="true">{Array.from(member.name || '?')[0]}</span>
        <span>{member.name}</span>
      </button>) : <p className="chatroom-mention-empty">没有匹配的成员</p>}
    </div>}
    <div className="chatroom-composer-row">
      <button type="button" className="chatroom-at-button" aria-label="点名成员" aria-haspopup="listbox" aria-expanded={mentionOpen} aria-controls="chatroom-mention-menu" onClick={onMentionButton} disabled={members.length === 0} data-testid="chatroom-at-button">@</button>
      <textarea
        ref={textareaRef} value={body} rows={2} maxLength={12000} data-testid="chatroom-input"
        placeholder="例如：@需求管理 请整理这个需求并交给开发…"
        aria-label="群聊消息" aria-haspopup="listbox" aria-expanded={mentionOpen} aria-controls="chatroom-mention-menu"
        aria-activedescendant={mentionOpen && mentionOptions[activeMentionIndex] ? `chatroom-mention-${mentionOptions[activeMentionIndex].id}` : undefined}
        onChange={event => onBodyChange(event.target.value, event.target.selectionStart)}
        onClick={event => onCaretChange(event.target.selectionStart)}
        onKeyUp={event => { if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) onCaretChange(event.target.selectionStart) }}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="chatroom-send-button" disabled={!canSend} data-testid="chatroom-send">{sending ? '发送中' : '发送'}</button>
    </div>
    <p className="chatroom-composer-help">@ 点名可唤醒对应 Agent · Enter 发送，Shift+Enter 换行</p>
  </form>
}
