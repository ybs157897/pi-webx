/**
 * Team 运行时的纯函数操作层（成员）：组装、收尾、中断标记与协作式取消请求。
 *
 * 从 `team-runtime-ops.ts` 二次拆出（拆分重构，行为不变）：逐字搬迁，不改语句顺序与错误码。
 */

import type { FrozenDefinition } from '../pi/subagent-tool';
import {
  definitionSnapshotHash,
  type AppendTeamRecord,
} from './team-runtime-contract';
import { memberSnapshot } from './team-snapshot';
import {
  TEAM_ERROR_CODES,
  TeamError,
  isSettledMemberStatus,
  type Team,
  type TeamMember,
  type TeamMemberStatus,
} from './team-types';

/* ------------------------------------------------------------------ 成员 ---- */

/** 组装一个成员：状态从 `running` 起，`sessionId` 由 {@link AgentTeamRuntime.settleMember} 补上。 */
export function buildMember(
  team: Team,
  definition: FrozenDefinition,
  deps: { readonly newId: () => string; readonly now: () => number },
): TeamMember {
  return {
    id: deps.newId(),
    teamId: team.id,
    definitionId: definition.id,
    definitionRevision: definition.revision,
    definitionSnapshotHash: definitionSnapshotHash(definition),
    sessionId: '',
    status: 'running',
    createdAt: deps.now(),
    lastSeq: team.seq,
  };
}

/** 找成员；不存在时抛 `memberNotFound`（与拆出前同一错误码与文本）。 */
export function requireMemberIn(team: Team, memberId: string): TeamMember {
  const member = team.members.get(memberId);
  if (member === undefined) {
    throw new TeamError(
      TEAM_ERROR_CODES.memberNotFound,
      `成员 ${memberId} 不存在。`,
      { teamId: team.id, memberId },
    );
  }
  return member;
}

/**
 * 收尾一个成员：写状态、结果文本与 `sessionId`（= 派发返回的 `runId`）。
 *
 * 结果文本按上限截断后**原样存**（不裁剪），由 `wait_team` 输出时再报 `truncated`——
 * 这样只读投影与工具看到的是同一份事实。不通知等待者，调用方负责 `notify`。
 */
export function settleMemberIn(
  team: Team,
  input: {
    readonly memberId: string;
    readonly status: TeamMemberStatus;
    readonly text?: string;
    readonly sessionId?: string;
  },
  append: AppendTeamRecord,
): TeamMember {
  const member = requireMemberIn(team, input.memberId);
  member.status = input.status;
  if (input.sessionId !== undefined) member.sessionId = input.sessionId;
  if (input.text !== undefined) member.resultText = input.text;
  append(team.id, { type: 'member-updated', member: memberSnapshot(member) });
  return member;
}

/** 宿主收尾：把所有未 settle 的成员记成 `interrupted`（停止没有得到确认），返回被标记的数量。 */
export function markMembersInterrupted(
  team: Team,
  reason: string,
  statusReason: string | undefined,
  append: AppendTeamRecord,
): number {
  let marked = 0;
  for (const member of team.members.values()) {
    if (isSettledMemberStatus(member.status)) continue;
    member.status = 'interrupted';
    member.resultText ??= reason;
    if (statusReason !== undefined) member.statusReason = statusReason;
    append(team.id, { type: 'member-updated', member: memberSnapshot(member) });
    marked += 1;
  }
  return marked;
}

/**
 * 请求取消一个成员：状态先到 `cancelling`，再把原因交给宿主登记的取消钩子
 * （AbortSignal 经现有 adapter 下传 worker）。
 *
 * 真正落到 `cancelled` 由派发方在 worker 收尾时调 `settleMember` —— 取消是协作式的，
 * 不假装立刻停住。
 */
export function requestMemberCancellation(input: {
  readonly team: Team;
  readonly member: TeamMember;
  readonly reason: string;
  readonly cancels: ReadonlyMap<string, (reason: string) => void>;
  readonly append: AppendTeamRecord;
}): void {
  const { member } = input;
  member.status = 'cancelling';
  input.append(input.team.id, { type: 'member-updated', member: memberSnapshot(member) });
  const cancel = input.cancels.get(member.id);
  if (cancel !== undefined) cancel(input.reason);
}
