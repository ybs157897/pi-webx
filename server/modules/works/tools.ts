import { Type } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkbenchStore } from '../../workbench/store';
import { readWorksContext, scheduleWorks } from './schedule';

export const WORKS_TOOL_NAMES: Readonly<Record<string, string>> = {
  'works.context': 'works_context',
  'works.schedule': 'works_schedule',
};

function result(data: unknown, maxChars: number, summary?: unknown): AgentToolResult<unknown> {
  const raw = JSON.stringify(data, null, 2);
  const compact = summary === undefined ? raw : JSON.stringify(summary, null, 2);
  const content = raw.length <= maxChars ? raw
    : compact.length <= maxChars ? compact
      : JSON.stringify({ truncated: true, message: '结果超过输出上限，请缩小查询范围' });
  return {
    content: [{ type: 'text', text: content }],
    details: { data },
  };
}

export function createWorksTools(deps: { store: WorkbenchStore; limits: { maxToolOutputChars: number } }): ToolDefinition[] {
  const max = deps.limits.maxToolOutputChars;
  return [
    {
      name: WORKS_TOOL_NAMES['works.context']!,
      label: '读取待办与工作排期',
      description: '读取当前服务器本地日期、时区、未完成待办、工作及已有排期。规划前先调用；修改工作时使用返回的 id 和 updatedAt。可用 query 检索，limit 默认为 100；hasMore 为 true 时用 offset 翻页。',
      promptSnippet: 'works_context: 规划前读取当前本地时间、待办和已有工作；修改现有排期须使用 id 与 expectedUpdatedAt。',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: '按标题或备注检索，最多 100 字' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, description: '分页起点，默认 0' })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        let data = readWorksContext(deps.store, params);
        const { query, offset } = params as { query?: string; limit?: number; offset?: number };
        let limit = (params as { limit?: number }).limit ?? 100;
        while (JSON.stringify(data, null, 2).length > max && limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          data = readWorksContext(deps.store, { query, limit, offset });
        }
        return result(data, max, {
          now: data.now, totals: data.totals, returned: { tasks: 0, works: 0, schedule: 0 }, offset: data.offset,
          truncated: true, message: '单条上下文仍超出输出上限，请用 query 缩小范围',
        });
      },
    },
    {
      name: WORKS_TOOL_NAMES['works.schedule']!,
      label: '保存工作排期',
      description: '用户已明确要求安排，或同意具体方案后，整批原子保存工作排期。每条 entryKey 在本会话固定；再次使用同一 key 修改同一记录，不会重复新建。更新已有 id 或修改已保存 entryKey 时需要 expectedUpdatedAt。taskIds 仅建立工作到待办的关联，不会修改待办。',
      promptSnippet: 'works_schedule: 用户确定安排后批量保存日期和时段；重试保持 entryKey 不变；修改时带 id/expectedUpdatedAt。返回每条工作记录。',
      parameters: Type.Object({
        entries: Type.Array(Type.Object({
          entryKey: Type.String({ description: '本会话稳定且唯一的条目标识，如 monday-review' }),
          id: Type.Optional(Type.String({ description: '修改已有工作的 id；新建时省略' })),
          expectedUpdatedAt: Type.Optional(Type.String({ description: '修改已有工作时传 works_context 或上次保存返回的 updatedAt' })),
          title: Type.String({ description: '具体工作标题，最多 200 字' }),
          note: Type.Optional(Type.String({ description: '工作内容和完成条件，最多 5000 字' })),
          scheduledDate: Type.String({ description: '本地日期 YYYY-MM-DD' }),
          startTime: Type.String({ description: '本地开始时间 HH:mm，24 小时制' }),
          endTime: Type.String({ description: '本地结束时间 HH:mm，24 小时制，晚于开始时间' }),
          taskIds: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: '关联未完成待办的 id；仅建立 refs' })),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const data = scheduleWorks(deps.store, ctx.sessionManager.getSessionId(), params);
        return result(data, max, { truncated: true, entries: data.entries.map(item => ({
          entryKey: item.entryKey, alreadyApplied: item.alreadyApplied,
          record: {
            id: item.record.id, title: item.record.title,
            scheduledDate: item.record.scheduledDate, startTime: item.record.startTime,
            endTime: item.record.endTime, updatedAt: item.record.updatedAt,
          },
        })) });
      },
    },
  ];
}
