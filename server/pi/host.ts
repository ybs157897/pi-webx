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
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type SettingsManager,
  type ToolDefinition,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
} from '@earendil-works/pi-coding-agent';

import type {
  JournalEntry,
  PiCommandEnvelope,
  PiEvent,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiModel,
  PiQueueAction,
  PiQueuedPrompt,
  PiRpcResponse,
  PiSessionState,
  PiSessionStats,
  ServerFrame,
  SessionSummary,
} from '../../src/shared/protocol';
import { PromptRequests, SessionJournal } from './session-journal';
import { createExtensionUiScope, type PendingExtensionDialog } from './extension-ui';
import { prepareIncomingImages } from '../attachment/store';
import {
  appendToolSelection,
  readToolSelection,
  validateToolSelection,
  withExtensionTools,
} from '../tool-selection';
import { agentDefinitionsStore, type AgentDefinitionStore } from '../agent-definitions';
import {
  SUBAGENT_TOOL_NAME,
  type AgentDefinition,
  type AgentDefinitionsResponse,
} from '../../src/shared/agent-definitions';
import { mergeBuiltinAndUserAgents } from '../builtin-agents';
import { MAX_WORKERS, SubagentCapacity } from './subagent-capacity';
import { SessionCapacity, type SessionReservation } from './session-capacity';
import {
  createSubagentTool,
  enabledDefinitions,
  freezeDefinition,
  nextActiveTools,
  type SubagentDispatchOutcome,
  type SubagentDispatchRequest,
  type SubagentToolDeps,
} from './subagent-tool';
import { createSubagentWorkerDispatch, type SubagentWorkerRunner } from './subagent-worker';
import { AgentTeamRuntime } from '../agent-team/team-runtime';
import { TeamJournal } from '../agent-team/team-journal';
import { TeamInjector, type TeamLiveSession } from '../agent-team/team-inject';
import {
  createOrchestratorTeamTools,
  createWorkerTeamTools,
  type TeamDispatchRequest,
} from '../agent-team/team-tools';
import {
  TEAM_INTERRUPT_REASONS,
  TEAM_ORCHESTRATOR_TOOL_NAMES,
  type TeamProjection,
} from '../agent-team/team-types';

const MAX_SESSIONS = 12;
/** Sweep dead sessions with no subscribers after this long. */
const SWEEP_AFTER_MS = 10 * 60_000;

/** Commands whose submit is idempotent by requestId, like dsh's prompt path. */
const PROMPT_COMMANDS = new Set(['prompt', 'steer', 'follow_up']);

export interface HostSubscriber {
  frame: (entry: JournalEntry) => void;
  close: () => void;
}

/**
 * One wait-list row: the text and images a settled turn will be handed, plus the
 * id the browser addresses it by.
 */
export interface QueuedPrompt {
  id: string;
  text: string;
  images?: ImageContent[];
  createdAt: number;
}

export class HostError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HostedSession {
  reservation: SessionReservation;
  id: string;
  cwd: string;
  createdAt: number;
  resumed: boolean;
  alive: boolean;
  streaming: boolean;
  /** A prompt is mid-preflight; a second one would race the first. */
  preparing?: boolean;
  /** A queued row is being handed to pi right now; one flush at a time. */
  flushing?: boolean;
  /**
   * Messages accepted while a turn was running, in arrival order — the dock's
   * rows. Held here, not in pi: pi's own queues are strings with no per-item
   * identity, so nothing could address a single row (steer/edit/remove).
   */
  queue: QueuedPrompt[];
  sessionFile: string | null;
  sessionName: string | null;
  session: AgentSession;
  /**
   * What pi's resource loader found for this session. Its runtime is the only
   * public source of the merged slash-command list (`getCommands()`), which is
   * why it is kept: the extension-runner that builds it is private to
   * `createAgentSession`.
   */
  extensionsResult: LoadExtensionsResult;
  /**
   * Dialogs an extension is waiting on, keyed by request id. An extension's
   * `ctx.ui.confirm()` resolves only when the browser answers, so a dead session
   * has to resolve them rather than leave the agent's tool call hanging.
   *
   * The request text and its arrival time are kept alongside the responder: a
   * client that reconnects is handed the open dialogs again, and the timeout it
   * is told about has to be the time *left*, not a fresh full one.
   */
  pendingDialogs: Map<string, PendingExtensionDialog>;
  /**
   * The builtin selection this session is running with, as the user chose it
   * (before shell resolution and the extension-tool merge). `null` until a
   * selection is known.
   */
  toolSelection: string[] | null;
  /**
   * The mutable array handed to `createAgentSession` as `customTools`.
   *
   * Held per session and mutated **in place**: the SDK keeps this exact array
   * reference, so `refreshSubagentTool` can replace its contents and call
   * `extensionsResult.runtime.refreshTools()` to rebuild the registry without
   * recreating the session.
   */
  customTools: ToolDefinition[];
  /**
   * The Agent Team this session orchestrates, or `null` for an ordinary session.
   *
   * Set once at creation (and again after an in-place reset) and never cleared:
   * it is what makes `refreshSubagentTool` mount the Team tool面 instead of the
   * single-shot `subagent` tool. The Team's own state lives in
   * {@link PiHost.teams} — **in memory only**, so a restart loses every member,
   * task and message (the journal is P3).
   */
  teamId: string | null;
  /** Whether this session was created in Team mode (survives an in-place reset). */
  teamMode: boolean;
  /** Ordered in-memory log every subscriber's stream is cut from. */
  journal: SessionJournal;
  /** requestId ledger: duplicate-submit guard + echo-retire annotation. */
  promptRequests: PromptRequests;
  subscribers: Set<HostSubscriber>;
  unsubscribe: (() => void) | null;
  lastSeen: number;
}

export interface CreateHostedSessionOptions {
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  sessionPath?: string;
  name?: string;
  /** `--no-session`: keep the transcript in memory only. */
  noSession?: boolean;
  /**
   * Builtin tools a new session starts with, from the browser's preset. A resumed
   * session keeps the selection recorded in its own log instead: that record says
   * what the session was last run with, which the client cannot know.
   */
  toolNames?: string[];
  /**
   * Team mode: swap the single-shot `subagent` tool for the nine orchestration
   * tools and attach an in-memory Agent Team.
   *
   * Not a UI feature yet (P4 owns the panel); it exists so the P2 runtime can be
   * exercised through the normal create path. The session keeps the tools its
   * preset already had — the orchestrator reads files and checks facts itself —
   * and simply gains the nine Team tools.
   */
  teamMode?: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether two tool-name lists hold the same names, ignoring order. */
function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((name) => set.has(name));
}

/**
 * The SDK's "a turn is already running" refusal.
 *
 * Matched by text because it is thrown, not typed. It means the same thing the
 * preflight's `accepted: false` means — the message has to wait — so the caller
 * turns it into a queue row instead of an error the user has to read.
 */
const ALREADY_PROCESSING = /already processing/i;

function isAlreadyProcessing(message: string): boolean {
  return ALREADY_PROCESSING.test(message);
}

function asModel(model: Model<any> | undefined | null): PiModel | null {
  if (!model) return null;
  return model as unknown as PiModel;
}

/**
 * A cheap identity for a config file: size and modification time.
 *
 * Size is in the stamp as well as the time because a same-second rewrite that
 * changes the length would otherwise look unchanged to a coarse-grained clock.
 * A missing file stamps as `gone`, which is a state worth reloading for: the
 * runtime should drop providers the config no longer declares.
 */
async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return 'gone';
  }
}

export interface PiHostOptions {
  /**
   * Definitions source. Defaults to the process-wide file-backed store.
   *
   * Only `read` is used, so the option is narrowed to that: a test can hand in a
   * list without a definitions file, and the real store still fits.
   */
  definitions?: Pick<AgentDefinitionStore, 'read'>;
  /**
   * Builds the one shared model runtime. Defaults to pi's own
   * `ModelRuntime.create()`, which reads the real `auth.json`/`models.json`.
   *
   * A test that needs real credentials without touching the user's files injects
   * a factory here (for example one built on a read-only auth storage and a
   * temporary models store); the credentials stay inside the SDK and are never
   * read, copied or printed by this host.
   */
  modelRuntimeFactory?: () => Promise<ModelRuntime>;
  /**
   * Directory every session of this host is stored in. Omitted means pi's own
   * default (`~/.pi/agent/sessions/<cwd>`), which is what the product uses.
   */
  sessionDir?: string;
  /**
   * Settings manager for the sessions this host creates. Omitted means pi's
   * file-backed manager; a test passes `(cwd) => SettingsManager.inMemory()` so a
   * session can never write the user's defaults.
   */
  settingsManagerFactory?: (cwd: string) => SettingsManager;
  /**
   * Directory the append-only Team journal is kept in (P3-A).
   *
   * Defaults to `<agentDir>/pi-webx/teams`, i.e. a `pi-webx` subtree of pi's own
   * config directory: next to the sessions the Teams describe, never inside the
   * user's definition file (`agent-definitions.json`) and never in the repository.
   * A test passes a temp directory.
   */
  teamJournalDir?: string;
}

export class PiHost {
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
  private readonly sessions = new Map<string, HostedSession>();
  private readonly sweeper: NodeJS.Timeout;
  /**
   * Live worker slots. Every dispatch reserves here before it can start a
   * session, and workers count against the same session budget as hosted
   * conversations — a worker is a real agent session, not a free one.
   */
  private readonly capacity: SubagentCapacity;
  private readonly sessionCapacity = new SessionCapacity(MAX_SESSIONS);
  /**
   * Every Agent Team this process orchestrates, keyed by team id.
   *
   * Live state is memory; the **append-only journal** below is what lets a restart
   * rebuild it (P3-A). The journal is written as state changes, so a restart sees
   * every change that had already happened — see `team-journal.ts` for the honest
   * scope of that promise (append, no fsync).
   */
  private readonly journal: TeamJournal;
  private readonly teams: AgentTeamRuntime;
  /**
   * P3-B delivery: hands pending inbox items to the live orchestrator session.
   *
   * Constructed with a lookup, not the session table itself, so the injector stays
   * a policy module with one dependency it can be tested against.
   */
  private readonly teamInjector: TeamInjector;
  private closing = false;
  private readonly workerRunner: SubagentWorkerRunner;
  private readonly definitions: Pick<AgentDefinitionStore, 'read'>;
  private readonly modelRuntimeFactory: () => Promise<ModelRuntime>;
  private readonly sessionDir: string | undefined;
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
      onInboxItem: (message) => { void this.deliverTeamInbox(message.teamId); },
    });
    this.teamInjector = new TeamInjector({
      runtime: this.teams,
      liveSession: (teamId) => this.liveTeamSession(teamId),
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

  private runtime(): Promise<ModelRuntime> {
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
  private settingsOption(cwd: string): { settingsManager?: SettingsManager } {
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

  async create(options: CreateHostedSessionOptions = {}): Promise<HostedSession> {
    if (this.closing) throw new HostError(503, 'host is closing');
    const reservation = this.sessionCapacity.reserve();
    if (reservation === undefined) throw new HostError(429, `session limit reached (${MAX_SESSIONS})`);
    let createdSession: AgentSession | undefined;
    let createdHost: HostedSession | undefined;
    try {
      const cwd = options.cwd ?? process.cwd();
      // Before the model is resolved, so a config edited since the last session is
      // what this one is built from.
      await this.syncModelConfig();
      const runtime = await this.runtime();

      let model: Model<any> | undefined;
      if (options.provider && options.model) {
        const resolved = resolveCliModel({
          cliModel: `${options.provider}/${options.model}`,
          modelRuntime: runtime,
        });
        if (resolved.error) throw new HostError(400, resolved.error);
        model = resolved.model;
      }

      const sessionManager = options.sessionPath
        ? SessionManager.open(options.sessionPath, this.sessionDir, cwd)
        : options.noSession
          ? SessionManager.inMemory(cwd)
          : SessionManager.create(cwd, this.sessionDir);

      // The SDK keeps this exact array, so the dispatch tool is added and removed
      // by splicing its contents — never by replacing the array (see
      // `refreshSubagentTool`).
      const customTools: ToolDefinition[] = [];
      const { session, extensionsResult } = await createAgentSession({
        cwd,
        agentDir: getAgentDir(),
        ...(model ? { model } : {}),
        ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
        modelRuntime: runtime,
        sessionManager,
        customTools,
        ...this.settingsOption(cwd),
      });

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
        id: sessionManager.getSessionId(),
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
        teamId: null,
        teamMode: options.teamMode === true,
        pendingDialogs: new Map(),
        toolSelection: options.toolNames ?? null,
        journal: new SessionJournal(),
        promptRequests: new PromptRequests(),
        subscribers: new Set(),
        unsubscribe: null,
        lastSeen: Date.now(),
      };

      createdHost = hosted;
      // A Team-mode session is the point where the process proves what it knows:
      // replay the journal first, so Teams from before the restart are in memory
      // again (their members come back as `interrupted` — an in-memory worker
      // session cannot be revived), and only then add this session's own Team.
      if (hosted.teamMode) await this.hydrateTeams();
      // The Team exists before the tool面 is refreshed, because that refresh is
      // what decides between `subagent` and the nine orchestration tools. Its id
      // is the parent session's own id, so a team is addressable by the session
      // the user is talking to.
      if (hosted.teamMode) hosted.teamId = this.teams.createTeam(hosted.id).id;
      hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
      this.applyInitialToolSelection(hosted, sessionManager, options.toolNames);
      await this.bindExtensions(session, hosted);
      await this.refreshSubagentTool(hosted);
      if (this.closing) throw new HostError(503, 'host closed during session initialization');
      if (this.sessions.has(hosted.id)) throw new HostError(409, 'session is already hosted');
      this.sessions.set(hosted.id, hosted);
      return hosted;
    } catch (error) {
      if (createdHost !== undefined) {
        createdHost.alive = false;
        createdHost.unsubscribe?.();
        // A team created for a session that never finished coming up would linger
        // in memory as an orphan: nothing else can reach it, so drop it here.
        // (A fork never has one, so this is a no-op on that path.)
        if (createdHost.teamId !== null) this.teams.dropTeam(createdHost.teamId);
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
   * Put a session's tools where they belong, pi-web's way.
   *
   * A resumed session's own log decides: the newest `pi-webx:tool-selection` entry
   * records what it was last run with, and a client preset cannot know that. A
   * session with no such entry takes the client's preset and records it, so the
   * choice survives the next reload. A session with neither keeps pi's own default
   * tool set — the browser may simply not have sent one.
   */
  private applyInitialToolSelection(
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
  private setToolSelection(
    hosted: HostedSession,
    toolNames: readonly string[],
    options: { persist: boolean },
  ): void {
    const defaultTools = hosted.session.settingsManager?.getDefaultTools?.();
    const resolved = withExtensionTools(hosted.session, toolNames, defaultTools);
    hosted.session.setActiveToolsByName(resolved);
    hosted.toolSelection = [...toolNames];
    if (!options.persist) return;
    try {
      appendToolSelection(hosted.session.sessionManager, toolNames);
    } catch (error) {
      this.broadcastError(hosted, `工具选择未能写入会话记录：${errorText(error)}`);
    }
  }

  /* ------------------------------------------------------ subagent dispatch */

  /**
   * The definitions a session dispatches from: the shipped built-ins merged with
   * whatever the user stored.
   *
   * One merge point serves both readers — the tool description a session offers
   * the model, and the lookup a dispatch performs — so a `builtin:` id resolves
   * exactly when it is listed. A user definition with a built-in's name shadows
   * it (`mergeBuiltinAndUserAgents`).
   */
  private async mergedDefinitions(): Promise<AgentDefinitionsResponse> {
    const response = await this.definitions.read();
    return { ...response, agents: mergeBuiltinAndUserAgents(response.agents) };
  }

  /** What the dispatch tool needs from one hosted session. */
  private subagentToolDeps(hosted: HostedSession): SubagentToolDeps {
    return {
      definitions: () => this.mergedDefinitions(),
      /**
       * Read live, per dispatch: `getActiveToolNames()` is the permission
       * boundary — the preset the user chose — while `getAllTools()` is only the
       * catalogue. Handing over the catalogue once gave a `read`/`grep` session a
       * child with `bash`, `write` and `edit`.
       */
      parentActiveTools: () => hosted.session.getActiveToolNames(),
      dispatch: (request: SubagentDispatchRequest): Promise<SubagentDispatchOutcome> => (
        hosted.alive ? this.workerRunner.dispatch({
          sessionId: hosted.id,
          cwd: hosted.cwd,
          agentDir: getAgentDir(),
          session: hosted.session,
          createUiScope: (origin, signal) => createExtensionUiScope(this.extensionUiOwner(hosted), { origin, signal }),
        }, request) : Promise.reject(new Error('父会话已关闭，不能派发子智能体。'))
      ),
    };
  }

  /**
   * Re-read the definitions and put the dispatch tool where the session can see
   * it — before every prompt that could call it, and once per session assembly.
   *
   * Three things have to hold together, and each one is load-bearing:
   *
   *   1. The SDK holds the `customTools` **array** by reference, so its contents
   *      are spliced in place. Assigning a new array would leave the session
   *      looking at the old one.
   *   2. `refreshTools()` rebuilds the registry from the current definitions, so
   *      the model-facing description is the one this refresh rendered.
   *   3. The refresh makes a newly registered tool active by default. That would
   *      silently turn dispatch on for a session whose user chose no tools at
   *      all, so the active set is recomputed here instead: a session keeps
   *      exactly the tools it had, plus `subagent` only when it already had
   *      tools and at least one definition is enabled.
   *
   * A definitions file that cannot be read is not fatal: the tool disappears for
   * this turn and the next refresh picks it up again. Refusing the user's prompt
   * because a settings file is unreadable would be the worse failure.
   */
  private async refreshSubagentTool(hosted: HostedSession): Promise<void> {
    if (!hosted.alive) return;
    // Team mode has its own tool面, and it is not additive to `subagent`: the
    // orchestrator dispatches through `dispatch_agent` only, so the single-shot
    // tool is never registered there (two dispatch mechanisms in one session
    // would be two ways to do the same thing, with different lifecycles).
    if (hosted.teamId !== null) return this.refreshTeamTools(hosted);
    let definitions: AgentDefinition[] = [];
    try {
      // Merged: the built-ins are enabled by construction, so a user who has
      // stored nothing still gets a dispatch tool listing `general-purpose` and
      // `Explore` (`builtin:` ids).
      definitions = enabledDefinitions(await this.mergedDefinitions());
    } catch (error) {
      this.broadcastError(hosted, `子智能体定义读取失败：${errorText(error)}`);
    }

    const activeBefore = hosted.session.getActiveToolNames();
    const carried = activeBefore.filter((name) => name !== SUBAGENT_TOOL_NAME);
    const frozen = definitions.map(freezeDefinition);
    const tools = frozen.length === 0 ? [] : [createSubagentTool(this.subagentToolDeps(hosted), frozen)];
    hosted.customTools.splice(0, hosted.customTools.length, ...tools);
    hosted.extensionsResult.runtime.refreshTools();

    const next = nextActiveTools(carried, {
      definitionCount: frozen.length,
      registered: hosted.session.getToolDefinition(SUBAGENT_TOOL_NAME) !== undefined,
    });
    if (!sameNames(next, hosted.session.getActiveToolNames())) {
      hosted.session.setActiveToolsByName(next);
    }
  }

  /** Stop every worker this parent owns and wait until each has cleaned up. */
  private async cancelWorkersFor(parentId: string): Promise<void> {
    await this.workerRunner.cancelParent(parentId);
  }

  /* --------------------------------------------------------------- team mode */

  /**
   * Rebuild every Team the journal knows about, and report what changed.
   *
   * This is the P3-A replay entry point, called once at process start (and again
   * before a Team-mode session is assembled, as a safety net).
   *
   * Three properties it has to keep, because it sits on the boot path:
   *
   *   - **It never throws.** A journal directory that cannot be listed, or a file
   *     that cannot be read, is counted (`unreadable`) and skipped: a damaged log
   *     degrades to "fewer Teams rebuilt", never to "the host did not start".
   *   - **It is idempotent.** A Team already in memory is left alone, so a second
   *     call adds nothing, changes nothing and does not move a sequence number.
   *   - **Its cost is bounded and reported.** It scans exactly one directory for
   *     `*.jsonl`, and returns the file count, the bytes read and the wall time, so
   *     the caller can log what the replay actually cost instead of assuming.
   *
   * Members that were mid-flight come back `interrupted` (an in-memory worker
   * session cannot be revived) and stay refused by `TEAM_MEMBER_NOT_ACTIVE`.
   */
  async hydrateTeams(): Promise<{
    /** Teams that exist in memory after this call — not files that happened to parse. */
    readonly teams: number;
    readonly members: number;
    readonly tasks: number;
    readonly messages: number;
    readonly interrupted: number;
    readonly skipped: number;
    /** Journal files that yielded no team (empty, or every record belonged elsewhere). */
    readonly unusable: number;
    readonly files: number;
    readonly bytes: number;
    readonly durationMs: number;
    /** Set when the journal cannot be written at all; the host then runs in memory. */
    readonly journalDisabled?: string;
  }> {
    const startedAt = Date.now();
    const known = new Set(this.teams.listTeams());
    let teams = 0;
    let members = 0;
    let tasks = 0;
    let messages = 0;
    let interrupted = 0;
    let skipped = 0;
    let unusable = 0;
    let files = 0;
    let bytes = 0;

    let teamIds: string[] = [];
    try {
      teamIds = this.journal.listTeamIds();
    } catch {
      // An unreadable journal directory is a reason to start with no Teams, not a
      // reason to refuse to start.
      teamIds = [];
    }
    for (const teamId of teamIds) {
      if (known.has(teamId)) continue;
      try {
        const read = this.journal.readTeam(teamId);
        if (read === undefined) continue;
        files += 1;
        bytes += read.bytes;
        skipped += read.skipped.length;
        const result = this.teams.hydrate({ teamId, records: read.records });
        // Only a team that is really in memory counts. A file that parsed but held
        // no `team-created` record (empty file, or every record foreign) rebuilds
        // nothing, and reporting it as a team is exactly the over-report the
        // independent verification caught.
        if (result.created) teams += 1;
        else unusable += 1;
        members += result.members;
        tasks += result.tasks;
        messages += result.messages;
        interrupted += result.interrupted;
      } catch {
        skipped += 1;
      }
    }
    return {
      teams, members, tasks, messages, interrupted, skipped, unusable, files, bytes,
      durationMs: Date.now() - startedAt,
      ...(this.journal.disabled === undefined ? {} : { journalDisabled: this.journal.disabled }),
    };
  }

  /** Where the Team journal lives; surfaced for operators and tests. */
  get teamJournalDir(): string {
    return this.journal.directory;
  }

  /* ----------------------------------------------------------- P3-B delivery */

  /**
   * The live session that orchestrates one team, if there is one.
   *
   * A team can exist without one: after a restart the journal rebuilds the team,
   * but nobody has opened its parent session yet. The injector must be able to see
   * that difference — "no target" is not "delivery failed" — which is exactly why
   * this lookup returns `undefined` instead of throwing.
   */
  private liveTeamSession(teamId: string): TeamLiveSession | undefined {
    const team = this.teams.get(teamId);
    if (team === undefined) return undefined;
    const hosted = [...this.sessions.values()].find((session) => session.teamId === teamId);
    if (hosted === undefined || !hosted.alive) return undefined;
    const session = hosted.session;
    return {
      get isStreaming(): boolean {
        return session.isStreaming;
      },
      sendCustomMessage: (message, options) => session.sendCustomMessage(
        {
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        },
        { triggerTurn: options.triggerTurn, deliverAs: options.deliverAs },
      ),
      /**
       * Read-back for the strongest state we may claim. The entry is in the
       * session's own tree once the SDK appended it; an in-memory worker-free
       * parent session has no file to reopen, so this is the reader we have.
       */
      readBack: (messageId: string): boolean => session.messages.some((message) => {
        const record = message as { role?: string; details?: { messageId?: unknown } };
        return record.role === 'custom' && record.details?.messageId === messageId;
      }),
    };
  }

  /**
   * Sweep one team's inbox and hand what is deliverable to the orchestrator.
   *
   * Fire-and-forget by design: the inbox item is already recorded (P3-A made it
   * recoverable), so a slow or failed delivery must never block the tool call that
   * produced it. Every outcome — including a refusal — is recorded on the item, so
   * "nothing happened" is always observable afterwards.
   */
  private async deliverTeamInbox(teamId: string): Promise<void> {
    try {
      await this.teamInjector.deliverPending(teamId);
    } catch {
      // The injector records its own failures; a throw here would be a bug in it,
      // and losing an already-recorded message to a bug is the worse outcome.
    }
  }

  /**
   * Team mode's tool面: the nine orchestration tools, re-rendered per turn.
   *
   * Two things this deliberately does **not** do:
   *
   *   - it does not take the session's own tools away. The user is talking to the
   *     orchestrator, and an orchestrator that cannot read a file to decide who
   *     should get the work is useless — the set is the session's existing active
   *     tools **plus** the nine Team tools;
   *   - it does not register `subagent`: Team mode dispatches through
   *     `dispatch_agent` only, so the single-shot tool is spliced out of the
   *     custom-tool array (and therefore cannot come back through a later preset
   *     change either — an unregistered tool cannot be activated).
   *
   * The definition list is rendered into `dispatch_agent`'s description on every
   * refresh, which is what lets the description demand a current
   * `expectedDefinitionRevision`: the refresh runs before every prompt that could
   * call the tool (the same five call sites as the subagent refresh).
   */
  private async refreshTeamTools(hosted: HostedSession): Promise<void> {
    const teamId = hosted.teamId;
    if (teamId === null || !hosted.alive) return;
    let definitions: AgentDefinition[] = [];
    try {
      definitions = enabledDefinitions(await this.mergedDefinitions());
    } catch (error) {
      this.broadcastError(hosted, `子智能体定义读取失败：${errorText(error)}`);
    }

    const tools = createOrchestratorTeamTools({
      teamId,
      runtime: this.teams,
      definitions: () => this.mergedDefinitions(),
      parentActiveTools: () => hosted.session.getActiveToolNames(),
      dispatch: (request) => this.dispatchTeamMember(hosted, request),
    }, definitions);
    hosted.customTools.splice(0, hosted.customTools.length, ...tools);
    hosted.extensionsResult.runtime.refreshTools();

    const activeBefore = hosted.session.getActiveToolNames();
    const carried = activeBefore.filter((name) => (
      name !== SUBAGENT_TOOL_NAME && !TEAM_ORCHESTRATOR_TOOL_NAMES.includes(name)
    ));
    const next = [
      ...carried,
      ...TEAM_ORCHESTRATOR_TOOL_NAMES.filter((name) => hosted.session.getToolDefinition(name) !== undefined),
    ];
    if (!sameNames(next, hosted.session.getActiveToolNames())) {
      hosted.session.setActiveToolsByName(next);
    }
  }

  /**
   * Run one Team member through the **existing** dispatch path.
   *
   * Same capacity, leases, timeout, lifecycle and cancellation as a `subagent`
   * call — the only differences are the member's tool surface and the two member
   * tools registered inside its session. The member's `memberId` is bound here, so
   * the tools it receives can only ever touch its own task and talk to the lead.
   */
  private dispatchTeamMember(hosted: HostedSession, request: TeamDispatchRequest): Promise<SubagentDispatchOutcome> {
    if (!hosted.alive) return Promise.reject(new Error('父会话已关闭，不能派发成员。'));
    return this.workerRunner.dispatch({
      sessionId: hosted.id,
      cwd: hosted.cwd,
      agentDir: getAgentDir(),
      session: hosted.session,
      createUiScope: (origin, signal) => createExtensionUiScope(this.extensionUiOwner(hosted), { origin, signal }),
    }, {
      definition: request.definition,
      task: request.instruction,
      surface: request.surface,
      signal: request.signal,
      onUpdate: request.onUpdate,
      memberTools: createWorkerTeamTools({
        teamId: request.teamId,
        memberId: request.memberId,
        runtime: this.teams,
      }),
    });
  }

  /**
   * Resolve what a client sent as `:id` to a Team id — read-only.
   *
   * **Two identifiers are accepted**, because P2 carries no team id over the wire:
   * `POST /api/sessions` answers with a `SessionSummary` (a frozen contract, no
   * teamId field) and the WS frames are unchanged, so the only identity a client
   * actually holds is the **parent session id** it just created. Without this
   * resolution the two Team routes would be unreachable to every real client —
   * which is exactly the gap the end-to-end smoke run found.
   *
   * **A team id wins when an identifier matches both.** The route names a team, so
   * a session that merely happens to share an id must not shadow it. Team ids are
   * generated independently of session ids, so a collision is possible in
   * principle and this is the rule that decides it.
   *
   * Nothing here creates, mutates or drops a team: an unknown identifier simply
   * resolves to `undefined`, and the route keeps its existing 404.
   */
  resolveTeamId(idOrSessionId: string): string | undefined {
    if (this.teams.get(idOrSessionId) !== undefined) return idOrSessionId;
    // A Team rebuilt from the journal knows the session that created it, even when
    // that session never wrote a transcript (a run with no assistant turn) and so
    // cannot be found in the live table — which is why this index exists and comes
    // before it.
    const replayed = this.teams.findTeamByParentSession(idOrSessionId);
    if (replayed !== undefined) return replayed;
    return this.sessions.get(idOrSessionId)?.teamId ?? undefined;
  }

  /**
   * The read-only projection `GET /api/teams/:id` serves; `undefined` means 404.
   *
   * `:id` may be a team id or the parent session's id — see {@link resolveTeamId}.
   */
  teamSnapshot(idOrSessionId: string): TeamProjection | undefined {
    const teamId = this.resolveTeamId(idOrSessionId);
    return teamId === undefined ? undefined : this.teams.snapshot(teamId);
  }

  /**
   * `POST /api/teams/:id/cancel`: ask every running member to stop.
   *
   * Cancellation is cooperative — this reports how many were asked, not that they
   * have stopped. `undefined` means neither a team nor a team-mode session matched
   * the identifier. The resolved `teamId` is returned so a client that only knew
   * the session id can address the team canonically from then on.
   */
  cancelTeam(idOrSessionId: string, reason?: string): { teamId: string; cancelled: number } | undefined {
    const teamId = this.resolveTeamId(idOrSessionId);
    if (teamId === undefined) return undefined;
    return { teamId, cancelled: this.teams.cancelTeam(teamId, reason) };
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
   *
   * @param options - the source transcript and the workspace to fork into.
   * @returns the new hosted session.
   */
  async fork(options: { source: string; cwd?: string }): Promise<HostedSession> {
    if (this.closing) throw new HostError(503, 'host is closing');
    const reservation = this.sessionCapacity.reserve();
    if (reservation === undefined) throw new HostError(429, `session limit reached (${MAX_SESSIONS})`);
    let createdSession: AgentSession | undefined;
    let createdHost: HostedSession | undefined;
    try {
      const cwd = options.cwd ?? process.cwd();
      const runtime = await this.runtime();

      let sessionManager: SessionManager;
      try {
        sessionManager = SessionManager.forkFrom(options.source, cwd, this.sessionDir);
      } catch (error) {
        throw new HostError(400, `无法分叉该会话：${errorText(error)}`);
      }

      const customTools: ToolDefinition[] = [];
      const { session, extensionsResult } = await createAgentSession({
        cwd,
        agentDir: getAgentDir(),
        modelRuntime: runtime,
        sessionManager,
        customTools,
        ...this.settingsOption(cwd),
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
      hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
      await this.bindExtensions(session, hosted);
      await this.refreshSubagentTool(hosted);
      if (this.closing) throw new HostError(503, 'host closed during session initialization');
      if (this.sessions.has(hosted.id)) throw new HostError(409, 'session is already hosted');
      this.sessions.set(hosted.id, hosted);
      return hosted;
    } catch (error) {
      if (createdHost !== undefined) {
        createdHost.alive = false;
        createdHost.unsubscribe?.();
        // A team created for a session that never finished coming up would linger
        // in memory as an orphan: nothing else can reach it, so drop it here.
        // (A fork never has one, so this is a no-op on that path.)
        if (createdHost.teamId !== null) this.teams.dropTeam(createdHost.teamId);
        for (const dialog of createdHost.pendingDialogs.values()) {
          dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
        }
      }
      try { createdSession?.dispose(); }
      finally { reservation.release(); }
      throw error;
    }
  }

  /** Bind browser interactions; session replacement remains owned by PiHost. */
  private async bindExtensions(session: AgentSession, hosted: HostedSession): Promise<void> {
    const refused = (action: string) => async (): Promise<never> => {
      throw new Error(`此宿主不支持扩展命令的 ${action}（会话身份由 pi-webx 管理）`);
    };
    try {
      await session.bindExtensions({
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
      });
    } catch (error) {
      // A session without extension bindings still runs; only extension UI and
      // extension commands are lost, so this is reported and not fatal.
      this.broadcastError(hosted, `扩展绑定失败：${errorText(error)}`);
    }
  }

  /* ------------------------------------------------------- extension UI bridge */

  /** UI transport receives only this parent's dialog store and event publisher. */
  private extensionUiOwner(hosted: HostedSession) {
    return {
      pendingDialogs: hosted.pendingDialogs,
      isAlive: () => hosted.alive,
      publish: (request: PiExtensionUiRequest) => this.broadcast(hosted, { t: 'pi', event: request }),
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

  /* ------------------------------------------------------------- event fan-out */

  private onEvent(hosted: HostedSession, event: AgentSessionEvent): void {
    hosted.lastSeen = Date.now();
    if (event.type === 'agent_start') hosted.streaming = true;
    if (event.type === 'agent_settled' || event.type === 'agent_end') hosted.streaming = false;
    // SDK events are a superset of the RPC-mode union the client models; the
    // transcript reducer ignores the extras (entry_appended, …) safely.
    const source = this.claimPromptSource(hosted, event);
    this.broadcast(hosted, {
      t: 'pi',
      event: event as unknown as PiEvent,
      ...(source === undefined ? {} : { source }),
    });
    // The wait list's clock: a settled turn is the only moment a queued message
    // may start the next one. Broadcast first, so the client's `running` has
    // already gone false by the time the flush's own events arrive.
    if (event.type === 'agent_settled') void this.flushQueue(hosted);
  }

  /**
   * Correlate a durable user message with the prompt command that produced it.
   *
   * pi has no requestId on its own events, so the host is the adapter: the
   * oldest still-pending requestId claims the next user message, and the frame
   * carries it as `source.requestId` for the browser's echo retire.
   */
  private claimPromptSource(hosted: HostedSession, event: AgentSessionEvent): { requestId: string } | undefined {
    if (event.type !== 'message_start') return undefined;
    const message = (event as { message?: { role?: unknown } }).message;
    if (message === undefined || message.role !== 'user') return undefined;
    const requestId = hosted.promptRequests.consumePending();
    return requestId === null ? undefined : { requestId };
  }

  private broadcast(hosted: HostedSession, frame: ServerFrame): void {
    // Everything a subscriber can see passes through the journal first, so a
    // reconnecting client's replay and a live client's stream share one order.
    const entry = hosted.journal.append(frame);
    for (const subscriber of hosted.subscribers) subscriber.frame(entry);
  }

  private broadcastError(hosted: HostedSession, message: string): void {
    this.broadcast(hosted, { t: 'error', message });
  }

  /* ------------------------------------------------------------ wait list */

  /** The dock's projection of the wait list: text and id, images reduced to a count. */
  private queueView(hosted: HostedSession): PiQueuedPrompt[] {
    return hosted.queue.map((item) => ({
      id: item.id,
      text: item.text,
      imageCount: item.images?.length ?? 0,
      createdAt: item.createdAt,
    }));
  }

  /**
   * Publish the wait list, alongside pi's own two queues.
   *
   * One frame carries all three because the reducer replaces the whole
   * `queued` object: a frame that named only the wait list would erase pi's
   * arrays, and vice versa.
   */
  private broadcastQueue(hosted: HostedSession): void {
    this.broadcast(hosted, {
      t: 'pi',
      event: {
        type: 'queue_update',
        steering: [...hosted.session.getSteeringMessages()],
        followUp: [...hosted.session.getFollowUpMessages()],
        pending: this.queueView(hosted),
      } as unknown as PiEvent,
    });
  }

  /**
   * Accept a message the running turn is not ready for — dsh's queue.
   *
   * Owning the list here rather than handing it to pi is what makes each row
   * addressable (steer / edit / remove) and keeps its images; `flushQueue` is
   * what eventually starts the turn that carries it.
   */
  private enqueue(hosted: HostedSession, text: string, images?: readonly ImageContent[]): QueuedPrompt {
    const item: QueuedPrompt = {
      id: crypto.randomUUID(),
      text,
      ...(images !== undefined && images.length > 0 ? { images: [...images] } : {}),
      createdAt: Date.now(),
    };
    hosted.queue.push(item);
    this.broadcastQueue(hosted);
    return item;
  }

  /**
   * One row action: dsh's `session.updateQueue`.
   *
   * `steer` is the only one that talks to pi, and only while a turn is running —
   * that is the window in which a steer is delivered (after the current
   * assistant turn's tool calls). Everything else is a local edit, so nothing
   * can be lost to a queue pi has already begun to drain.
   *
   * @returns the failure to report, or `null` when the action was applied.
   */
  private async updateQueue(
    hosted: HostedSession,
    id: string,
    action: PiQueueAction,
  ): Promise<string | null> {
    const index = hosted.queue.findIndex((item) => item.id === id);
    if (index < 0) return '这条消息已经开始发送了。';

    if (action.kind === 'remove') {
      hosted.queue.splice(index, 1);
      this.broadcastQueue(hosted);
      return null;
    }

    const item = hosted.queue[index]!;
    if (action.kind === 'edit') {
      const text = action.text.trim();
      if (text.length === 0) return '这条消息的内容不能为空。';
      hosted.queue[index] = { ...item, text };
      this.broadcastQueue(hosted);
      return null;
    }

    if (!hosted.session.isStreaming) return '仅运行中可插话发送。';
    hosted.queue.splice(index, 1);
    this.broadcastQueue(hosted);
    try {
      await hosted.session.steer(item.text, item.images);
    } catch (error) {
      // Put it back where it was: the user's message is not the failure's cost.
      hosted.queue.splice(Math.min(index, hosted.queue.length), 0, item);
      this.broadcastQueue(hosted);
      return `插话发送失败：${errorText(error)}`;
    }
    return null;
  }

  /**
   * Hand pi the next queued message once a turn has fully settled.
   *
   * One row per settle is dsh's drain rule (`next-turn` claims exactly one
   * message per turn) and it is what keeps a batch of queued instructions from
   * collapsing into a single turn. `agent_settled` is pi's "nothing left to
   * run" edge — retries and compaction included — so this cannot fire mid-run;
   * a message that fails to start stays queued and is reported instead, because
   * a failure here is not a reason to silently drop what the user wrote.
   */
  private async flushQueue(hosted: HostedSession): Promise<void> {
    if (hosted.flushing === true || !hosted.alive || hosted.queue.length === 0) return;
    if (hosted.session.isStreaming || !hosted.session.isIdle) return;
    const item = hosted.queue[0];
    if (item === undefined) return;
    hosted.flushing = true;
    try {
      // A queued row starts a new turn, so it gets the same freshness guarantee
      // as a directly submitted prompt.
      await this.refreshSubagentTool(hosted);
      let reason: string | null = null;
      const accepted = await new Promise<boolean>((resolve) => {
        void hosted.session
          .prompt(item.text, {
            ...(item.images !== undefined && item.images.length > 0 ? { images: item.images } : {}),
            preflightResult: resolve,
          })
          .catch((error: unknown) => {
            reason = errorText(error);
          });
      });
      if (!accepted) {
        this.broadcastError(
          hosted,
          `排队消息未能发送${reason === null ? '' : `：${reason}`}。它仍在待发送里。`,
        );
        return;
      }
      hosted.queue = hosted.queue.filter((entry) => entry.id !== item.id);
      this.broadcastQueue(hosted);
    } finally {
      hosted.flushing = false;
    }
  }

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
    this.broadcast(session, { t: 'exit', code: 0, signal: null });
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

  /* -------------------------------------------------------- command dispatch */

  async command(id: string, command: PiCommandEnvelope): Promise<PiRpcResponse> {
    const hosted = this.sessions.get(id);
    if (!hosted) return fail(command.type, 'unknown session', command.id);
    if (!hosted.alive) return fail(command.type, 'session is not running', command.id);
    hosted.lastSeen = Date.now();

    // Business-level idempotency, independent of the HTTP transport: a prompt
    // the host has already seen (pending or settled) is acknowledged without
    // being submitted to pi again — a retried submit must not double-send.
    const requestId = command.id;
    const idempotent = requestId !== undefined && PROMPT_COMMANDS.has(command.type);
    if (idempotent && !hosted.promptRequests.add(requestId)) {
      return ok(command.type, { accepted: true, deduplicated: true }, requestId);
    }

    try {
      const response = await this.dispatch(hosted, command);
      return command.id === undefined ? response : { ...response, id: command.id };
    } catch (error) {
      if (idempotent && requestId !== undefined) hosted.promptRequests.forget(requestId);
      return fail(command.type, errorText(error), command.id);
    }
  }

  private async dispatch(hosted: HostedSession, command: PiCommandEnvelope): Promise<PiRpcResponse> {
    const session = hosted.session;

    // Every case returns; errors propagate to command(), which releases the
    // requestId and echoes the correlation id on the response.
    switch (command.type) {
      case 'prompt': {
        if (hosted.preparing) return fail(command.type, '正在准备上一轮，请稍后再发送。');
        if (command.images?.length && !session.model?.input.includes('image')) {
          return fail(command.type, '当前模型未启用图片输入，请在模型设置中启用或选择支持图片的模型。');
        }
        /**
         * 投递方式由**服务端自己的运行状态**决定，不用客户端的「正在执行」。
         *
         * 客户端的 running 是派生视图（transcript + 快照），轮次收尾的一瞬间会
         * 落后于 pi 的 `isStreaming`。DSH 的立场是服务端从不因为「正忙」而拒绝
         * 一条用户消息：忙 + 未指定 → 进待发送队列（`busyEnter` 默认就是 queue），
         * 忙 + 显式 steer → 立刻插话进当前这轮，空闲 → 正常开一轮。
         * 客户端因此不需要猜服务端的状态，也不会因为猜错而看到一条红色报错。
         */
        /**
         * 附上的图片先规范化再交给 pi。
         *
         * 客户端给的可能是任何东西（手机直出的 HEIC 转 PNG、带 EXIF 方向的 JPEG、
         * 超大截图），而网关只收 WebP/JPEG 且会拿 `unsupported image` 把一张合法 PNG
         * 挡回来。规范化同时把字节落进内容寻址的附件库，pi 于是把**规范化后**的图写进
         * 会话日志——后面每一轮历史里带的就是这份，不需要再处理一次。
         *
         * 这一步排在「排队还是直接发」之前：排队那条路 drain 时同样把 `item.images`
         * 交给 pi，所以两条路都得拿到规范化后的那份字节。
         */
        let prepared: Awaited<ReturnType<typeof prepareIncomingImages>>;
        try {
          prepared = await prepareIncomingImages(command.images);
        } catch (error) {
          if (command.id !== undefined) hosted.promptRequests.forget(command.id);
          return fail(command.type, errorText(error), command.id);
        }
        if (command.streamingBehavior === undefined && session.isStreaming) {
          const queued = this.enqueue(hosted, command.message, prepared.images as unknown as ImageContent[]);
          return ok(command.type, { accepted: true, deliveredAs: 'queue', queuedId: queued.id });
        }
        // 空闲时忽略显式 steer：pi 的 steer 只在当前轮里有投递窗口，空闲会话上
        // 它会一直躺在队列里等一个永远不会到来的下一轮。
        const behavior = session.isStreaming ? command.streamingBehavior : undefined;
        hosted.preparing = true;
        // Before the request is built: an enabled/disabled edit made since the
        // last turn has to be visible to this turn's tool schema, and the tool
        // must not be offered at all when nothing is enabled.
        await this.refreshSubagentTool(hosted);
        /** Why the preflight said no — the client needs it to tell a race from a real refusal. */
        let reason: string | null = null;
        const accepted = new Promise<boolean>((resolve) => {
          void session
            .prompt(command.message, {
              ...(prepared.images.length > 0
                ? { images: prepared.images as unknown as ImageContent[] }
                : {}),
              ...(behavior ? { streamingBehavior: behavior } : {}),
              preflightResult: resolve,
            })
            .catch((error: unknown) => {
              reason = errorText(error);
              // 「已经有一轮在跑」是这一层的竞态，不是用户的错：下面会把它
              // 收进待发送，所以不该先给界面推一条红色报错。
              if (!(command.streamingBehavior === undefined && isAlreadyProcessing(reason))) {
                this.broadcastError(hosted, reason);
              }
            });
        });
        const success = await accepted.finally(() => {
          hosted.preparing = false;
        });
        /**
         * 竞态自愈落在服务端：判定「正忙」用的是 pi 自己的 `isStreaming`，两者
         * 之间仍有一个极窄的窗口，此时 SDK 会抛 `Agent is already processing`。
         * 用户的本意是「接着说」，所以排进待发送而不是回一条错误。
         */
        if (!success && command.streamingBehavior === undefined && reason !== null && isAlreadyProcessing(reason)) {
          if (command.id !== undefined) hosted.promptRequests.forget(command.id);
          const queued = this.enqueue(hosted, command.message, prepared.images as unknown as ImageContent[]);
          return ok(command.type, { accepted: true, deliveredAs: 'queue', queuedId: queued.id });
        }
        // A rejected preflight never becomes a durable user message: release
        // the requestId so retrying the same submit re-attempts it.
        if (!success && command.id !== undefined) hosted.promptRequests.forget(command.id);
        /**
         * `accepted: false` 一定是「这一轮起不来」。把原因一起带回去，客户端才能
         * 分辨竞态与真正的拒绝——少了这个字段，前端只能猜。
         */
        return ok(command.type, {
          accepted: success,
          ...(success || reason === null ? {} : { reason }),
          ...(behavior === undefined ? {} : { deliveredAs: behavior }),
        });
      }
      case 'steer':
        await session.steer(command.message);
        return ok(command.type);
      case 'follow_up':
        await this.refreshSubagentTool(hosted);
        await session.followUp(command.message);
        return ok(command.type);
      case 'update_queue': {
        const failure = await this.updateQueue(hosted, command.id, command.action);
        return failure === null ? ok(command.type) : fail(command.type, failure);
      }
      case 'abort':
        // An extension awaiting a dialog would otherwise keep waiting for an
        // answer to a turn the user just stopped.
        for (const dialog of hosted.pendingDialogs.values()) {
          dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
        }
        await session.abort();
        return ok(command.type);
      case 'clear_queue': {
        hosted.queue = [];
        this.broadcastQueue(hosted);
        return { type: 'response', command: command.type, success: true, data: session.clearQueue() };
      }
      case 'new_session': {
        await this.resetInPlace(hosted);
        return { type: 'response', command: command.type, success: true, data: { cancelled: false } };
      }
      case 'get_state':
        return { type: 'response', command: command.type, success: true, data: this.stateOf(hosted) };
      case 'get_messages': {
        const messages = session.messages;
        const streamingMessage = session.agent.state.streamingMessage;
        const running = session.isStreaming;
        // Captured after the list was read: pi appends to its log and emits
        // the event in the same synchronous turn, so everything the snapshot
        // reflects is already journaled and covered by `throughSeq`.
        const throughSeq = hosted.journal.latestSeq;
        return {
          type: 'response',
          command: command.type,
          success: true,
          data: {
            messages,
            throughSeq,
            running,
            streamingMessage,
            // Handed back so a reconnecting client restores the prompts an
            // extension is still waiting on, with the time each has left rather
            // than a fresh full timeout.
            pendingDialogs: [...hosted.pendingDialogs.values()].map(({ request, createdAt }) => ({
              ...request,
              ...(request.timeout === undefined
                ? {}
                : { timeout: Math.max(1, request.timeout - (Date.now() - createdAt)) }),
            })),
            // Same reason as the dialogs: the wait list lives in memory and the
            // journal frames that announced it are already behind `throughSeq`
            // for a client that is opening the session now.
            queue: this.queueView(hosted),
          },
        };
      }
      case 'set_model': {
        const runtime = await this.runtime();
        const resolved = resolveCliModel({
          cliModel: `${command.provider}/${command.modelId}`,
          modelRuntime: runtime,
        });
        if (resolved.error) return fail(command.type, resolved.error);
        if (!resolved.model) return fail(command.type, 'model not found');
        await session.setModel(resolved.model);
        return { type: 'response', command: command.type, success: true, data: asModel(session.model) };
      }
      case 'cycle_model': {
        const result = await session.cycleModel();
        return { type: 'response', command: command.type, success: true, data: result ?? null };
      }
      case 'get_available_models': {
        const runtime = await this.runtime();
        const models = await runtime.getAvailable();
        return { type: 'response', command: command.type, success: true, data: { models } };
      }
      case 'set_thinking_level':
        session.setThinkingLevel(command.level);
        return ok(command.type);
      case 'cycle_thinking_level':
        return { type: 'response', command: command.type, success: true, data: { level: session.cycleThinkingLevel() ?? session.thinkingLevel } };
      case 'get_available_thinking_levels':
        return { type: 'response', command: command.type, success: true, data: { levels: this.thinkingLevels(hosted) } };
      case 'set_steering_mode':
        session.setSteeringMode(command.mode);
        return ok(command.type);
      case 'set_follow_up_mode':
        session.setFollowUpMode(command.mode);
        return ok(command.type);
      case 'compact':
        return { type: 'response', command: command.type, success: true, data: await session.compact(command.customInstructions) };
      case 'get_session_stats': {
        // The context-window percentage is this command's answer, so a config
        // edited under a running session must be picked up before it is computed.
        await this.syncModelConfig();
        return { type: 'response', command: command.type, success: true, data: this.statsOf(hosted) };
      }
      case 'set_session_name':
        session.setSessionName(command.name);
        hosted.sessionName = command.name;
        return ok(command.type);
      case 'get_tools': {
        // pi-web's shape: every tool, each flagged with whether it is active, so
        // a panel can show what a preset turned off.
        const active = new Set(hosted.session.getActiveToolNames());
        return {
          type: 'response',
          command: command.type,
          success: true,
          data: {
            tools: hosted.session.getAllTools().map((tool) => ({
              name: tool.name,
              description: tool.description,
              active: active.has(tool.name),
            })),
            selection: hosted.toolSelection ?? hosted.session.getActiveToolNames(),
          },
        };
      }
      case 'set_tools': {
        const requested = validateToolSelection((command as unknown as { toolNames?: unknown }).toolNames);
        if (requested === undefined) {
          return fail(command.type, 'toolNames 必须是内置工具名数组');
        }
        this.setToolSelection(hosted, requested, { persist: true });
        return { type: 'response', command: command.type, success: true, data: { toolNames: requested } };
      }
      case 'get_commands':
        return {
          type: 'response',
          command: command.type,
          success: true,
          // The merged list: extension commands, prompt templates and skills.
          // pi built it while loading resources, and its runtime is the only
          // public accessor — the runner that assembles it is private to
          // `createAgentSession`.
          data: { commands: this.commandsOf(hosted) },
        };
      case 'extension_ui_response': {
        const answered = this.respondToDialog(command.id, {
          type: 'extension_ui_response',
          id: command.id,
          ...(command.value === undefined ? {} : { value: command.value }),
          ...(command.confirmed === undefined ? {} : { confirmed: command.confirmed }),
          ...(command.cancelled === undefined ? {} : { cancelled: command.cancelled }),
        });
        if (!answered) return fail(command.type, `no extension dialog is waiting on id ${command.id}`);
        return ok(command.type);
      }
      case 'set_auto_compaction':
      case 'set_auto_retry':
      case 'export_html':
      case 'bash':
      case 'abort_bash':
        return fail(command.type, `${command.type} is not supported by the SDK host yet`);
      default:
        return fail(command.type, `unknown command: ${(command as { type: string }).type}`);
    }
  }

  /**
   * The session's slash commands, as the browser's command menu needs them.
   *
   * Sending `/name args` as a prompt is enough to run one: `session.prompt`
   * dispatches extension commands and expands skill and prompt-template commands
   * by default, so this list only has to be accurate, not executable here.
   */
  private commandsOf(hosted: HostedSession): Array<{
    name: string;
    description?: string;
    source?: string;
  }> {
    try {
      const commands = hosted.extensionsResult.runtime.getCommands();
      return commands.map((entry) => ({
        name: entry.name,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.source === undefined ? {} : { source: entry.source }),
      }));
    } catch (error) {
      this.broadcastError(hosted, `无法读取斜杠命令列表：${errorText(error)}`);
      return [];
    }
  }

  private stateOf(hosted: HostedSession): PiSessionState {    const { session } = hosted;
    return {
      model: asModel(session.model),
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      sessionFile: session.sessionFile ?? null,
      sessionId: session.sessionId,
      sessionName: hosted.sessionName ?? undefined,
      messageCount: session.messages.length,
      pendingMessageCount: hosted.queue.length,
    };
  }

  private statsOf(hosted: HostedSession): PiSessionStats {
    const { session } = hosted;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    for (const message of session.messages) {
      if (message.role === 'user') userMessages += 1;
      if (message.role === 'assistant') {
        assistantMessages += 1;
        for (const block of message.content) {
          if (block.type === 'toolCall') toolCalls += 1;
        }
        const usage = message.usage;
        if (usage) {
          input += usage.input ?? 0;
          output += usage.output ?? 0;
          cacheRead += usage.cacheRead ?? 0;
          cacheWrite += usage.cacheWrite ?? 0;
          cost += usage.cost?.total ?? 0;
        }
      }
    }
    const contextWindow = session.model?.contextWindow ?? 0;
    const tokens = input + output;
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      model: asModel(session.model),
      thinkingLevel: session.thinkingLevel,
      totalMessages: session.messages.length,
      userMessages,
      assistantMessages,
      toolCalls,
      totalTokens: tokens,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalCost: cost,
      contextUsage:
        contextWindow > 0
          ? { tokens, contextWindow, percent: Math.round((tokens / contextWindow) * 100) }
          : null,
    };
  }

  /**
   * Levels this session's model actually accepts.
   *
   * Mirrors pi's own `getSupportedThinkingLevels` (`pi-ai/dist/models.js`),
   * because it is the same function `session.setThinkingLevel` clamps against:
   * a model that does not reason supports `off` alone, and a model that does
   * supports the extended list minus every level its `thinkingLevelMap` pins to
   * `null` — with `xhigh`/`max` counted as supported only when the map names
   * them explicitly. Reporting the global vocabulary here (as this used to) told
   * the browser about levels every request would be clamped away from.
   */
  private thinkingLevels(hosted: HostedSession): ModelThinkingLevel[] {
    const model = hosted.session.model as
      | { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }
      | undefined;
    if (model?.reasoning !== true) return ['off'];
    const levels = ([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ] as const).filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (level === 'xhigh' || level === 'max') return mapped !== undefined;
      return true;
    });
    return levels as unknown as ModelThinkingLevel[];
  }

  /** Fresh conversation in the same hosted session, mirroring pi's `new_session`. */
  private async resetInPlace(hosted: HostedSession): Promise<void> {
    hosted.alive = false;
    void hosted.session.abort().catch(() => undefined);
    hosted.queue = [];
    for (const dialog of hosted.pendingDialogs.values()) {
      dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
    }
    const cwd = hosted.cwd;
    const model = hosted.session.model;
    const thinking = hosted.session.thinkingLevel;
    const runtime = await this.runtime();

    // A worker outliving the conversation that started it would keep answering
    // into a transcript nobody reads; stop it before the old session goes away.
    await this.cancelWorkersFor(hosted.id);

    try {
      hosted.unsubscribe?.();
      hosted.session.dispose();
    } catch {
      // Recreate regardless.
    }

    const customTools: ToolDefinition[] = [];
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      ...(model ? { model } : {}),
      thinkingLevel: thinking,
      modelRuntime: runtime,
      sessionManager: SessionManager.create(cwd, this.sessionDir),
      customTools,
      ...this.settingsOption(cwd),
    });
    if (this.closing || this.sessions.get(hosted.id) !== hosted) {
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
      this.teams.cancelTeam(hosted.teamId, '会话已重置。');
      this.teams.dropTeam(hosted.teamId);
      hosted.teamId = null;
    }
    if (hosted.teamMode) hosted.teamId = this.teams.createTeam(hosted.id).id;
    hosted.unsubscribe = session.subscribe((event) => this.onEvent(hosted, event));
    await this.bindExtensions(session, hosted);
    await this.refreshSubagentTool(hosted);
  }
}

function ok(command: string, data?: unknown, id?: string): PiRpcResponse {
  return {
    type: 'response',
    ...(id === undefined ? {} : { id }),
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  };
}

function fail(command: string, error: string, id?: string): PiRpcResponse {
  return {
    type: 'response',
    ...(id === undefined ? {} : { id }),
    command,
    success: false,
    error,
  };
}
