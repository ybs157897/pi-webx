/**
 * Team 的模型侧工具面：编排者的 9 个 + 成员的 2 个。
 *
 * 两条边界写在这里，而不是靠调用方自觉：
 *
 *   1. **表单里没有身份字段。** `from`/`to`/`teamId`/`ownerMemberId` 都不在任何工具的参数
 *      列表里——它们由宿主可信上下文填。模型传了这些键会被参数门禁拒绝，不是被忽略。
 *   2. **定义是唯一真值。** `dispatch_agent` 只接受 `definitionId` +
 *      `expectedDefinitionRevision`；`model`/`systemPrompt`/`tools`/`maxTurns` 之类的覆写键
 *      一律拒绝（`TEAM_OVERRIDE_REJECTED`），因为那等于让模型自己造一个定义。
 *
 * 失败一律**抛出**（`TeamError`，带稳定 code）：SDK 只有 throw 才会把工具调用标成
 * `isError: true`，而返回结果会被当成成功——这与 `subagent` 工具同一条约定。
 *
 * 拆分重构（导出面不变，见文件尾的再导出）：共享原语在 `team-tools-shared.ts`，
 * 成员的 2 个工具在 `team-tools-worker.ts`，本文件只留编排者的 9 个与名字清单。
 */

import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { AgentDefinition } from '../../src/shared/agent-definitions';
import { frameWorkerOutput, freezeDefinition } from '../pi/subagent-tool';
import {
  planMemberToolSurface,
  renderDispatchAgentDescription,
  requireRevision,
  requireString,
  stringArray,
  teamTool,
  type OrchestratorTeamToolDeps,
} from './team-tools-shared';
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
        // The member's final text leaves through the tool result below — that IS the
        // delivery. No inbox item is appended for it: a second copy would only be text the
        // model already has (and the member record already journals `resultText`), so
        // "settle ⇒ nothing to inject" is a fact this check asserts, not an accident.
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
        // Recorded as the lead's own message for provenance. Delivery needs no marking:
        // the injector only ever delivers items addressed to the lead, and this one goes
        // to a member.
        origin: 'lead-message',
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

/** 断言用：两个工具面加起来的名字集合，必须与冻结契约逐字一致。 */
export function teamToolNameInventory(): { orchestrator: readonly string[]; worker: readonly string[]; forbiddenForWorker: readonly string[] } {
  return {
    orchestrator: [...TEAM_ORCHESTRATOR_TOOL_NAMES],
    worker: [...TEAM_WORKER_TOOL_NAMES],
    forbiddenForWorker: [...TEAM_WORKER_FORBIDDEN_TOOL_NAMES],
  };
}

/* --------------------------------------------- 原路径再导出（导出面不变） ---- */

/**
 * 原本从这个文件导出的名字全部仍然从**这个路径**可用：调用方（`server/pi/host-teams.ts`、
 * `scripts/check-agent-team*.ts`）零改动。
 */
export {
  planMemberToolSurface,
  renderDispatchAgentDescription,
} from './team-tools-shared';
export type {
  OrchestratorTeamToolDeps,
  TeamDispatchRequest,
  WorkerTeamToolDeps,
} from './team-tools-shared';
export { createWorkerTeamTools } from './team-tools-worker';
