import { useRef, useState } from 'react'
import { collectSkillImports } from './skill-import.js'

export default function SkillList({ skills, imports = [], disabled, onChange, onImportsChange }) {
  const [expanded, setExpanded] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [importError, setImportError] = useState('')
  const [reading, setReading] = useState(false)
  const selection = useRef(0)

  function update(key, patch) {
    onChange(skills.map(skill => skill.key === key ? { ...skill, ...patch } : skill))
  }

  async function chooseFolder(event) {
    const files = event.target.files
    const request = ++selection.current
    setReading(true)
    setImportError('')
    try {
      const result = await collectSkillImports(files)
      if (request === selection.current) setCandidates(result)
    } catch (error) {
      if (request === selection.current) {
        setCandidates([])
        setImportError(error.message || '读取 Skill 文件夹失败。')
      }
    } finally {
      if (request === selection.current) setReading(false)
      event.target.value = ''
    }
  }

  return <section className="agent-settings-section" data-testid="agent-settings-skills">
    <div className="agent-settings-section-heading">
      <h2 className="agent-settings-section-title">Skill</h2>
      <label className="btn agent-settings-import-button">
        导入 Skill 文件夹
        <input type="file" webkitdirectory="" directory="" multiple disabled={disabled || reading}
          onChange={chooseFolder} data-testid="agent-settings-skill-import" aria-label="导入 Skill 文件夹" />
      </label>
    </div>
    <p className="small muted">查看完整内容，编辑当前模块的 Skill，或导入本地 Skill 文件夹。更改在保存配置后生效。</p>
    {importError && <p className="agent-settings-field-error" role="alert" data-testid="agent-settings-import-error">{importError}</p>}
    {reading && <p role="status">正在读取 Skill 文件夹…</p>}
    {candidates.length > 0 && <div className="agent-settings-import-candidates" data-testid="agent-settings-import-candidates">
      <h3>可导入的 Skill</h3>
      {candidates.map(candidate => {
        const staged = imports.some(item => item.name === candidate.name)
        const exists = skills.some(item => item.name === candidate.name)
        return <div className="agent-settings-import-row" key={candidate.name}>
          <span><strong>{candidate.name}</strong><small>{candidate.description || `${candidate.files.length} 个文件`}</small></span>
          <button type="button" className="btn" disabled={disabled || staged || exists}
            onClick={() => onImportsChange([...imports, candidate])}
            data-testid="agent-settings-import-add">{staged ? '待保存' : exists ? '已存在' : '加入草稿'}</button>
        </div>
      })}
    </div>}
    {imports.length > 0 && <div className="agent-settings-staged-imports" data-testid="agent-settings-staged-imports">
      <h3>待导入 · 保存后启用</h3>
      {imports.map(item => <div className="agent-settings-import-row" key={item.name}>
        <span><strong>{item.name}</strong><small>{item.files.length} 个文件</small></span>
        <button type="button" className="btn" disabled={disabled} aria-label={`移除 ${item.name}`}
          data-testid="agent-settings-import-remove"
          onClick={() => onImportsChange(imports.filter(candidate => candidate.name !== item.name))}>移除</button>
      </div>)}
    </div>}
    <div className="agent-settings-skill-list">
      {skills.length === 0 && <p className="small muted" data-testid="agent-settings-empty-skills">当前 Agent 未配置 Skill。可从本地文件夹导入。</p>}
      {skills.map(skill => <article className="agent-settings-skill" key={skill.key} data-testid="agent-settings-skill">
        <div className="agent-settings-skill-heading">
          <label className="agent-settings-skill-choice">
            <input type="checkbox" checked={skill.selected} disabled={disabled}
              onChange={event => update(skill.key, { selected: event.target.checked })} aria-label={`使用 ${skill.name}`} />
            <span className="agent-settings-skill-name">{skill.name}</span>
          </label>
          <span className="small muted">{skill.selected ? '已选用' : '未选用'}</span>
          <button type="button" className="btn agent-settings-skill-details" aria-expanded={expanded === skill.key}
            onClick={() => setExpanded(expanded === skill.key ? null : skill.key)}
            data-testid="agent-settings-skill-details">{expanded === skill.key ? '收起详情' : '查看详情'}</button>
        </div>
        <p className="small muted agent-settings-skill-description">{skill.description}</p>
        {expanded === skill.key && <div className="agent-settings-skill-content" data-testid="agent-settings-skill-content">
          <div className="agent-settings-section-heading">
            <h3>完整内容</h3>
            <span className="small muted">{skill.editable ? '当前模块可编辑' : '共享内容仅可查看'}</span>
          </div>
          {skill.editable ? <textarea className="textarea agent-settings-skill-textarea"
            value={skill.content || ''} disabled={disabled} aria-label={`编辑 ${skill.name} 的内容`}
            onChange={event => update(skill.key, { content: event.target.value })}
            data-testid="agent-settings-skill-editor" />
            : <pre className="agent-settings-skill-readonly">{skill.content || '暂无可显示的内容。'}</pre>}
        </div>}
      </article>)}
    </div>
  </section>
}
