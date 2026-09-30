/**
 * 日志对话首页三件套：欢迎语（空会话）+ 输入框左侧的新对话键 + 输入框下方的
 * 工具栏与快捷检索 chips。文案与 Agent 面板（agent-ui.js）同源，chips 只往草稿里
 * 写前缀，发送仍走宿主的一条 send。
 */
import { IconAlert, IconBug, IconLogs, IconPlus, IconSearch } from '../../icons.jsx'

const starters = [
  { id: 'errors', label: '查错误', Icon: IconBug, prompt: '帮我查找最近的错误日志，按来源和时间列出来：\n' },
  { id: 'analysis', label: '析原因', Icon: IconSearch, prompt: '根据最近的日志帮我分析可能的问题原因：\n' },
  { id: 'summary', label: '今日汇总', Icon: IconLogs, prompt: '帮我汇总今天的日志：\n' },
  { id: 'open', label: '未解决', Icon: IconAlert, prompt: '还有哪些尚未解决的问题？\n' },
]

export function LogsWelcome({ error }) {
  return <div className="logs-landing" data-testid="logs-landing">
    <h2 className="logs-landing-title" data-testid="logs-landing-title">日志助手</h2>
    <p className="logs-landing-description">查日志、记日志，截图和日志文件可以直接丢进来</p>
    {error && <p role="alert" className="logs-chat-error" data-testid="logs-agent-error">{error}</p>}
  </div>
}

export function LogsNewConversation({ busy, onNew }) {
  return <button type="button" className="icon-btn logs-composer-new" data-testid="logs-new-conversation" aria-label="新对话" title="新对话" disabled={busy} onClick={onNew}>
    <IconPlus size={20} />
  </button>
}

export function LogsStarterActions({ busy, status, modelName, onChoose }) {
  const statusText = status === 'connecting' ? '连接中…' : status === 'error' ? '连接失败' : status === 'live' ? modelName || '已连接' : '准备就绪'
  return <div className="logs-starter-footer" data-testid="logs-starter-footer">
    <div className="logs-starter-toolbar" data-testid="logs-starter-toolbar">
      <span><IconLogs size={15} />日志检索</span>
      <span className="logs-starter-status" title={statusText}><span className={`status-dot ${status === 'live' ? '' : status === 'connecting' ? 'connecting' : 'off'}`} />{statusText}</span>
    </div>
    <div className="logs-starter-suggestions" data-testid="logs-starter-suggestions" role="group" aria-label="开始检索日志">
      {starters.map(({ id, label, Icon, prompt }) => <button type="button" className="logs-starter-chip" data-testid={`logs-starter-${id}`} key={id} disabled={busy} onClick={() => onChoose(prompt)}>
        <Icon size={16} />{label}
      </button>)}
    </div>
  </div>
}
