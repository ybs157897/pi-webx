import { useState } from 'react'

const STAGE_LABELS = {
  draft: '需求草稿',
  ready: '待派工',
  developing: '开发执行中',
  verifying: '验证中',
  delivered: '正式交付已接受',
  needs_review: '等待核对',
  cancelled: '已取消',
  deleted: '已删除',
}

const EVENT_LABELS = {
  'requirement.created': '需求创建', 'requirement.updated': '需求内容修订',
  'requirement.metadata_updated': '需求元信息更新', 'requirement.tasks_imported': '待办导入',
  'requirement.deleted': '需求删除', 'requirement.restored': '需求恢复',
  'requirement.historical': '历史需求基线',
  'task.linked': '待办关联', 'task.completed': '待办完成', 'task.reopened': '待办重新打开',
  'task.updated': '待办更新', 'task.unlinked': '待办解除关联',
  'task.deleted': '待办删除', 'task.historical': '历史待办基线',
  'dataset.replaced': '业务数据集替换',
  requirement_created: '需求草稿', requirement_updated: '需求修订', requirement_imported: '导入待办',
  chatroom_message_created: '群消息', chatroom_delivery_finished: '群消息投递',
  chatroom_revision_blocked: '需求版本冲突', chatroom_task_accepted: '协作任务认领',
  chatroom_assignment_created: '成员分工', chatroom_assignment_updated: '分工进展',
  chatroom_run_started: 'Agent 运行开始', chatroom_run_finished: 'Agent 运行结束',
  chatroom_tool_started: '工具开始', chatroom_tool_finished: '工具结束',
  chatroom_handoff_created: 'Agent 交接', 'delivery.submitted': '提交交付',
  'delivery.accepted': '人工接受交付', 'delivery.rejected': '人工退回交付',
}

const DELIVERY_LABELS = {
  pending: '待审阅',
  submitted: '待审阅',
  accepted: '已接受',
  rejected: '已退回',
}

const EVIDENCE_LABELS = {
  file: '文件', commit: '提交', pull_request: '拉取请求', test: '测试', report: '报告',
}

const WORK_STATUS_LABELS = {
  waiting: '待开始', running: '进行中', waiting_for_user: '待补充', waiting_for_agent: '待成员',
  completed: '业务已完成', succeeded: '运行成功', failed: '失败', interrupted: '中断',
  needs_review: '待核对', cancelled: '已取消',
}
const AGENT_LABELS = { assistant: '我的助理', requirements: '需求管理', codes: '代码开发', logs: '日志查询' }
const REF_LABELS = { taskId: '任务', assignmentId: '分工', runId: 'Run', messageId: '消息',
  deliveryId: '交付', reviewId: '审阅', toolName: '工具', status: '状态', attempt: '执行次数' }

export function deliveryAcceptanceBlockers(trace, delivery) {
  const blockers = []
  if (delivery?.requirementVersion !== trace?.requirementVersion) blockers.push('这份交付属于旧需求版本')
  if (!Array.isArray(delivery?.runIds) || delivery.runIds.length === 0) blockers.push('这份交付尚未关联成功 Run')
  else for (const runId of delivery.runIds) {
    const run = trace?.links?.runs?.find(item => item.id === runId)
    if (!run || run.status !== 'succeeded' || run.requirementVersion !== trace.requirementVersion) {
      blockers.push('关联 Run 尚未成功结束或属于旧需求版本')
      break
    }
  }
  return blockers
}
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const PROFILE_REVISION_PATTERN = /^[0-9a-f]{64}$/i

function eventReferences(refs) {
  if (Array.isArray(refs)) return refs.map(ref => ({ label: shortText(ref?.kind) || shortText(ref?.type, '引用'),
    value: shortText(ref?.id) || shortText(ref?.ref, '未指定') }))
  if (!refs || typeof refs !== 'object') return []
  return Object.entries(REF_LABELS).filter(([key]) => refs[key] !== null && refs[key] !== undefined)
    .map(([key, label]) => ({ label, value: String(refs[key]) }))
}

function formatTime(value) {
  if (typeof value !== 'string') return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : TIME_FORMAT.format(date)
}

function eventMillis(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? millis : null
}

function shortText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function itemTitle(item) {
  return shortText(item?.title) || shortText(item?.name) || shortText(item?.toolName)
    || shortText(item?.body) || shortText(item?.summary) || shortText(item?.id, '未命名记录')
}

function ResultHash({ value }) {
  const [copyStatus, setCopyStatus] = useState('')
  async function copy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setCopyStatus('请选中哈希后手动复制')
      return
    }
    try { await navigator.clipboard.writeText(value); setCopyStatus('已复制') }
    catch { setCopyStatus('请选中哈希后手动复制') }
  }
  return <span className="req-trace-hash" data-testid="req-trace-result-hash">
    结果哈希：<code>{value}</code>
    <button type="button" onClick={() => { void copy() }} data-testid="req-trace-copy-hash">复制</button>
    {copyStatus && <span role="status">{copyStatus}</span>}
  </span>
}

function SessionId({ value }) {
  const [copyStatus, setCopyStatus] = useState('')
  async function copy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setCopyStatus('请选中 ID 后手动复制')
      return
    }
    try { await navigator.clipboard.writeText(value); setCopyStatus('已复制') }
    catch { setCopyStatus('请选中 ID 后手动复制') }
  }
  return <span className="req-trace-session-id" data-testid="req-trace-session-id">
    <code>{value}</code>
    <button type="button" onClick={() => { void copy() }} data-testid="req-trace-session-copy">复制</button>
    {copyStatus && <span role="status">{copyStatus}</span>}
  </span>
}

function SessionLinks({ trace }) {
  const source = trace?.requirement?.sourceSessionId
  const sourceId = typeof source === 'string' && UUID_PATTERN.test(source) ? source : null
  const sessions = new Map()
  for (const item of [...(trace?.links?.assignments || []), ...(trace?.links?.runs || [])]) {
    if (typeof item?.sessionId !== 'string' || !UUID_PATTERN.test(item.sessionId)) continue
    const existing = sessions.get(item.sessionId) || { agentIds: new Set(), runIds: new Set(), profileRevision: null }
    if (item.agentId) existing.agentIds.add(item.agentId)
    if (item.attempt && item.id) existing.runIds.add(item.id)
    if (typeof item.profileRevision === 'string' && PROFILE_REVISION_PATTERN.test(item.profileRevision)) {
      existing.profileRevision = item.profileRevision
    }
    sessions.set(item.sessionId, existing)
  }
  return <details className="req-trace-section req-trace-sessions" data-testid="req-trace-sessions">
    <summary>会话关联 · {sessions.size + (sourceId ? 1 : 0)}</summary>
    <p className="req-trace-muted">会话 ID 仅用于定位执行记录，不展示会话转录、工具参数或工作目录。</p>
    {sourceId && <div className="req-trace-session-row" data-testid="req-trace-source-session">
      <strong>需求来源会话</strong><SessionId value={sourceId} />
      <p>来源会话可能讨论过多个需求，不能据此把其中每条内容归属此需求。</p>
    </div>}
    {[...sessions].map(([sessionId, details]) => <div className="req-trace-session-row" key={sessionId}
      data-testid="req-trace-agent-session">
      <strong>{[...details.agentIds].map(id => AGENT_LABELS[id] || id).join('、') || 'Agent'} 的工作会话</strong>
      <SessionId value={sessionId} />
      {details.runIds.size > 0 && <p>关联 Run：{[...details.runIds].join('、')}</p>}
      {details.profileRevision && <p className="req-trace-profile-revision" data-testid="req-trace-profile-revision">
        配置摘要：<code>{details.profileRevision}</code>
      </p>}
    </div>)}
    {!sourceId && sessions.size === 0 && <p className="req-trace-muted">尚无可公开定位的 UUID 会话关联。</p>}
  </details>
}

function EvidenceList({ evidence }) {
  const entries = Array.isArray(evidence) ? evidence : []
  if (entries.length === 0) return <p className="req-trace-muted">尚未记录证据引用。</p>
  return <ul className="req-trace-evidence" data-testid="req-trace-evidence-list">
    {entries.map((item, index) => <li key={item?.id || index} data-testid="req-trace-evidence" data-kind={item?.kind || ''}>
      <span>{EVIDENCE_LABELS[item?.kind] || '证据'}</span>
      {item?.label && <strong>{String(item.label)}</strong>}
      <code>{shortText(item?.ref) || shortText(item?.value) || shortText(item?.url, '未填写引用')}</code>
      {item?.result && <small>记录结果：{String(item.result)}</small>}
      {item?.verification && <small>{item.verification === 'observed' ? '关联运行记录' : '提交者报告'}</small>}
    </li>)}
  </ul>
}

function LinkGroup({ title, kind, items }) {
  const rows = Array.isArray(items) ? items : []
  return <section className="req-trace-link-group" data-testid="req-trace-link-group" data-kind={kind}>
    <h4>{title}<span>{rows.length}</span></h4>
    {rows.length === 0 ? <p className="req-trace-muted">暂无关联记录。</p> : <ul>
      {rows.map((item, index) => <li key={item?.id || index} data-testid="req-trace-link" data-kind={kind}>
        <strong>{itemTitle(item)}</strong>
        {item?.status && <span>{WORK_STATUS_LABELS[item.status] || String(item.status)}</span>}
        {item?.done === true && <span>业务任务已完成</span>}
        {item?.agentId && <span>成员：{AGENT_LABELS[item.agentId] || String(item.agentId)}</span>}
        {Number.isSafeInteger(item?.attempt) && <span>第 {item.attempt} 次运行</span>}
        {item?.startedAt && <time dateTime={item.startedAt}>{formatTime(item.startedAt)}</time>}
        {kind === 'runs' && item?.failureCategory && <span data-testid="req-trace-failure-category">
          失败分类：{String(item.failureCategory)}
        </span>}
        {kind === 'runs' && item?.error && <p data-testid="req-trace-run-error">失败原因：{String(item.error)}</p>}
        {kind === 'tools' && Number.isInteger(item?.exitCode) && <span>退出码：{item.exitCode}</span>}
        {kind === 'tools' && Number.isSafeInteger(item?.resultBytes) && <span>结果字节数：{item.resultBytes}</span>}
        {kind === 'tools' && typeof item?.resultHash === 'string' && item.resultHash
          && <ResultHash value={item.resultHash} />}
        {item?.summary && item.summary !== itemTitle(item) && <p>{String(item.summary)}</p>}
      </li>)}
    </ul>}
  </section>
}

export function TraceTimeline({ events = [] }) {
  const rows = [...(Array.isArray(events) ? events : [])].sort((left, right) => {
    const leftTime = eventMillis(left.time)
    const rightTime = eventMillis(right.time)
    if (leftTime === null && rightTime !== null) return -1
    if (rightTime === null && leftTime !== null) return 1
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime
    return Number(left.seq) - Number(right.seq)
  })
  return <section className="req-trace-section" data-testid="req-trace-timeline">
    <h3>生命周期时间线 <span>{rows.length}</span></h3>
    {rows.length === 0 ? <p className="req-trace-muted">尚无可追踪事件。</p> : <ol className="req-trace-events">
      {rows.map(event => <li key={event.id || event.seq} data-testid="req-trace-event" data-event-type={event.type || ''}>
        <div className="req-trace-event-meta">
          <span>{EVENT_LABELS[event.type] || shortText(event.type, '事件')}</span>
          {event.actor && <span>{event.actor === 'record' ? '业务记录' : String(event.actor)}</span>}
          {eventMillis(event.time) === null
            ? <span data-testid="req-trace-time-unknown">时间未知</span>
            : <time dateTime={event.time}>{formatTime(event.time)}</time>}
        </div>
        <p>{shortText(event.summary, '暂无说明')}</p>
        {eventReferences(event.refs).length > 0 && <ul className="req-trace-refs">
          {eventReferences(event.refs).map((ref, index) => <li key={index}>{ref.label}：{ref.value}</li>)}
        </ul>}
      </li>)}
    </ol>}
  </section>
}

export default function TraceContent({
  trace, reviewTarget = null, reviewComment = '', onReviewCommentChange = () => {},
  onBeginReview = () => {}, onCancelReview = () => {}, onConfirmReview = () => {},
  reviewBusy = false, reviewError = '',
}) {
  const links = trace?.links || {}
  const deliveries = Array.isArray(trace?.deliveries) ? trace.deliveries : []
  const acceptedCurrent = deliveries.some(delivery => delivery.status === 'accepted'
    && delivery.requirementVersion === trace?.requirementVersion)
  const acceptedHistorical = deliveries.some(delivery => delivery.status === 'accepted')
  return <div className="req-trace-content" data-testid="req-trace-content">
    <div className="req-trace-overview" data-testid="req-trace-overview">
      <div><span>当前阶段</span><strong data-testid="req-trace-stage">{STAGE_LABELS[trace?.stage] || shortText(trace?.stage, '待记录')}</strong></div>
      <div><span>业务任务</span><strong>以待办和成员分工状态为准</strong></div>
      <div><span>正式交付</span><strong data-testid="req-trace-acceptance">{acceptedCurrent ? '当前版本已人工接受'
        : acceptedHistorical ? '当前版本未接受（历史版本已接受）' : '尚未人工接受'}</strong></div>
    </div>

    <section className="req-trace-section" data-testid="req-trace-requirement">
      <h3>需求来源</h3>
      <p><strong>{itemTitle(trace?.requirement)}</strong></p>
      {trace?.humanId && <p className="req-trace-muted" data-testid="req-trace-human-id">编号：{trace.humanId}</p>}
      {trace?.requirementVersion && <p className="req-trace-muted">版本：{String(trace.requirementVersion)}</p>}
      {trace?.requirement?.importedAt && <p className="req-trace-muted">已导入：{formatTime(trace.requirement.importedAt)}</p>}
      {trace?.archived && <p className="req-trace-muted">此需求已归档。</p>}
      {trace?.coverage?.historical && <p className="req-trace-muted" data-testid="req-trace-historical">
        包含历史补录；早期链路以已列出的事件和证据为准。
      </p>}
      {trace?.coverage?.warnings?.length > 0 && <ul className="req-trace-warnings" data-testid="req-trace-coverage-warnings">
        {trace.coverage.warnings.map((warning, index) => <li key={index}>{String(warning)}</li>)}
      </ul>}
    </section>

    <TraceTimeline events={trace?.events} />

    <SessionLinks trace={trace} />

    <section className="req-trace-section" data-testid="req-trace-links">
      <h3>关联工作与执行记录</h3>
      <div className="req-trace-link-grid">
        <LinkGroup title="导入待办" kind="tasks" items={links.tasks} />
        <LinkGroup title="协作任务" kind="collaborationTasks" items={links.collaborationTasks} />
        <LinkGroup title="成员分工" kind="assignments" items={links.assignments} />
        <LinkGroup title="Agent 运行" kind="runs" items={links.runs} />
        <LinkGroup title="公开消息" kind="messages" items={links.messages} />
        <LinkGroup title="工具记录" kind="tools" items={links.tools} />
      </div>
    </section>

    <section className="req-trace-section" data-testid="req-trace-deliveries">
      <h3>交付与人工审阅 <span>{deliveries.length}</span></h3>
      {!trace?.acceptanceReady && Array.isArray(trace?.blockers) && trace.blockers.length > 0
        && <div className="req-trace-blockers" data-testid="req-trace-blockers">
          <strong>目前不能接受交付</strong>
          <ul>{trace.blockers.map((blocker, index) => <li key={index}>{String(blocker)}</li>)}</ul>
        </div>}
      {deliveries.length === 0 ? <p className="req-trace-muted">尚无交付记录。业务任务完成后仍需提交证据并由人审阅。</p> : <ul className="req-trace-delivery-list">
        {deliveries.map(delivery => <li key={delivery.id} data-testid="req-trace-delivery" data-status={delivery.status || ''}>
          <div className="req-trace-delivery-head">
            <strong>{shortText(delivery.title) || shortText(delivery.summary, '交付记录')}</strong>
            <span>{DELIVERY_LABELS[delivery.status] || shortText(delivery.status, '状态待同步')}</span>
          </div>
          {delivery.summary && delivery.title && <p>{delivery.summary}</p>}
          {delivery.updatedAt && <time dateTime={delivery.updatedAt}>{formatTime(delivery.updatedAt)}</time>}
          <EvidenceList evidence={delivery.evidence} />
          {Array.isArray(delivery.reviews) && delivery.reviews.map(review => <p key={review.id} data-testid="req-trace-review-record">
            {review.decision === 'accept' ? '接受交付' : '退回交付'} · {formatTime(review.createdAt)}{review.comment ? `：${review.comment}` : ''}
          </p>)}
          {delivery.status === 'submitted' && deliveryAcceptanceBlockers(trace, delivery).length > 0
            && <p className="req-trace-muted" data-testid="req-trace-delivery-blocker">
              {deliveryAcceptanceBlockers(trace, delivery).join('；')}
            </p>}
          {delivery.status === 'submitted' && <div className="req-trace-review-actions">
            <button type="button" disabled={reviewBusy || !trace?.acceptanceReady
              || deliveryAcceptanceBlockers(trace, delivery).length > 0} onClick={() => onBeginReview(delivery, 'accept')}
              data-testid="req-trace-accept">接受交付</button>
            <button type="button" disabled={reviewBusy} onClick={() => onBeginReview(delivery, 'reject')}
              data-testid="req-trace-reject">退回交付</button>
          </div>}
          {reviewTarget?.deliveryId === delivery.id && <div className="req-trace-review-confirm" data-testid="req-trace-review-confirm">
            <strong>{reviewTarget.decision === 'accept' ? '确认接受这份交付？' : '确认退回这份交付？'}</strong>
            <p>审阅会记录为人工决定；提交者报告和测试引用不会自动视为已验证。</p>
            <label>审阅意见（可选）
              <textarea value={reviewComment} onChange={event => onReviewCommentChange(event.target.value)}
                maxLength={2000} data-testid="req-trace-review-comment" />
            </label>
            <div className="req-trace-review-actions">
              <button type="button" disabled={reviewBusy} onClick={() => onConfirmReview(delivery, reviewTarget.decision)}
                data-testid="req-trace-review-submit">{reviewBusy ? '提交中…' : reviewTarget.decision === 'accept' ? '确认接受' : '确认退回'}</button>
              <button type="button" disabled={reviewBusy} onClick={onCancelReview} data-testid="req-trace-review-cancel">返回</button>
            </div>
          </div>}
        </li>)}
      </ul>}
      {reviewError && <p className="req-trace-error" role="alert" data-testid="req-trace-review-error">{reviewError}</p>}
    </section>
  </div>
}
