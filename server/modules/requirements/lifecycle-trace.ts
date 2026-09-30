import { agentFailureDetail } from '../../module-agents/failures';
import type { LifecycleRoot, LifecycleStore, PublicDelivery, RequirementTrace } from './lifecycle-contracts';
import { lifecycleRoot, type RequirementLookup } from './lifecycle-events';

type LinkRow = { kind: string; entity_id: string; requirement_version: number | null; refs: string; occurred_at: string | null };
type Value = Record<string, unknown>;

function table(store: LifecycleStore, name: string): boolean {
  return !!store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function row(store: LifecycleStore, name: string, id: string): Value | undefined {
  return table(store, name) ? store.sqlite.prepare(`SELECT * FROM ${name} WHERE id=?`).get(id) as Value | undefined : undefined;
}

export function publicDeliveries(store: LifecycleStore, rootId: string): PublicDelivery[] {
  const deliveries = store.sqlite.prepare('SELECT * FROM requirement_deliveries WHERE requirement_id=? ORDER BY created_at DESC,id')
    .all(rootId) as Array<Record<string, string>>;
  return deliveries.map(delivery => ({ id: delivery.id!, status: delivery.status as PublicDelivery['status'],
    summary: delivery.summary!, evidence: JSON.parse(delivery.evidence!), runIds: JSON.parse(delivery.run_ids!),
    requirementVersion: Number(delivery.requirement_version), createdAt: delivery.created_at!, updatedAt: delivery.updated_at!,
    reviews: (store.sqlite.prepare(`SELECT * FROM requirement_delivery_reviews WHERE delivery_id=? ORDER BY created_at,id`)
      .all(delivery.id) as Array<Record<string, string>>).map(review => ({ id: review.id!,
        decision: review.decision as 'accept' | 'reject', comment: review.comment!, createdAt: review.created_at!, actor: 'user' })),
  }));
}

function hydrate(store: LifecycleStore, link: LinkRow): Value {
  const refs = JSON.parse(link.refs) as Value;
  const base = { ...refs, id: link.entity_id, requirementVersion: link.requirement_version };
  if (link.kind === 'task') {
    const record = store.sqlite.prepare("SELECT payload FROM workbench_records WHERE module='tasks' AND id=?")
      .get(link.entity_id) as { payload: string } | undefined;
    return { ...base, ...(record ? JSON.parse(record.payload) : {}), deleted: !record, removed: refs.removed === true };
  }
  if (link.kind === 'chatroom_task') {
    const value = row(store, 'chatroom_work_tasks', link.entity_id);
    const source = typeof value?.source_context === 'string' ? JSON.parse(value.source_context) : {};
    return { ...base, title: value?.title ?? refs.title, status: value?.status ?? refs.status,
      threadId: value?.thread_id ?? refs.threadId, inputRequirementVersion: source.requirementVersion ?? null };
  }
  if (link.kind === 'chatroom_assignment') {
    const value = row(store, 'chatroom_work_assignments', link.entity_id);
    return { ...base, taskId: value?.task_id ?? refs.taskId, agentId: value?.agent_id ?? refs.agentId,
      sessionId: value?.session_id ?? refs.sessionId, profileRevision: value?.profile_revision ?? null, status: value?.status ?? refs.status, summary: value?.summary ?? refs.summary };
  }
  if (link.kind === 'chatroom_run') {
    const value = row(store, 'chatroom_work_runs', link.entity_id);
    return { ...base, taskId: value?.task_id ?? refs.taskId, assignmentId: value?.assignment_id ?? refs.assignmentId,
      threadId: value?.thread_id ?? refs.threadId, agentId: value?.agent_id ?? refs.agentId, sessionId: value?.session_id ?? refs.sessionId,
      recorded: !!value, status: value?.status ?? refs.status, attempt: value?.attempt ?? refs.attempt,
      startedAt: value?.started_at ?? refs.startedAt, finishedAt: value?.finished_at ?? refs.finishedAt,
      reviewedAt: value?.reviewed_at ?? null,
      failureCategory: value?.error ? agentFailureDetail(String(value.error)).category : null,
      error: value?.error ? agentFailureDetail(String(value.error)).summary : null };
  }
  if (link.kind === 'chatroom_message') {
    const value = row(store, 'chatroom_messages', link.entity_id);
    return { ...base, seq: value?.seq ?? refs.seq, threadId: value?.thread_id ?? refs.threadId,
      senderId: value?.sender_id ?? refs.senderId, body: value?.body ?? refs.body,
      deliveryStatus: value?.delivery_status ?? refs.deliveryStatus, createdAt: value?.created_at ?? refs.createdAt,
      sessionId: value?.sender_id !== 'user' ? value?.sender_session_id ?? null : null };
  }
  if (link.kind === 'chatroom_tool') {
    const value = table(store, 'chatroom_work_run_tools') && refs.runId && refs.toolCallId
      ? store.sqlite.prepare('SELECT * FROM chatroom_work_run_tools WHERE run_id=? AND tool_call_id=?')
        .get(refs.runId, refs.toolCallId) as Value | undefined : undefined;
    return { ...base, recorded: !!value, toolName: value?.tool_name ?? refs.toolName,
      startedAt: value?.started_at ?? refs.startedAt, finishedAt: value?.finished_at ?? refs.finishedAt,
      status: value?.finished_at ? value.is_error ? 'failed' : 'succeeded' : 'running',
      isError: value?.is_error === 1 };
  }
  return base;
}

function acceptanceBlockers(root: LifecycleRoot, links: RequirementTrace['links']): string[] {
  const blockers: string[] = [];
  const requirement = JSON.parse(root.payload) as Value;
  if (root.archived) blockers.push('需求记录已删除，不能交付');
  const expectedTasks = Array.isArray(requirement.importedTaskIds) ? requirement.importedTaskIds : [];
  for (const id of expectedTasks) {
    const task = links.tasks.find(item => item.id === id);
    if (!task || task.deleted || task.removed) blockers.push(`待办 ${id} 已删除或解除关联，需重新核对验收范围`);
  }
  const tasks = links.tasks.filter(item => !item.deleted && !item.removed);
  if (tasks.some(item => item.done !== true)) blockers.push('关联待办尚未全部完成');
  const currentTasks = links.collaborationTasks.filter(item => item.inputRequirementVersion === root.current_version
    || item.requirementVersion === root.current_version);
  const currentAssignments = links.assignments.filter(item => currentTasks.some(task => task.id === item.taskId));
  if (currentAssignments.some(item => item.status !== 'completed')) blockers.push('当前需求的 Agent 分工尚未全部完成');
  const currentRuns = links.runs.filter(item => item.requirementVersion === root.current_version);
  if (currentRuns.some(item => item.status === 'running')) blockers.push('仍有 Agent 正在执行');
  if (links.runs.some(item => item.status === 'needs_review' && !item.reviewedAt)) blockers.push('存在未核对的外部操作结果');
  if (!currentRuns.some(item => item.recorded && item.status === 'succeeded')) blockers.push('当前需求版本尚无成功执行记录');
  const latest = new Map<string, Value>();
  for (const run of currentRuns) {
    const key = JSON.stringify([run.agentId, run.taskId ?? run.threadId ?? run.sessionId]);
    if (!latest.has(key) || Number(run.attempt) > Number(latest.get(key)!.attempt)) latest.set(key, run);
  }
  if ([...latest.values()].some(item => item.status !== 'succeeded')) blockers.push('最新执行仍处于失败、中断或取消状态');
  return [...new Set(blockers)];
}

export function readRequirementTrace(store: LifecycleStore, id: string,
  lookup: RequirementLookup = 'id'): RequirementTrace {
  const root = lifecycleRoot(store, id, lookup);
  const entries = store.sqlite.prepare('SELECT * FROM requirement_lifecycle_links WHERE requirement_id=? ORDER BY occurred_at,kind,entity_id')
    .all(root.requirement_id) as LinkRow[];
  const byKind = (kind: string) => entries.filter(entry => entry.kind === kind).map(entry => hydrate(store, entry));
  const links = { tasks: byKind('task'), collaborationTasks: byKind('chatroom_task'), assignments: byKind('chatroom_assignment'),
    runs: byKind('chatroom_run'), messages: byKind('chatroom_message'), tools: byKind('chatroom_tool') };
  const deliveries = publicDeliveries(store, root.requirement_id);
  const blockers = acceptanceBlockers(root, links);
  let stage: RequirementTrace['stage'] = 'draft';
  const requirement = JSON.parse(root.payload);
  if (root.archived) stage = 'deleted';
  else if (blockers.length === 0 && deliveries.some(item => item.status === 'accepted' && item.requirementVersion === root.current_version)) stage = 'delivered';
  else if (links.runs.some(item => item.status === 'needs_review' && !item.reviewedAt)) stage = 'needs_review';
  else if (links.runs.some(item => item.requirementVersion === root.current_version && item.status === 'running')) stage = 'developing';
  else if (deliveries.some(item => item.status === 'submitted' && item.requirementVersion === root.current_version)
    || links.assignments.length && links.assignments.every(item => item.status === 'completed')) stage = 'verifying';
  else if (links.collaborationTasks.length && links.collaborationTasks.every(item => item.status === 'cancelled')) stage = 'cancelled';
  else if (requirement.importedAt || links.tasks.length) stage = 'ready';
  const events = (store.sqlite.prepare(`SELECT * FROM requirement_lifecycle_events
    WHERE requirement_id=? ORDER BY occurred_at,seq`).all(root.requirement_id) as Array<Record<string, unknown>>)
    .map(event => ({ id: String(event.id), seq: Number(event.seq), type: String(event.type), time: event.occurred_at as string | null,
      actor: String(event.actor), summary: String(event.summary), refs: JSON.parse(String(event.refs)),
      requirementVersion: event.requirement_version as number | null }));
  const warnings: string[] = [];
  if (root.historical) warnings.push('存量记录仅有接入时的基线，接入前的变更顺序和时间无法还原');
  if (entries.some(link => link.requirement_version === null)) warnings.push('部分关联发生在正式需求生成之前，原始输入版本未知');
  return { requirementId: root.requirement_id, humanId: `REQ-${String(root.seq).padStart(6, '0')}`,
    requirementVersion: root.current_version, stage, archived: !!root.archived, requirement,
    events, links, deliveries, acceptanceReady: blockers.length === 0, blockers,
    coverage: { historical: !!root.historical, warnings } };
}
