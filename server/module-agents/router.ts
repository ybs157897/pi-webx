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
import { HostError } from '../pi/host';
import type { SessionSummary, ModuleAgentCapability } from '../../src/shared/protocol';
import {
  AGENT_IDS,
  type AgentId,
} from './contracts';
import { readBinding } from './knowledge';
import { effectiveWorkspace } from './workspace';
import { assertCodesWorkspace, createModuleAgentSessionService, type ModuleAgentSessionService, type ModuleAgentSessionServiceDeps } from './session-service';

/** 同一 requestId 的创建结果保留窗口：客户端重试落在窗口内得到同一份应答。 */
const REQUEST_ID_TTL_MS = 5 * 60_000;
export interface ModuleAgentsRouterDeps extends ModuleAgentSessionServiceDeps {
  sessionService?: ModuleAgentSessionService;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function createModuleAgentsRouter(deps: ModuleAgentsRouterDeps): Router {
  const { host, store, profiles, workspaceKey } = deps;
  const sessionService = deps.sessionService ?? createModuleAgentSessionService(deps);
  const router = Router();
  const restoring = new Map<string, Promise<SessionSummary>>();
  const requestTargets = new Map<string, string>();
  const inFlight = new Map<string, Promise<SessionSummary>>();

  router.get('/', (_req: Request, res: Response) => {
    const agents: ModuleAgentCapability[] = AGENT_IDS.map((id) => {
      const result = profiles.get(id);
      const binding = readBinding(store, workspaceKey, id);
      if (result === undefined) {
        return { id, enabled: false, ok: false, error: '配置文件缺失' };
      }
      if (!result.ok) {
        return { id, enabled: false, ok: false, error: result.error };
      }
      const { config, profileRevision, skills } = result.profile;
      return {
        id,
        enabled: config.enabled,
        ok: true,
        profileRevision,
        workspace: effectiveWorkspace(result.profile),
        tools: config.tools,
        skills: skills.map(({ name, description }) => ({ name, description })),
        dataSources: Object.entries(config.dataSources).map(([kind, source]) => ({ kind: kind as 'logs' | 'issues', id: source.id, adapter: source.adapter })),
        mcp: config.mcp.map((entry) => ({
          id: entry.id,
          enabled: entry.enabled,
          transport: entry.connection.transport,
          configuredTools: entry.tools,
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
    if (Object.keys(body).some(key => key !== 'requestId' && key !== 'sessionId' && key !== 'cwd')) {
      res.status(400).json({ error: '模块会话请求包含未知字段' });
      return;
    }
    const requestId = typeof body.requestId === 'string' && body.requestId !== '' ? body.requestId : null;
    if (requestId === null) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined;
    let assertedCwd: string | undefined;
    try {
      if (agentId === 'codes' && body.cwd !== undefined) assertedCwd = await assertCodesWorkspace(body.cwd);
      else if (body.cwd !== undefined) throw new HostError(400, '仅代码 Agent 可以指定项目目录');
    } catch (error) {
      respondError(res, error);
      return;
    }

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

    const inFlightKey = `${agentId}:${requestId}`;
    const target = `${sessionId ?? 'new'}:${assertedCwd ?? ''}`;
    if (requestTargets.has(inFlightKey) && requestTargets.get(inFlightKey) !== target) {
      res.status(409).json({ error: 'requestId 已用于不同会话请求' });
      return;
    }
    const pending = inFlight.get(inFlightKey);
    if (pending !== undefined) {
      try {
        res.json({ session: await pending });
      } catch (error) {
        respondError(res, error);
      }
      return;
    }

    const restoreKey = sessionId ? `${agentId}:${workspaceKey}:${sessionId}:${assertedCwd ?? ''}` : undefined;
    const creation = (restoreKey ? restoring.get(restoreKey) : undefined)
      ?? sessionService.openOrCreate(agentId, profile, sessionId, assertedCwd).then((hosted) => host.summary(hosted));
    requestTargets.set(inFlightKey, target);
    inFlight.set(inFlightKey, creation);
    if (restoreKey) restoring.set(restoreKey, creation);
    const cleanup = () => {
      if (restoreKey) restoring.delete(restoreKey);
      setTimeout(() => { inFlight.delete(inFlightKey); requestTargets.delete(inFlightKey); }, REQUEST_ID_TTL_MS).unref?.();
    };
    void creation.then(cleanup, cleanup);
    try {
      res.json({ session: await creation });
    } catch (error) {
      respondError(res, error);
    }
  });

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
