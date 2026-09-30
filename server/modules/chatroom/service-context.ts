import type { WorkbenchStore } from '../../workbench/store';
import type { AgentId } from '../../module-agents/contracts';
import type { ChatroomContext, ChatroomMessage, ChatroomSendInput } from './contracts';
import { bad } from './service-input';
import { getRequirementVersion } from '../requirements/lifecycle';
import { rootForTask } from './trace-links';

export function contextFor(store: WorkbenchStore, workspaceKey: string, senderId: AgentId,
  sessionId: string, input: ChatroomSendInput, parent?: ChatroomMessage): ChatroomContext {
  if (parent) {
    const taskRoot = parent.context.collaborationTaskId
      ? rootForTask(store, workspaceKey, parent.context.collaborationTaskId) : undefined;
    if (taskRoot && parent.context.requirementId && taskRoot.id !== parent.context.requirementId) {
      bad('协作任务与群消息的需求根不一致', 409);
    }
    const inherited = taskRoot && !parent.context.requirementId
      ? { ...parent.context, requirementId: taskRoot.id,
        ...(typeof taskRoot.version === 'number' ? { requirementVersion: taskRoot.version } : {}),
        ...(taskRoot.expectedUpdatedAt ? { expectedUpdatedAt: taskRoot.expectedUpdatedAt } : {}) }
      : parent.context;
    if (input.requirementId !== undefined && input.requirementId !== inherited.requirementId) bad('不能改写继承的需求引用', 403);
    if (input.requirementVersion !== undefined && input.requirementVersion !== inherited.requirementVersion) {
      bad('不能改写继承的需求修订号', 403);
    }
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== inherited.expectedUpdatedAt) bad('不能改写继承的需求版本', 403);
    if (input.taskIds !== undefined && input.taskIds.some(id => !inherited.taskIds?.includes(id))) {
      bad('只能转交当前群话题内的待办', 403);
    }
    const taskIds = input.taskIds ?? inherited.taskIds;
    const baseContext = { ...inherited };
    delete baseContext.reportedTaskIds;
    return {
      ...baseContext,
      ...(taskIds === undefined ? {} : { taskIds, taskVersions: Object.fromEntries(taskIds.map(id => [id, inherited.taskVersions?.[id] ?? ''])) }),
      ...(senderId === 'codes' && input.to === 'assistant' ? { reportedTaskIds: input.taskIds ?? [] } : {}),
    };
  }
  if (input.requirementId !== undefined || input.requirementVersion !== undefined
    || input.expectedUpdatedAt !== undefined) {
    if (senderId !== 'requirements' || !input.requirementId || !input.expectedUpdatedAt) {
      bad('只有需求会话可引用自己保存的需求及版本', 403);
    }
    const row = store.sqlite.prepare("SELECT payload FROM workbench_records WHERE module = 'requirements' AND id = ?")
      .get(input.requirementId) as { payload: string } | undefined;
    const requirement = row ? JSON.parse(row.payload) as Record<string, unknown> : undefined;
    if (!requirement || requirement.sourceSessionId !== sessionId) bad('需求不属于当前会话', 403);
    if (requirement.updatedAt !== input.expectedUpdatedAt) bad('需求已更新，请重新读取版本', 409);
    const currentVersion = getRequirementVersion(store, input.requirementId);
    const requirementVersion = input.requirementVersion
      ?? getRequirementVersion(store, input.requirementId, input.expectedUpdatedAt);
    if (typeof requirementVersion !== 'number'
      || requirementVersion !== currentVersion) {
      bad('需求修订不可验证，请读取 chatroom_trace 获取当前 requirementVersion 后重新交接', 409);
    }
    if (input.taskIds !== undefined) bad('需求会话不能伪造待办引用', 403);
    return { requirementId: input.requirementId, requirementVersion, expectedUpdatedAt: input.expectedUpdatedAt };
  }
  if (input.taskIds !== undefined) {
    if (senderId !== 'assistant') bad('只有助理可首次引用现有待办', 403);
    const taskVersions: Record<string, string> = {};
    const records = new Map(store.listRecords('tasks').map(task => [task.id, task]));
    for (const id of input.taskIds) {
      const task = records.get(id);
      if (!task || typeof task.updatedAt !== 'string') bad('引用的待办不存在', 404);
      taskVersions[id] = task.updatedAt;
    }
    return { taskIds: input.taskIds, taskVersions };
  }
  return {};
}
