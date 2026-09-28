/**
 * 模块 Agent 的 HTTP 入口：能力展示 + 会话新建/恢复。
 *
 * `GET /` 给只读的能力投影（脱敏：MCP 只露 id/transport/地址，不含 headerRefs
 * 值与凭据）；`POST /:agentId/sessions` 是唯一装配入口——恢复按已登记的
 * sessionId 定位磁盘会话文件，身份核对在 host 装配线里完成，客户端不能传
 * sessionPath、不能覆盖工具面。requestId 幂等：同一请求重试复用进行中的创建。
 */
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { realpath, stat } from 'node:fs/promises';
import { readModuleAgentEntry } from '../pi/host-session-assembly';
import { ProfileSnapshots } from './snapshots';
import type { DataSourceRegistry } from '../data-sources/registry';
import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';

import type { PiHost } from '../pi/host';
import { HostError } from '../pi/host';
import { listStoredSessions } from '../stored-sessions';
import type { SessionSummary, ModuleAgentCapability } from '../../src/shared/protocol';
import type { WorkbenchStore } from '../workbench/store';
import {
  AGENT_IDS,
  type AgentId,
  type ProfileLoadResult,
  type ResolvedAgentProfile,
} from './contracts';
import { assembleModuleAgent } from './assemble';
import { readBinding } from './knowledge';
import { assertWorkspaceAvailable, canonicalWorkspacePath, effectiveWorkspace, WorkspaceError, workspacePathsOverlap } from './workspace';

/** 同一 requestId 的创建结果保留窗口：客户端重试落在窗口内得到同一份应答。 */
const REQUEST_ID_TTL_MS = 5 * 60_000;
/** 按 sessionId 恢复时扫描的存储会话上限，与 routes 的 STORED_LOOKUP_LIMIT 对齐。 */
const STORED_LOOKUP_LIMIT = 200;

export interface ModuleAgentsRouterDeps {
  host: PiHost;
  store: WorkbenchStore;
  profiles: Map<AgentId, ProfileLoadResult>;
  workspaceKey: string;
  dataSourceRegistry?: DataSourceRegistry;
  snapshots?: ProfileSnapshots;
  storedSessions?: typeof listStoredSessions;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

async function codesWorkspace(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new HostError(400, '代码 Agent 需要绝对路径的项目目录');
  }
  try {
    const canonical = await realpath(value);
    if (!(await stat(canonical)).isDirectory()) throw new HostError(400, '项目路径不是目录');
    return canonical;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError(400, '项目目录不存在或不可访问');
  }
}

export function createModuleAgentsRouter(deps: ModuleAgentsRouterDeps): Router {
  const { host, store, profiles, workspaceKey } = deps;
  const snapshots = deps.snapshots ?? new ProfileSnapshots(path.join(path.dirname(store.sqlite.name), 'module-agent-profiles'));
  const router = Router();
  const restoring = new Map<string, Promise<SessionSummary>>();
  const requestTargets = new Map<string, string>();
  const inFlight = new Map<string, Promise<SessionSummary>>();
  const workspaceClaims = new Map<symbol, { agentId: AgentId; path: string }>();

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
      if (agentId === 'codes' && body.cwd !== undefined) assertedCwd = await codesWorkspace(body.cwd);
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
      ?? openOrCreate(agentId, profile, sessionId, assertedCwd).then((hosted) => host.summary(hosted));
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

  async function openOrCreate(agentId: AgentId, profile: ResolvedAgentProfile, sessionId?: string, assertedCwd?: string) {
    if (sessionId !== undefined) {
      const hosted = host.get(sessionId);
      if (hosted !== undefined) {
        if (hosted.moduleAgent?.agentId !== agentId || hosted.moduleAgent?.workspaceKey !== workspaceKey) {
          throw new HostError(409, '会话不属于该模块 Agent');
        }
        if (assertedCwd !== undefined && await codesWorkspace(hosted.cwd) !== assertedCwd) {
          throw new HostError(409, '会话属于其他项目目录');
        }
        await available(agentId, hosted.cwd);
        return hosted;
      }
      const stored = (await (deps.storedSessions ?? listStoredSessions)({ limit: STORED_LOOKUP_LIMIT }))
        .find((entry) => entry.id === sessionId);
      if (stored === undefined) {
        throw new HostError(404, `no stored session with id ${sessionId}`);
      }
      const manager = SessionManager.open(stored.path);
      const identity = readModuleAgentEntry(manager);
      if (identity?.agentId !== agentId || identity?.workspaceKey !== workspaceKey || !identity.profileRevision) {
        throw new HostError(409, '会话身份不匹配，不能恢复');
      }
      const original = await snapshots.read(identity.profileRevision);
      const historicalCwd = original.effectiveWorkspace ?? stored.cwd;
      if (assertedCwd !== undefined && await codesWorkspace(historicalCwd) !== assertedCwd) {
        throw new HostError(409, '会话属于其他项目目录');
      }
      if (agentId === 'codes' && await codesWorkspace(manager.getHeader()?.cwd) !== await codesWorkspace(historicalCwd)) {
        throw new HostError(409, '会话记录的项目目录不匹配');
      }
      const release = await claim(agentId, historicalCwd);
      try {
        const assembled = await assemble(agentId, original, stored.cwd);
        try {
          return await host.create({
            sessionPath: stored.path,
            cwd: stored.cwd,
            moduleAgent: assembled,
          });
        } catch (error) {
          // 装配已建立 MCP 连接但 create 失败：连接不能被遗弃。
          await assembled.dispose().catch(() => undefined);
          throw error;
        }
      } finally {
        release();
      }
    }
    const currentCwd = effectiveWorkspace(profile);
    if (assertedCwd !== undefined && await codesWorkspace(currentCwd) !== assertedCwd) {
      throw new HostError(409, '项目目录与 Agent 配置的工作区不一致');
    }
    const release = await claim(agentId, currentCwd);
    try {
      await snapshots.save(profile);
      const assembled = await assemble(agentId, profile);
      try {
        return await host.create({ moduleAgent: assembled });
      } catch (error) {
        await assembled.dispose().catch(() => undefined);
        throw error;
      }
    } finally {
      release();
    }
  }

  /** 装配收敛到 assemble.ts：领域工具按配置 tools 过滤后才进会话。 */
  async function assemble(agentId: AgentId, profile: ResolvedAgentProfile, legacyStoredCwd?: string) {
    return assembleModuleAgent({ store, workspaceKey, agentId, profile,
      workspaceDir: profile.effectiveWorkspace ?? legacyStoredCwd,
      dataSourceRegistry: deps.dataSourceRegistry });
  }

  async function available(agentId: AgentId, directory: string): Promise<void> {
    try {
      await assertWorkspaceAvailable(agentId, directory, profiles,
        [...host.sessions.values()].filter(item => item.moduleAgent).map(item => ({
          agentId: item.moduleAgent!.agentId, cwd: item.cwd,
        })));
    } catch (error) {
      if (error instanceof WorkspaceError) throw new HostError(409, error.message);
      throw error;
    }
  }

  async function claim(agentId: AgentId, directory: string): Promise<() => void> {
    await available(agentId, directory);
    const canonical = await canonicalWorkspacePath(directory);
    // No await between checking and publishing the claim: concurrent restores serialize here.
    for (const hosted of host.sessions.values()) {
      if (hosted.moduleAgent?.agentId !== undefined && hosted.moduleAgent.agentId !== agentId
        && workspacePathsOverlap(canonical, hosted.cwd)) {
        throw new HostError(409, `工作区与运行中的模块 Agent「${hosted.moduleAgent.agentId}」重叠`);
      }
    }
    for (const [otherId, result] of profiles) {
      if (otherId !== agentId && result.ok && workspacePathsOverlap(canonical, effectiveWorkspace(result.profile))) {
        throw new HostError(409, `工作区与模块 Agent「${otherId}」的目录重叠`);
      }
    }
    for (const held of workspaceClaims.values()) {
      if (held.agentId !== agentId && workspacePathsOverlap(canonical, held.path)) {
        throw new HostError(409, `工作区与正在创建的模块 Agent「${held.agentId}」重叠`);
      }
    }
    const token = Symbol();
    workspaceClaims.set(token, { agentId, path: canonical });
    return () => { workspaceClaims.delete(token); };
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
