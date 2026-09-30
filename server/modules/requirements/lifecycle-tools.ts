import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import type { AgentId } from '../../module-agents/contracts';
import type { ChatroomService } from '../chatroom/service';
import { readRequirementTrace } from './lifecycle-trace';
import { submitRequirementDelivery } from './lifecycle-deliveries';

export const REQUIREMENT_LIFECYCLE_TOOL_NAMES: Readonly<Record<string, string>> = {
  'chatroom.trace': 'chatroom_trace', 'chatroom.delivery': 'chatroom_delivery',
};

export function createRequirementLifecycleTools(deps: {
  store: WorkbenchStore; chatroom: ChatroomService; agentId: AgentId; limits: { maxToolOutputChars: number };
}): ToolDefinition[] {
  const data = (value: unknown) => {
    const raw = JSON.stringify(value);
    return { content: [{ type: 'text' as const, text: raw.length > deps.limits.maxToolOutputChars
      ? JSON.stringify({ truncated: true, message: '追踪记录过长，请在需求全链路界面查看完整记录' }) : raw }], details: { data: value } };
  };
  function rootFor(sessionId: string, requested?: string): string {
    const delivery = deps.chatroom.getDelivery(sessionId);
    if (delivery) {
      if (delivery.recipientId !== deps.agentId || !delivery.context.requirementId
        || requested && requested !== delivery.context.requirementId) throw new WorkbenchInputError('追踪仅限当前交接需求', 403);
      deps.chatroom.work.assertSessionWritable(sessionId);
      return delivery.context.requirementId;
    }
    if (deps.agentId !== 'requirements' || !requested) throw new WorkbenchInputError('请从已关联需求的会话读取追踪', 403);
    const row = deps.store.sqlite.prepare("SELECT payload FROM workbench_records WHERE module='requirements' AND id=?")
      .get(requested) as { payload: string } | undefined;
    if (!row || JSON.parse(row.payload).sourceSessionId !== sessionId) throw new WorkbenchInputError('需求不属于当前会话', 403);
    return requested;
  }
  return [{
    name: 'chatroom_trace', label: '读取当前需求全链路',
    description: '读取当前交接需求的唯一 ID、修订、消息、任务分工、执行和工具结果摘要、交付及人工审阅。普通需求会话只能读取自己保存的需求。',
    parameters: Type.Object({ requirementId: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new WorkbenchInputError('会话已取消', 409);
      const input = params as { requirementId?: string };
      return data(readRequirementTrace(deps.store, rootFor(ctx.sessionManager.getSessionId(), input.requirementId)));
    },
  }, {
    name: 'chatroom_delivery', label: '提交当前需求交付证据',
    description: '在关联需求的群工作会话中提交真实文件、提交号、PR、测试或报告引用，保存为待人工审阅。不能接受交付；当前 Run 可仍在收尾，正式接受须等待成功结束。省略 runIds 会关联当前执行，toolCallId 可关联自己的已结束工具记录。',
    parameters: Type.Object({ entryKey: Type.String(), summary: Type.String(),
      evidence: Type.Array(Type.Object({ kind: Type.Union(['file', 'commit', 'pull_request', 'test', 'report'].map(kind => Type.Literal(kind))),
        ref: Type.String(), label: Type.Optional(Type.String()), runId: Type.Optional(Type.String()), toolCallId: Type.Optional(Type.String()),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
      runIds: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new WorkbenchInputError('会话已取消', 409);
      const sessionId = ctx.sessionManager.getSessionId(), rootId = rootFor(sessionId);
      const delivery = deps.chatroom.getDelivery(sessionId);
      const run = deps.chatroom.work.storage.runningRun(sessionId);
      const trace = readRequirementTrace(deps.store, rootId);
      if (!delivery || !run || delivery.context.requirementVersion !== trace.requirementVersion) {
        throw new WorkbenchInputError('交付须来自当前需求版本的执行', 409);
      }
      const input = params as Record<string, unknown>;
      if (!Array.isArray(input.evidence)) throw new WorkbenchInputError('交付须提供证据');
      const evidence = (input.evidence as Array<Record<string, unknown>>).map(item => ({ ...item,
        ...(item.toolCallId && !item.runId ? { runId: run.id } : {}) }));
      const result = submitRequirementDelivery(deps.store, rootId, { ...input, evidence,
        runIds: input.runIds ?? [run.id], expectedUpdatedAt: trace.requirement.updatedAt,
        expectedRequirementVersion: trace.requirementVersion }, `${deps.agentId}:${sessionId}`);
      return data({ delivery: result.delivery, requirementId: result.trace.requirementId,
        requirementVersion: result.trace.requirementVersion, stage: result.trace.stage });
    },
  }];
}
