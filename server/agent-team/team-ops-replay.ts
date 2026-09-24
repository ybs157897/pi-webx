/**
 * Team 运行时的纯函数操作层（重放）：日志记录重放与进程重启后的归一化。
 *
 * 从 `team-runtime-ops.ts` 二次拆出（拆分重构，行为不变）：逐字搬迁，不改语句顺序与错误码。
 */

import type { TeamJournalRecord } from './team-journal';
import { readMember, readMessage, readTask } from './team-snapshot';
import { TEAM_INTERRUPT_REASONS, type Team } from './team-types';

/* -------------------------------------------------------------- 日志重放 ---- */

/** 重放要改的那几处运行时状态；`teamId` 是被重放的那个 team。 */
export interface ReplayTarget {
  readonly teamId: string;
  readonly now: () => number;
  readonly teams: Map<string, Team>;
  readonly parentIndex: Map<string, string>;
  readonly claimed: Set<string>;
}

/**
 * Apply one team's records, in order — the record loop of the P3-A replay.
 *
 * Records are applied in order; each carries the entity **after** its change, so
 * the last record for an entity wins and replaying twice is a no-op. Records for an
 * unknown team type are ignored, and a record that does not describe its entity is
 * dropped rather than guessed at.
 *
 * Returns the rebuilt team (or `undefined` when no `team-created` record was seen)
 * and the highest `seq` observed, which the caller continues its numbering from.
 */
export function replayRecords(
  target: ReplayTarget,
  records: readonly TeamJournalRecord[],
): { team: Team | undefined; maxSeq: number } {
  let team = target.teams.get(target.teamId);
  let maxSeq = 0;
  for (const record of records) {
    maxSeq = Math.max(maxSeq, record.seq);
    switch (record.type) {
      case 'team-created': {
        const parentSessionId = typeof record['parentSessionId'] === 'string' ? record['parentSessionId'] : '';
        const createdAt = typeof record['createdAt'] === 'number' ? record['createdAt'] : target.now();
        team = {
          id: target.teamId,
          parentSessionId,
          createdAt,
          members: new Map(),
          tasks: new Map(),
          messages: [],
          seq: 0,
        };
        target.teams.set(team.id, team);
        // The alias index: a client only ever holds the session id, and after a
        // restart the session may have no transcript at all.
        target.parentIndex.set(parentSessionId, team.id);
        break;
      }
      case 'member-added':
      case 'member-updated': {
        if (team === undefined) break;
        const member = readMember(record['member'], target.teamId);
        if (member === undefined) break;
        team.members.set(member.id, member);
        break;
      }
      case 'task-created':
      case 'task-updated': {
        if (team === undefined) break;
        const task = readTask(record['task'], target.teamId);
        if (task === undefined) break;
        team.tasks.set(task.id, task);
        break;
      }
      case 'message-queued':
      case 'message-updated': {
        if (team === undefined) break;
        const message = readMessage(record['message'], target.teamId);
        if (message === undefined) break;
        const existing = team.messages.findIndex((entry) => entry.id === message.id);
        if (existing === -1) team.messages.push(message);
        else team.messages[existing] = message;
        team.seq = Math.max(team.seq, message.seq);
        break;
      }
      case 'delivery-claimed': {
        const messageId = typeof record['messageId'] === 'string' ? record['messageId'] : undefined;
        if (messageId !== undefined) target.claimed.add(messageId);
        break;
      }
      default:
        break;
    }
  }
  return { team, maxSeq };
}

/** `AgentTeamRuntime.hydrate` 的返回形状：重建了什么，调用方据此如实汇报而不是猜。 */
export interface TeamHydrateResult {
  readonly teamId: string;
  /** Whether a team actually exists in memory after this replay. */
  readonly created: boolean;
  readonly members: number;
  readonly tasks: number;
  readonly messages: number;
  readonly interrupted: number;
  readonly claimed: number;
}

/**
 * The full replay of one team: apply the records, normalise what died with the
 * process, hand the highest `seq` back to the journal, and report what changed.
 */
export function hydrateTeam(input: {
  readonly teamId: string;
  readonly records: readonly TeamJournalRecord[];
  readonly now: () => number;
  readonly teams: Map<string, Team>;
  readonly parentIndex: Map<string, string>;
  readonly claimed: Set<string>;
  /** 继续记录编号：把最高重放 seq 交给 journal（没有 journal 或它不支持时是 `undefined`）。 */
  readonly seed: ((teamId: string, seq: number) => void) | undefined;
}): TeamHydrateResult {
  const { team, maxSeq } = replayRecords(input, input.records);
  if (team === undefined) {
    return { teamId: input.teamId, created: false, members: 0, tasks: 0, messages: 0, interrupted: 0, claimed: 0 };
  }
  const interrupted = normalizeRestoredMembers(team);
  // Continue the record numbering after the highest replayed seq.
  input.seed?.(input.teamId, maxSeq);
  return {
    teamId: team.id,
    // "A team exists in memory after this replay" — the only thing a caller may
    // report as rebuilt. (`existed` is not part of the answer: replaying over live
    // state is the caller's own decision to make, and the answer stays truthful.)
    created: input.teams.has(team.id),
    members: team.members.size,
    tasks: team.tasks.size,
    messages: team.messages.length,
    interrupted,
    claimed: input.claimed.size,
  };
}

/**
 * The process is gone, so nothing that was mid-flight can still be running — the
 * closing normalisation of a replay. Returns how many members it wrote.
 *
 * These members are written here, not in the journal: the record that put them in
 * `running` is the last word the process managed, and this replay is the reader that
 * draws the conclusion. The code says *which* kind of unconfirmed stop this is —
 * `restart-replay`, never `host-shutdown` (graceful shutdown is a different event,
 * written while the process was still alive).
 */
export function normalizeRestoredMembers(team: Team): number {
  let interrupted = 0;
  for (const member of team.members.values()) {
    if (member.status === 'running' || member.status === 'cancelling') {
      member.status = 'interrupted';
      member.resultText ??= '宿主重启：成员会话是内存态的，无法恢复，停止未得到确认。';
      member.statusReason = TEAM_INTERRUPT_REASONS.restartReplay;
      interrupted += 1;
    }
  }
  return interrupted;
}
