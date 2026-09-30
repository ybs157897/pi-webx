const EVIDENCE_KINDS = [
  { value: 'file', label: '文件' },
  { value: 'commit', label: '提交' },
  { value: 'pull_request', label: '拉取请求' },
  { value: 'test', label: '测试' },
  { value: 'report', label: '报告' },
]

export default function TraceDeliveryForm({
  trace, summary = '', evidence = [], runIdsText = '', busy = false, error = '',
  onSummaryChange = () => {}, onEvidenceChange = () => {}, onAddEvidence = () => {},
  onRemoveEvidence = () => {}, onRunIdsChange = () => {}, onSelectRun = () => {},
  onSubmit = () => {},
}) {
  const successfulRuns = (Array.isArray(trace?.links?.runs) ? trace.links.runs : [])
    .filter(run => run.status === 'succeeded' && run.requirementVersion === trace.requirementVersion)
  return <section className="req-trace-section req-trace-delivery-form" data-testid="req-trace-delivery-form">
    <h3>提交交付证据</h3>
    <p className="req-trace-muted">仅记录实际成果及引用；提交后仍需人工审阅，不能凭提交记录自动标记为接受。</p>
    <form className="req-trace-evidence-form" onSubmit={event => { event.preventDefault(); onSubmit() }}>
      <label>交付说明
        <textarea value={summary} maxLength={4000} onChange={event => onSummaryChange(event.target.value)}
          placeholder="说明完成内容、测试结果及仍需关注的事项" data-testid="req-trace-delivery-summary" />
      </label>
      <div className="req-trace-form-heading"><strong>证据引用</strong><button type="button" disabled={busy || evidence.length >= 10}
        onClick={onAddEvidence} data-testid="req-trace-evidence-add">添加一条</button></div>
      {evidence.map((item, index) => <fieldset key={index} className="req-trace-evidence-row" disabled={busy}
        data-testid="req-trace-evidence-edit">
        <legend>证据 {index + 1}</legend>
        <label>类型
          <select value={item.kind} onChange={event => onEvidenceChange(index, 'kind', event.target.value)}
            data-testid="req-trace-evidence-kind">
            {EVIDENCE_KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </select>
        </label>
        <label>引用
          <input value={item.ref} maxLength={1000} onChange={event => onEvidenceChange(index, 'ref', event.target.value)}
            placeholder="文件位置、提交号、测试记录或报告链接" data-testid="req-trace-evidence-ref" />
        </label>
        <label>说明（可选）
          <input value={item.label || ''} maxLength={200} onChange={event => onEvidenceChange(index, 'label', event.target.value)}
            data-testid="req-trace-evidence-label" />
        </label>
        <button type="button" className="req-trace-evidence-remove" onClick={() => onRemoveEvidence(index)}
          data-testid="req-trace-evidence-remove">移除</button>
      </fieldset>)}
      <label>关联成功 Run ID（可选，逗号分隔）
        <input value={runIdsText} onChange={event => onRunIdsChange(event.target.value)}
          placeholder="仅填真实运行记录 ID" data-testid="req-trace-run-ids" />
      </label>
      {successfulRuns.length > 0 && <label>从已有成功运行中选择
        <select value="" onChange={event => onSelectRun(event.target.value)} data-testid="req-trace-run-select">
          <option value="">选择 Run</option>
          {successfulRuns.map(run => <option key={run.id} value={run.id}>{run.id}{run.agentId ? ` · ${run.agentId}` : ''}</option>)}
        </select>
      </label>}
      {error && <p className="req-trace-error" role="alert" data-testid="req-trace-delivery-error">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy} data-testid="req-trace-delivery-submit">
        {busy ? '提交中…' : '提交交付记录'}
      </button>
    </form>
  </section>
}
