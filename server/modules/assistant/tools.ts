import { Type } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkbenchStore } from '../../workbench/store';
import { captureAssistantTasks, proposeAssistantPlan, readAssistantContext } from './service';

export const ASSISTANT_TOOL_NAMES: Readonly<Record<string, string>> = {
  'assistant.context': 'assistant_context',
  'assistant.capture': 'assistant_capture',
  'assistant.proposePlan': 'assistant_propose_plan',
};

function result(data: unknown, maxChars: number): AgentToolResult<unknown> {
  const raw = JSON.stringify(data, null, 2);
  const summary = data !== null && typeof data === 'object' && 'entries' in data && Array.isArray(data.entries)
    ? { entries: data.entries.map((entry: unknown) => entry !== null && typeof entry === 'object'
      ? { entryKey: 'entryKey' in entry ? entry.entryKey : undefined,
        id: 'record' in entry && entry.record && typeof entry.record === 'object' && 'id' in entry.record ? entry.record.id : undefined }
      : {}) }
    : data !== null && typeof data === 'object' && 'plan' in data && data.plan && typeof data.plan === 'object' && 'id' in data.plan
      ? { planId: data.plan.id }
      : {};
  return { content: [{ type: 'text', text: raw.length > maxChars
    ? JSON.stringify({ truncated: true, message: '结果过长，请缩小查询范围或分批读取', ...summary }) : raw }], details: { data } };
}

const priority = Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')]);
const kind = Type.Union([Type.Literal('fixed'), Type.Literal('flexible')]);

export function createAssistantTools(deps: { store: WorkbenchStore; limits: { maxToolOutputChars: number } }): ToolDefinition[] {
  const max = deps.limits.maxToolOutputChars;
  return [
    {
      name: ASSISTANT_TOOL_NAMES['assistant.context']!, label: '读取待办和今日安排',
      description: '读取服务器本地日期、未完成待办及待确认的安排建议。安排前先读取；使用返回的 id 和 updatedAt 生成规划。支持 query/limit/offset 分页。',
      promptSnippet: 'assistant_context: 规划前读取当前时间、待办及已安排事项；重新安排必须使用最新 updatedAt。',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: '按标题、备注或原话检索，最多 100 字' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        let data = readAssistantContext(deps.store, params);
        let limit = (params as { limit?: number }).limit ?? 100;
        const { query, offset } = params as { query?: string; offset?: number };
        while (JSON.stringify(data).length > max && limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          data = readAssistantContext(deps.store, { query, offset, limit });
        }
        return result(data, max);
      },
    },
    {
      name: ASSISTANT_TOOL_NAMES['assistant.capture']!, label: '收集待办',
      description: '从用户的话中提取需要处理的事项并保存到我的待办。每条保留 originalText 原话。没有明确日期时不要填 due；此工具只收集事项，不安排到某天。重试同一事项保持 entryKey 不变。',
      promptSnippet: 'assistant_capture: 用户让你记下事情时收集待办，保留原话；不要自行猜截止日或排期。',
      parameters: Type.Object({ entries: Type.Array(Type.Object({
        entryKey: Type.String({ description: '本会话稳定且唯一的事项标识' }),
        originalText: Type.String({ description: '用户关于本事项的原话，必填' }),
        title: Type.String({ description: '简短可执行的事项标题' }),
        due: Type.Optional(Type.Union([Type.String({ description: '明确的截止日期 YYYY-MM-DD' }), Type.Null()])),
        priority: Type.Optional(priority), tag: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        durationMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return result(captureAssistantTasks(deps.store, ctx.sessionManager.getSessionId(), params), max);
      },
    },
    {
      name: ASSISTANT_TOOL_NAMES['assistant.proposePlan']!, label: '提出安排建议',
      description: '生成可审阅的今日或未来安排草稿，不修改待办排期。必须使用 assistant_context 返回的事项版本；用户在界面明确确认后才应用。已固定时段不能由建议改动。',
      promptSnippet: 'assistant_propose_plan: 保存安排草稿；只有用户确认草稿后，界面才会把时间写入待办。',
      parameters: Type.Object({
        planKey: Type.String({ description: '本会话唯一的规划标识，重试保持不变' }),
        note: Type.Optional(Type.String({ description: '整体安排理由和留白说明，最多 5000 字' })),
        entries: Type.Array(Type.Object({
          taskId: Type.String(), expectedUpdatedAt: Type.String(), plannedDate: Type.String({ description: '安排日期 YYYY-MM-DD' }),
          startTime: Type.Optional(Type.String({ description: '开始时间 HH:mm；无确定时段可省略' })),
          endTime: Type.Optional(Type.String({ description: '结束时间 HH:mm；无确定时段可省略' })),
          kind: Type.Optional(kind), reason: Type.Optional(Type.String({ description: '本事项的安排理由' })),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return result(proposeAssistantPlan(deps.store, ctx.sessionManager.getSessionId(), params), max);
      },
    },
  ];
}
