import { IconCheck, IconPlus, IconRequirements, IconSparkles, IconTasks } from '../../icons.jsx'

const starters = [
  { id: 'idea', label: '聊聊想法', Icon: IconSparkles, prompt: '我有一个新想法，帮我一步步梳理需求：\n' },
  { id: 'document', label: '整理文档', Icon: IconRequirements, prompt: '帮我梳理下面这份需求文档，找出目标、使用场景和待确认的问题：\n' },
  { id: 'tasks', label: '拆解待办', Icon: IconTasks, prompt: '帮我把下面的需求拆解成可执行的待办，先和我确认再导入：\n' },
  { id: 'acceptance', label: '明确验收', Icon: IconCheck, prompt: '帮我为下面的需求补充具体、可验证的验收标准：\n' },
]

export function RequirementsWelcome({ error }) {
  return <div className="req-landing" data-testid="req-landing">
    <h2 className="req-landing-title" data-testid="req-landing-title">需求助手</h2>
    <p className="req-landing-description">从一个想法开始，让需求变得清晰</p>
    {error && <p role="alert" className="req-chat-error" data-testid="req-agent-error">{error}</p>}
  </div>
}

export function RequirementsNewConversation({ busy, onNew }) {
  return <button type="button" className="icon-btn req-composer-new" data-testid="req-new-conversation" aria-label="新对话" title="新对话" disabled={busy} onClick={onNew}>
    <IconPlus size={20} />
  </button>
}

export function RequirementsStarterActions({ busy, status, modelName, onChoose }) {
  const statusText = status === 'connecting' ? '连接中…' : status === 'error' ? '连接失败' : status === 'live' ? modelName || '已连接' : '准备就绪'
  return <div className="req-starter-footer" data-testid="req-starter-footer">
    <div className="req-starter-toolbar" data-testid="req-starter-toolbar">
      <span><IconRequirements size={15} />需求梳理</span>
      <span className="req-starter-status" title={statusText}><span className={`status-dot ${status === 'live' ? '' : status === 'connecting' ? 'connecting' : 'off'}`} />{statusText}</span>
    </div>
    <div className="req-starter-suggestions" data-testid="req-starter-suggestions" role="group" aria-label="开始梳理需求">
      {starters.map(({ id, label, Icon, prompt }) => <button type="button" className="req-starter-chip" data-testid={`req-starter-${id}`} key={id} disabled={busy} onClick={() => onChoose(prompt)}>
        <Icon size={16} />{label}
      </button>)}
    </div>
  </div>
}
