/**
 * host 的契约层：导出类型、常量与纯工具函数，外加 `HostInternals` 内部接口。
 *
 * `PiHost` 的按职责拆分模块（host-commands / host-teams / host-session-assembly /
 * host-events）都只依赖这里的类型与本接口，不 import 彼此的私有状态——模块声明自己
 * 需要的最小依赖面，`PiHost` 以结构化类型自动满足。
 */
import { stat } from 'node:fs/promises';

import type { ImageContent, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type {
  AgentSession,
  AgentSessionEvent,
  LoadExtensionsResult,
  SettingsManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiExtensionUiRequest, PiExtensionUiResponse, PiModel, PiRpcResponse } from '../../src/shared/protocol';
import type { PendingExtensionDialog } from './extension-ui';
import type { SessionCapacity, SessionReservation } from './session-capacity';
import type { PromptRequests, SessionJournal } from './session-journal';
import type { SubagentWorkerRunner } from './subagent-worker';
import type { AgentDefinitionStore } from '../agent-definitions';
import type { AgentTeamRuntime } from '../agent-team/team-runtime';
import type { TeamInjector } from '../agent-team/team-inject';
import type { TeamJournal } from '../agent-team/team-journal';

export const MAX_SESSIONS = 12;
/** Sweep dead sessions with no subscribers after this long. */
export const SWEEP_AFTER_MS = 10 * 60_000;

/** Commands whose submit is idempotent by requestId, like dsh's prompt path. */
export const PROMPT_COMMANDS = new Set(['prompt', 'steer', 'follow_up']);

export interface HostSubscriber {
  frame: (entry: import('../../src/shared/protocol').JournalEntry) => void;
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
   * single-shot `subagent` tool. The Team's own state lives in the host's
   * team runtime — **in memory only**, so a restart loses every member,
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
  /** Create a Team, or reattach the stored Team when resuming its conversation. */
  teamMode?: boolean;
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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether two tool-name lists hold the same names, ignoring order. */
export function sameNames(left: readonly string[], right: readonly string[]): boolean {
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

export function isAlreadyProcessing(message: string): boolean {
  return ALREADY_PROCESSING.test(message);
}

export function asModel(model: Model<any> | undefined | null): PiModel | null {
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
export async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return 'gone';
  }
}

export function ok(command: string, data?: unknown, id?: string): PiRpcResponse {
  return {
    type: 'response',
    ...(id === undefined ? {} : { id }),
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  };
}

export function fail(command: string, error: string, id?: string): PiRpcResponse {
  return {
    type: 'response',
    ...(id === undefined ? {} : { id }),
    command,
    success: false,
    error,
  };
}

/**
 * `PiHost` 的内部依赖面：拆分模块（host-commands / host-teams / host-events /
 * host-session-assembly）只看见这个接口，看不见 PiHost 的其余成员。
 *
 * 这些成员在 `PiHost` 上以 `@internal` 标注为公开——同一包内的协作模块用，
 * 不构成对外 API。新增拆分模块时，把它需要的成员加进来即可。
 */
export interface HostInternals {
  readonly sessions: Map<string, HostedSession>;
  readonly teams: AgentTeamRuntime;
  readonly journal: TeamJournal;
  readonly teamInjector: TeamInjector;
  readonly workerRunner: SubagentWorkerRunner;
  readonly definitions: Pick<AgentDefinitionStore, 'read'>;
  readonly sessionCapacity: SessionCapacity;
  readonly sessionDir: string | undefined;
  readonly closing: boolean;
  runtime(): Promise<ModelRuntime>;
  syncModelConfig(force?: boolean): Promise<boolean>;
  settingsOption(cwd: string): { settingsManager?: SettingsManager };
  applyInitialToolSelection(
    hosted: HostedSession,
    sessionManager: import('@earendil-works/pi-coding-agent').SessionManager,
    requested: readonly string[] | undefined,
  ): void;
  setToolSelection(hosted: HostedSession, toolNames: readonly string[], options: { persist: boolean }): void;
  bindExtensions(session: AgentSession, hosted: HostedSession): Promise<void>;
  extensionUiOwner(hosted: HostedSession): {
    pendingDialogs: Map<string, PendingExtensionDialog>;
    isAlive: () => boolean;
    publish: (request: PiExtensionUiRequest) => void;
  };
  onEvent(hosted: HostedSession, event: AgentSessionEvent): void;
  respondToDialog(id: string, response: PiExtensionUiResponse): boolean;
}
