import { SessionManager } from '@earendil-works/pi-coding-agent';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DataSourceRegistry } from '../data-sources/registry';
import type { PiHost } from '../pi/host';
import { HostError } from '../pi/host';
import { readModuleAgentEntry } from '../pi/host-session-assembly';
import { listStoredSessions } from '../stored-sessions';
import type { WorkbenchStore } from '../workbench/store';
import { assembleModuleAgent } from './assemble';
import type { AgentId, ProfileLoadResult, ResolvedAgentProfile } from './contracts';
import { ProfileSnapshots } from './snapshots';
import { findModuleSession, ModuleSessionIndex } from './session-index';
import { assertWorkspaceAvailable, canonicalWorkspacePath, effectiveWorkspace, WorkspaceError, workspacePathsOverlap } from './workspace';

export interface ModuleAgentSessionServiceDeps {
  host: PiHost;
  store: WorkbenchStore;
  profiles: Map<AgentId, ProfileLoadResult>;
  workspaceKey: string;
  dataSourceRegistry?: DataSourceRegistry;
  snapshots?: ProfileSnapshots;
  storedSessions?: typeof listStoredSessions;
}

export async function assertCodesWorkspace(value: unknown): Promise<string> {
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

/** One admission path for UI and room-driven module sessions. */
export class ModuleAgentSessionService {
  private readonly snapshots: ProfileSnapshots;
  private readonly index: ModuleSessionIndex;
  private readonly workspaceClaims = new Map<symbol, { agentId: AgentId; path: string }>();

  constructor(private readonly deps: ModuleAgentSessionServiceDeps) {
    this.snapshots = deps.snapshots ?? new ProfileSnapshots(path.join(path.dirname(deps.store.sqlite.name), 'module-agent-profiles'));
    this.index = new ModuleSessionIndex(deps.store, deps.workspaceKey);
  }

  async openOrCreate(agentId: AgentId, profile: ResolvedAgentProfile, sessionId?: string, assertedCwd?: string) {
    const { host, workspaceKey } = this.deps;
    if (sessionId !== undefined) {
      const hosted = host.get(sessionId);
      if (hosted !== undefined) {
        if (hosted.moduleAgent?.agentId !== agentId || hosted.moduleAgent?.workspaceKey !== workspaceKey) {
          throw new HostError(409, '会话不属于该模块 Agent');
        }
        if (assertedCwd !== undefined && await assertCodesWorkspace(hosted.cwd) !== assertedCwd) {
          throw new HostError(409, '会话属于其他项目目录');
        }
        await this.available(agentId, hosted.cwd);
        return this.index.remember(agentId, hosted);
      }
      const indexed = this.index.get(sessionId);
      if (indexed && indexed.agentId !== agentId) throw new HostError(409, '会话不属于该模块 Agent');
      const stored = indexed ?? (this.deps.storedSessions
        ? (await this.deps.storedSessions({ limit: 200 })).find(entry => entry.id === sessionId)
        : await findModuleSession(sessionId, host.sessionDir));
      if (stored === undefined) throw new HostError(404, `no stored session with id ${sessionId}`);
      try { await stat(stored.path); }
      catch { throw new HostError(404, `no stored session with id ${sessionId}`); }
      const manager = SessionManager.open(stored.path);
      if (manager.getSessionId() !== sessionId) throw new HostError(409, '会话索引与日志身份不匹配');
      const identity = readModuleAgentEntry(manager);
      if (identity?.agentId !== agentId || identity?.workspaceKey !== workspaceKey || !identity.profileRevision) {
        throw new HostError(409, '会话身份不匹配，不能恢复');
      }
      const original = await this.snapshots.read(identity.profileRevision);
      const historicalCwd = original.effectiveWorkspace ?? stored.cwd;
      if (assertedCwd !== undefined && await assertCodesWorkspace(historicalCwd) !== assertedCwd) {
        throw new HostError(409, '会话属于其他项目目录');
      }
      if (agentId === 'codes' && await assertCodesWorkspace(manager.getHeader()?.cwd) !== await assertCodesWorkspace(historicalCwd)) {
        throw new HostError(409, '会话记录的项目目录不匹配');
      }
      const release = await this.claim(agentId, historicalCwd);
      try {
        const assembled = await this.assemble(agentId, original, stored.cwd);
        try { return this.index.remember(agentId, await host.create({ sessionPath: stored.path, cwd: stored.cwd, moduleAgent: assembled })); }
        catch (error) { await assembled.dispose().catch(() => undefined); throw error; }
      } finally { release(); }
    }

    const currentCwd = effectiveWorkspace(profile);
    if (assertedCwd !== undefined && await assertCodesWorkspace(currentCwd) !== assertedCwd) {
      throw new HostError(409, '项目目录与 Agent 配置的工作区不一致');
    }
    const release = await this.claim(agentId, currentCwd);
    try {
      await this.snapshots.save(profile);
      const assembled = await this.assemble(agentId, profile);
      try { return this.index.remember(agentId, await host.create({ moduleAgent: assembled })); }
      catch (error) { await assembled.dispose().catch(() => undefined); throw error; }
    } finally { release(); }
  }

  private async assemble(agentId: AgentId, profile: ResolvedAgentProfile, legacyStoredCwd?: string) {
    const { store, workspaceKey, dataSourceRegistry } = this.deps;
    return assembleModuleAgent({ store, workspaceKey, agentId, profile,
      workspaceDir: profile.effectiveWorkspace ?? legacyStoredCwd, dataSourceRegistry });
  }

  private async available(agentId: AgentId, directory: string): Promise<void> {
    const { host, profiles } = this.deps;
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

  private async claim(agentId: AgentId, directory: string): Promise<() => void> {
    const { host, profiles } = this.deps;
    await this.available(agentId, directory);
    const canonical = await canonicalWorkspacePath(directory);
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
    for (const held of this.workspaceClaims.values()) {
      if (held.agentId !== agentId && workspacePathsOverlap(canonical, held.path)) {
        throw new HostError(409, `工作区与正在创建的模块 Agent「${held.agentId}」重叠`);
      }
    }
    const token = Symbol();
    this.workspaceClaims.set(token, { agentId, path: canonical });
    return () => { this.workspaceClaims.delete(token); };
  }
}

export function createModuleAgentSessionService(deps: ModuleAgentSessionServiceDeps): ModuleAgentSessionService {
  return new ModuleAgentSessionService(deps);
}
