import { IconCheck, IconPlus, IconRequirements, IconSparkles, IconTasks } from '../../icons.jsx'

const starters = [
  { id: 'idea', label: '聊聊想法', Icon: IconSparkles, prompt: '我有一个新想法，帮我一步步梳理需求：\n' },
  { id: 'document', label: '整理文档', Icon: IconRequirements, prompt: '帮我梳理下面这份需求文档，找出目标、使用场景和待确认的问题：\n' },
  { id: 'tasks', label: '细化交付', Icon: IconTasks, prompt: '帮我把下面的需求细化成文：先分析代码影响面，把需要我对齐的问题列成 Q1/Q2 清单，确认后形成需求文档和一条整体待办：\n' },
  { id: 'acceptance', label: '明确验收', Icon: IconCheck, prompt: '帮我为下面的需求补充具体、可验证的验收标准：\n' },
]

/** 说清楚一段需求要交代的四件事：问题 / 人 / 期望行为 / 边界。 */
const guidePoints = [
  { term: '要解决的问题', text: '现状哪里不好、造成了什么影响' },
  { term: '给谁用', text: '使用者是谁、在什么场景下用' },
  { term: '期望的行为', text: '用起来应该是什么样、怎么算做完了' },
  { term: '边界与约束', text: '必须满足的限制，以及这次明确不做的部分' },
]

/** 可点击的示例引导语：点一下填进输入框，用户再改成自己的情况。 */
const examples = [
  {
    id: 'categorize',
    text: '我希望在需求记录里一眼看出每条需求属于新功能、需求变更、问题修复还是体验优化，方便按分类跟进；列表在手机上也要正常显示，不能变慢。',
  },
  {
    id: 'export',
    text: '把待办导出成 CSV，包含标题、优先级和截止日期；一次最多导出 1000 条；没有待办时按钮置灰并说明原因。',
  },
]

/**
 * 示例引导语的填入规则：同一前缀的连续点击只替换引导语本身，
 * 已经写在输入框里的内容（用户自己补的正文）留在末尾。
 */
export function starterDraft(prefix, current, prompt) {
  const text = String(current ?? '')
  const head = String(prefix ?? '')
  return String(prompt ?? '') + (head !== '' && text.startsWith(head) ? text.slice(head.length) : text)
}

/**
 * 对齐提示的出场规则：Agent 回过一轮（正文里的 Q1/Q2 清单）、回合已结束、
 * 输入框还空着。不解析正文，也不在用户已经落笔时反复打扰。
 */
export function alignHintVisible(entries, busy, draft) {
  const replied = Array.isArray(entries)
    && entries.some(entry => entry?.kind === 'assistant' && String(entry?.text ?? '').trim() !== '')
  return replied && busy !== true && String(draft ?? '').trim() === ''
}

export function RequirementsWelcome({ error, busy = false, onChoose }) {
  return <div className="req-landing" data-testid="req-landing">
    <h2 className="req-landing-title" data-testid="req-landing-title">需求助手</h2>
    <p className="req-landing-description">从一个想法开始，让需求变得清晰</p>
    {error && <p role="alert" className="req-chat-error" data-testid="req-agent-error">{error}</p>}
    <div className="req-guide" data-testid="req-guide">
      <p className="req-guide-title">一段说得清楚的需求，先交代这四件事：</p>
      <ul className="req-guide-points" data-testid="req-guide-points">
        {guidePoints.map(point => <li key={point.term}><strong>{point.term}</strong>：{point.text}</li>)}
      </ul>
      {typeof onChoose === 'function' && <div className="req-guide-examples" data-testid="req-guide-examples">
        <span className="req-guide-examples-label">还没想好怎么写？点一条示例填进输入框，再改成你的情况：</span>
        {examples.map(example => (
          <button
            type="button"
            className="req-example"
            data-testid={`req-example-${example.id}`}
            key={example.id}
            disabled={busy}
            onClick={() => onChoose(example.text)}
          >
            {example.text}
          </button>
        ))}
      </div>}
    </div>
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
