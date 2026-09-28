/**
 * 模块 Agent 能力卡：空态欢迎语下方展示该 Agent 的配置投影（脱敏）。
 * 只渲染 GET /api/module-agents 已脱敏的字段——MCP 只露 id/enabled/transport，
 * headerRefs/env 名与凭据值不出现在 DOM 里。
 * @module agents/AgentCapabilities
 */

import './ModuleAgentPanel.css'

const TEXT = {
  loading: '正在读取该 Agent 的能力配置…',
  revision: '配置版本',
  tools: '工具',
  skills: 'Skills',
  mcp: 'MCP 连接',
  none: '无',
  knowledge: '知识库',
  disabled: '未启用',
}

export default function AgentCapabilities({ capability, error }) {
  if (typeof error === 'string' && error !== '') {
    return (
      <div className="agent-capabilities" data-testid="module-agent-capabilities">
        <p className="agent-cap-error" data-testid="module-agent-capabilities-error">⚠️ {error}</p>
      </div>
    )
  }
  if (capability === null || capability === undefined) {
    return (
      <div className="agent-capabilities" data-testid="module-agent-capabilities">
        <p className="agent-cap-muted">{TEXT.loading}</p>
      </div>
    )
  }
  if (capability.ok !== true) {
    return (
      <div className="agent-capabilities" data-testid="module-agent-capabilities">
        <p className="agent-cap-error" data-testid="module-agent-capabilities-error">
          ⚠️ {capability.error ?? TEXT.disabled}
        </p>
      </div>
    )
  }

  const revision = typeof capability.profileRevision === 'string' ? capability.profileRevision.slice(0, 12) : ''
  const tools = Array.isArray(capability.tools) ? capability.tools : []
  const skills = Array.isArray(capability.skills) ? capability.skills : []
  const mcp = Array.isArray(capability.mcp) ? capability.mcp : []
  const homeBaseId = capability.knowledge?.homeBaseId

  return (
    <div className="agent-capabilities" data-testid="module-agent-capabilities">
      <dl className="agent-cap-list">
        <div className="agent-cap-row" data-testid="module-agent-sources">
          <dt>数据源</dt>
          <dd>{(capability.dataSources ?? []).map(source => <span key={source.kind} className="agent-cap-chip">{source.kind} · {source.id}</span>)}</dd>
        </div>
        {revision !== '' && (
          <div className="agent-cap-row">
            <dt>{TEXT.revision}</dt>
            <dd><code>{revision}</code></dd>
          </div>
        )}
        <div className="agent-cap-row">
          <dt>{TEXT.tools}</dt>
          <dd>{tools.length === 0 ? TEXT.none : tools.map(name => <code key={name}>{name}</code>)}</dd>
        </div>
        <div className="agent-cap-row">
          <dt>{TEXT.skills}</dt>
          <dd>{skills.length === 0 ? TEXT.none : skills.map(skill => <span key={skill.name} className="agent-cap-chip">{skill.name}</span>)}</dd>
        </div>
        <div className="agent-cap-row">
          <dt>{TEXT.mcp}</dt>
          <dd>
            {mcp.length === 0 ? TEXT.none : mcp.map(entry => (
              <span key={entry.id} className="agent-cap-chip">
                {entry.id} · {entry.transport} · {entry.enabled ? 'on' : 'off'}
              </span>
            ))}
          </dd>
        </div>
        {typeof homeBaseId === 'string' && homeBaseId !== '' && (
          <div className="agent-cap-row">
            <dt>{TEXT.knowledge}</dt>
            <dd><code>{homeBaseId}</code></dd>
          </div>
        )}
      </dl>
    </div>
  )
}
