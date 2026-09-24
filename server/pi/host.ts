/**
 * In-process session host: one `AgentSession` per hosted conversation, created
 * through the pi SDK (`createAgentSession`) — no subprocess, no PATH lookup.
 *
 * pi's own config dir (`~/.pi/agent`) supplies models.json, auth.json and
 * extensions, so everything configured elsewhere in this app keeps working.
 *
 * The outward surface deliberately mirrors the old subprocess bridge
 * (`POST /command` with pi's command vocabulary and `ServerFrame` SSE frames)
 * so the client needs no protocol changes.
 *
 * ## 按职责拆分（2026-09-24）
 *
 * 这个文件曾经是 2000+ 行的上帝类。现在 `PiHost` 只保留**状态持有**（会话表、
 * 模型运行时、团队运行时、容量）与**装配委托**，行为按职责住进了四个模块，全部
 * 通过 `HostInternals` 依赖面协作：
 *
 * - `host-contract.ts` — 导出类型、常量、纯工具与 `HostInternals` 接口；
 * - `host-events.ts` — 事件扇出与等待队列（broadcast / enqueue / flushQueue）；
 * - `host-teams.ts` — 团队运行时与子智能体工具面（hydrate / refresh / dispatch）；
 * - `host-commands.ts` — 浏览器命令分发（幂等闸门 + dispatch switch + 状态投影）；
 * - `host-session-assembly.ts` — 三条装配线（create / fork / resetInPlace）与
 *   资源加载器构建。
 *
 * `@internal` 标注的成员是拆分模块的依赖面：同一包内协作用，不构成对外 API。
 * 对外 API（本文件的公开方法与再导出的类型）与拆分前完全一致。
 */

import { join } from 'node:path';

import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  ModelRuntime,
  getAgentDir,
  resolveCliModel,
} from '@earendil-works/pi-coding-agent';
import type {
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiCommandEnvelope,
  PiRpcResponse,
  SessionSummary,
} from '../../src/shared/protocol';
import { TEAM_INTERRUPT_REASONS } from '../agent-team/team-types';
import { createExtensionUiScope } from './extension-ui';
import { appendToolSelection, readToolSelection, withExtensionTools } from '../tool-selection';
import { agentDefinitionsStore, type AgentDefinitionStore } from '../agent-definitions';
import { MAX_WORKERS, SubagentCapacity } from './subagent-capacity';
import { SessionCapacity } from './session-capacity';
import { createSubagentWorkerDispatch, type SubagentWorkerRunner } from './subagent-worker';
import { AgentTeamRuntime } from '../agent-team/team-runtime';
import { TeamJournal } from '../agent-team/team-journal';
import { TeamInjector } from '../agent-team/team-inject';
import {
  cancelTeam as cancelTeamOp,
  cancelWorkersFor as cancelWorkersOp,
  deliverTeamInbox as deliverTeamInboxOp,
  hydrateTeams as hydrateTeamsOp,
  liveTeamSession as liveTeamSessionOp,
  resolveTeamId as resolveTeamIdOp,
  teamSnapshot as teamSnapshotOp,
} from './host-teams';
import {
  broadcast as broadcastFrame,
  broadcastError,
  onEvent as onEventOp,
} from './host-events';
import { handleCommand } from './host-commands';
import { createHostedSession, forkHostedSession } from './host-session-assembly';
import {
  MAX_SESSIONS,
  SWEEP_AFTER_MS,
  asModel,
  errorText,
  fileStamp,
  type HostInternals,
  type HostSubscriber,
  type HostedSession,
  type CreateHostedSessionOptions,
  type PiHostOptions,
} from './host-contract';

export {
  type CreateHostedSessionOptions,
  type HostSubscriber,
  type HostedSession,
  type PiHostOptions,
  type QueuedPrompt,
  HostError,
} from './host-contract';

export class PiHost implements HostInternals {
  private modelRuntime: ModelRuntime | null = null;
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;
  /**
   * The file the runtime loads models from, and its stamp at the last load.
   *
   * `ModelRuntime.create()` reads models.json once and keeps the result; nothing
   * in pi watches the file. So a config edited by anything other than this app —
   * the user in an editor, the `pi` CLI, a script — was invisible until the
   * process restarted: sessions reported the old `contextWindow` and the model
   * picker offered the old catalogue. `syncModelConfig` is the way back to the
   * file, and these two fields are how it knows whether it has to. The path is
   * derived from pi's own `getAgentDir()` rather than hardcoded, so an agent dir
   * moved by `PI_AGENT_DIR` is followed rather than missed.
   */
  private readonly modelsPath = join(getAgentDir(), 'models.json');
  private configStamp: string | null = null;
  /** @internal 会话表：命令分发、团队解析、事件扇出都以它为真相源。 */
  readonly sessions = new Map<string, HostedSession>();
  private readonly sweeper: NodeJS.Timeout;
  /**
   * Live worker slots. Every dispatch reserves here before it can start a
   * session, and workers count against the same session budget as hosted
   * conversations — a worker is a real agent session, not a free one.
   */
  private readonly capacity: SubagentCapacity;
  /** @internal 会话容量（create / fork 预留；sweep 用 capacity 判断 worker 占用）。 */
  readonly sessionCapacity = new SessionCapacity(MAX_SESSIONS);
  /**
   * Every Agent Team this process orchestrates, keyed by team id.
   *
   * Live state is memory; the **append-only journal** below is what lets a restart
   * rebuild it (P3-A). The journal is written as state changes, so a restart sees
   * every change that had already happened — see `team-journal.ts` for the honest
   * scope of that promise (append, no fsync).
   */
  /** @internal */ readonly journal: TeamJournal;
  /** @internal */ readonly teams: AgentTeamRuntime;
  /**
   * P3-B delivery: hands pending inbox items to the live orchestrator session.
   *
   * Constructed with a lookup, not the session table itself, so the injector stays
   * a policy module with one dependency it can be tested against.
   */
  /** @internal */ readonly teamInjector: TeamInjector;
  /** @internal 关机标记：create/fork 在装配中也会检查，半途拒绝新会话。 */
  closing = false;
  /** @internal */ readonly workerRunner: SubagentWorkerRunner;
  /** @internal */ readonly definitions: Pick<AgentDefinitionStore, 'read'>;
  private readonly modelRuntimeFactory: () => Promise<ModelRuntime>;
  /** @internal */ readonly sessionDir: string | undefined;
  private readonly settingsManagerFactory: ((cwd: string) => SettingsManager) | undefined;

  constructor(options: PiHostOptions = {}) {
    this.definitions = options.definitions ?? agentDefinitionsStore;
    this.modelRuntimeFactory = options.modelRuntimeFactory ?? (() => ModelRuntime.create());
    this.sessionDir = options.sessionDir;
    this.settingsManagerFactory = options.settingsManagerFactory;
    this.journal = new TeamJournal({
      dir: options.teamJournalDir ?? join(getAgentDir(), 'pi-webx', 'teams'),
    });
    this.teams = new AgentTeamRuntime({
      journal: this.journal,
      // The inbox has one birth point; observing it is what makes injection happen
      // for both a member's out-of-band message and a settle result, without a tool
      // having to cooperate.
      onInboxItem: (message) => { void deliverTeamInboxOp(this, message.teamId); },
    });
    this.teamInjector = new TeamInjector({
      runtime: this.teams,
      liveSession: (teamId) => liveTeamSessionOp(this, teamId),
    });
    this.capacity = new SubagentCapacity({
      maxWorkers: MAX_WORKERS,
      budget: this.sessionCapacity,
    });
    this.workerRunner = createSubagentWorkerDispatch({
      modelRuntime: () => this.runtime(),
      capacity: this.capacity,
    });
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** @internal 惰性共享模型运行时（装配线与命令分发共用）。 */
  runtime(): Promise<ModelRuntime> {
    if (this.modelRuntime) return Promise.resolve(this.modelRuntime);
    this.modelRuntimePromise ??= (async () => {
      const runtime = await this.modelRuntimeFactory();
      this.modelRuntime = runtime;
      // Stamped at load, so the first freshness check is a stat rather than a
      // second reload of a file that was just read.
      this.configStamp = await fileStamp(this.modelsPath);
      return runtime;
    })();
    return this.modelRuntimePromise;
  }

  /**
   * Extra `createAgentSession` options for this host.
   *
   * Empty by default, which is exactly the product behaviour: pi builds its own
   * file-backed settings manager. A test injects an in-memory one so nothing a
   * session does can rewrite the user's defaults.
   */
  /** @internal */
  settingsOption(cwd: string): { settingsManager?: SettingsManager } {
    return this.settingsManagerFactory === undefined
      ? {}
      : { settingsManager: this.settingsManagerFactory(cwd) };
  }

  /**
   * Re-read models.json if it changed on disk, and carry the change into the
   * sessions that are already open.
   *
   * Callers are the points where a stale answer is visible: creating a session,
   * reading the catalogue, and reading a session's stats (which is where the
   * context-window percentage comes from). A `stat` that reports no change costs
   * nothing, so this can sit on a hot path; the reload only happens once per
   * actual edit. Returns true when a reload happened.
   *
   * Deliberately not an `fs.watch`: a request-scoped check cannot miss an event,
   * needs no lifecycle of its own, and survives the atomic-rename save that
   * editors do (which silently detaches a watch on the file inode).
   */
  async syncModelConfig(force = false): Promise<boolean> {
    const runtime = await this.runtime();
    const stamp = await fileStamp(this.modelsPath);
    if (!force && stamp === this.configStamp) return false;
    this.configStamp = stamp;
    // Local re-read: a file edit is not a request to refetch catalogues over the
    // network, and this bridge does not do that to the user.
    await runtime.refresh({ allowNetwork: false });
    await this.readoptSessions(runtime);
    return true;
  }

  /**
   * Re-point open sessions at their own model as the config now describes it.
   *
   * A session holds the model object it was created with, so a corrected
   * `contextWindow` reached new sessions only: the open one kept reporting the
   * old window, which is the number the composer's percentage and pi's own
   * compaction threshold are both computed from. Only sessions whose model
   * actually changed are touched, and a model the new config no longer offers is
   * left alone — a running session must not be broken by an edit to a file.
   */
  private async readoptSessions(runtime: ModelRuntime): Promise<void> {
    for (const hosted of this.sessions.values()) {
      const current = hosted.session.model;
      if (!current) continue;
      try {
        const resolved = resolveCliModel({
          cliModel: `${current.provider}/${current.id}`,
          modelRuntime: runtime,
        });
        if (resolved.error || !resolved.model) continue;
        if (JSON.stringify(resolved.model) === JSON.stringify(current)) continue;
        await hosted.session.setModel(resolved.model);
      } catch {
        // Best effort: a session that could not be re-adopted keeps working with
        // the model it has, which is what it was doing a moment ago.
      }
    }
  }

  /**
   * The shared model runtime, for readers that must not touch a session.
   *
   * The picker's catalog is built from this object rather than from a live
   * session's `get_available_models`, so it reads the same registry the
   * sessions resolve against while needing no session to exist.
   */
  getModelRuntime(): Promise<ModelRuntime> {
    return this.runtime();
  }

  /* ----------------------------------------------------------------- create */

  create(options: CreateHostedSessionOptions = {}): Promise<HostedSession> {
    return createHostedSession(this, options);
  }

  /* --------------------------------------------------------- tool selection */

  /**
   * Put a session's tools where they belong, pi-web's way.
   *
   * A resumed session's own log decides: the newest `pi-webx:tool-selection` entry
   * records what it was last run with, and a client preset cannot know that. A
   * session with no such entry takes the client's preset and records it, so the
   * choice survives the next reload. A session with neither keeps pi's own default
   * tool set — the browser may simply not have sent one.
   */
  /** @internal */
  applyInitialToolSelection(
    hosted: HostedSession,
    sessionManager: SessionManager,
    requested: readonly string[] | undefined,
  ): void {
    let entries: readonly unknown[] = [];
    try {
      entries = sessionManager.getEntries() as unknown as readonly unknown[];
    } catch {
      entries = [];
    }
    const persisted = readToolSelection(entries);
    if (persisted !== undefined) {
      this.setToolSelection(hosted, persisted, { persist: false });
      return;
    }
    if (requested === undefined) return;
    this.setToolSelection(hosted, requested, { persist: true });
  }

  /**
   * Apply one tool selection and, unless it came from the log, record it.
   *
   * `withExtensionTools` is the part that matters: a preset chooses builtin tools
   * only, and everything an extension registered stays enabled. pi's
   * `setActiveToolsByName` adopts the given set exactly, so skipping the merge
   * would silently switch off extension tools on any preset change.
   */
  /** @internal */
  setToolSelection(
    hosted: HostedSession,
    toolNames: readonly string[],
    options: { persist: boolean },
  ): void {
    const defaultTools = hosted.teamMode && process.platform === 'win32'
      ? ['powershell']
      : hosted.session.settingsManager?.getDefaultTools?.();
    const resolved = withExtensionTools(hosted.session, toolNames, defaultTools);
    hosted.session.setActiveToolsByName(resolved);
    hosted.toolSelection = [...toolNames];
    if (!options.persist) return;
    try {
      appendToolSelection(hosted.session.sessionManager, toolNames);
    } catch (error) {
      broadcastError(this, hosted, `工具选择未能写入会话记录：${errorText(error)}`);
    }
  }

  /* ------------------------------------------------ subagent / team delegates */

  /** @internal Stop every worker this parent owns and wait until each has cleaned up. */
  cancelWorkersFor(parentId: string): Promise<void> {
    return cancelWorkersOp(this, parentId);
  }

  hydrateTeams(): ReturnType<typeof hydrateTeamsOp> {
    return hydrateTeamsOp(this);
  }

  /** Where the Team journal lives; surfaced for operators and tests. */
  get teamJournalDir(): string {
    return this.journal.directory;
  }

  resolveTeamId(idOrSessionId: string): string | undefined {
    return resolveTeamIdOp(this, idOrSessionId);
  }

  teamSnapshot(idOrSessionId: string): ReturnType<typeof teamSnapshotOp> {
    return teamSnapshotOp(this, idOrSessionId);
  }

  cancelTeam(idOrSessionId: string, reason?: string): ReturnType<typeof cancelTeamOp> {
    return cancelTeamOp(this, idOrSessionId, reason);
  }

  /* ------------------------------------------------------------------ fork */

  fork(options: { source: string; cwd?: string }): Promise<HostedSession> {
    return forkHostedSession(this, options);
  }

  /* --------------------------------------------------- extension UI bridge */

  /**
   * Bind browser interactions; session replacement remains owned by PiHost.
   *
   * A session without extension bindings still runs; only extension UI and
   * extension commands are lost, so a bind failure is reported, not fatal.
   */
  /** @internal */
  bindExtensions(session: AgentSession, hosted: HostedSession): Promise<void> {
    const refused = (action: string) => async (): Promise<never> => {
      throw new Error(`此宿主不支持扩展命令的 ${action}（会话身份由 pi-webx 管理）`);
    };
    return session.bindExtensions({
      uiContext: this.uiContextFor(hosted),
      mode: 'rpc',
      abortHandler: () => {
        void session.abort();
      },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        reload: () => session.waitForIdle(),
        newSession: refused('newSession'),
        fork: refused('fork'),
        navigateTree: refused('navigateTree'),
        switchSession: refused('switchSession'),
      },
    }).catch((error: unknown) => {
      broadcastError(this, hosted, `扩展绑定失败：${errorText(error)}`);
    });
  }

  /** UI transport receives only this parent's dialog store and event publisher. */
  /** @internal */
  extensionUiOwner(hosted: HostedSession) {
    return {
      pendingDialogs: hosted.pendingDialogs,
      isAlive: () => hosted.alive,
      publish: (request: PiExtensionUiRequest) => broadcastFrame(this, hosted, { t: 'pi', event: request }),
    };
  }

  private uiContextFor(hosted: HostedSession): ExtensionUIContext {
    return createExtensionUiScope(this.extensionUiOwner(hosted)).context;
  }

  /** Answer a pending dialog; an unknown id is ignored rather than an error. */
  respondToDialog(id: string, response: PiExtensionUiResponse): boolean {
    for (const hosted of this.sessions.values()) {
      const resolver = hosted.pendingDialogs.get(id);
      if (resolver !== undefined) {
        resolver.respond(response);
        return true;
      }
    }
    return false;
  }

  /* --------------------------------------------------------- event fan-out */

  /** @internal 事件桥接入口：会话订阅的回调，转发到 host-events。 */
  onEvent(hosted: HostedSession, event: AgentSessionEvent): void {
    onEventOp(this, hosted, event);
  }

  /* ----------------------------------------------------------- subscription */

  subscribe(session: HostedSession, subscriber: HostSubscriber): void {
    session.subscribers.add(subscriber);
    session.lastSeen = Date.now();
  }

  unsubscribe(session: HostedSession, subscriber: HostSubscriber): void {
    session.subscribers.delete(subscriber);
    session.lastSeen = Date.now();
  }

  /* ------------------------------------------------------------------- CRUD */

  get(id: string): HostedSession | undefined {
    return this.sessions.get(id);
  }

  list(): HostedSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  summary(session: HostedSession): SessionSummary {
    const model = asModel(session.session.model);
    return {
      id: session.id,
      cwd: session.cwd,
      pid: null,
      createdAt: session.createdAt,
      alive: session.alive,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      streaming: session.streaming,
      pendingDialogs: session.pendingDialogs.size,
      clients: session.subscribers.size,
    };
  }

  async kill(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    // Close admission before waiting: a closing parent cannot create another child.
    session.alive = false;
    void session.session.abort().catch(() => undefined);
    await this.cancelWorkersFor(id);
    // The team goes with the session: its members were just asked to stop above
    // (`cancelWorkersFor` cancels every run this parent owns), and a team nobody
    // can address any more is only a memory leak. Anything the cancellation did
    // not confirm stays invisible rather than being reported as finished.
    if (session.teamId !== null) {
      this.teams.cancelTeam(session.teamId, '父会话已关闭。');
      this.teams.dropTeam(session.teamId);
    }
    this.sessions.delete(id);
    session.streaming = false;
    // An extension awaiting a dialog would otherwise hang forever: answer every
    // pending request as a dismissal, which is what a closed window means.
    for (const dialog of session.pendingDialogs.values()) {
      dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
    }
    session.pendingDialogs.clear();
    try {
      session.unsubscribe?.();
      session.session.dispose();
    } catch {
      // Disposal is best-effort; the session is gone either way.
    }
    session.reservation.release();
    broadcastFrame(this, session, { t: 'exit', code: 0, signal: null });
    for (const subscriber of session.subscribers) subscriber.close();
    return true;
  }

  async disposeAll(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweeper);
    for (const hosted of this.sessions.values()) {
      hosted.alive = false;
      void hosted.session.abort().catch(() => undefined);
    }
    // Workers first: their parent sessions are about to be killed, and a run
    // cancelled mid-answer must not be reported as a finished one.
    await this.workerRunner.cancelAll();
    // Anything that did not confirm its stop is recorded as `interrupted` — the
    // honest state for "we asked, we never heard back" — before the teams are
    // dropped by `kill` below. (P2 keeps this in memory only; P3's journal is what
    // would make it visible after a restart.)
    for (const hosted of this.sessions.values()) {
      if (hosted.teamId !== null) {
        this.teams.markInterrupted(
          hosted.teamId,
          '宿主已关闭，停止未得到确认。',
          TEAM_INTERRUPT_REASONS.hostShutdown,
        );
      }
    }
    for (const id of [...this.sessions.keys()]) await this.kill(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      // A parent with a live worker is not idle, whatever its subscribers say:
      // killing it would strand the worker's answer and leak the child session.
      if (this.capacity.hasPending(session.id)) {
        session.lastSeen = now;
        continue;
      }
      if (!session.alive && session.subscribers.size === 0) {
        void this.kill(session.id);
        continue;
      }
      if (session.subscribers.size === 0 && now - session.lastSeen > SWEEP_AFTER_MS) {
        void this.kill(session.id);
      }
    }
  }

  /* ------------------------------------------------------- command dispatch */

  command(id: string, command: PiCommandEnvelope): Promise<PiRpcResponse> {
    return handleCommand(this, id, command);
  }
}
