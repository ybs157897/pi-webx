const STATUS_LABELS = {
  waiting: '等待开始',
  running: '进行中',
  waiting_for_user: '等待你补充',
  waiting_for_agent: '等待成员',
  completed: '已完成',
  failed: '执行失败',
  interrupted: '执行中断',
  needs_review: '待核对改动',
  cancelled: '已取消',
}

const SUPPLEMENT_STATUSES = new Set(['waiting', 'running', 'waiting_for_user', 'waiting_for_agent'])
const RESUME_STATUSES = new Set(['failed', 'interrupted', 'needs_review'])

export function taskReviewKey(taskId, agentId) {
  return `${taskId}:${agentId || ''}`
}

export default function ChatroomTaskBoard({
  tasks = [], members = [], selectedTaskId = null,
  onSelectTask = () => {}, onAction = () => {},
  reviewed = new Set(), onReviewChange = () => {}, busyAction = '', actionError = null, actionNotice = '',
}) {
  const memberNames = new Map(members.map(member => [member.id, member.name]))
  const ordered = [...tasks].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))

  return <section className="chatroom-tasks" aria-label="协作任务" data-testid="chatroom-task-list">
    <div className="chatroom-tasks-heading">
      <strong>协作任务</strong>
      <span>{tasks.length}</span>
      <small>消息投递与任务进度分别记录</small>
    </div>
    {actionNotice && <p className="chatroom-task-action-notice" role="status" data-testid="chatroom-task-action-notice">{actionNotice}</p>}
    {ordered.length === 0 ? <p className="chatroom-tasks-empty" data-testid="chatroom-tasks-empty">暂无协作任务。发起讨论后，成员认领的工作会显示在这里。</p>
      : <ul className="chatroom-task-items">
        {ordered.map(task => <li className={`chatroom-task${selectedTaskId === task.id ? ' is-selected' : ''}`}
          key={task.id} data-testid="chatroom-task" data-task-id={task.id} data-status={task.status}>
          <div className="chatroom-task-topline">
            <button type="button" className="chatroom-task-title" onClick={() => onSelectTask(task, null)}
              aria-label={`${task.assignments?.length > 1 ? '查看任务话题，补充时请点选成员或先 @ 成员' : '继续话题'}：${task.title || '协作任务'}`}
              data-testid="chatroom-task-select">{task.title || '协作任务'}</button>
            <span className="chatroom-task-status" data-testid="chatroom-task-status" data-status={task.status}>
              {STATUS_LABELS[task.status] || '状态待同步'}{task.needsReview ? ' · 待核对' : ''}
            </span>
          </div>
          <ul className="chatroom-task-assignments">
            {(Array.isArray(task.assignments) ? task.assignments : []).map(assignment => {
              const status = assignment.status || task.status
              const agentId = task.assignments.length > 1 ? assignment.agentId : undefined
              const actionKey = taskReviewKey(task.id, agentId)
              const actionBusy = busyAction === actionKey
              return <li className="chatroom-task-assignment" key={assignment.agentId}
                data-testid="chatroom-task-assignment" data-agent-id={assignment.agentId} data-status={status}>
                <div className="chatroom-task-assignment-line">
                  <strong>{memberNames.get(assignment.agentId) || assignment.agentId}</strong>
                  <span>{STATUS_LABELS[status] || '状态待同步'}</span>
                </div>
                {assignment.summary && <p className="chatroom-task-summary" data-testid="chatroom-task-summary">{assignment.summary}</p>}
                <div className="chatroom-task-actions">
                  {SUPPLEMENT_STATUSES.has(status) && <button type="button" onClick={() => onSelectTask(task, assignment.agentId)}
                    data-testid="chatroom-task-continue" data-agent-id={assignment.agentId}>补充到任务</button>}
                  {!task.needsReview && RESUME_STATUSES.has(status) && <button type="button" onClick={() => onAction(task, 'resume', agentId, false)}
                    disabled={Boolean(busyAction)}
                    data-testid="chatroom-task-resume">{actionBusy ? '处理中…' : '继续执行'}</button>}
                </div>
                {actionError?.key === actionKey && !task.needsReview && <p className="chatroom-task-action-error" role="alert"
                  data-testid="chatroom-task-action-error">{actionError.text}</p>}
              </li>
            })}
          </ul>
          {task.needsReview && <div className="chatroom-task-review" data-testid="chatroom-task-review">
            <p>上次执行的实际改动或外部结果尚不确定。请先核对，再记录核对结果。核对完成不会重启已取消的任务。</p>
            <label>
              <input type="checkbox" checked={reviewed.has(taskReviewKey(task.id, 'review'))}
                onChange={event => onReviewChange(taskReviewKey(task.id, 'review'), event.target.checked)}
                data-testid="chatroom-task-reviewed" />
              我已核对上次的实际改动与外部结果
            </label>
            <button type="button" onClick={() => onAction(task, 'review', undefined, true)}
              disabled={Boolean(busyAction) || !reviewed.has(taskReviewKey(task.id, 'review'))}
              data-testid="chatroom-task-review-complete">
              {busyAction === taskReviewKey(task.id, undefined) ? '处理中…' : '核对完成'}
            </button>
          </div>}
          {SUPPLEMENT_STATUSES.has(task.status) && <div className="chatroom-task-actions">
            <button type="button" className="is-danger" onClick={() => onAction(task, 'cancel', undefined, false)}
              disabled={Boolean(busyAction)} data-testid="chatroom-task-cancel">
              {busyAction === taskReviewKey(task.id, undefined) ? '处理中…' : '取消整个任务'}
            </button>
          </div>}
          {actionError?.key === taskReviewKey(task.id, undefined) && (task.needsReview || task.assignments?.length > 1)
            && <p className="chatroom-task-action-error" role="alert" data-testid="chatroom-task-action-error">{actionError.text}</p>}
        </li>)}
      </ul>}
  </section>
}
