/**
 * 模块注册表：装配/查找模块定义的唯一入口，本身无业务逻辑。
 *
 * 只有注册了的模块才有领域工具工厂；配置里 enabled:false 的模块仍会被加载器
 * 解析（用于状态展示与错误隔离），但路由不为它装配会话。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { DataSource } from '../data-sources/contracts';
import type { WorkbenchStore } from '../workbench/store';
import type { AgentId } from './contracts';
import type { KnowledgeAccess } from './knowledge';
import { LOGS_TOOL_NAMES, createLogsTools } from '../modules/logs';
import { REQUIREMENTS_TOOL_NAMES, createRequirementsTools } from '../modules/requirements';
import { ASSISTANT_TOOL_NAMES, createAssistantTools } from '../modules/assistant';
import { CHATROOM_TOOL_NAMES } from '../modules/chatroom/tools';
import { REQUIREMENT_LIFECYCLE_TOOL_NAMES } from '../modules/requirements/lifecycle-tools';

export interface ModuleAgentToolDeps {
  knowledge: KnowledgeAccess;
  store: WorkbenchStore;
  sources: Partial<Record<'logs' | 'issues', DataSource>>;
  limits: { maxRunningSessions: number; maxToolOutputChars: number };
}

export interface ModuleAgentDefinition {
  id: AgentId;
  /** 配置名（`logs.search`）→ pi 工具名（`logs_search`）的固定映射。 */
  toolNameMap: Readonly<Record<string, string>>;
  createTools(deps: ModuleAgentToolDeps): ToolDefinition[];
}

const definitions = new Map<AgentId, ModuleAgentDefinition>([
  ['codes', { id: 'codes', toolNameMap: {}, createTools: () => [] }],
  ['logs', { id: 'logs', toolNameMap: LOGS_TOOL_NAMES, createTools: createLogsTools }],
  ['requirements', { id: 'requirements', toolNameMap: { ...REQUIREMENTS_TOOL_NAMES, 'requirements.dispatch': 'requirements_dispatch' }, createTools: createRequirementsTools }],
  ['assistant', { id: 'assistant', toolNameMap: { ...ASSISTANT_TOOL_NAMES, 'assistant.coordinate': 'assistant_coordinate' }, createTools: createAssistantTools }],
]);

export function moduleAgentDefinition(id: AgentId): ModuleAgentDefinition | undefined {
  return definitions.get(id);
}

/**
 * 配置 `tools` 列表里的名字解析成最终工具白名单：领域名经映射表换成 pi 工具名；
 * 表外名字（内置工具或 MCP 工具名）原样保留，由装配侧决定是否合法。
 */
export function resolveToolNames(id: AgentId, configured: readonly string[]): string[] {
  const map = moduleAgentDefinition(id)?.toolNameMap ?? {};
  const common: Record<string, string> = { 'skills.read': 'skills_read', ...CHATROOM_TOOL_NAMES, ...REQUIREMENT_LIFECYCLE_TOOL_NAMES };
  return configured.map((name) => common[name] ?? map[name] ?? name);
}
