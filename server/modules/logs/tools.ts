/** 日志 Agent 领域工具；知识能力经受限 KnowledgeAccess 注入。 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkbenchStore } from '../../workbench/store';
import type { KnowledgeAccess } from '../../module-agents/knowledge';
import type { DataSource } from '../../data-sources/contracts';
import { sourceTools } from '../../data-sources/tools';
import { KNOWLEDGE_TOOL_NAMES, createKnowledgeTools } from '../knowledge';

export const LOGS_TOOL_NAMES: Readonly<Record<string, string>> = {
  'logs.search': 'logs_search',
  'logs.read': 'logs_read',
  'issues.search': 'issues_search',
  'issues.read': 'issues_read',
  ...KNOWLEDGE_TOOL_NAMES,
};

export interface LogsToolDeps {
  store: WorkbenchStore;
  sources: Partial<Record<'logs' | 'issues', DataSource>>;
  knowledge: KnowledgeAccess;
  limits: { maxToolOutputChars: number };
}

export function createLogsTools(deps: LogsToolDeps): ToolDefinition[] {
  const max = deps.limits.maxToolOutputChars;
  return [
    ...(deps.sources.logs ? sourceTools('logs', deps.sources.logs, max) : []),
    ...(deps.sources.issues ? sourceTools('issues', deps.sources.issues, max) : []),
    ...createKnowledgeTools(deps.knowledge, max),
  ];
}
