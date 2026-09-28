/**
 * 模块 Agent 的 HTTP 入口：能力展示 + 会话新建/恢复。
 *
 * `GET /` 给只读的能力投影（脱敏：MCP 只露 id/transport/地址，不含 headerRefs
 * 值与凭据）；`POST /:agentId/sessions` 是唯一装配入口——恢复按已登记的
 * sessionId 定位磁盘会话文件，身份核对在 host 装配线里完成，客户端不能传
 * sessionPath、不能覆盖工具面。requestId 幂等：同一请求重试复用进行中的创建。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';

import type { PiHost } from '../pi/host';
import { HostError } from '../pi/host';
import { listStoredSessions } from '../stored-sessions';
import { BUILTIN_TOOL_NAMES } from '../../src/shared/tool-presets';
import type { SessionSummary } from '../../src/shared/protocol';
import type { WorkbenchStore } from '../workbench/store';
import {
  AGENT_IDS,
  type AgentId,
  type ProfileLoadResult,
  type ResolvedAgentProfile,
} from './contracts';
import { createKnowledgeAccess, ensureBinding, readBinding } from './knowledge';
import { moduleAgentDefinition, resolveToolNames } from './registry';

/** 同一 requestId 的创建结果保留窗口：客户端重试落在窗口内得到同一份应答。 */
const REQUEST_ID_TTL_MS = 5 * 60_000;
/** 按 sessionId 恢复时扫描的存储会话上限，与 routes 的 STORED_LOOKUP_LIMIT 对齐。 */
const STORED_LOOKUP_LIMIT = 200;

export interface ModuleAgentsRouterDeps {
  host: PiHost;
  store: WorkbenchStore;
  profiles: Map<AgentId, ProfileLoadResult>;
  workspaceKey: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function createModuleAgentsRouter(deps: ModuleAgentsRouterDeps): Router {
  const { host, store, profiles, workspaceKey } = deps;
  const router = Router();
  const inFlight = new Map<string, Promise<SessionSummary>>();

  router.get('/', (_req: Request, res: Response) => {
    const agents = AGENT_IDS.map((id) => {
      const result = profiles.get(id);
      const binding = readBinding(store, workspaceKey, id);
      if (result === undefined) {
        return { id, enabled: false, ok: false, error: '配置文件缺失' };
      }
      if (!result.ok) {
        return { id, enabled: false, ok: false, error: result.error };
      }
      const { config, profileRevision, skillPaths } = result.profile;
      return {
        id,
        enabled: config.enabled,
        ok: true,
        profileRevision,
        tools: config.tools,
        skills: skillPaths.map((skillPath) => ({
          name: path.basename(path.dirname(skillPath)),
          path: skillPath,
        })),
        mcp: config.mcp.map((entry) => ({
          id: entry.id,
          enabled: entry.enabled,
          transport: entry.connection.transport,
          ...(entry.connection.transport === 'stdio'
            ? { command: entry.connection.command }
            : { url: entry.connection.url }),
        })),
        ...(config.model === undefined ? {} : { model: config.model }),
        knowledge: {
          homeBinding: config.knowledge.homeBinding,
          ...(binding === null ? {} : { homeBaseId: binding.homeBaseId }),
        },
      };
    });
    res.json({ workspaceKey, agents });
  });

  router.post('/:agentId/sessions', async (req: Request, res: Response) => {
    const agentId = req.params.agentId;
    if (typeof agentId !== 'string' || !isAgentId(agentId)) {
      res.status(404).json({ error: `unknown module agent: ${String(agentId)}` });
      return;
    }
    const body = isObject(req.body) ? req.body : {};
    const requestId = typeof body.requestId === 'string' && body.requestId !== '' ? body.requestId : null;
    if (requestId === null) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined;

    const result = profiles.get(agentId);
    if (result === undefined || !result.ok) {
      res.status(503).json({
        error: result !== undefined && !result.ok ? result.error : '配置文件缺失',
      });
      return;
    }
    if (!result.profile.config.enabled) {
      res.status(503).json({ error: `模块 Agent「${agentId}」未启用` });
      return;
    }
    const profile = result.profile;

    /** 每模块一段运行中会话的软限制；多会话历史不受影响。 */
    const running = host.list().filter(
      (hosted) => hosted.moduleAgent?.agentId === agentId && hosted.alive && hosted.streaming,
    ).length;
    if (running >= profile.config.limits.maxRunningSessions) {
      res.status(429).json({ error: `模块 Agent「${agentId}」已有 ${running} 段会话在运行，请稍后再试` });
      return;
    }

    const inFlightKey = `${agentId}:${requestId}`;
    const pending = inFlight.get(inFlightKey);
    if (pending !== undefined) {
      try {
        res.json({ session: await pending });
      } catch (error) {
        respondError(res, error);
      }
      return;
    }

    const creation = openOrCreate(agentId, profile, sessionId).then((hosted) => host.summary(hosted));
    inFlight.set(inFlightKey, creation);
    creation.finally(() => {
      setTimeout(() => inFlight.delete(inFlightKey), REQUEST_ID_TTL_MS).unref?.();
    });
    try {
      res.json({ session: await creation });
    } catch (error) {
      respondError(res, error);
    }
  });

  async function openOrCreate(agentId: AgentId, profile: ResolvedAgentProfile, sessionId?: string) {
    if (sessionId !== undefined) {
      const hosted = host.get(sessionId);
      if (hosted !== undefined) {
        if (hosted.moduleAgent?.agentId !== agentId) {
          throw new HostError(409, '会话不属于该模块 Agent');
        }
        return hosted;
      }
      const stored = (await listStoredSessions({ limit: STORED_LOOKUP_LIMIT }))
        .find((entry) => entry.id === sessionId);
      if (stored === undefined) {
        throw new HostError(404, `no stored session with id ${sessionId}`);
      }
      return host.create({
        sessionPath: stored.path,
        cwd: stored.cwd,
        moduleAgent: assemble(agentId, profile),
      });
    }
    return host.create({ moduleAgent: assemble(agentId, profile) });
  }

  /**
   * 装配包：绑定解析在请求线程内完成，领域工具闭包绑定到该会话的 scope。
   * `sharedReadBindings` 首版只支持其他 Agent 的逻辑绑定名（同名即其 home 库）。
   */
  function assemble(agentId: AgentId, profile: ResolvedAgentProfile) {
    const definition = moduleAgentDefinition(agentId);
    if (definition === undefined) {
      throw new HostError(503, `模块 Agent「${agentId}」尚未注册实现`);
    }
    const binding = ensureBinding(store, workspaceKey, agentId, profile.config.knowledge.homeBinding);
    const sharedReadBaseIds = new Set(binding.sharedReadBaseIds);
    for (const shared of profile.config.knowledge.sharedReadBindings) {
      if (isAgentId(shared)) {
        sharedReadBaseIds.add(
          ensureBinding(store, workspaceKey, shared, shared).homeBaseId,
        );
      }
    }
    const access = createKnowledgeAccess(store, { ...binding, sharedReadBaseIds: [...sharedReadBaseIds] });
    const customTools = definition.createTools({ knowledge: access, store, limits: profile.config.limits });
    const resolved = resolveToolNames(agentId, profile.config.tools);
    const customNames = new Set(customTools.map((tool) => tool.name));
    for (const name of resolved) {
      if (!customNames.has(name) && !BUILTIN_TOOL_NAMES.has(name)) {
        throw new HostError(503, `模块 Agent「${agentId}」配置了未知工具：${name}`);
      }
    }
    return {
      scope: {
        agentId,
        workspaceKey,
        profileRevision: profile.profileRevision,
      },
      profile,
      customTools,
      // SDK 的 tools 是注册白名单：领域工具名由装配线补入，这里只给内置子集。
      allowedToolNames: resolved.filter((name) => BUILTIN_TOOL_NAMES.has(name)),
      systemPromptAppend: [],
    };
  }

  return router;
}

function respondError(res: Response, error: unknown): void {
  if (res.headersSent) return;
  if (error instanceof HostError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}
