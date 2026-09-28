/**
 * 模块装配：把 ResolvedAgentProfile 变成 host.create 的 moduleAgent 选项。
 *
 * 关键约束：customTools 先按配置 tools 过滤再传入——领域工具工厂产出的全集
 * 只是能力上限，配置里删掉的名字必须真的不在会话里。配置名经映射表解析后，
 * 既不在工具输出也不在 BUILTIN_TOOL_NAMES 的名字直接报装配错误（503 由路由层
 * 转成状态码），不默默放行。
 *
 * MCP：`cfg.enabled` 的连接逐个装配，`required: true` 失败 → 503 且已连的全部
 * dispose；`required: false` 失败 → 记入 degraded 继续。连接返回值随装配包走，
 * 销毁由宿主会话生命周期统一调用 `dispose()`。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import { BUILTIN_TOOL_NAMES } from '../../src/shared/tool-presets';
import { HostError } from '../pi/host-contract';
import type { WorkbenchStore } from '../workbench/store';
import { AGENT_IDS, type AgentId, type AgentScope, type ResolvedAgentProfile } from './contracts';
import { createKnowledgeAccess, ensureBinding } from './knowledge';
import { connectMcp, type ConnectedMcp } from './mcp';
import { moduleAgentDefinition, resolveToolNames } from './registry';

export interface AssembleModuleAgentInput {
  store: WorkbenchStore;
  workspaceKey: string;
  agentId: AgentId;
  profile: ResolvedAgentProfile;
}

export interface AssembledModuleAgent {
  scope: Omit<AgentScope, 'sessionId'>;
  profile: ResolvedAgentProfile;
  customTools: ToolDefinition[];
  allowedToolNames: string[];
  systemPromptAppend: string[];
  mcp: {
    connected: ConnectedMcp[];
    degraded: { id: string; error: string }[];
  };
  dispose(): Promise<void>;
}

export async function assembleModuleAgent(input: AssembleModuleAgentInput): Promise<AssembledModuleAgent> {
  const { store, workspaceKey, agentId, profile } = input;
  const definition = moduleAgentDefinition(agentId);
  if (definition === undefined) {
    throw new HostError(503, `模块 Agent「${agentId}」尚未注册实现`);
  }

  const binding = ensureBinding(store, workspaceKey, agentId, profile.config.knowledge.homeBinding);
  // `sharedReadBindings` 首版只认其他 Agent 的逻辑绑定名（同名即其 home 库）。
  const sharedReadBaseIds = new Set(binding.sharedReadBaseIds);
  for (const shared of profile.config.knowledge.sharedReadBindings) {
    if ((AGENT_IDS as readonly string[]).includes(shared)) {
      sharedReadBaseIds.add(ensureBinding(store, workspaceKey, shared as AgentId, shared).homeBaseId);
    }
  }
  const knowledge = createKnowledgeAccess(store, { ...binding, sharedReadBaseIds: [...sharedReadBaseIds] });

  const produced = definition.createTools({ knowledge, store, limits: profile.config.limits });
  const producedNames = new Set(produced.map((tool) => tool.name));
  const resolved = resolveToolNames(agentId, profile.config.tools);
  for (const name of resolved) {
    if (!producedNames.has(name) && !BUILTIN_TOOL_NAMES.has(name)) {
      throw new HostError(503, `模块 Agent「${agentId}」配置了未知工具：${name}`);
    }
  }
  const resolvedSet = new Set(resolved);
  const customTools = produced.filter((tool) => resolvedSet.has(tool.name));

  // MCP 连接按声明顺序装配：required 失败整包失败并回收已连；其余记 degraded。
  const connected: ConnectedMcp[] = [];
  const degraded: { id: string; error: string }[] = [];
  const systemPromptAppend: string[] = [];
  const disposeAll = async () => {
    for (const conn of connected.splice(0)) {
      try { await conn.dispose(); } catch { /* best-effort */ }
    }
  };
  try {
    for (const cfg of profile.config.mcp) {
      if (!cfg.enabled) continue;
      try {
        const conn = await connectMcp(agentId, cfg, {
          maxToolOutputChars: profile.config.limits.maxToolOutputChars,
        });
        connected.push(conn);
        customTools.push(...conn.tools);
        if (conn.instructions !== undefined && conn.instructions !== '') {
          systemPromptAppend.push(conn.instructions);
        }
      } catch (error) {
        if (cfg.required) {
          throw new HostError(
            503,
            `模块 Agent「${agentId}」必需 MCP「${cfg.id}」连接失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        degraded.push({ id: cfg.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    await disposeAll();
    throw error;
  }

  return {
    scope: {
      agentId,
      workspaceKey,
      profileRevision: profile.profileRevision,
    },
    profile,
    customTools,
    // SDK 的 tools 是注册白名单：领域与 MCP 工具名由装配线补入，这里只给内置子集。
    allowedToolNames: resolved.filter((name) => BUILTIN_TOOL_NAMES.has(name)),
    systemPromptAppend,
    mcp: { connected, degraded },
    dispose: disposeAll,
  };
}
