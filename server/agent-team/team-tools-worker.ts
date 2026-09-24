/**
 * 成员的 2 个 Team 工具。
 *
 * 从 `team-tools.ts` 拆出（拆分重构，行为不变）：身份由宿主绑定——`update_team_task`
 * 只能改 `ownerMemberId === memberId` 的任务，`send_team_message` 的收件人**固定**为
 * {@link TEAM_LEAD_ID}（表单里连 `to` 都没有，传了会被拒绝，不是被忽略）。
 */

import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import { requireRevision, requireString, teamTool, type WorkerTeamToolDeps } from './team-tools-shared';
import {
  TEAM_ERROR_CODES,
  TEAM_LEAD_ID,
  TeamError,
  type TeamMessageKind,
  type TeamTaskStatus,
} from './team-types';

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
        // The member is talking to the orchestrator in its own words: this text has NOT
        // reached the model yet (only the member's *final* text travels back as
        // `dispatch_agent`'s tool result), so this is exactly the item P3-B injects.
        origin: 'member-message',
        deliveredAsToolResult: false,
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
