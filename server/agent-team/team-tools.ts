/**
 * Team 的模型侧工具面：编排者的 9 个 + 成员的 2 个。
 *
 * 两条边界写在这里，而不是靠调用方自觉：
 *
 *   1. **表单里没有身份字段。** `from`/`to`/`teamId`/`ownerMemberId` 都不在任何工具的参数
 *      列表里——它们由宿主可信上下文填。模型传了这些键会被 {@link rejectUnknownKeys} 拒绝，
 *      不是被忽略。
 *   2. **定义是唯一真值。** `dispatch_agent` 只接受 `definitionId` +
 *      `expectedDefinitionRevision`；`model`/`systemPrompt`/`tools`/`maxTurns` 之类的覆写键
 *      一律拒绝（`TEAM_OVERRIDE_REJECTED`），因为那等于让模型自己造一个定义。
 *
 * 失败一律**抛出**（`TeamError`，带稳定 code）：SDK 只有 throw 才会把工具调用标成
 * `isError: true`，而返回结果会被当成成功——这与 `subagent` 工具同一条约定。
 */

import { Type } from 'typebox';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import type { AgentDefinition, AgentDefinitionsResponse, AgentToolPolicy } from '../../src/shared/agent-definitions';
import {
  frameWorkerOutput,
  freezeDefinition,
  planToolSurface,
  type FrozenDefinition,
  type SubagentDispatchOutcome,
  type ToolSurface,
} from '../pi/subagent-tool';
import { AgentTeamRuntime } from './team-runtime';
import {
  TEAM_ERROR_CODES,
  TEAM_LEAD_ID,
  TEAM_ORCHESTRATOR_TOOL_NAMES,
  TEAM_WORKER_FORBIDDEN_TOOL_NAMES,
  TEAM_WORKER_TOOL_NAMES,
  TeamError,
  type TeamMessageKind,
  type TeamTaskStatus,
} from './team-types';

/** 定义字段的覆写键：出现即拒绝，理由要对模型说清楚，否则它会换个拼法再试一次。 */
const OVERRIDE_KEYS: readonly string[] = [
  'model', 'modelId', 'provider', 'providerId', 'thinkingLevel',
  'systemPrompt', 'prompt', 'tools', 'allowedTools', 'toolNames',
  'maxTurns', 'maxConcurrentInstances', 'color', 'injectAgentsMd',
];

/** 一次成员派发请求。宿主把它接到现有 worker 派发上（capacity/租约/取消都不变）。 */
export interface TeamDispatchRequest {
  readonly teamId: string;
  readonly memberId: string;
  readonly definition: FrozenDefinition;
  readonly instruction: string;
  readonly surface: ToolSurface;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: ((note: string) => void) | undefined;
}

/** 编排者工具需要宿主提供的东西。全部注入，没有 import 宿主。 */
export interface OrchestratorTeamToolDeps {
  readonly teamId: string;
  readonly runtime: AgentTeamRuntime;
  /** 合并后的定义列表（内置 + 用户，同名遮蔽规则与 dispatch 一致）。 */
  readonly definitions: () => Promise<AgentDefinitionsResponse>;
  /** 编排者会话当前 active 的工具：成员工具面的天花板。 */
  readonly parentActiveTools: () => readonly string[];
  /** 排一个成员并跑到结束。失败抛错。 */
  readonly dispatch: (request: TeamDispatchRequest) => Promise<SubagentDispatchOutcome>;
}

/** 成员工具需要的身份：宿主在派发时绑定，模型无从提供。 */
export interface WorkerTeamToolDeps {
  readonly teamId: string;
  readonly memberId: string;
  readonly runtime: AgentTeamRuntime;
}

/**
 * 成员的工具面：定义自己的工具（按既有规则求交）∪ 两个成员工具，减掉全部编排工具。
 *
 * 「既有规则」就是 {@link planToolSurface}：`all` 以父会话 active 为上限，`selected` 仍须在
 * 父会话里有（只读豁免照旧），任何 dispatch/管理类名字一律先被排除。这里再补两条：
 * 9 个编排工具一个都不进成员会话，而两个成员工具一定在——成员要能更新自己任务、能给 lead 回信。
 */
export function planMemberToolSurface(
  policy: AgentToolPolicy,
  parentActiveTools: readonly string[],
): ToolSurface {
  const base = planToolSurface(policy, parentActiveTools);
  const requested = [...new Set(policy.mode === 'all' ? [...parentActiveTools] : [...policy.names])];
  const orchestrationRequested = requested.filter((name) => TEAM_ORCHESTRATOR_TOOL_NAMES.includes(name));
  const names = [
    ...base.toolNames.filter((name) => !TEAM_ORCHESTRATOR_TOOL_NAMES.includes(name)),
    ...TEAM_WORKER_TOOL_NAMES,
  ];
  return {
    toolNames: [...new Set(names)],
    excluded: [...new Set([...base.excluded, ...orchestrationRequested])],
    // 两个成员工具由宿主提供，不因「父会话没启用」而算缺失。
    unavailable: base.unavailable.filter((name) => !TEAM_WORKER_TOOL_NAMES.includes(name)),
  };
}

/**
 * Parameter gate: the **first** offending key decides the error, and the message
 * says which of the three kinds it is, so the model learns the rule instead of
 * guessing (`不可覆写的定义字段` / `宿主填写的身份字段` / `未知参数`).
 */
function rejectUnknownKeys(toolName: string, params: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${toolName} 的参数必须是对象。`);
  }
  const record = params as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    if (OVERRIDE_KEYS.includes(key)) {
      throw new TeamError(
        TEAM_ERROR_CODES.overrideRejected,
        `${toolName} 的第 1 个违规键 ${key} 属于「不可覆写的定义字段」：模型不能覆写定义的模型/提示词/工具/轮数——`
        + '定义是唯一真值，要改请让用户在设置里改定义。',
        { key, kind: 'definition-field' },
      );
    }
    if (key === 'from' || key === 'to' || key === 'teamId' || key === 'ownerMemberId' || key === 'memberId') {
      throw new TeamError(
        TEAM_ERROR_CODES.overrideRejected,
        `${toolName} 的第 1 个违规键 ${key} 属于「宿主填写的身份字段」：身份与收件人由宿主上下文填写，模型不能指定。`,
        { key, kind: 'identity-field' },
      );
    }
    throw new TeamError(
      TEAM_ERROR_CODES.invalidArguments,
      `${toolName} 的第 1 个违规键 ${key} 属于「未知参数」：本工具只接受 ${allowed.join('、') || '（无参数）'}。`,
      { key, kind: 'unknown-argument' },
    );
  }
  return record;
}

function requireString(toolName: string, value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${toolName} 的 ${key} 必须是非空字符串。`, { key });
  }
  return value;
}

function requireRevision(toolName: string, value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${toolName} 的 ${key} 必须是 ≥1 的整数。`, { key });
  }
  return value;
}

function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${key} 必须是字符串数组。`, { key });
  }
  return [...value] as string[];
}

/**
 * The definition list `dispatch_agent`'s description carries.
 *
 * One line per **enabled** definition, and each line must let the model do three
 * things without another tool: name it (`definitionId`), recognise it (`name` +
 * one-line description) and echo a revision that is current (`revision`).
 *
 * What is deliberately absent, and why it must stay absent:
 *
 *   - **disabled definitions** — a dispatch would be refused, so listing them only
 *     invites a refusal;
 *   - **built-ins a same-named user definition shadowed** — the caller passes the
 *     *merged* list (`mergeBuiltinAndUserAgents`), where the shadowed builtin is
 *     already gone; this function must never re-add from the store;
 *   - **the orchestrator role itself** ({@link TEAM_ORCHESTRATOR_ROLE}) — it is not
 *     an `AgentDefinition`, is not dispatchable and is not user-editable.
 *
 * The list is only as fresh as the last refresh: `host.ts`'s `refreshTeamTools`
 * recomputes it on every prompt in team mode, which is what makes "revision from
 * this list" a safe thing to demand.
 */
export function renderDispatchAgentDescription(definitions: readonly AgentDefinition[]): string {
  const enabled = definitions.filter((definition) => definition.enabled);
  const lines = enabled.map((definition) => {
    const tools = definition.tools.mode === 'all' ? '继承父会话可用工具' : definition.tools.names.join(', ');
    const description = definition.description.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    return `- ${definition.id} (rev ${definition.revision}) — ${definition.name}：${description} [tools: ${tools || '无'}]`;
  });
  return [
    '把一个任务派给某个已启用的子智能体定义，并等它跑完。',
    'expectedDefinitionRevision 必须原样使用**下面清单里的** revision；不要复用上一轮的 revision，也不要复用 requestId：'
    + 'requestId 一经使用不可复用，重复使用会被拒绝（要再次派发请换新的 requestId）。',
    `revision 过期会返回 ${TEAM_ERROR_CODES.definitionRevisionStale}，请重新读取本清单后再派。`,
    '不接受 model/systemPrompt/tools/maxTurns 等覆写参数：定义是唯一真值，要改定义请让用户在设置里改。',
    '可用定义：',
    ...(lines.length === 0 ? ['（当前没有已启用的定义）'] : lines),
  ].join('\n');
}

interface ToolBodyContext {
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: ((note: string) => void) | undefined;
}

interface ToolBodyResult {
  readonly text: string;
  readonly details: Record<string, unknown>;
}

/** 把一个 team 工具包成 SDK 工具：参数门禁 + 文本/details 双通道 + 失败抛出。 */
function teamTool(spec: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: ToolDefinition['parameters'];
  readonly allowedKeys: readonly string[];
  readonly body: (args: Record<string, unknown>, ctx: ToolBodyContext) => Promise<ToolBodyResult>;
}): ToolDefinition {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const args = rejectUnknownKeys(spec.name, params, spec.allowedKeys);
      const note = onUpdate === undefined ? undefined : (text: string): void => {
        onUpdate({ content: [{ type: 'text', text }], details: {} });
      };
      const result = await spec.body(args, { signal, onUpdate: note });
      return { content: [{ type: 'text', text: result.text }], details: result.details };
    },
  };
}

/**
 * 编排者的 9 个工具。
 *
 * 工具数量与名字是冻结契约：check 会断言 `TEAM_ORCHESTRATOR_TOOL_NAMES` 与这里产出的
 * 名字集合**完全相等**（一个不多一个不少）。启用定义清单渲染进 `dispatch_agent` 的描述
 * （见 {@link renderDispatchAgentDescription}），而不是新加第 10 个「列定义」工具。
 *
 * `definitions` 是**这一次**渲染用的清单；Team 模式下由 `host.ts` 的 `refreshTeamTools`
 * 每轮重算，因此描述里的 revision 在调用它的那一轮是新鲜的——这也是描述敢要求模型
 * 「必须用本清单的 revision」的前提。
 */
export function createOrchestratorTeamTools(
  deps: OrchestratorTeamToolDeps,
  definitions: readonly AgentDefinition[],
): ToolDefinition[] {
  const { runtime, teamId } = deps;

  const listMembers = teamTool({
    name: 'list_team_members',
    label: 'List team members',
    description: '列出本 Team 的成员：定义、状态、是否有结果。结果文本用 wait_team 取。',
    parameters: Type.Object({}),
    allowedKeys: [],
    async body() {
      const team = runtime.requireTeam(teamId);
      const members = [...team.members.values()].map((member) => ({
        memberId: member.id,
        definitionId: member.definitionId,
        definitionRevision: member.definitionRevision,
        status: member.status,
        createdAt: member.createdAt,
        hasResult: member.resultText !== undefined,
      }));
      return {
        text: members.length === 0 ? '当前没有成员。' : members.map((m) => `${m.memberId} ${m.definitionId} rev${m.definitionRevision} ${m.status}`).join('\n'),
        details: { members },
      };
    },
  });

  const dispatchAgent = teamTool({
    name: 'dispatch_agent',
    label: 'Dispatch agent',
    description: renderDispatchAgentDescription(definitions),
    parameters: Type.Object({
      definitionId: Type.String(),
      expectedDefinitionRevision: Type.Integer(),
      instruction: Type.String(),
      taskId: Type.Optional(Type.String()),
      requestId: Type.Optional(Type.String()),
    }),
    allowedKeys: ['definitionId', 'expectedDefinitionRevision', 'instruction', 'taskId', 'requestId'],
    async body(args, ctx) {
      const definitionId = requireString('dispatch_agent', args.definitionId, 'definitionId');
      const expectedRevision = requireRevision('dispatch_agent', args.expectedDefinitionRevision, 'expectedDefinitionRevision');
      const instruction = requireString('dispatch_agent', args.instruction, 'instruction');
      const requestId = typeof args.requestId === 'string' ? args.requestId : undefined;
      if (requestId !== undefined) {
        // Pure refusal: this runs before any member is created, any task is
        // claimed or any message is recorded, so a repeat request has **zero**
        // side effects — it cannot even bump a revision.
        const owner = runtime.requestOwner(teamId, requestId);
        if (owner !== undefined) {
          const status = runtime.get(teamId)?.members.get(owner)?.status ?? '已不存在的成员';
          throw new TeamError(
            TEAM_ERROR_CODES.requestDuplicate,
            `requestId ${requestId} 已经用于成员 ${owner}（状态 ${status}）；本次没有创建或改动任何成员/任务/消息。`
            + '要查那次的结果用 list_team_members / wait_team；要再派一次请换一个新的 requestId。',
            { requestId, memberId: owner, status },
          );
        }
      }

      const response = await deps.definitions();
      const stored = response.agents.find((definition) => definition.id === definitionId);
      if (stored === undefined) {
        throw new TeamError(
          TEAM_ERROR_CODES.definitionUnknown,
          `没有 id 为 ${definitionId} 的子智能体定义。可用：${response.agents.map((d) => d.id).join('、') || '（无）'}。`,
          { definitionId },
        );
      }
      if (!stored.enabled) {
        throw new TeamError(
          TEAM_ERROR_CODES.definitionDisabled,
          `子智能体「${stored.name}」已停用，不能派发（停用不杀在跑成员，只拦新派发）。`,
          { definitionId },
        );
      }
      if (stored.revision !== expectedRevision) {
        throw new TeamError(
          TEAM_ERROR_CODES.definitionRevisionStale,
          `定义 ${definitionId} 的 revision 已从 ${expectedRevision} 变成 ${stored.revision}：`
          + '请重新读取 dispatch_agent 描述里的清单后再派。',
          { definitionId, expectedRevision, currentRevision: stored.revision },
        );
      }

      const definition = freezeDefinition(stored);
      const member = runtime.addMember({ teamId, definition });
      if (requestId !== undefined) runtime.rememberRequest(teamId, requestId, member.id);
      if (args.taskId !== undefined) {
        const taskId = requireString('dispatch_agent', args.taskId, 'taskId');
        runtime.assignTask(teamId, taskId, member.id);
      }

      const surface = planMemberToolSurface(definition.tools, deps.parentActiveTools());
      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort(ctx.signal?.reason);
      if (ctx.signal !== undefined) {
        if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
        else ctx.signal.addEventListener('abort', onParentAbort, { once: true });
      }
      runtime.registerMemberCancel(member.id, (reason) => controller.abort(reason));
      try {
        const outcome = await deps.dispatch({
          teamId,
          memberId: member.id,
          definition,
          instruction,
          surface,
          signal: controller.signal,
          onUpdate: ctx.onUpdate,
        });
        runtime.settleMember({
          teamId,
          memberId: member.id,
          status: 'idle',
          text: outcome.text,
          sessionId: outcome.runId,
        });
        return {
          text: frameWorkerOutput(outcome, definition),
          details: {
            memberId: member.id,
            memberStatus: 'idle',
            definitionId: definition.id,
            definitionRevision: definition.revision,
            runId: outcome.runId,
            model: outcome.model,
            effectiveTools: [...outcome.effectiveTools],
            turns: outcome.turns,
            durationMs: outcome.durationMs,
            truncated: outcome.truncated,
            ...(outcome.unavailableTools === undefined ? {} : { unavailableTools: [...outcome.unavailableTools] }),
          },
        };
      } catch (error) {
        const aborted = controller.signal.aborted;
        runtime.settleMember({
          teamId,
          memberId: member.id,
          status: aborted ? 'cancelled' : 'failed',
          text: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        if (ctx.signal !== undefined) ctx.signal.removeEventListener('abort', onParentAbort);
      }
    },
  });

  const sendTeamMessage = teamTool({
    name: 'send_team_message',
    label: 'Send team message',
    description: `给某个成员留一条消息（from 固定为 ${TEAM_LEAD_ID}，由宿主填写）。P2 只记账，不注入会话。`,
    parameters: Type.Object({
      to: Type.String(),
      kind: Type.String(),
      payload: Type.Unknown(),
      requestId: Type.Optional(Type.String()),
    }),
    allowedKeys: ['to', 'kind', 'payload', 'requestId'],
    async body(args) {
      const to = requireString('send_team_message', args.to, 'to');
      const kind = requireString('send_team_message', args.kind, 'kind') as TeamMessageKind;
      if (!['instruction', 'question', 'answer', 'result'].includes(kind)) {
        throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `kind 必须是 instruction/question/answer/result。`);
      }
      const requestId = typeof args.requestId === 'string' ? args.requestId : undefined;
      if (requestId !== undefined && runtime.requestOwner(teamId, requestId) !== undefined) {
        throw new TeamError(
          TEAM_ERROR_CODES.requestDuplicate,
          `requestId ${requestId} 已经用过，不重复发送。`,
          { requestId },
        );
      }
      const message = runtime.appendMessage({
        teamId,
        from: TEAM_LEAD_ID,
        to,
        kind,
        payload: args.payload ?? null,
      });
      if (requestId !== undefined) runtime.rememberRequest(teamId, requestId, message.id);
      return {
        text: `已记录消息 ${message.id}（to=${to}, kind=${kind}, seq=${message.seq}, deliveryState=${message.deliveryState}）。`,
        details: {
          messageId: message.id,
          seq: message.seq,
          to,
          kind,
          deliveryState: message.deliveryState,
        },
      };
    },
  });

  const listTasks = teamTool({
    name: 'list_team_tasks',
    label: 'List team tasks',
    description: '列出任务板：id、revision、状态、owner 与依赖。',
    parameters: Type.Object({}),
    allowedKeys: [],
    async body() {
      const team = runtime.requireTeam(teamId);
      const tasks = [...team.tasks.values()].map((task) => ({
        taskId: task.id,
        revision: task.revision,
        status: task.status,
        ownerMemberId: task.ownerMemberId ?? null,
        blockedBy: [...task.blockedBy],
        title: task.title,
      }));
      return {
        text: tasks.length === 0
          ? '任务板是空的。'
          : tasks.map((t) => `${t.taskId} rev${t.revision} ${t.status}${t.ownerMemberId === null ? '' : ` owner=${t.ownerMemberId}`} ${t.title}`).join('\n'),
        details: { tasks },
      };
    },
  });

  const getTask = teamTool({
    name: 'get_team_task',
    label: 'Get team task',
    description: '读一条任务的完整内容（含当前 revision，改之前必须先读它）。',
    parameters: Type.Object({ taskId: Type.String() }),
    allowedKeys: ['taskId'],
    async body(args) {
      const taskId = requireString('get_team_task', args.taskId, 'taskId');
      const task = runtime.getTask(teamId, taskId);
      if (task === undefined) {
        throw new TeamError(TEAM_ERROR_CODES.taskNotFound, `任务 ${taskId} 不存在。`, { taskId });
      }
      return {
        text: `${task.id} rev${task.revision} ${task.status}\n${task.title}\n${task.description}`,
        details: {
          taskId: task.id,
          revision: task.revision,
          status: task.status,
          ownerMemberId: task.ownerMemberId ?? null,
          blockedBy: [...task.blockedBy],
          writeScopes: [...task.writeScopes],
          title: task.title,
          description: task.description,
        },
      };
    },
  });

  const createTask = teamTool({
    name: 'create_team_task',
    label: 'Create team task',
    description: '新建一条任务。blockedBy 里任一依赖未完成时，任务初始即为 blocked。',
    parameters: Type.Object({
      title: Type.String(),
      description: Type.String(),
      blockedBy: Type.Optional(Type.Array(Type.String())),
      writeScopes: Type.Optional(Type.Array(Type.String())),
    }),
    allowedKeys: ['title', 'description', 'blockedBy', 'writeScopes'],
    async body(args) {
      const task = runtime.createTask({
        teamId,
        title: requireString('create_team_task', args.title, 'title'),
        description: requireString('create_team_task', args.description, 'description'),
        blockedBy: stringArray(args.blockedBy, 'blockedBy'),
        writeScopes: stringArray(args.writeScopes, 'writeScopes'),
      });
      return {
        text: `已建任务 ${task.id}（revision ${task.revision}，状态 ${task.status}）。`,
        details: {
          taskId: task.id,
          revision: task.revision,
          status: task.status,
          blockedBy: [...task.blockedBy],
          writeScopes: [...task.writeScopes],
        },
      };
    },
  });

  const updateTask = teamTool({
    name: 'update_team_task',
    label: 'Update team task',
    description: '按 revision CAS 更新任务。revision 不是最新的会返回 TEAM_TASK_STALE_REVISION。',
    parameters: Type.Object({
      taskId: Type.String(),
      expectedRevision: Type.Integer(),
      status: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      ownerMemberId: Type.Optional(Type.String()),
    }),
    allowedKeys: ['taskId', 'expectedRevision', 'status', 'title', 'description', 'ownerMemberId'],
    async body(args) {
      const patch: { status?: TeamTaskStatus; title?: string; description?: string; ownerMemberId?: string } = {};
      if (args.status !== undefined) patch.status = requireString('update_team_task', args.status, 'status') as TeamTaskStatus;
      if (args.title !== undefined) patch.title = requireString('update_team_task', args.title, 'title');
      if (args.description !== undefined) patch.description = requireString('update_team_task', args.description, 'description');
      if (args.ownerMemberId !== undefined) patch.ownerMemberId = requireString('update_team_task', args.ownerMemberId, 'ownerMemberId');
      const task = runtime.updateTask({
        teamId,
        taskId: requireString('update_team_task', args.taskId, 'taskId'),
        expectedRevision: requireRevision('update_team_task', args.expectedRevision, 'expectedRevision'),
        patch,
      });
      return {
        text: `任务 ${task.id} 已更新到 revision ${task.revision}（状态 ${task.status}）。`,
        details: { taskId: task.id, revision: task.revision, status: task.status },
      };
    },
  });

  const waitTeam = teamTool({
    name: 'wait_team',
    label: 'Wait for team',
    description: '等成员结束，只返回**已结束**成员的最终文本（超过窗口先回，仍在跑的列在 pending）。',
    parameters: Type.Object({
      memberIds: Type.Optional(Type.Array(Type.String())),
      timeoutMs: Type.Optional(Type.Integer()),
    }),
    allowedKeys: ['memberIds', 'timeoutMs'],
    async body(args) {
      const memberIds = args.memberIds === undefined ? undefined : stringArray(args.memberIds, 'memberIds');
      const timeoutMs = args.timeoutMs === undefined
        ? undefined
        : requireRevision('wait_team', args.timeoutMs, 'timeoutMs');
      const view = await runtime.waitForSettled(teamId, {
        ...(memberIds === undefined ? {} : { memberIds }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      const lines = view.settled.map((entry) => `[${entry.memberId} ${entry.status}]${entry.truncated ? ' (已截断)' : ''}\n${entry.text}`);
      return {
        text: lines.length === 0
          ? `还没有成员结束${view.timedOut ? '（等待超时）' : ''}。`
          : `${lines.join('\n\n')}\n\n(settled=${view.settled.length} pending=${view.pending.length} timedOut=${view.timedOut})`,
        details: {
          settled: view.settled.map((entry) => ({ ...entry })),
          pending: [...view.pending],
          timedOut: view.timedOut,
        },
      };
    },
  });

  const interruptAgent = teamTool({
    name: 'interrupt_agent',
    label: 'Interrupt agent',
    description: '请求取消一个成员：AbortSignal 经现有 adapter 下传 worker，状态 running→cancelling→cancelled。',
    parameters: Type.Object({ memberId: Type.String(), reason: Type.Optional(Type.String()) }),
    allowedKeys: ['memberId', 'reason'],
    async body(args) {
      const member = runtime.interruptMember({
        teamId,
        memberId: requireString('interrupt_agent', args.memberId, 'memberId'),
        ...(args.reason === undefined ? {} : { reason: requireString('interrupt_agent', args.reason, 'reason') }),
      });
      return {
        text: `已请求取消成员 ${member.id}，当前状态 ${member.status}（取消是协作式的，等它自己收尾）。`,
        details: { memberId: member.id, status: member.status },
      };
    },
  });

  return [listMembers, dispatchAgent, sendTeamMessage, listTasks, getTask, createTask, updateTask, waitTeam, interruptAgent];
}

/**
 * 成员的 2 个工具。
 *
 * 身份由宿主绑定：`update_team_task` 只能改 `ownerMemberId === memberId` 的任务，
 * `send_team_message` 的收件人**固定**为 {@link TEAM_LEAD_ID}——表单里连 `to` 都没有，
 * 传了会被拒绝（不是被忽略）。
 */
export function createWorkerTeamTools(deps: WorkerTeamToolDeps): ToolDefinition[] {
  const { runtime, teamId, memberId } = deps;

  /**
   * The member must be running for anything it says to count.
   *
   * This is the only barrier that does not depend on the transport: a cancelled or
   * finished member cannot reach these tools *today* only because its session was
   * aborted, and P3's persistent sessions plus message replay remove that accident.
   * So the write path checks the recorded state itself, before touching anything —
   * refusing here is a pure no-op: no revision bump, no message, no counter change.
   */
  const requireRunningMember = (): void => {
    const member = runtime.requireMember(teamId, memberId);
    if (member.status !== 'running') {
      throw new TeamError(
        TEAM_ERROR_CODES.memberNotActive,
        `成员 ${memberId} 当前状态是 ${member.status}，不再接受任务板写入或回信（只有 running 中的成员可以写）；`
        + '如需继续这项工作，请让编排者重新 dispatch 一个新成员。',
        { memberId, status: member.status },
      );
    }
  };

  const updateOwnTask = teamTool({
    name: 'update_team_task',
    label: 'Update my team task',
    description: '更新**自己负责的**任务（revision CAS）。只能改状态/标题/描述，不能改 owner。',
    parameters: Type.Object({
      taskId: Type.String(),
      expectedRevision: Type.Integer(),
      status: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    allowedKeys: ['taskId', 'expectedRevision', 'status', 'title', 'description'],
    async body(args) {
      requireRunningMember();
      const patch: { status?: TeamTaskStatus; title?: string; description?: string } = {};
      if (args.status !== undefined) patch.status = requireString('update_team_task', args.status, 'status') as TeamTaskStatus;
      if (args.title !== undefined) patch.title = requireString('update_team_task', args.title, 'title');
      if (args.description !== undefined) patch.description = requireString('update_team_task', args.description, 'description');
      const task = runtime.updateTask({
        teamId,
        taskId: requireString('update_team_task', args.taskId, 'taskId'),
        expectedRevision: requireRevision('update_team_task', args.expectedRevision, 'expectedRevision'),
        patch,
        actor: { memberId },
      });
      return {
        text: `任务 ${task.id} 已更新到 revision ${task.revision}（状态 ${task.status}）。`,
        details: { taskId: task.id, revision: task.revision, status: task.status },
      };
    },
  });

  const reportToLead = teamTool({
    name: 'send_team_message',
    label: 'Message the lead',
    description: `给 ${TEAM_LEAD_ID} 回一条消息（收件人由宿主固定为 ${TEAM_LEAD_ID}，表单里没有 to）。`,
    parameters: Type.Object({
      kind: Type.String(),
      payload: Type.Unknown(),
      requestId: Type.Optional(Type.String()),
    }),
    allowedKeys: ['kind', 'payload', 'requestId'],
    async body(args) {
      requireRunningMember();
      const kind = requireString('send_team_message', args.kind, 'kind') as TeamMessageKind;
      if (!['instruction', 'question', 'answer', 'result'].includes(kind)) {
        throw new TeamError(TEAM_ERROR_CODES.invalidArguments, 'kind 必须是 instruction/question/answer/result。');
      }
      const requestId = typeof args.requestId === 'string' ? args.requestId : undefined;
      if (requestId !== undefined && runtime.requestOwner(teamId, requestId) !== undefined) {
        throw new TeamError(TEAM_ERROR_CODES.requestDuplicate, `requestId ${requestId} 已经用过，不重复发送。`, { requestId });
      }
      const message = runtime.appendMessage({
        teamId,
        from: memberId,
        to: TEAM_LEAD_ID,
        kind,
        payload: args.payload ?? null,
      });
      if (requestId !== undefined) runtime.rememberRequest(teamId, requestId, message.id);
      return {
        text: `已把消息交给 ${TEAM_LEAD_ID}（seq=${message.seq}, deliveryState=${message.deliveryState}）。`,
        details: { messageId: message.id, seq: message.seq, from: memberId, to: TEAM_LEAD_ID, deliveryState: message.deliveryState },
      };
    },
  });

  return [updateOwnTask, reportToLead];
}

/** 断言用：两个工具面加起来的名字集合，必须与冻结契约逐字一致。 */
export function teamToolNameInventory(): { orchestrator: readonly string[]; worker: readonly string[]; forbiddenForWorker: readonly string[] } {
  return {
    orchestrator: [...TEAM_ORCHESTRATOR_TOOL_NAMES],
    worker: [...TEAM_WORKER_TOOL_NAMES],
    forbiddenForWorker: [...TEAM_WORKER_FORBIDDEN_TOOL_NAMES],
  };
}
