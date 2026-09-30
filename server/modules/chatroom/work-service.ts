import { randomUUID } from 'node:crypto';
import type { AgentId } from '../../module-agents/contracts';
import type { WorkbenchStore } from '../../workbench/store';
import { getRequirementVersion } from '../requirements/lifecycle';
import { CHATROOM_ID, type ChatroomContext, type ChatroomMessage, type ChatroomPublicTask, type ChatroomRunStatus, type ChatroomTaskStatus } from './contracts';
import type { WorkAcceptInput, WorkBinding, WorkRun, WorkRunningRun, WorkTaskActionInput, WorkUpdateInput } from './work-contracts';
import { ChatroomWorkStore, type AssignmentRow, type RunRow, type TaskRow } from './work-store';
import { performWorkUserAction } from './work-user-actions';
import { assertFields, bad, hash, requiredText, validAgent } from './work-input';
import { markToolEnd, markToolStart } from './work-run-tools';
import { recoverInterruptedRuns } from './work-recovery';
import { rootForMessage, traceAssignmentUpdate, traceCancelledRuns, traceHandoff, traceRunFinished,
  traceRunStarted, traceTaskAccepted, traceUserAction, traceVersionBlocked } from './trace-links';

const TASK_STATUSES: readonly ChatroomTaskStatus[] = [
  'waiting', 'running', 'waiting_for_user', 'waiting_for_agent', 'completed',
  'failed', 'interrupted', 'needs_review', 'cancelled',
];
const ACTIVE_TASK_STATUSES: readonly ChatroomTaskStatus[] = ['waiting', 'running', 'waiting_for_user', 'waiting_for_agent'];

function now(): string { return new Date().toISOString(); }
function publicRun(run: RunRow | undefined): ChatroomPublicTask['assignments'][number]['lastRun'] {
  return run ? { status: run.status, attempt: run.attempt, startedAt: run.started_at,
    finishedAt: run.finished_at, error: run.error ? run.status === 'needs_review'
      ? '外部操作结果待核对' : '执行未完成，请查看群消息状态' : null } : null;
}
function exposedRun(run: RunRow): WorkRun {
  return { id: run.id, attempt: run.attempt, status: run.status, taskId: run.task_id,
    assignmentId: run.assignment_id, messageId: run.message_id, sessionId: run.session_id,
    agentId: run.agent_id, startedAt: run.started_at, finishedAt: run.finished_at, error: run.error };
}

/** Room messages, scoped SDK sessions, assignments and attempts have separate durable identities. */
export class ChatroomWorkService {
  private readonly activeRuns = new Map<string, string>();
  private readonly actionLocks = new Map<string, { signature: string; promise: Promise<{ task: ChatroomPublicTask; message?: ChatroomMessage }> }>();
  private cancelRunHandler: ((runId: string) => Promise<void> | void) | undefined;
  constructor(readonly storage: ChatroomWorkStore,
    private readonly getDelivery: (sessionId: string) => ChatroomMessage | undefined,
    private readonly store: WorkbenchStore) {
    recoverInterruptedRuns(store, storage, (id, status) => this.setAssignmentStatus(id, status));
  }
  getBinding(message: ChatroomMessage, agentId: AgentId): WorkBinding {
    if (!validAgent(agentId)) bad('未知工作成员');
    const taskId = message.context.collaborationTaskId;
    if (taskId) {
      const task = this.storage.task(taskId);
      if (!task || task.thread_id !== message.threadId) bad('协作任务不属于当前话题', 403);
      const assignment = this.storage.assignment(taskId, agentId);
      if (assignment) return { scope: 'assignment', taskId, assignmentId: assignment.id,
        sessionId: assignment.session_id, lastProcessedSeq: assignment.last_processed_seq,
        needsReview: assignment.status === 'needs_review' || task.status === 'needs_review' };
    }
    const discussion = this.storage.discussion(message.threadId, agentId);
    const unresolved = this.storage.sqlite.prepare(`SELECT 1 FROM chatroom_work_runs
      WHERE workspace_key = ? AND thread_id = ? AND agent_id = ?
        AND status = 'needs_review' AND reviewed_at IS NULL LIMIT 1`)
      .get(this.storage.workspaceKey, message.threadId, agentId) !== undefined;
    return { scope: 'discussion', taskId: taskId ?? null, assignmentId: null,
      sessionId: discussion?.session_id ?? null, lastProcessedSeq: discussion?.last_processed_seq ?? 0,
      needsReview: unresolved || (taskId ? this.storage.task(taskId)?.status === 'needs_review' : false) };
  }

  bindSession(message: ChatroomMessage, agentId: AgentId, sessionId: string, profileRevision?: string): WorkBinding {
    requiredText(sessionId, '会话 ID', 500);
    return this.storage.transaction(() => {
      const binding = this.getBinding(message, agentId);
      if (binding.sessionId && binding.sessionId !== sessionId) bad('会话绑定已存在，须恢复原会话', 409);
      if (!binding.sessionId && this.storage.boundSession(sessionId)) bad('会话已绑定其他工作范围', 409);
      const timestamp = now();
      if (binding.scope === 'assignment') {
        this.storage.sqlite.prepare(`UPDATE chatroom_work_assignments
          SET session_id = ?, profile_revision = COALESCE(profile_revision, ?), updated_at = ?
          WHERE workspace_key = ? AND id = ?`)
          .run(sessionId, profileRevision ?? null, timestamp, this.storage.workspaceKey, binding.assignmentId);
      } else {
        this.storage.sqlite.prepare(`INSERT INTO chatroom_discussion_bindings
          (workspace_key, room_id, thread_id, agent_id, session_id, profile_revision, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_key, room_id, thread_id, agent_id) DO UPDATE SET
          session_id = excluded.session_id, profile_revision = COALESCE(chatroom_discussion_bindings.profile_revision, excluded.profile_revision),
          updated_at = excluded.updated_at`)
          .run(this.storage.workspaceKey, CHATROOM_ID, message.threadId, agentId, sessionId,
            profileRevision ?? null, timestamp);
      }
      return this.getBinding(message, agentId);
    });
  }

  beginRun(message: ChatroomMessage, agentId: AgentId, sessionId: string): WorkRunningRun {
    const root = rootForMessage(this.store, this.storage.workspaceKey, message.context);
    const inputVersion = message.inputRequirementVersion;
    if (root) {
      const currentVersion = getRequirementVersion(this.store, root.id);
      if (message.inputRequirementId !== root.id
        || typeof inputVersion !== 'number' || inputVersion !== currentVersion) {
        traceVersionBlocked(this.store, this.storage.workspaceKey, message, agentId, currentVersion);
        bad('需求修订已变化或无法核对，请重新交接当前版本', 409);
      }
    }
    return this.storage.transaction(() => {
      const binding = this.getBinding(message, agentId);
      if (binding.needsReview) bad('协作任务存在未核对的外部操作，须先由用户确认', 409);
      if (binding.taskId && ['completed', 'cancelled', 'failed', 'interrupted'].includes(this.storage.task(binding.taskId)?.status ?? '')) {
        bad('任务尚未恢复或已结束，不能直接执行', 409);
      }
      if (binding.assignmentId) {
        const assignment = this.storage.assignment(binding.taskId!, agentId)!;
        if (!ACTIVE_TASK_STATUSES.includes(assignment.status)) bad('成员分工尚未恢复或已经结束', 409);
      }
      if (binding.sessionId !== sessionId) bad('执行会话与当前工作绑定不一致', 409);
      const existing = this.storage.sqlite.prepare(`SELECT id FROM chatroom_work_runs
        WHERE workspace_key = ? AND message_id = ? AND agent_id = ?`)
        .get(this.storage.workspaceKey, message.id, agentId) as { id: string } | undefined;
      if (existing) bad('这条群消息已有执行记录，不能自动重跑', 409);
      if (this.storage.runningRun(sessionId)) bad('同一会话已有运行中的回合', 409);
      const attempt = (this.storage.sqlite.prepare(`SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM chatroom_work_runs
        WHERE workspace_key = ? AND thread_id = ? AND agent_id = ? AND
          ((assignment_id IS NULL AND ? IS NULL) OR assignment_id = ?)`)
        .get(this.storage.workspaceKey, message.threadId, agentId, binding.assignmentId, binding.assignmentId) as { n: number }).n;
      const id = randomUUID();
      this.storage.sqlite.prepare(`INSERT INTO chatroom_work_runs
        (workspace_key, id, task_id, assignment_id, requirement_id, requirement_version,
         thread_id, agent_id, session_id,
         message_id, attempt, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(this.storage.workspaceKey, id, binding.taskId,
          binding.assignmentId, root?.id ?? null, root ? inputVersion : null,
          message.threadId, agentId, sessionId, message.id, attempt, now());
      this.activeRuns.set(sessionId, id);
      if (binding.assignmentId) this.setAssignmentStatus(binding.assignmentId, 'running');
      const saved = this.storage.run(id)!;
      traceRunStarted(this.store, this.storage.workspaceKey, saved);
      return { ...exposedRun(saved), status: 'running' };
    });
  }

  getRun(runId: string): WorkRun | undefined {
    const run = this.storage.run(runId);
    return run ? exposedRun(run) : undefined;
  }

  markToolStart(runId: string, toolCallId: string, toolName: string): void {
    markToolStart(this.store, this.storage, runId, toolCallId, toolName);
  }

  markToolEnd(runId: string, toolCallId: string, isError: boolean,
    facts?: { resultHash: string; resultBytes: number; exitCode: number | null }): void {
    markToolEnd(this.store, this.storage, runId, toolCallId, isError, facts);
  }

  finishRun(runId: string, status: Exclude<ChatroomRunStatus, 'running' | 'interrupted'>,
    options: { error?: string; checkpoint?: string; lastProcessedSeq?: number } = {}): WorkRun {
    return this.storage.transaction(() => {
      const run = this.storage.run(runId);
      if (!run) bad('执行记录不存在', 404);
      if (run.status !== 'running') return exposedRun(run);
      const seq = options.lastProcessedSeq ?? run.last_processed_seq;
      if (!Number.isSafeInteger(seq) || seq < 0) bad('执行游标不合法');
      const checkpoint = options.checkpoint === undefined ? run.checkpoint
        : requiredText(options.checkpoint, '检查点', 4000);
      this.storage.sqlite.prepare(`UPDATE chatroom_work_runs
        SET status = ?, error = ?, checkpoint = ?, last_processed_seq = ?, finished_at = ?
        WHERE workspace_key = ? AND id = ? AND status = 'running'`)
        .run(status, options.error?.slice(0, 500) ?? null, checkpoint, seq, now(), this.storage.workspaceKey, runId);
      if (status === 'succeeded') {
        const updated = this.storage.run(runId)!;
        if (updated.assignment_id) this.storage.sqlite.prepare(`UPDATE chatroom_work_assignments
          SET last_processed_seq = MAX(last_processed_seq, ?), updated_at = ?
          WHERE workspace_key = ? AND id = ?`)
          .run(seq, now(), this.storage.workspaceKey, updated.assignment_id);
        else this.storage.sqlite.prepare(`UPDATE chatroom_discussion_bindings
          SET last_processed_seq = MAX(last_processed_seq, ?), updated_at = ?
          WHERE workspace_key = ? AND room_id = ? AND thread_id = ? AND agent_id = ? AND session_id = ?`)
          .run(seq, now(), this.storage.workspaceKey, CHATROOM_ID, updated.thread_id, updated.agent_id, updated.session_id);
      } else if (run.assignment_id) {
        this.setAssignmentStatus(run.assignment_id, status === 'needs_review' ? 'needs_review' : status);
      }
      if (run.task_id) this.refreshTaskStatus(run.task_id);
      this.activeRuns.delete(run.session_id);
      const finished = this.storage.run(runId)!;
      traceRunFinished(this.store, this.storage.workspaceKey, finished);
      return exposedRun(finished);
    });
  }

  accept(sessionId: string, agentId: AgentId, input: WorkAcceptInput): ChatroomPublicTask {
    assertFields(input, 'accept', ['action', 'title', 'entryKey']);
    const delivery = this.authorizedDelivery(sessionId, agentId);
    const title = requiredText(input.title, '任务标题', 200);
    const entryKey = requiredText(input.entryKey, 'entryKey', 200);
    const requestHash = hash(['accept', title, delivery.id]);
    return this.storage.transaction(() => {
      const prior = this.toolAction(sessionId, entryKey, requestHash);
      if (prior) return this.publicTask(prior.task_id)!;
      const taskId = delivery.context.collaborationTaskId ?? randomUUID();
      let task = this.storage.task(taskId);
      const timestamp = now();
      if (task && task.thread_id !== delivery.threadId) bad('协作任务不属于当前话题', 403);
      if (!task) {
        const source = { ...delivery.context };
        delete source.collaborationTaskId; delete source.reportedTaskIds;
        this.storage.sqlite.prepare(`INSERT INTO chatroom_work_tasks
          (workspace_key, id, thread_id, title, status, version, source_context, created_message_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'waiting', 1, ?, ?, ?, ?)`)
          .run(this.storage.workspaceKey, taskId, delivery.threadId, title, JSON.stringify(source), delivery.id, timestamp, timestamp);
        task = this.storage.task(taskId)!;
      }
      let assignment = this.storage.assignment(taskId, agentId);
      if (assignment && assignment.session_id !== sessionId) bad('该成员的工作会话已经绑定', 409);
      if (!assignment) {
        const id = randomUUID();
        const discussion = this.storage.discussion(delivery.threadId, agentId);
        this.storage.sqlite.prepare(`INSERT INTO chatroom_work_assignments
          (workspace_key, id, task_id, agent_id, session_id, profile_revision, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
          .run(this.storage.workspaceKey, id, taskId, agentId, sessionId, discussion?.profile_revision ?? null, timestamp, timestamp);
        this.storage.sqlite.prepare(`UPDATE chatroom_discussion_bindings SET session_id = NULL,
          last_processed_seq = 0, updated_at = ? WHERE workspace_key = ? AND room_id = ?
          AND thread_id = ? AND agent_id = ? AND session_id = ?`)
          .run(timestamp, this.storage.workspaceKey, CHATROOM_ID, delivery.threadId, agentId, sessionId);
        assignment = this.storage.assignment(taskId, agentId)!;
      }
      const runId = this.activeRuns.get(sessionId);
      if (runId) this.storage.sqlite.prepare(`UPDATE chatroom_work_runs SET task_id = ?, assignment_id = ?
        WHERE workspace_key = ? AND id = ? AND status = 'running'`)
        .run(taskId, assignment.id, this.storage.workspaceKey, runId);
      delivery.context = { ...delivery.context, collaborationTaskId: taskId };
      this.storage.sqlite.prepare(`UPDATE chatroom_messages SET context = ? WHERE workspace_key = ? AND id = ?`)
        .run(JSON.stringify(delivery.context), this.storage.workspaceKey, delivery.id);
      this.storage.sqlite.prepare(`INSERT INTO chatroom_work_tool_actions
        (workspace_key, session_id, entry_key, request_hash, action, task_id)
        VALUES (?, ?, ?, ?, 'accept', ?)`)
        .run(this.storage.workspaceKey, sessionId, entryKey, requestHash, taskId);
      this.refreshTaskStatus(taskId);
      traceTaskAccepted(this.store, this.storage.workspaceKey, this.storage.task(taskId)!, assignment);
      return this.publicTask(taskId)!;
    });
  }

  update(sessionId: string, agentId: AgentId, input: WorkUpdateInput): ChatroomPublicTask {
    assertFields(input, 'update', ['action', 'taskId', 'status', 'summary', 'entryKey']);
    const delivery = this.authorizedDelivery(sessionId, agentId);
    const entryKey = requiredText(input.entryKey, 'entryKey', 200);
    requiredText(input.taskId, '协作任务 ID', 200);
    const summary = requiredText(input.summary, '工作摘要', 4000);
    if (!TASK_STATUSES.includes(input.status)) bad('工作状态不合法');
    const requestHash = hash(['update', input.taskId, input.status, summary, delivery.id]);
    return this.storage.transaction(() => {
      const prior = this.toolAction(sessionId, entryKey, requestHash);
      if (prior) return this.publicTask(prior.task_id)!;
      if (delivery.context.collaborationTaskId !== input.taskId) bad('只能更新当前投递关联的协作任务', 403);
      const assignment = this.storage.assignment(input.taskId, agentId);
      if (!assignment || assignment.session_id !== sessionId) bad('当前成员尚未认领该协作任务', 403);
      if (!ACTIVE_TASK_STATUSES.includes(assignment.status)) bad('工作已经终止，须由用户继续', 409);
      this.storage.sqlite.prepare(`UPDATE chatroom_work_assignments SET status = ?, summary = ?, updated_at = ?
        WHERE workspace_key = ? AND id = ?`)
        .run(input.status, summary, now(), this.storage.workspaceKey, assignment.id);
      this.storage.sqlite.prepare(`INSERT INTO chatroom_work_tool_actions
        (workspace_key, session_id, entry_key, request_hash, action, task_id)
        VALUES (?, ?, ?, ?, 'update', ?)`)
        .run(this.storage.workspaceKey, sessionId, entryKey, requestHash, input.taskId);
      this.refreshTaskStatus(input.taskId);
      traceAssignmentUpdate(this.store, this.storage.workspaceKey, input.taskId,
        this.storage.assignment(input.taskId, agentId)!, hash([sessionId, entryKey]));
      return this.publicTask(input.taskId)!;
    });
  }

  publicTasks(): ChatroomPublicTask[] { return this.storage.tasks().map(task => this.projectTask(task)); }

  publicTask(taskId: string): ChatroomPublicTask | undefined {
    const task = this.storage.task(taskId);
    return task ? this.projectTask(task) : undefined;
  }

  registerCancelRun(handler: (runId: string) => Promise<void> | void): () => void {
    if (this.cancelRunHandler && this.cancelRunHandler !== handler) bad('取消运行回调已注册', 409);
    this.cancelRunHandler = handler;
    return () => { if (this.cancelRunHandler === handler) this.cancelRunHandler = undefined; };
  }

  async performUserAction(userSessionKey: string, taskId: string, input: WorkTaskActionInput,
    sendUser: (agentId: AgentId, body: string) => ChatroomMessage,
    messageById: (id: string) => ChatroomMessage | undefined): Promise<{ task: ChatroomPublicTask; message?: ChatroomMessage }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('任务操作参数不合法');
    const key = `${userSessionKey}:${input.entryKey}`;
    const signature = hash([taskId, input.action, input.entryKey, input.expectedVersion,
      input.agentId ?? null, input.reviewed ?? null, input.body ?? null]);
    const previous = this.actionLocks.get(key);
    if (previous) {
      if (previous.signature !== signature) bad('entryKey 已用于其他任务操作', 409);
      return previous.promise;
    }
    const promise = performWorkUserAction(this.storage, userSessionKey, taskId, input,
      sendUser, messageById,
      id => this.cancelRunHandler ? this.cancelRunHandler(id) : bad('当前执行器无法取消运行', 503),
      id => this.publicTask(id)!, id => this.refreshTaskStatus(id),
      (action, actionKey, occurredAt, messageId) => {
        traceUserAction(this.store, this.storage.workspaceKey, taskId,
          action, actionKey, occurredAt, messageId);
        if (action === 'cancel' || action === 'cancel_unconfirmed') {
          traceCancelledRuns(this.store, this.storage.workspaceKey, taskId);
        }
      });
    this.actionLocks.set(key, { signature, promise });
    try { return await promise; } finally { this.actionLocks.delete(key); }
  }

  /** Child handoff and parent attempt are written under the caller's message transaction. */
  recordHandoff(sessionId: string, messageId: string): void {
    const run = this.storage.runningRun(sessionId);
    if (!run) return;
    this.storage.sqlite.prepare(`INSERT OR IGNORE INTO chatroom_work_handoffs
      (workspace_key, message_id, parent_run_id) VALUES (?, ?, ?)`)
      .run(this.storage.workspaceKey, messageId, run.id);
    const message = this.storage.sqlite.prepare(`SELECT created_at FROM chatroom_messages
      WHERE workspace_key = ? AND id = ?`).get(this.storage.workspaceKey, messageId) as
      { created_at: string } | undefined;
    if (message) traceHandoff(this.store, this.storage.workspaceKey, messageId, run, message.created_at);
  }

  updateSourceContext(taskId: string | undefined, context: ChatroomContext): void {
    if (!taskId) return;
    const task = this.storage.task(taskId);
    if (!task) bad('协作任务不存在', 404);
    const source = { ...JSON.parse(task.source_context) as ChatroomContext, ...context };
    delete source.collaborationTaskId; delete source.reportedTaskIds;
    const serialized = JSON.stringify(source);
    if (serialized !== task.source_context) this.storage.sqlite.prepare(`UPDATE chatroom_work_tasks
      SET source_context = ?, version = version + 1, updated_at = ? WHERE workspace_key = ? AND id = ?`)
      .run(serialized, now(), this.storage.workspaceKey, taskId);
  }

  assertSessionWritable(sessionId: string): void {
    const delivery = this.getDelivery(sessionId);
    if (!delivery) return;
    const run = this.storage.sqlite.prepare(`SELECT status FROM chatroom_work_runs
      WHERE workspace_key = ? AND session_id = ? AND message_id = ? AND agent_id = ?`)
      .get(this.storage.workspaceKey, sessionId, delivery.id, delivery.recipientId) as
      { status: ChatroomRunStatus } | undefined;
    if (run && run.status !== 'running') bad('当前执行已结束，不能再写入群消息', 409);
  }

  refreshTaskStatus(taskId: string): void {
    const task = this.storage.task(taskId);
    if (!task) return;
    const statuses = this.storage.assignments(taskId).map(item => item.status);
    let status: ChatroomTaskStatus = 'waiting';
    if (statuses.includes('needs_review')) status = 'needs_review';
    else if (statuses.length && statuses.every(item => item === 'completed')) status = 'completed';
    else if (statuses.length && statuses.every(item => item === 'cancelled')) status = 'cancelled';
    else if (statuses.includes('running')) status = 'running';
    else if (statuses.includes('waiting_for_user')) status = 'waiting_for_user';
    else if (statuses.includes('waiting_for_agent')) status = 'waiting_for_agent';
    else if (statuses.includes('failed')) status = 'failed';
    else if (statuses.includes('interrupted')) status = 'interrupted';
    this.storage.sqlite.prepare(`UPDATE chatroom_work_tasks
      SET status = ?, version = version + 1, updated_at = ? WHERE workspace_key = ? AND id = ?`)
      .run(status, now(), this.storage.workspaceKey, taskId);
  }

  private projectTask(task: TaskRow): ChatroomPublicTask {
    return { id: task.id, title: task.title, threadId: task.thread_id, status: task.status,
      needsReview: this.storage.hasUnreviewedRun(task.id), version: task.version,
      createdAt: task.created_at, updatedAt: task.updated_at,
      assignments: this.storage.assignments(task.id).map(assignment => ({
        agentId: assignment.agent_id, status: assignment.status, summary: assignment.summary,
        lastRun: publicRun(this.storage.lastRun(assignment.id)),
      })) };
  }

  private authorizedDelivery(sessionId: string, agentId: AgentId): ChatroomMessage {
    if (!validAgent(agentId)) bad('未知工作成员');
    const delivery = this.getDelivery(sessionId);
    if (!delivery || delivery.recipientId !== agentId) bad('工作工具只能在当前成员的群投递中使用', 403);
    this.assertSessionWritable(sessionId);
    return delivery;
  }

  private toolAction(sessionId: string, entryKey: string, requestHash: string): { task_id: string } | undefined {
    const prior = this.storage.sqlite.prepare(`SELECT request_hash, task_id FROM chatroom_work_tool_actions
      WHERE workspace_key = ? AND session_id = ? AND entry_key = ?`)
      .get(this.storage.workspaceKey, sessionId, entryKey) as { request_hash: string; task_id: string } | undefined;
    if (prior && prior.request_hash !== requestHash) bad('entryKey 已用于其他工作操作', 409);
    return prior;
  }

  private setAssignmentStatus(assignmentId: string, status: ChatroomTaskStatus): void {
    const assignment = this.storage.sqlite.prepare(`SELECT task_id, status FROM chatroom_work_assignments
      WHERE workspace_key = ? AND id = ?`).get(this.storage.workspaceKey, assignmentId) as
      Pick<AssignmentRow, 'task_id' | 'status'> | undefined;
    if (!assignment || assignment.status === status) return;
    this.storage.sqlite.prepare(`UPDATE chatroom_work_assignments SET status = ?, updated_at = ?
      WHERE workspace_key = ? AND id = ?`)
      .run(status, now(), this.storage.workspaceKey, assignmentId);
    this.refreshTaskStatus(assignment.task_id);
  }

}
