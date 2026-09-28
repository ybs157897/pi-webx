/**
 * 日志 Agent 的领域工具：`logs_*` 只读查询 + `knowledge_*` 受限知识读写。
 *
 * 工具名用下划线（pi 工具名以 `name` 直进 LLM 调用面，点号不做分隔假设），
 * 配置里的 `logs.search` 等名字经 `LOGS_TOOL_NAMES` 映射过来。结果超过
 * `limits.maxToolOutputChars` 截断并显式标注——截断对模型可见，不静默丢内容。
 */
import { Type } from 'typebox';

import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { WorkbenchStore } from '../../workbench/store';
import type { KnowledgeAccess } from '../knowledge';
import type { DataSource } from '../../data-sources/contracts';
import { sourceTools } from '../../data-sources/tools';

/** 配置名 → pi 工具名。装配与配置校验都以这张表为准。 */
export const LOGS_TOOL_NAMES: Readonly<Record<string, string>> = {
  'logs.search': 'logs_search',
  'logs.read': 'logs_read',
  'issues.search': 'issues_search',
  'issues.read': 'issues_read',
  'knowledge.search': 'knowledge_search',
  'knowledge.read': 'knowledge_read',
  'knowledge.create': 'knowledge_create',
  'knowledge.update': 'knowledge_update',
};

export interface LogsToolDeps {
  store: WorkbenchStore;
  sources: Partial<Record<'logs' | 'issues', DataSource>>;
  knowledge: KnowledgeAccess;
  limits: { maxToolOutputChars: number };
}

function result(data: unknown, maxChars: number): AgentToolResult<unknown> {
  let text = JSON.stringify(data, null, 2);
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（结果超出上限 ${maxChars} 字符，已截断）`;
  }
  return { content: [{ type: 'text', text }], details: { data } };
}

export function createLogsTools(deps: LogsToolDeps): ToolDefinition[] {
  const { knowledge, limits } = deps;
  const max = limits.maxToolOutputChars;

  return [
    ...(deps.sources.logs ? sourceTools('logs', deps.sources.logs, max) : []),
    ...(deps.sources.issues ? sourceTools('issues', deps.sources.issues, max) : []),
    {
      name: LOGS_TOOL_NAMES['knowledge.search']!,
      label: '知识检索',
      description: '在本 Agent 可访问的知识库范围内检索条目，返回标题与摘要。',
      promptSnippet: 'knowledge_search: 在本 Agent 知识范围内检索条目。',
      parameters: Type.Object({
        q: Type.String({ description: '检索关键词' }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const p = params as { q: string; limit?: number };
        return result(knowledge.search(p.q, p.limit ?? 20), max);
      },
    },
    {
      name: LOGS_TOOL_NAMES['knowledge.read']!,
      label: '知识读取',
      description: '按 id 读取本 Agent 可访问范围内的知识条目全文。',
      promptSnippet: 'knowledge_read: 按 id 读取知识条目全文。',
      parameters: Type.Object({
        id: Type.String({ description: '知识条目 id' }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return result(knowledge.read((params as { id: string }).id), max);
      },
    },
    {
      name: LOGS_TOOL_NAMES['knowledge.create']!,
      label: '知识沉淀',
      description: '把排查结论沉淀进本 Agent 的专属知识库；归属库由服务端填写。',
      promptSnippet: 'knowledge_create: 沉淀结论到本 Agent 知识库，title 写一句话结论。',
      parameters: Type.Object({
        title: Type.String({ description: '一句话结论式标题' }),
        body: Type.Optional(Type.String({ description: '正文，可用 [[标题]] 关联旧知识' })),
        tags: Type.Optional(Type.Array(Type.String())),
        refs: Type.Optional(Type.Array(Type.Object({ type: Type.String(), id: Type.String() }))),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return result(knowledge.create(params as Parameters<KnowledgeAccess['create']>[0]), max);
      },
    },
    {
      name: LOGS_TOOL_NAMES['knowledge.update']!,
      label: '知识修订',
      description: '修订本 Agent 知识库中已有条目的标题、正文或标签。',
      promptSnippet: 'knowledge_update: 修订本库已有知识条目。',
      parameters: Type.Object({
        id: Type.String({ description: '知识条目 id' }),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const { id, ...patch } = params as { id: string } & Parameters<KnowledgeAccess['update']>[1];
        return result(knowledge.update(id, patch), max);
      },
    },
  ];
}
