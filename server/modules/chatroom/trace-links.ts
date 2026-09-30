import type { WorkbenchStore } from '../../workbench/store';
import { linkRequirementEntity, recordRequirementEvent } from '../requirements/lifecycle';
import type { ChatroomContext, ChatroomMessage, DeliveryStatus } from './contracts';
import type { AssignmentRow, RunRow, TaskRow } from './work-store';

type Root = { id: string; version: number | string | null; expectedUpdatedAt?: string };
type TraceRefs = Record<string, string | number | boolean | null>;
type MessageRow = {
  id: string; thread_id: string; reply_to: string | null; sender_id: string;
  recipient_id: string | null; created_at: string; delivery_status: DeliveryStatus;
  context: string; input_requirement_id: string | null; input_requirement_version: number | null;
};
type ToolRow = {
  run_id: string; tool_call_id: string; tool_name: string;
  started_at: string; finished_at: string | null; is_error: number | null;
  result_hash: string | null; result_bytes: number | null; exit_code: number | null;
};

function rootFromContext(context: ChatroomContext): Root | undefined {
  return context.requirementId
    ? { id: context.requirementId,
      version: typeof context.requirementVersion === 'number' ? context.requirementVersion
        : context.expectedUpdatedAt ?? null,
      ...(context.expectedUpdatedAt ? { expectedUpdatedAt: context.expectedUpdatedAt } : {}) }
    : undefined;
}

export function rootForTask(store: WorkbenchStore, workspaceKey: string, taskId: string): Root | undefined {
  const row = store.sqlite.prepare(`SELECT source_context FROM chatroom_work_tasks
    WHERE workspace_key = ? AND id = ?`).get(workspaceKey, taskId) as { source_context: string } | undefined;
  return row ? rootFromContext(JSON.parse(row.source_context) as ChatroomContext) : undefined;
}

export function rootForMessage(store: WorkbenchStore, workspaceKey: string,
  context: ChatroomContext): Root | undefined {
  return rootFromContext(context)
    ?? (context.collaborationTaskId ? rootForTask(store, workspaceKey, context.collaborationTaskId) : undefined);
}

function link(store: WorkbenchStore, root: Root, kind: string, id: string, occurredAt: string,
  refs: TraceRefs = {}): void {
  linkRequirementEntity(store, root.id, { kind, id, refs, requirementVersion: root.version, occurredAt });
}

function event(store: WorkbenchStore, root: Root, eventKey: string, type: string, summary: string,
  occurredAt: string, refs: TraceRefs = {}, actor?: string): void {
  recordRequirementEvent(store, root.id, {
    eventKey, type, actor, summary, refs, requirementVersion: root.version, occurredAt,
  });
}

export function traceMessageCreated(store: WorkbenchStore, workspaceKey: string, message: ChatroomMessage): void {
  const linked = rootForMessage(store, workspaceKey, message.context);
  if (!linked) return;
  const root: Root = { id: message.inputRequirementId ?? linked.id,
    version: message.inputRequirementVersion ?? null };
  const refs = { workspaceKey, threadId: message.threadId, messageId: message.id,
    senderId: message.senderId, recipientId: message.recipientId, replyTo: message.replyTo };
  link(store, root, 'chatroom_message', message.id, message.createdAt, refs);
  event(store, root, `chatroom:message:${message.id}:created`, 'chatroom_message_created',
    '群消息已记录', message.createdAt, refs, message.senderId);
}

export function traceMessageSettled(store: WorkbenchStore, workspaceKey: string,
  message: ChatroomMessage, status: 'delivered' | 'failed'): void {
  const linked = rootForMessage(store, workspaceKey, message.context);
  if (!linked) return;
  const root: Root = { id: message.inputRequirementId ?? linked.id,
    version: message.inputRequirementVersion ?? null };
  const refs = { workspaceKey, threadId: message.threadId, messageId: message.id, status };
  link(store, root, 'chatroom_message', message.id, message.createdAt, refs);
  event(store, root, `chatroom:message:${message.id}:${status}`, 'chatroom_delivery_finished',
    `群消息投递${status === 'delivered' ? '完成' : '失败'}`, new Date().toISOString(), refs);
}

export function traceVersionBlocked(store: WorkbenchStore, workspaceKey: string,
  message: ChatroomMessage, agentId: string, currentVersion: number | undefined): void {
  const linked = rootForMessage(store, workspaceKey, message.context);
  if (!linked) return;
  const root: Root = { id: message.inputRequirementId ?? linked.id,
    version: message.inputRequirementVersion ?? null };
  const refs = { workspaceKey, messageId: message.id, threadId: message.threadId, agentId,
    inputVersion: message.inputRequirementVersion ?? null, currentVersion: currentVersion ?? null };
  link(store, root, 'chatroom_message', message.id, message.createdAt, refs);
  event(store, root, `chatroom:message:${message.id}:revision-blocked:${agentId}`,
    'chatroom_revision_blocked', '输入需求修订与当前版本不一致，执行已阻止',
    new Date().toISOString(), refs, agentId);
}

export function traceTaskAccepted(store: WorkbenchStore, workspaceKey: string,
  task: TaskRow, assignment: AssignmentRow): void {
  const root = rootForTask(store, workspaceKey, task.id);
  if (!root) return;
  link(store, root, 'chatroom_task', task.id, task.created_at,
    { workspaceKey, taskId: task.id, threadId: task.thread_id });
  event(store, root, `chatroom:task:${task.id}:accepted`, 'chatroom_task_accepted',
    '协作任务已认领', task.created_at, { workspaceKey, taskId: task.id, messageId: task.created_message_id });
  link(store, root, 'chatroom_assignment', assignment.id, assignment.created_at,
    { workspaceKey, taskId: task.id, assignmentId: assignment.id, agentId: assignment.agent_id });
  event(store, root, `chatroom:assignment:${assignment.id}:created`, 'chatroom_assignment_created',
    '成员分工已建立', assignment.created_at,
    { workspaceKey, taskId: task.id, assignmentId: assignment.id, agentId: assignment.agent_id }, assignment.agent_id);
}

function rootForRun(store: WorkbenchStore, workspaceKey: string, run: RunRow): Root | undefined {
  if (run.requirement_id) return { id: run.requirement_id, version: run.requirement_version };
  if (run.task_id) return rootForTask(store, workspaceKey, run.task_id);
  const message = store.sqlite.prepare(`SELECT context FROM chatroom_messages
    WHERE workspace_key = ? AND id = ?`).get(workspaceKey, run.message_id) as { context: string } | undefined;
  return message ? rootForMessage(store, workspaceKey, JSON.parse(message.context) as ChatroomContext) : undefined;
}

export function traceRunStarted(store: WorkbenchStore, workspaceKey: string, run: RunRow): void {
  const root = rootForRun(store, workspaceKey, run);
  if (!root) return;
  const refs = { workspaceKey, runId: run.id, taskId: run.task_id, assignmentId: run.assignment_id,
    messageId: run.message_id, agentId: run.agent_id, attempt: run.attempt };
  link(store, root, 'chatroom_run', run.id, run.started_at, refs);
  event(store, root, `chatroom:run:${run.id}:started`, 'chatroom_run_started',
    'Agent 执行开始', run.started_at, refs, run.agent_id);
}

export function traceRunFinished(store: WorkbenchStore, workspaceKey: string, run: RunRow): void {
  const root = rootForRun(store, workspaceKey, run);
  if (!root || !run.finished_at) return;
  const refs = { workspaceKey, runId: run.id, taskId: run.task_id, assignmentId: run.assignment_id,
    messageId: run.message_id, agentId: run.agent_id, attempt: run.attempt, status: run.status };
  link(store, root, 'chatroom_run', run.id, run.started_at, refs);
  event(store, root, `chatroom:run:${run.id}:finished`, 'chatroom_run_finished',
    `Agent 执行${run.status}`, run.finished_at, refs, run.agent_id);
}

export function traceTool(store: WorkbenchStore, workspaceKey: string, run: RunRow, tool: ToolRow): void {
  const root = rootForRun(store, workspaceKey, run);
  if (!root) return;
  const id = `${tool.run_id}:${tool.tool_call_id}`;
  const refs = { workspaceKey, runId: run.id, taskId: run.task_id, toolCallId: tool.tool_call_id,
    toolName: tool.tool_name,
    ...(tool.finished_at ? { status: tool.is_error ? 'failed' : 'succeeded',
      resultHash: tool.result_hash, resultBytes: tool.result_bytes, exitCode: tool.exit_code } : {}) };
  link(store, root, 'chatroom_tool', id, tool.started_at, refs);
  event(store, root, `chatroom:tool:${id}:started`, 'chatroom_tool_started',
    `工具 ${tool.tool_name} 开始`, tool.started_at, refs, run.agent_id);
  if (tool.finished_at) event(store, root, `chatroom:tool:${id}:finished`, 'chatroom_tool_finished',
    `工具 ${tool.tool_name} ${tool.is_error ? '失败' : '完成'}`, tool.finished_at,
    refs, run.agent_id);
}

export function traceAssignmentUpdate(store: WorkbenchStore, workspaceKey: string,
  taskId: string, assignment: AssignmentRow, actionKey: string): void {
  const root = rootForTask(store, workspaceKey, taskId);
  if (!root) return;
  const refs = { workspaceKey, taskId, assignmentId: assignment.id, agentId: assignment.agent_id,
    status: assignment.status };
  link(store, root, 'chatroom_assignment', assignment.id, assignment.created_at, refs);
  event(store, root, `chatroom:assignment:${assignment.id}:update:${actionKey}`, 'chatroom_assignment_updated',
    `成员分工${assignment.status}`, assignment.updated_at, refs, assignment.agent_id);
}

export function traceUserAction(store: WorkbenchStore, workspaceKey: string, taskId: string,
  action: 'review' | 'resume' | 'cancel' | 'cancel_unconfirmed', actionKey: string,
  occurredAt: string, messageId?: string): void {
  const root = rootForTask(store, workspaceKey, taskId);
  if (!root) return;
  const refs = { workspaceKey, taskId, action, messageId: messageId ?? null };
  event(store, root, `chatroom:task:${taskId}:user-action:${actionKey}:${action}`,
    'chatroom_user_action', `用户${action}`, occurredAt, refs, 'user');
}

export function traceCancelledRuns(store: WorkbenchStore, workspaceKey: string, taskId: string): void {
  const runs = store.sqlite.prepare(`SELECT * FROM chatroom_work_runs
    WHERE workspace_key = ? AND task_id = ? AND status IN ('cancelled','needs_review')`)
    .all(workspaceKey, taskId) as RunRow[];
  for (const run of runs) traceRunFinished(store, workspaceKey, run);
}

export function traceHandoff(store: WorkbenchStore, workspaceKey: string, messageId: string,
  parentRun: RunRow, occurredAt: string): void {
  const parentRoot = rootForRun(store, workspaceKey, parentRun);
  const child = store.sqlite.prepare(`SELECT context, input_requirement_id, input_requirement_version FROM chatroom_messages
    WHERE workspace_key = ? AND id = ?`).get(workspaceKey, messageId) as
    { context: string; input_requirement_id: string | null; input_requirement_version: number | null } | undefined;
  const childRoot = child ? rootForMessage(store, workspaceKey,
    JSON.parse(child.context) as ChatroomContext) : undefined;
  const root = childRoot && parentRoot && childRoot.id !== parentRoot.id
    ? { id: child!.input_requirement_id ?? childRoot.id,
      version: child!.input_requirement_version } : parentRoot ?? childRoot;
  if (!root) return;
  const refs = { workspaceKey, messageId, parentRunId: parentRun.id,
    taskId: parentRun.task_id, assignmentId: parentRun.assignment_id,
    parentRequirementId: parentRoot?.id ?? null };
  link(store, root, 'chatroom_handoff', messageId, occurredAt, refs);
  event(store, root, `chatroom:handoff:${messageId}`, 'chatroom_handoff_created',
    'Agent 已交接群消息', occurredAt, refs, parentRun.agent_id);
}

export function traceRequirementBranch(store: WorkbenchStore, workspaceKey: string,
  delivery: ChatroomMessage, fromRequirementId: string, toRequirementId: string,
  runId: string | null): void {
  const occurredAt = new Date().toISOString();
  const refs = { workspaceKey, messageId: delivery.id, threadId: delivery.threadId,
    fromRequirementId, toRequirementId, originatingRunId: runId };
  event(store, { id: fromRequirementId, version: delivery.inputRequirementVersion ?? null },
    `chatroom:branch:${delivery.id}:from`, 'chatroom_requirement_branched',
    '群话题中建立了独立需求', occurredAt, refs, delivery.senderId);
  link(store, { id: toRequirementId, version: null }, 'chatroom_requirement_branch',
    delivery.id, delivery.createdAt, refs);
  event(store, { id: toRequirementId, version: null },
    `chatroom:branch:${delivery.id}:to`, 'chatroom_requirement_branch',
    '独立需求从群话题建立', occurredAt, refs, delivery.senderId);
}

/** Attach a late-created requirement to the existing task chain without changing occurrence times. */
export function backfillRequirementTrace(store: WorkbenchStore, workspaceKey: string,
  delivery: ChatroomMessage, requirementId: string, requirementVersion: number,
  expectedUpdatedAt: string): void {
  const historicalRoot: Root = { id: requirementId, version: null };
  const messages = new Map<string, MessageRow>();
  const lookup = store.sqlite.prepare(`SELECT id, thread_id, reply_to, sender_id, recipient_id,
    created_at, delivery_status, context, input_requirement_id, input_requirement_version
    FROM chatroom_messages WHERE workspace_key = ? AND id = ?`);
  let ancestor: string | null = delivery.id;
  for (let depth = 0; ancestor && depth < 80; depth += 1) {
    const row = lookup.get(workspaceKey, ancestor) as MessageRow | undefined;
    if (!row || messages.has(row.id)) break;
    const prior = JSON.parse(row.context) as ChatroomContext;
    if (prior.requirementId && prior.requirementId !== requirementId) break;
    messages.set(row.id, row);
    ancestor = row.reply_to;
  }
  const taskId = delivery.context.collaborationTaskId;
  if (taskId) {
    const taskMessages = store.sqlite.prepare(`SELECT id, thread_id, reply_to, sender_id, recipient_id,
      created_at, delivery_status, context, input_requirement_id, input_requirement_version FROM chatroom_messages
      WHERE workspace_key = ? AND json_extract(context, '$.collaborationTaskId') = ?`)
      .all(workspaceKey, taskId) as MessageRow[];
    for (const row of taskMessages) messages.set(row.id, row);
  }
  const runIds = new Set<string>();
  for (const row of messages.values()) {
    const prior = JSON.parse(row.context) as ChatroomContext;
    if (prior.requirementId && prior.requirementId !== requirementId) {
      throw new Error('群消息已归属其他需求根，不能重新绑定');
    }
    const context = { ...prior, requirementId,
      requirementVersion: prior.requirementVersion ?? requirementVersion,
      expectedUpdatedAt: prior.expectedUpdatedAt ?? expectedUpdatedAt };
    store.sqlite.prepare(`UPDATE chatroom_messages SET context = ? WHERE workspace_key = ? AND id = ?`)
      .run(JSON.stringify(context), workspaceKey, row.id);
    const refs = { workspaceKey, threadId: row.thread_id, messageId: row.id,
      senderId: row.sender_id, recipientId: row.recipient_id, replyTo: row.reply_to };
    const messageRoot: Root = { id: requirementId,
      version: row.input_requirement_id === requirementId ? row.input_requirement_version : null };
    link(store, messageRoot, 'chatroom_message', row.id, row.created_at, refs);
    event(store, messageRoot, `chatroom:message:${row.id}:created`, 'chatroom_message_created',
      '群消息已记录', row.created_at, refs, row.sender_id);
    if (row.delivery_status === 'delivered' || row.delivery_status === 'failed') {
      const terminal = store.sqlite.prepare(`SELECT MAX(finished_at) AS finished_at
        FROM chatroom_consumptions WHERE workspace_key = ? AND message_id = ?`)
        .get(workspaceKey, row.id) as { finished_at: string | null };
      if (terminal.finished_at) event(store, messageRoot, `chatroom:message:${row.id}:${row.delivery_status}`,
        'chatroom_delivery_finished',
        `群消息投递${row.delivery_status === 'delivered' ? '完成' : '失败'}`,
        terminal.finished_at, { workspaceKey, threadId: row.thread_id, messageId: row.id, status: row.delivery_status });
    }
    const runs = store.sqlite.prepare(`SELECT * FROM chatroom_work_runs
      WHERE workspace_key = ? AND message_id = ?`).all(workspaceKey, row.id) as RunRow[];
    for (const run of runs) runIds.add(run.id);
  }
  if (taskId) {
    const task = store.sqlite.prepare(`SELECT * FROM chatroom_work_tasks WHERE workspace_key = ? AND id = ?`)
      .get(workspaceKey, taskId) as TaskRow | undefined;
    if (task) {
      link(store, historicalRoot, 'chatroom_task', task.id, task.created_at,
        { workspaceKey, taskId: task.id, threadId: task.thread_id });
      event(store, historicalRoot, `chatroom:task:${task.id}:accepted`, 'chatroom_task_accepted',
        '协作任务已认领', task.created_at,
        { workspaceKey, taskId: task.id, messageId: task.created_message_id });
      const assignments = store.sqlite.prepare(`SELECT * FROM chatroom_work_assignments
        WHERE workspace_key = ? AND task_id = ?`).all(workspaceKey, taskId) as AssignmentRow[];
      for (const assignment of assignments) {
        link(store, historicalRoot, 'chatroom_assignment', assignment.id, assignment.created_at,
          { workspaceKey, taskId, assignmentId: assignment.id, agentId: assignment.agent_id });
        event(store, historicalRoot, `chatroom:assignment:${assignment.id}:created`, 'chatroom_assignment_created',
          '成员分工已建立', assignment.created_at,
          { workspaceKey, taskId, assignmentId: assignment.id, agentId: assignment.agent_id }, assignment.agent_id);
      }
    }
    const taskRuns = store.sqlite.prepare(`SELECT id FROM chatroom_work_runs
      WHERE workspace_key = ? AND task_id = ?`).all(workspaceKey, taskId) as Array<{ id: string }>;
    for (const run of taskRuns) runIds.add(run.id);
  }
  for (const runId of runIds) {
    const run = store.sqlite.prepare(`SELECT * FROM chatroom_work_runs WHERE workspace_key = ? AND id = ?`)
      .get(workspaceKey, runId) as RunRow;
    if (run.requirement_id && run.requirement_id !== requirementId) {
      throw new Error('Agent Run 已归属其他需求根，不能重新绑定');
    }
    if (!run.requirement_id) {
      store.sqlite.prepare(`UPDATE chatroom_work_runs SET requirement_id = ?
        WHERE workspace_key = ? AND id = ? AND requirement_id IS NULL`)
        .run(requirementId, workspaceKey, runId);
      run.requirement_id = requirementId;
    }
    traceRunStarted(store, workspaceKey, run);
    traceRunFinished(store, workspaceKey, run);
    const tools = store.sqlite.prepare(`SELECT * FROM chatroom_work_run_tools
      WHERE workspace_key = ? AND run_id = ?`).all(workspaceKey, runId) as ToolRow[];
    for (const tool of tools) traceTool(store, workspaceKey, run, tool);
    const handoffs = store.sqlite.prepare(`SELECT h.message_id, m.created_at FROM chatroom_work_handoffs h
      JOIN chatroom_messages m ON m.workspace_key = h.workspace_key AND m.id = h.message_id
      WHERE h.workspace_key = ? AND h.parent_run_id = ?`)
      .all(workspaceKey, runId) as Array<{ message_id: string; created_at: string }>;
    for (const handoff of handoffs) traceHandoff(store, workspaceKey, handoff.message_id, run, handoff.created_at);
  }
}
