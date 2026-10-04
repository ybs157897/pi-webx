/**
 * 会话组装：`create`（新会话 / 恢复）、`fork`（分叉转写）、`resetInPlace`（原位重置）
 * 三条装配线，外加它们共用的资源加载器构建助手。
 *
 * 装配线的一致形状：预留容量 → 解析模型与设置 → 组装 loader（team 隔离 / 主会话
 * 追加内置提示词）→ `createAgentSession` → 挂事件、绑扩展、刷工具面 → 入住 host。
 * 失败路径统一回收：会话 dispose、容量释放、孤儿团队丢弃、挂起的扩展弹窗全部
 * 以取消收尾。
 */
import { rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type ToolDefinition,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
} from '@earendil-works/pi-coding-agent';
import { MAIN_IDENTITY_PROMPT, WORKBENCH_PROMPT } from '../prompts/loader';
import { SessionJournal, PromptRequests } from './session-journal';
import { createIsolatedToolDefinitions, TeamSandboxUnavailableError } from '../agent-team/sandbox-tools';
import { ensureWindowsAppContainerVerified } from '../agent-team/windows-appcontainer';
import {
  cancelWorkersFor,
  deliverTeamInbox,
  hydrateTeams,
  refreshSubagentTool,
} from './host-teams';
import { skillsPrompt } from '../module-agents/resources';
import { boundSessionWorkspace } from '../module-agents/workspace';
import {
  MAX_SESSIONS,
  errorText,
  type CreateHostedSessionOptions,
  type HostedSession,
  type HostInternals,
} from './host-contract';
import { HostError } from './host-contract';

/** 模块 Agent 身份在会话日志里的自定义条目类型（版本化，恢复时按它核对）。 */
export const MODULE_AGENT_ENTRY_TYPE = 'pi-webx:module-agent';

interface ModuleAgentEntryData {
  agentId?: string;
  workspaceKey?: string;
  profileRevision?: string;
}

/** 会话日志里最新一条模块 Agent 身份条目；没有则该日志属于普通会话。 */
export function readModuleAgentEntry(
  sessionManager: Pick<SessionManager, 'getEntries'>,
): ModuleAgentEntryData | undefined {
  let entries: readonly unknown[] = [];
  try {
    entries = sessionManager.getEntries() as unknown as readonly unknown[];
  } catch {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (entry === undefined || entry.type !== 'custom' || entry.customType !== MODULE_AGENT_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data as Record<string, unknown> | undefined;
    if (data === undefined || data.version !== 1) continue;
    return {
      agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
      workspaceKey: typeof data.workspaceKey === 'string' ? data.workspaceKey : undefined,
      profileRevision: typeof data.profileRevision === 'string' ? data.profileRevision : undefined,
    };
  }
  return undefined;
}

/**
 * 一对资源加载器：team 会话用隔离加载器（无扩展），普通会话的加载器把内置身份段
 * 与工作台感知段追加进系统提示词（用户级 APPEND_SYSTEM.md 经 base 原样保留在后）。
 */
function buildSessionLoaders(
  cwd: string,
  agentDir: string,
  settings: { settingsManager?: SettingsManager },
  teamMode: boolean,
): {
  teamSettings: SettingsManager | undefined;
  teamLoader: DefaultResourceLoader | undefined;
  mainLoader: DefaultResourceLoader | undefined;
} {
  const teamSettings = teamMode
    ? settings.settingsManager ?? SettingsManager.create(cwd, agentDir)
    : undefined;
  const teamLoader = teamSettings === undefined ? undefined : new DefaultResourceLoader({
    cwd, agentDir, settingsManager: teamSettings, noExtensions: true,
  });
  const mainLoader = teamMode ? undefined : new DefaultResourceLoader({
    cwd, agentDir,
    ...(settings.settingsManager !== undefined ? { settingsManager: settings.settingsManager } : {}),
    appendSystemPromptOverride: (base) => [MAIN_IDENTITY_PROMPT, WORKBENCH_PROMPT, ...base],
  });
  // reload 由调用方 await（create / resetInPlace 各自控制装配节奏）。
  return { teamSettings, teamLoader, mainLoader };
}

/**
 * 新建或恢复一个托管会话。团队恢复的规则：resume 一个 team 模式会话时重新挂载
 * journal 里的原团队，而不是另铸一个把任务板藏起来。
 */
export async function createHostedSession(
  host: HostInternals,
  options: CreateHostedSessionOptions = {},
): Promise<HostedSession> {
  if (host.closing) throw new HostError(503, 'host is closing');
  const reservation = host.sessionCapacity.reserve();
  if (reservation === undefined) throw new HostError(429, `session limit reached (${MAX_SESSIONS})`);
  let createdSession: AgentSession | undefined;
  let createdHost: HostedSession | undefined;
  let createdTeamId: string | null = null;
  try {
    const moduleAgent = options.moduleAgent;
    let cwd: string;
    if (moduleAgent === undefined) cwd = options.cwd ?? process.cwd();
    else {
      try {
        cwd = await boundSessionWorkspace(moduleAgent.profile, options.sessionPath ? options.cwd : undefined);
      } catch (error) {
        throw new HostError(503, error instanceof Error ? error.message : '模块工作区不可用');
      }
      if (moduleAgent.scope.agentId === 'codes' && options.cwd !== undefined) {
        if (!path.isAbsolute(options.cwd) || options.cwd.includes('\0')) throw new HostError(400, '代码 Agent 需要绝对路径的项目目录');
        let requested: string;
        try { requested = await realpath(options.cwd); }
        catch { throw new HostError(400, '项目目录不存在或不可访问'); }
        if (requested !== cwd) throw new HostError(409, '项目目录与 Agent 工作区不一致');
      }
    }
    if (moduleAgent !== undefined && options.teamMode === true) {
      throw new HostError(400, '模块 Agent 会话不支持团队模式');
    }
    // Before the model is resolved, so a config edited since the last session is
    // what this one is built from.
    await host.syncModelConfig();
    const runtime = await host.runtime();

    let model: Model<any> | undefined;
    const moduleModel = moduleAgent?.profile.config.model;
    const modelSpec = options.provider !== undefined && options.model !== undefined
      ? { provider: options.provider, id: options.model }
      : moduleModel;
    if (modelSpec !== undefined) {
      const resolved = resolveCliModel({
        cliModel: `${modelSpec.provider}/${modelSpec.id}`,
        modelRuntime: runtime,
      });
      if (resolved.error) throw new HostError(400, resolved.error);
      model = resolved.model;
    }

    const sessionManager = options.sessionPath
      ? SessionManager.open(options.sessionPath, host.sessionDir, cwd)
      : options.noSession
        ? SessionManager.inMemory(cwd)
        : SessionManager.create(cwd, host.sessionDir);
    if (moduleAgent?.scope.agentId === 'codes' && options.sessionPath !== undefined) {
      const recordedCwd = sessionManager.getHeader()?.cwd;
      if (typeof recordedCwd !== 'string' || !path.isAbsolute(recordedCwd)) {
        throw new HostError(409, '会话记录缺少有效项目目录');
      }
      let canonicalRecorded: string;
      try { canonicalRecorded = await realpath(recordedCwd); }
      catch { throw new HostError(409, '会话记录的项目目录不可用'); }
      if (canonicalRecorded !== cwd) throw new HostError(409, '会话记录的项目目录不匹配');
    }

    const hostedId = sessionManager.getSessionId();
    /**
     * 恢复路径的身份核对在会话创建之前：普通入口不许接管模块会话，模块入口
     * 也不许接管身份不符的会话——两个方向都靠日志里的条目说话。
     */
    const moduleEntry = options.sessionPath === undefined
      ? undefined
      : readModuleAgentEntry(sessionManager);
    if (moduleEntry !== undefined && moduleAgent === undefined) {
      throw new HostError(409, '该会话属于模块 Agent，请从模块入口恢复');
    }
    if (moduleAgent !== undefined && options.sessionPath !== undefined) {
      if (moduleEntry === undefined) throw new HostError(409, '该会话不是模块 Agent 会话');
      if (
        moduleEntry.agentId !== moduleAgent.scope.agentId
        || moduleEntry.workspaceKey !== moduleAgent.scope.workspaceKey
      ) {
        throw new HostError(409, '会话身份与模块 Agent 不一致');
      }
      if (moduleEntry.profileRevision !== moduleAgent.scope.profileRevision) {
        throw new HostError(409, '必须使用原会话配置快照恢复，请从模块入口打开');
      }
    }
    if (options.teamMode === true || options.sessionPath !== undefined) await hydrateTeams(host);
    const previousTeamId = options.sessionPath === undefined || moduleAgent !== undefined
      ? undefined
      : host.teams.findTeamByParentSession(hostedId);
    const teamMode = moduleAgent === undefined
      && (options.teamMode === true || previousTeamId !== undefined);
    const agentDir = getAgentDir();
    const settings = host.settingsOption(cwd);
    /**
     * 模块会话关闭默认资源发现；项目指令仅来自装配时校验过的绑定根目录。
     * 提示词与 Skills 由 profile 提供，不加载主会话或全局配置。
     */
    const moduleLoader = moduleAgent === undefined ? undefined : new DefaultResourceLoader({
      cwd, agentDir,
      ...(settings.settingsManager !== undefined ? { settingsManager: settings.settingsManager } : {}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      agentsFilesOverride: () => ({ agentsFiles: moduleAgent.projectContextFiles ?? [] }),
      systemPromptOverride: () => moduleAgent.profile.promptText,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      appendSystemPromptOverride: () => [
        skillsPrompt(moduleAgent.profile.skills),
        ...moduleAgent.systemPromptAppend,
      ],
    });
    const { teamSettings, teamLoader, mainLoader } = moduleAgent === undefined
      ? buildSessionLoaders(cwd, agentDir, settings, teamMode)
      : { teamSettings: undefined, teamLoader: undefined, mainLoader: undefined };
    await teamLoader?.reload();
    await mainLoader?.reload();
    await moduleLoader?.reload();
    if (teamMode && process.platform === 'win32') await ensureWindowsAppContainerVerified(cwd, agentDir);

    // The SDK keeps this exact array, so the dispatch tool is added and removed
    // by splicing its contents — never by replacing the array (see
    // `refreshSubagentTool`).
    const customTools: ToolDefinition[] = moduleAgent !== undefined
      ? moduleAgent.customTools
      : teamMode ? createIsolatedToolDefinitions(cwd, agentDir) : [];
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      ...(model ? { model } : {}),
      ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
      modelRuntime: runtime,
      sessionManager,
      customTools,
      /**
       * `tools` 是 SDK 的全量白名单（customTools 也受其过滤），所以模块会话必须
       * 把自己的领域工具名一并列入，allowedToolNames 只决定内置工具子集。
       */
      ...(moduleAgent !== undefined
        ? { tools: [...new Set([...moduleAgent.customTools.map((tool) => tool.name), ...moduleAgent.allowedToolNames])] }
        : {}),
      ...(moduleLoader !== undefined
        ? { ...settings, resourceLoader: moduleLoader }
        : teamLoader === undefined
          ? { ...settings, ...(mainLoader !== undefined ? { resourceLoader: mainLoader } : {}) }
          : { settingsManager: teamSettings, resourceLoader: teamLoader }),
    });
    // 身份先于首次模型调用落地：会话日志是模块归属的事实源。
    if (moduleAgent !== undefined && moduleEntry === undefined) {
      sessionManager.appendCustomEntry(MODULE_AGENT_ENTRY_TYPE, {
        version: 1,
        agentId: moduleAgent.scope.agentId,
        workspaceKey: moduleAgent.scope.workspaceKey,
        profileRevision: moduleAgent.scope.profileRevision,
      });
    }

    createdSession = session;
    if (options.name) session.setSessionName(options.name);
    const hosted: HostedSession = {
      reservation,
      /**
       * 会话的身份用 **pi 自己写进会话文件的那个 id**，不再另铸一个。
       *
       * 以前这里是 `crypto.randomUUID()`：桥接层的 id 与文件里的 id 毫无关系，
       * 于是服务端一重启，`?session=<桥接 id>` 就再也对不上任何东西——磁盘上的
       * 对话明明还在，界面却只能说「这堂课已结束」。同一个 id 之后，「按 id
       * 恢复」才有东西可查（见 routes 里的 `findStoredSessionById`）。
       */
      id: hostedId,
      cwd,
      createdAt: Date.now(),
      resumed: Boolean(options.sessionPath),
      alive: true,
      streaming: false,
      queue: [],
      sessionFile: session.sessionFile ?? null,
      sessionName: options.name ?? null,
      session,
      extensionsResult,
      customTools,
      ...(moduleAgent === undefined
        ? {}
        : {
            moduleAgentMaxRunning: moduleAgent.profile.config.limits.maxRunningSessions,
            moduleAgent: {
              agentId: moduleAgent.scope.agentId,
              workspaceKey: moduleAgent.scope.workspaceKey,
              sessionId: hostedId,
              profileRevision: moduleAgent.scope.profileRevision,
            },
          }),
      teamId: null,
      teamMode,
      ...(moduleAgent?.dispose === undefined ? {} : { dispose: moduleAgent.dispose }),
      pendingDialogs: new Map(),
      toolSelection: options.toolNames ?? null,
      journal: new SessionJournal(),
      promptRequests: new PromptRequests(),
      subscribers: new Set(),
      unsubscribe: null,
      lastSeen: Date.now(),
    };

    createdHost = hosted;
    // A stored Team belongs to this exact conversation. Reattach it on resume
    // instead of creating a second team and hiding the journal's task board.
    // The Team must exist before refreshSubagentTool chooses its tool surface.
    if (hosted.teamMode) {
      hosted.teamId = previousTeamId ?? host.teams.createTeam(hosted.id).id;
      if (previousTeamId === undefined) createdTeamId = hosted.teamId;
    }
    hosted.unsubscribe = session.subscribe((event) => host.onEvent(hosted, event));
    if (moduleAgent === undefined) {
      host.applyInitialToolSelection(hosted, sessionManager, options.toolNames);
    }
    await host.bindExtensions(session, hosted);
    if (moduleAgent === undefined) await refreshSubagentTool(host, hosted);
    if (host.closing) throw new HostError(503, 'host closed during session initialization');
    if (host.sessions.has(hosted.id)) throw new HostError(409, 'session is already hosted');
    host.sessions.set(hosted.id, hosted);
    if (previousTeamId !== undefined) void deliverTeamInbox(host, previousTeamId);
    return hosted;
  } catch (error) {
    if (createdHost !== undefined) {
      createdHost.alive = false;
      createdHost.unsubscribe?.();
      // A team created for a session that never finished coming up would linger
      // in memory as an orphan: nothing else can reach it, so drop it here.
      // (A fork never has one, so this is a no-op on that path.)
      if (createdTeamId !== null) host.teams.dropTeam(createdTeamId);
      for (const dialog of createdHost.pendingDialogs.values()) {
        dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
      }
    }
    // 装配期建立的外部资源（MCP 连接）随创建失败一并回收。
    try { await options.moduleAgent?.dispose?.(); } catch { /* best-effort */ }
    try { createdSession?.dispose(); }
    finally { reservation.release(); }
    if (error instanceof TeamSandboxUnavailableError) {
      throw new HostError(error.status, error.message);
    }
    throw error;
  }
}

/**
 * Copy a transcript into a new session and host it — dsh's `分叉会话`.
 *
 * `SessionManager.forkFrom` is pi's own implementation of the same idea: it
 * writes a new session file whose header names the source as `parentSession`,
 * so the fork is a real session the CLI can also open, not a private view.
 * The new session starts on the deployment default model rather than the
 * source's — dsh's fork takes the default the same way, because the copied
 * prefix is history the next model reads, not a route it is bound to.
 */
export async function forkHostedSession(
  host: HostInternals,
  options: { source: string; cwd?: string },
): Promise<HostedSession> {
  if (host.closing) throw new HostError(503, 'host is closing');
  const reservation = host.sessionCapacity.reserve();
  if (reservation === undefined) throw new HostError(429, `session limit reached (${MAX_SESSIONS})`);
  let createdSession: AgentSession | undefined;
  let createdHost: HostedSession | undefined;
  try {
    const cwd = options.cwd ?? process.cwd();
    const runtime = await host.runtime();

    let sessionManager: SessionManager;
    try {
      sessionManager = SessionManager.forkFrom(options.source, cwd, host.sessionDir);
    } catch (error) {
      throw new HostError(400, `无法分叉该会话：${errorText(error)}`);
    }
    if (readModuleAgentEntry(sessionManager) !== undefined) {
      // forkFrom 已把新文件写好：拒绝前把这个没人会引用的孤儿删掉。
      const forkedFile = sessionManager.getSessionFile();
      if (forkedFile !== undefined) rmSync(forkedFile, { force: true });
      throw new HostError(400, '模块 Agent 会话暂不支持分叉');
    }

    const customTools: ToolDefinition[] = [];
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      modelRuntime: runtime,
      sessionManager,
      customTools,
      ...host.settingsOption(cwd),
    });

    createdSession = session;
    const hosted: HostedSession = {
      reservation,
      // Same identity rule as `create`: the bridge's id is pi's session id, so a
      // URL that carries only the id can be resolved back to a session file.
      id: sessionManager.getSessionId(),
      cwd,
      createdAt: Date.now(),
      resumed: false,
      alive: true,
      streaming: false,
      queue: [],
      sessionFile: session.sessionFile ?? null,
      sessionName: null,
      session,
      extensionsResult,
      customTools,
      // A fork is never a Team: it copies a transcript, and a team is runtime
      // state the source session's log says nothing about.
      teamId: null,
      teamMode: false,
      pendingDialogs: new Map(),
      // A fork keeps pi's default tool set until someone chooses otherwise; the
      // source session's selection describes that session, not this one.
      toolSelection: null,
      journal: new SessionJournal(),
      promptRequests: new PromptRequests(),
      subscribers: new Set(),
      unsubscribe: null,
      lastSeen: Date.now(),
    };

    createdHost = hosted;
    hosted.unsubscribe = session.subscribe((event) => host.onEvent(hosted, event));
    await host.bindExtensions(session, hosted);
    await refreshSubagentTool(host, hosted);
    if (host.closing) throw new HostError(503, 'host closed during session initialization');
    if (host.sessions.has(hosted.id)) throw new HostError(409, 'session is already hosted');
    host.sessions.set(hosted.id, hosted);
    return hosted;
  } catch (error) {
    if (createdHost !== undefined) {
      createdHost.alive = false;
      createdHost.unsubscribe?.();
      // A team created for a session that never finished coming up would linger
      // in memory as an orphan: nothing else can reach it, so drop it here.
      // (A fork never has one, so this is a no-op on that path.)
      if (createdHost.teamId !== null) host.teams.dropTeam(createdHost.teamId);
      for (const dialog of createdHost.pendingDialogs.values()) {
        dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
      }
    }
    try { createdSession?.dispose(); }
    finally { reservation.release(); }
    throw error;
  }
}

/**
 * 原位重置：同一托管会话换一个全新对话（pi 的 `new_session`）。
 *
 * 旧会话先停（abort → 取消 worker → 释放），团队随旧对话取消；team 模式保留
 * 模式本身并铸一个全新空团队。等待队列清空——旧行引用的是旧对话的消息。
 */
export async function resetInPlace(host: HostInternals, hosted: HostedSession): Promise<void> {
  if (hosted.moduleAgent !== undefined) {
    throw new HostError(400, '模块 Agent 会话请从模块入口新建');
  }
  hosted.alive = false;
  void hosted.session.abort().catch(() => undefined);
  hosted.queue = [];
  for (const dialog of hosted.pendingDialogs.values()) {
    dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
  }
  const cwd = hosted.cwd;
  const model = hosted.session.model;
  const thinking = hosted.session.thinkingLevel;
  const runtime = await host.runtime();

  // A worker outliving the conversation that started it would keep answering
  // into a transcript nobody reads; stop it before the old session goes away.
  await cancelWorkersFor(host, hosted.id);

  try {
    hosted.unsubscribe?.();
    hosted.session.dispose();
  } catch {
    // Recreate regardless.
  }

  const agentDir = getAgentDir();
  const settings = host.settingsOption(cwd);
  const { teamSettings, teamLoader, mainLoader } = buildSessionLoaders(cwd, agentDir, settings, hosted.teamMode);
  await teamLoader?.reload();
  await mainLoader?.reload();
  if (hosted.teamMode && process.platform === 'win32') await ensureWindowsAppContainerVerified(cwd, agentDir);
  const customTools: ToolDefinition[] = hosted.teamMode
    ? createIsolatedToolDefinitions(cwd, agentDir)
    : [];
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    ...(model ? { model } : {}),
    thinkingLevel: thinking,
    modelRuntime: runtime,
    sessionManager: SessionManager.create(cwd, host.sessionDir),
    customTools,
    ...(teamLoader === undefined
      ? { ...settings, ...(mainLoader !== undefined ? { resourceLoader: mainLoader } : {}) }
      : { settingsManager: teamSettings, resourceLoader: teamLoader }),
  });
  if (host.closing || host.sessions.get(hosted.id) !== hosted) {
    session.dispose();
    throw new HostError(409, 'session closed during reset');
  }
  if (hosted.sessionName) session.setSessionName(hosted.sessionName);

  hosted.session = session;
  hosted.extensionsResult = extensionsResult;
  hosted.customTools = customTools;
  hosted.sessionFile = session.sessionFile ?? null;
  hosted.streaming = false;
  hosted.alive = true;
  // A new conversation has no wait list: the rows named messages of the old one.
  hosted.queue = [];
  // A team belonged to the conversation that was just replaced: its members were
  // cancelled above, and its task board would otherwise describe work nobody can
  // address. Team mode keeps its mode and gets a fresh, empty team.
  if (hosted.teamId !== null) {
    host.teams.cancelTeam(hosted.teamId, '会话已重置。');
    host.teams.dropTeam(hosted.teamId);
    hosted.teamId = null;
  }
  if (hosted.teamMode) hosted.teamId = host.teams.createTeam(hosted.id).id;
  hosted.unsubscribe = session.subscribe((event) => host.onEvent(hosted, event));
  await host.bindExtensions(session, hosted);
  await refreshSubagentTool(host, hosted);
}
