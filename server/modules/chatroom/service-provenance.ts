import type { WorkbenchStore } from '../../workbench/store';
import { CHATROOM_MAX_THREAD_MESSAGES, type ChatroomMessage } from './contracts';
import type { ChatroomStore } from './store';
import type { ChatroomWorkService } from './work-service';
import { bad, ids } from './service-input';
import { backfillRequirementTrace, rootForTask, traceRequirementBranch } from './trace-links';
import { getRequirementVersion } from '../requirements/lifecycle';

/** Attach only records checked against the receiving domain and its current version. */
export function attachTasks(store: WorkbenchStore, storage: ChatroomStore, work: ChatroomWorkService,
  delivery: ChatroomMessage | undefined, tasks: readonly { id: string; updatedAt?: unknown }[]): void {
  if (!delivery || (delivery.recipientId !== 'assistant' && delivery.recipientId !== 'requirements')) {
    bad('只有投递中的需求或助理会话可绑定待办', 403);
  }
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > CHATROOM_MAX_THREAD_MESSAGES) bad('待办列表不合法');
  const taskIds = ids(tasks.map(task => task.id));
  const records = new Map(store.listRecords('tasks').map(task => [task.id, task]));
  const taskVersions: Record<string, string> = {};
  for (const task of tasks) {
    const row = records.get(task.id);
    if (!row || typeof task.updatedAt !== 'string' || row.updatedAt !== task.updatedAt) {
      bad('待办不存在或版本已变化', 409);
    }
    taskVersions[task.id] = task.updatedAt;
  }
  const context = { ...delivery.context, taskIds, taskVersions };
  storage.transaction(() => {
    storage.updateContext(delivery.id, context);
    work.updateSourceContext(context.collaborationTaskId, context);
  });
  delivery.context = context;
}

/** A saved requirement belongs to this receiving session or an inherited trusted handoff. */
export function attachRequirement(store: WorkbenchStore, storage: ChatroomStore, work: ChatroomWorkService,
  delivery: ChatroomMessage | undefined, sessionId: string, requirement: { id: string; updatedAt?: unknown },
  options: { newRequirement?: boolean } = {}): void {
  if (!delivery || delivery.recipientId !== 'requirements') bad('只有投递中的需求会话可绑定需求', 403);
  if (!requirement || typeof requirement.id !== 'string' || typeof requirement.updatedAt !== 'string') {
    bad('需求记录及版本不合法');
  }
  const updatedAt = requirement.updatedAt;
  const row = store.sqlite.prepare("SELECT payload FROM workbench_records WHERE module = 'requirements' AND id = ?")
    .get(requirement.id) as { payload: string } | undefined;
  const saved = row ? JSON.parse(row.payload) as Record<string, unknown> : undefined;
  const currentSession = saved?.sourceSessionId === sessionId;
  const inheritedSource = delivery.context.requirementId === requirement.id;
  if (!saved || (!currentSession && !inheritedSource)) bad('需求不属于当前交接上下文', 403);
  if (saved.updatedAt !== updatedAt) bad('需求版本已变化', 409);
  const branching = options.newRequirement === true && delivery.context.requirementId
    && delivery.context.requirementId !== requirement.id && currentSession;
  if (delivery.context.requirementId && delivery.context.requirementId !== requirement.id && !branching) {
    bad('群消息已归属其他需求，不能重新绑定', 409);
  }
  const taskId = delivery.context.collaborationTaskId;
  const boundRoot = taskId ? rootForTask(store, storage.workspaceKey, taskId) : undefined;
  if (boundRoot && boundRoot.id !== requirement.id && !branching) {
    bad('协作任务已归属其他需求，不能重新绑定', 409);
  }
  const requirementVersion = getRequirementVersion(store, requirement.id, updatedAt);
  if (typeof requirementVersion !== 'number'
    || requirementVersion !== getRequirementVersion(store, requirement.id)) {
    bad('需求修订不可验证，请重新保存需求', 409);
  }
  const context = { ...delivery.context, requirementId: requirement.id,
    requirementVersion, expectedUpdatedAt: updatedAt };
  if (branching) {
    delete context.collaborationTaskId;
    delete context.taskIds;
    delete context.taskVersions;
    delete context.reportedTaskIds;
  }
  storage.transaction(() => {
    storage.updateContext(delivery.id, context);
    if (!branching) work.updateSourceContext(taskId, context);
    if (branching) traceRequirementBranch(store, storage.workspaceKey, delivery,
      delivery.context.requirementId!, requirement.id, work.storage.runningRun(sessionId)?.id ?? null);
    else {
      const branchRecorded = store.sqlite.prepare(`SELECT 1 FROM requirement_lifecycle_links
        WHERE requirement_id = ? AND kind = 'chatroom_requirement_branch' AND entity_id = ?`)
        .get(requirement.id, delivery.id) !== undefined;
      if (!branchRecorded) backfillRequirementTrace(store, storage.workspaceKey, { ...delivery, context },
        requirement.id, requirementVersion, updatedAt);
    }
  });
  delivery.context = context;
}
