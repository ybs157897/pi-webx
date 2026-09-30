import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import type { ChatroomService } from '../chatroom/service';

type CoordinationInput = { action: 'complete_tasks'; taskIds?: string[]; evidence?: string };

/** Only a delivered handoff can grant access to its linked business records. */
export function coordinateAssistantTasks(store: WorkbenchStore, chatroom: ChatroomService, sessionId: string, input: CoordinationInput) {
  const delivery = chatroom.getDelivery(sessionId);
  if (!delivery || delivery.recipientId !== 'assistant') throw new WorkbenchInputError('只能在助理收到的群聊交接中操作关联待办', 403);
  const context = delivery.context;
  if (input.action !== 'complete_tasks') throw new WorkbenchInputError('未知交接动作');
  if (delivery.senderId !== 'codes') throw new WorkbenchInputError('只有研发回报可以触发待办完成', 403);
  if (!Array.isArray(input.taskIds) || input.taskIds.length < 1 || input.taskIds.length > 20
    || new Set(input.taskIds).size !== input.taskIds.length) throw new WorkbenchInputError('请选择 1 至 20 个不重复的关联待办');
  if (typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 5000) {
    throw new WorkbenchInputError('请记录研发回报的实际完成与验证依据');
  }
  const allowed = new Set((context.taskIds ?? []).filter(id => context.reportedTaskIds?.includes(id)));
  const tasks = store.sqlite.transaction(() => {
    const records = new Map(store.listRecords('tasks').map(task => [task.id, task]));
    const selected = input.taskIds!.map(id => {
      if (!allowed.has(id)) throw new WorkbenchInputError('不能更改本次交接之外的待办', 403);
      const task = records.get(id);
      if (!task) throw new WorkbenchInputError('关联待办已删除', 409);
      if (task.done !== true && (!context.taskVersions?.[id] || task.updatedAt !== context.taskVersions[id])) {
        throw new WorkbenchInputError('待办在研发期间已更新，请核对后重新交接', 409);
      }
      return task;
    });
    return selected.map(task => task.done === true ? task : store.updateRecord('tasks', task.id, { done: true }));
  })();
  return { action: input.action, tasks, evidence: input.evidence.trim() };
}

export function createAssistantCoordinationTool(store: WorkbenchStore, chatroom: ChatroomService): ToolDefinition {
  return {
    name: 'assistant_coordinate', label: '处理群聊待办交接',
    description: '仅限当前收到的研发群聊回报：complete_tasks 按显式完成 ID 和版本校验完成关联待办。需求整理、创建待办与派发开发由需求 Agent 负责。不可操作本次交接之外的数据，也不改变排期；完成后群内广播结果，不再点名互相确认。',
    parameters: Type.Object({
      action: Type.Literal('complete_tasks'),
      taskIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
      evidence: Type.Optional(Type.String({ maxLength: 5000 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new WorkbenchInputError('交接已取消', 409);
      const data = coordinateAssistantTasks(store, chatroom, ctx.sessionManager.getSessionId(), params as CoordinationInput);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: { data } };
    },
  };
}
