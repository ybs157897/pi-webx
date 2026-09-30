import { createHash } from 'node:crypto';
import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import { WorkbenchInputError } from '../../workbench/store';
import type { ChatroomMessage, ChatroomPublicTask } from './contracts';
import type { WorkTaskActionInput } from './work-contracts';
import type { ChatroomWorkStore, RunRow } from './work-store';

function bad(message: string, status = 400): never { throw new WorkbenchInputError(message, status); }
function validAgent(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}
function requestHash(taskId: string, input: WorkTaskActionInput): string {
  return createHash('sha256').update(JSON.stringify([taskId, input.action, input.entryKey,
    input.expectedVersion, input.agentId ?? null, input.reviewed ?? null, input.body ?? null])).digest('hex');
}

/** A browser action is scoped to its durable server-issued user key, never a caller-provided sender ID. */
export async function performWorkUserAction(
  storage: ChatroomWorkStore, userSessionKey: string, taskId: string, input: WorkTaskActionInput,
  sendUser: (agentId: AgentId, body: string) => ChatroomMessage,
  messageById: (id: string) => ChatroomMessage | undefined,
  cancelRun: (runId: string) => Promise<void> | void,
  publicTask: (id: string) => ChatroomPublicTask,
  refreshTaskStatus: (id: string) => void,
  traceAction: (action: 'review' | 'resume' | 'cancel' | 'cancel_unconfirmed',
    key: string, occurredAt: string, messageId?: string) => void,
): Promise<{ task: ChatroomPublicTask; message?: ChatroomMessage }> {
  if (!userSessionKey || !storage.sqlite.prepare(`SELECT 1 FROM chatroom_user_sessions
    WHERE workspace_key = ? AND session_key = ?`).get(storage.workspaceKey, userSessionKey)) bad('用户群聊会话无效', 403);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['action', 'entryKey', 'expectedVersion', 'agentId', 'reviewed', 'body'].includes(key))) {
    bad('任务操作包含未知字段');
  }
  if (input.action !== 'resume' && input.action !== 'cancel' && input.action !== 'review') bad('未知任务操作');
  if (typeof input.entryKey !== 'string' || !input.entryKey.trim() || input.entryKey.length > 200) bad('entryKey 不合法');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) bad('任务版本不合法');
  if (input.agentId !== undefined && !validAgent(input.agentId)) bad('未知任务成员');
  if (input.reviewed !== undefined && typeof input.reviewed !== 'boolean') bad('核对标记不合法');
  if (input.body !== undefined && (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 12_000)) {
    bad('继续任务正文不合法');
  }
  const digest = requestHash(taskId, input);
  const traceKey = createHash('sha256').update(userSessionKey).update(digest).digest('hex');
  const previous = storage.sqlite.prepare(`SELECT request_hash, task_id, message_id FROM chatroom_work_user_actions
    WHERE workspace_key = ? AND user_session_key = ? AND entry_key = ?`)
    .get(storage.workspaceKey, userSessionKey, input.entryKey) as
    { request_hash: string; task_id: string; message_id: string | null } | undefined;
  if (previous) {
    if (previous.request_hash !== digest || previous.task_id !== taskId) bad('entryKey 已用于其他任务操作', 409);
    const message = previous.message_id ? messageById(previous.message_id) : undefined;
    return { task: publicTask(taskId), ...(message ? { message } : {}) };
  }
  const task = storage.task(taskId);
  if (!task) bad('协作任务不存在', 404);
  if (task.version !== input.expectedVersion) bad('任务状态已变化，请刷新后重试', 409);
  const assignments = storage.assignments(taskId);
  if (!assignments.length) bad('任务尚无成员分工', 409);
  if (input.action === 'review') {
    if (input.reviewed !== true) bad('须明确确认已经核对外部改动', 409);
    if (input.agentId !== undefined || input.body !== undefined) bad('核对操作不接受成员或执行正文');
    if (!storage.hasUnreviewedRun(taskId)) bad('当前任务没有待核对的执行记录', 409);
    return storage.transaction(() => {
      const latest = storage.task(taskId)!;
      if (latest.version !== input.expectedVersion) bad('任务状态已变化，请刷新后重试', 409);
      const timestamp = new Date().toISOString();
      storage.sqlite.prepare(`UPDATE chatroom_work_runs SET reviewed_at = ?
        WHERE workspace_key = ? AND task_id = ? AND status = 'needs_review' AND reviewed_at IS NULL`)
        .run(timestamp, storage.workspaceKey, taskId);
      if (latest.status !== 'cancelled') storage.sqlite.prepare(`UPDATE chatroom_work_assignments
        SET status = 'interrupted', updated_at = ?
        WHERE workspace_key = ? AND task_id = ? AND status = 'needs_review'`)
        .run(timestamp, storage.workspaceKey, taskId);
      refreshTaskStatus(taskId);
      if (storage.task(taskId)!.version === latest.version) storage.sqlite.prepare(`UPDATE chatroom_work_tasks
        SET version = version + 1, updated_at = ? WHERE workspace_key = ? AND id = ?`)
        .run(timestamp, storage.workspaceKey, taskId);
      storage.sqlite.prepare(`INSERT INTO chatroom_work_user_actions
        (workspace_key, user_session_key, entry_key, request_hash, action, task_id)
        VALUES (?, ?, ?, ?, 'review', ?)`)
        .run(storage.workspaceKey, userSessionKey, input.entryKey, digest, taskId);
      traceAction('review', traceKey, timestamp);
      return { task: publicTask(taskId) };
    });
  }
  if (input.action === 'resume') {
    if (task.status === 'completed' || task.status === 'cancelled') bad('已结束的任务不能继续', 409);
    const assignment = input.agentId
      ? assignments.find(item => item.agent_id === input.agentId)
      : assignments.length === 1 ? assignments[0] : undefined;
    if (!assignment) bad('多个成员分工时须指定继续执行的 Agent', 400);
    if (!['failed', 'interrupted', 'needs_review'].includes(assignment.status)) bad('当前分工无需恢复执行', 409);
    const uncertain = task.status === 'needs_review' || assignments.some(item => item.status === 'needs_review');
    if (uncertain && input.reviewed !== true) bad('工具副作用结果不明，须核对后明确 reviewed:true', 409);
    return storage.transaction(() => {
      const latest = storage.task(taskId)!;
      if (latest.version !== input.expectedVersion) bad('任务状态已变化，请刷新后重试', 409);
      const timestamp = new Date().toISOString();
      if (uncertain) storage.sqlite.prepare(`UPDATE chatroom_work_runs SET reviewed_at = ?
        WHERE workspace_key = ? AND task_id = ? AND status = 'needs_review' AND reviewed_at IS NULL`)
        .run(timestamp, storage.workspaceKey, taskId);
      if (uncertain) storage.sqlite.prepare(`UPDATE chatroom_work_assignments
        SET status = 'interrupted', updated_at = ? WHERE workspace_key = ? AND task_id = ? AND status = 'needs_review'`)
        .run(timestamp, storage.workspaceKey, taskId);
      storage.sqlite.prepare(`UPDATE chatroom_work_assignments SET status = 'running', updated_at = ?
        WHERE workspace_key = ? AND id = ?`).run(timestamp, storage.workspaceKey, assignment.id);
      refreshTaskStatus(taskId);
      const message = sendUser(assignment.agent_id, input.body?.trim() ?? `继续任务：${task.title}`);
      storage.sqlite.prepare(`INSERT INTO chatroom_work_user_actions
        (workspace_key, user_session_key, entry_key, request_hash, action, task_id, message_id)
        VALUES (?, ?, ?, ?, 'resume', ?, ?)`)
        .run(storage.workspaceKey, userSessionKey, input.entryKey, digest, taskId, message.id);
      traceAction('resume', traceKey, timestamp, message.id);
      return { task: publicTask(taskId), message };
    });
  }
  if (task.status === 'completed' || task.status === 'cancelled') bad('任务已经结束', 409);
  const running = storage.sqlite.prepare(`SELECT * FROM chatroom_work_runs
    WHERE workspace_key = ? AND task_id = ? AND status = 'running'`).all(storage.workspaceKey, taskId) as RunRow[];
  const committed = storage.transaction(() => {
    const latest = storage.task(taskId)!;
    if (latest.version !== input.expectedVersion) bad('任务状态已变化，请刷新后重试', 409);
    const timestamp = new Date().toISOString();
    storage.sqlite.prepare(`UPDATE chatroom_work_runs SET status = 'cancelled', finished_at = ?, error = ?
      WHERE workspace_key = ? AND task_id = ? AND status = 'running'`)
      .run(timestamp, '用户取消了任务', storage.workspaceKey, taskId);
    storage.sqlite.prepare(`UPDATE chatroom_work_assignments SET status = 'cancelled', updated_at = ?
      WHERE workspace_key = ? AND task_id = ?`).run(timestamp, storage.workspaceKey, taskId);
    refreshTaskStatus(taskId);
    storage.sqlite.prepare(`INSERT INTO chatroom_work_user_actions
      (workspace_key, user_session_key, entry_key, request_hash, action, task_id)
      VALUES (?, ?, ?, ?, 'cancel', ?)`)
      .run(storage.workspaceKey, userSessionKey, input.entryKey, digest, taskId);
    traceAction('cancel', traceKey, timestamp);
    return { task: publicTask(taskId) };
  });
  try {
    for (const run of running) await cancelRun(run.id);
    return committed;
  } catch {
    storage.transaction(() => {
      const timestamp = new Date().toISOString();
      for (const run of running) {
        storage.sqlite.prepare(`UPDATE chatroom_work_runs SET status = 'needs_review', error = ?
          WHERE workspace_key = ? AND id = ? AND status = 'cancelled'`)
          .run('取消执行未确认，外部操作结果待核对', storage.workspaceKey, run.id);
        if (run.assignment_id) storage.sqlite.prepare(`UPDATE chatroom_work_assignments
          SET status = 'needs_review', updated_at = ? WHERE workspace_key = ? AND id = ?`)
          .run(timestamp, storage.workspaceKey, run.assignment_id);
      }
      refreshTaskStatus(taskId);
      traceAction('cancel_unconfirmed', traceKey, timestamp);
    });
    bad('取消执行未确认，已标为待核对', 503);
  }
}
