import SkillList from './SkillList.jsx'
import ModuleTabs from './ModuleTabs.jsx'
import PromptEditor from './PromptEditor.jsx'
import WorkspaceEditor from './WorkspaceEditor.jsx'

function modelValue(model) {
  return model === null ? 'null' : JSON.stringify({ provider: model.provider, id: model.id })
}

export function AgentSettingsEditor({
  id, view, draft, loading, saving, feedback, errors, catalog, catalogError,
  pending, onModuleChange, onEdit, onReload, onConfirmPending, onCancelPending,
}) {
  const modelOptions = catalog?.groups?.flatMap(group => group.models.map(model => ({
    value: modelValue({ provider: group.provider, id: model.id }),
    name: model.name || model.id,
  }))) ?? []
  const currentModel = draft ? modelValue(draft.model) : 'null'
  const missingModel = draft?.model && !modelOptions.some(option => option.value === currentModel)

  return (
    <div className="agent-settings-editor" data-testid="agent-settings-editor">
      <div className="agent-settings-intro">
        <div className="agent-settings-module-group">
          <h2 className="agent-settings-section-title">模块 Agent</h2>
          <ModuleTabs id={id} disabled={saving || Boolean(pending)} onChange={onModuleChange} />
        </div>
        {view && <div className="agent-settings-status" data-testid="agent-settings-status">
          <span className={`agent-settings-badge ${view.enabled ? 'is-ok' : 'is-warn'}`}>{view.enabled ? '已启用' : '已禁用'}</span>
          <span className={`agent-settings-badge ${view.implemented ? 'is-ok' : 'is-warn'}`}>{view.implemented ? '已实现' : '尚未实现'}</span>
        </div>}
      </div>

      <p className="small muted agent-settings-scope">保存后用于新对话，已有对话保持原配置。</p>
      {pending && <div className="agent-settings-confirm" role="alertdialog" aria-label="未保存的修改" data-testid="agent-settings-unsaved">
        <p>当前有未保存的修改。放弃草稿并{pending.kind === 'navigate' ? '离开 Agent 配置' : '切换 Agent'}？</p>
        <div className="agent-settings-confirm-actions">
          <button type="button" className="btn" onClick={onCancelPending} data-testid="agent-settings-keep-editing">继续编辑</button>
          <button type="button" className="btn btn-danger-solid" onClick={onConfirmPending} data-testid="agent-settings-discard">放弃修改</button>
        </div>
      </div>}
      {feedback && <div className={`agent-settings-feedback ${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'} data-testid="agent-settings-feedback">
        <span>{feedback.message}</span>
        {feedback.conflict && <button type="button" className="btn" disabled={saving} onClick={onReload}>重新读取并丢弃本地修改</button>}
      </div>}
      {loading && <p role="status" data-testid="agent-settings-loading">正在读取模块配置…</p>}
      {!loading && !view && <button type="button" className="btn" disabled={saving} onClick={onReload}>重试读取</button>}
      {view && draft && <div id="agent-settings-module-panel" role="tabpanel"
        aria-labelledby={`agent-settings-tab-${id}`} className="agent-settings-module-panel">
        <WorkspaceEditor key={`workspace-${id}`} workspace={draft.workspace}
          workspacePath={view.workspacePath} workspaceDefaultPath={view.workspaceDefaultPath}
          disabled={saving} error={errors.workspace}
          onChange={workspace => onEdit(current => ({ ...current, workspace }))} />
        <PromptEditor key={`prompt-${id}`} id={id} prompt={draft.prompt} model={draft.model} disabled={saving}
          error={errors.prompt} onChange={prompt => onEdit(current => ({ ...current, prompt }))} />
        <section className="agent-settings-section" data-testid="agent-settings-model-section">
          <label className="field" htmlFor="agent-settings-model">
            <span className="agent-settings-section-title">模型</span>
            <select id="agent-settings-model" className="select" value={currentModel} disabled={saving}
              onChange={event => onEdit(current => ({ ...current, model: JSON.parse(event.target.value) }))}
              data-testid="agent-settings-model">
              <option value="null">跟随默认模型</option>
              {missingModel && <option value={currentModel}>当前配置：{draft.model.provider} / {draft.model.id}（目录中未找到）</option>}
              {catalog?.groups?.map(group => <optgroup label={group.name || group.provider} key={group.provider}>
                {group.models.map(model => <option key={`${group.provider}/${model.id}`} value={modelValue({ provider: group.provider, id: model.id })}>
                  {model.name || model.id} ({model.id})
                </option>)}
              </optgroup>)}
            </select>
          </label>
          {catalogError && <p className="agent-settings-field-error" role="status">模型目录读取失败：{catalogError}。提示词和 Skill 草稿可继续编辑；当前模型选择已保留。</p>}
        </section>
        <SkillList key={`skills-${id}`} skills={draft.skills} imports={draft.imports} disabled={saving}
          onChange={skills => onEdit(current => ({ ...current, skills }))}
          onImportsChange={imports => onEdit(current => ({ ...current, imports }))} />
      </div>}
    </div>
  )
}

export function AgentSettingsActions({ dirty, saving, pending, onSave }) {
  return (
    <div className="agent-settings-actions">
      <span className="small muted">{dirty ? '有未保存的修改' : '当前配置已同步'}</span>
      <button type="button" className="btn btn-primary" disabled={saving || !dirty || Boolean(pending)}
        onClick={onSave} data-testid="agent-settings-save">{saving ? '保存中…' : '保存配置'}</button>
    </div>
  )
}
