import { Type } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkbenchStore } from '../../workbench/store';
import { saveRequirementDraft } from './import-tasks';

export const REQUIREMENTS_TOOL_NAMES: Readonly<Record<string, string>> = {
  'requirements.saveDraft': 'requirements_save_draft',
};

function result(data: unknown, maxChars: number): AgentToolResult<unknown> {
  const raw = JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text: raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…（结果已截断）` : raw }],
    details: { data },
  };
}

export function createRequirementsTools(deps: { store: WorkbenchStore; limits: { maxToolOutputChars: number } }): ToolDefinition[] {
  return [{
    name: REQUIREMENTS_TOOL_NAMES['requirements.saveDraft']!,
    label: '保存需求草稿',
    description: '保存当前对话梳理出的需求与可审阅待办草稿。此操作不会创建待办；用户在界面确认后才导入。传 id 可修订本会话的草稿。',
    promptSnippet: 'requirements_save_draft: 保存需求与待办草稿，返回需求 id；需要用户在界面预览并确认导入。',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '修订已有草稿时传返回的需求 id' })),
      title: Type.String({ description: '需求标题，最多 200 字' }),
      note: Type.Optional(Type.String({ description: '背景、范围、约束和验收标准，最多 5000 字' })),
      priority: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')])),
      taskDrafts: Type.Array(Type.Object({
        title: Type.String({ description: '可执行的待办标题' }),
        priority: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')])),
        due: Type.Optional(Type.Union([Type.String({ description: 'YYYY-MM-DD' }), Type.Null()])),
        tag: Type.Optional(Type.String()),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = saveRequirementDraft(deps.store, ctx.sessionManager.getSessionId(), params);
      return result({ record }, deps.limits.maxToolOutputChars);
    },
  }];
}
