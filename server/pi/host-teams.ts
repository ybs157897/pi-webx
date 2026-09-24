/**
 * 团队模式与子智能体工具面：定义合并、dispatch 工具的挂载/刷新、Team 编排工具、
 * journal 重放（hydrate）与投递（P3-B）。
 *
 * 全部函数的第一个参数是 `HostInternals`；这一组行为围绕 host 的团队运行时
 * （teams/journal/teamInjector/workerRunner/definitions）工作，本身不持状态。
 */
import type { AgentDefinition, AgentDefinitionsResponse } from '../../src/shared/agent-definitions';
import { SUBAGENT_TOOL_NAME } from '../../src/shared/agent-definitions';
import type { TeamProjection } from '../agent-team/team-types';
import {
  createOrchestratorTeamTools,
  createWorkerTeamTools,
  type TeamDispatchRequest,
} from '../agent-team/team-tools';
import { TEAM_ORCHESTRATOR_TOOL_NAMES } from '../agent-team/team-types';
import { createIsolatedToolDefinitions } from '../agent-team/sandbox-tools';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { mergeBuiltinAndUserAgents } from '../builtin-agents';
import { createExtensionUiScope } from './extension-ui';
import {
  createSubagentTool,
  enabledDefinitions,
  freezeDefinition,
  nextActiveTools,
  type SubagentDispatchOutcome,
  type SubagentDispatchRequest,
  type SubagentToolDeps,
} from './subagent-tool';
import { broadcastError } from './host-events';
import { errorText, sameNames } from './host-contract';
import type { HostInternals, HostedSession } from './host-contract';
import type { TeamLiveSession } from '../agent-team/team-inject';

/**
 * The definitions a session dispatches from: the shipped built-ins merged with
 * whatever the user stored.
 *
 * One merge point serves both readers — the tool description a session offers
 * the model, and the lookup a dispatch performs — so a `builtin:` id resolves
 * exactly when it is listed. A user definition with a built-in's name shadows
 * it (`mergeBuiltinAndUserAgents`).
 */
export async function mergedDefinitions(host: HostInternals): Promise<AgentDefinitionsResponse> {
  const response = await host.definitions.read();
  return { ...response, agents: mergeBuiltinAndUserAgents(response.agents) };
}

/** What the dispatch tool needs from one hosted session. */
export function subagentToolDeps(host: HostInternals, hosted: HostedSession): SubagentToolDeps {
  return {
    definitions: () => mergedDefinitions(host),
    /**
     * Read live, per dispatch: `getActiveToolNames()` is the permission
     * boundary — the preset the user chose — while `getAllTools()` is only the
     * catalogue. Handing over the catalogue once gave a `read`/`grep` session a
     * child with `bash`, `write` and `edit`.
     */
    parentActiveTools: () => hosted.session.getActiveToolNames(),
    dispatch: (request: SubagentDispatchRequest): Promise<SubagentDispatchOutcome> => (
      hosted.alive ? host.workerRunner.dispatch({
        sessionId: hosted.id,
        cwd: hosted.cwd,
        agentDir: getAgentDir(),
        session: hosted.session,
        createUiScope: (origin, signal) => createExtensionUiScope(host.extensionUiOwner(hosted), { origin, signal }),
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
export async function refreshSubagentTool(host: HostInternals, hosted: HostedSession): Promise<void> {
  if (!hosted.alive) return;
  // Team mode has its own tool面, and it is not additive to `subagent`: the
  // orchestrator dispatches through `dispatch_agent` only, so the single-shot
  // tool is never registered there (two dispatch mechanisms in one session
  // would be two ways to do the same thing, with different lifecycles).
  if (hosted.teamId !== null) return refreshTeamTools(host, hosted);
  let definitions: AgentDefinition[] = [];
  try {
    // Merged: the built-ins are enabled by construction, so a user who has
    // stored nothing still gets a dispatch tool listing `general-purpose` and
    // `Explore` (`builtin:` ids).
    definitions = enabledDefinitions(await mergedDefinitions(host));
  } catch (error) {
    broadcastError(host, hosted, `子智能体定义读取失败：${errorText(error)}`);
  }

  const activeBefore = hosted.session.getActiveToolNames();
  const carried = activeBefore.filter((name) => name !== SUBAGENT_TOOL_NAME);
  const frozen = definitions.map(freezeDefinition);
  const tools = frozen.length === 0 ? [] : [createSubagentTool(subagentToolDeps(host, hosted), frozen)];
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
export async function cancelWorkersFor(host: HostInternals, parentId: string): Promise<void> {
  await host.workerRunner.cancelParent(parentId);
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
export async function hydrateTeams(host: HostInternals): Promise<{
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
  const known = new Set(host.teams.listTeams());
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
    teamIds = host.journal.listTeamIds();
  } catch {
    // An unreadable journal directory is a reason to start with no Teams, not a
    // reason to refuse to start.
    teamIds = [];
  }
  for (const teamId of teamIds) {
    if (known.has(teamId)) continue;
    try {
      const read = host.journal.readTeam(teamId);
      if (read === undefined) continue;
      files += 1;
      bytes += read.bytes;
      skipped += read.skipped.length;
      const result = host.teams.hydrate({ teamId, records: read.records });
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
    ...(host.journal.disabled === undefined ? {} : { journalDisabled: host.journal.disabled }),
  };
}

/** Where the Team journal lives; surfaced for operators and tests. */
export function teamJournalDir(host: HostInternals): string {
  return host.journal.directory;
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
export function liveTeamSession(host: HostInternals, teamId: string): TeamLiveSession | undefined {
  const team = host.teams.get(teamId);
  if (team === undefined) return undefined;
  const hosted = [...host.sessions.values()].find((session) => session.teamId === teamId);
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
export async function deliverTeamInbox(host: HostInternals, teamId: string): Promise<void> {
  try {
    await host.teamInjector.deliverPending(teamId);
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
export async function refreshTeamTools(host: HostInternals, hosted: HostedSession): Promise<void> {
  const teamId = hosted.teamId;
  if (teamId === null || !hosted.alive) return;
  let definitions: AgentDefinition[] = [];
  try {
    definitions = enabledDefinitions(await mergedDefinitions(host));
  } catch (error) {
    broadcastError(host, hosted, `子智能体定义读取失败：${errorText(error)}`);
  }

  const tools = createOrchestratorTeamTools({
    teamId,
    runtime: host.teams,
    definitions: () => mergedDefinitions(host),
    parentActiveTools: () => hosted.session.getActiveToolNames(),
    dispatch: (request) => dispatchTeamMember(host, hosted, request),
  }, definitions);
  hosted.customTools.splice(
    0, hosted.customTools.length,
    ...tools, ...createIsolatedToolDefinitions(hosted.cwd, getAgentDir()),
  );
  hosted.extensionsResult.runtime.refreshTools();

  const activeBefore = hosted.session.getActiveToolNames();
  const carried = [...new Set(activeBefore
    .map((name) => process.platform === 'win32' && name === 'bash' ? 'powershell' : name)
    .filter((name) => name !== SUBAGENT_TOOL_NAME && !TEAM_ORCHESTRATOR_TOOL_NAMES.includes(name)))];
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
export function dispatchTeamMember(
  host: HostInternals,
  hosted: HostedSession,
  request: TeamDispatchRequest,
): Promise<SubagentDispatchOutcome> {
  if (!hosted.alive) return Promise.reject(new Error('父会话已关闭，不能派发成员。'));
  return host.workerRunner.dispatch({
    sessionId: hosted.id,
    cwd: hosted.cwd,
    agentDir: getAgentDir(),
    session: hosted.session,
    createUiScope: (origin, signal) => createExtensionUiScope(host.extensionUiOwner(hosted), { origin, signal }),
  }, {
    definition: request.definition,
    task: request.instruction,
    surface: request.surface,
    signal: request.signal,
    onUpdate: request.onUpdate,
    memberTools: createWorkerTeamTools({
      teamId: request.teamId,
      memberId: request.memberId,
      runtime: host.teams,
    }),
    isolateCodingTools: true,
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
export function resolveTeamId(host: HostInternals, idOrSessionId: string): string | undefined {
  if (host.teams.get(idOrSessionId) !== undefined) return idOrSessionId;
  // A Team rebuilt from the journal knows the session that created it, even when
  // that session never wrote a transcript (a run with no assistant turn) and so
  // cannot be found in the live table — which is why this index exists and comes
  // before it.
  const replayed = host.teams.findTeamByParentSession(idOrSessionId);
  if (replayed !== undefined) return replayed;
  return host.sessions.get(idOrSessionId)?.teamId ?? undefined;
}

/**
 * The read-only projection `GET /api/teams/:id` serves; `undefined` means 404.
 *
 * `:id` may be a team id or the parent session's id — see `resolveTeamId`.
 */
export function teamSnapshot(host: HostInternals, idOrSessionId: string): TeamProjection | undefined {
  const teamId = resolveTeamId(host, idOrSessionId);
  return teamId === undefined ? undefined : host.teams.snapshot(teamId);
}

/**
 * `POST /api/teams/:id/cancel`: ask every running member to stop.
 *
 * Cancellation is cooperative — this reports how many were asked, not that they
 * have stopped. `undefined` means neither a team nor a team-mode session matched
 * the identifier. The resolved `teamId` is returned so a client that only knew
 * the session id can address the team canonically from then on.
 */
export function cancelTeam(
  host: HostInternals,
  idOrSessionId: string,
  reason?: string,
): { teamId: string; cancelled: number } | undefined {
  const teamId = resolveTeamId(host, idOrSessionId);
  if (teamId === undefined) return undefined;
  return { teamId, cancelled: host.teams.cancelTeam(teamId, reason) };
}
