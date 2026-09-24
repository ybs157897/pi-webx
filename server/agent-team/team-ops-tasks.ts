/**
 * Team 运行时的纯函数操作层（任务板）：建任务、依赖校验、CAS 更新与 blocked 重算。
 *
 * 从 `team-runtime-ops.ts` 二次拆出（拆分重构，行为不变）：逐字搬迁，不改语句顺序与错误码。
 */

import {
  type AppendTeamRecord,
  type TeamTaskActor,
  type TeamTaskPatch,
} from './team-runtime-contract';
import { taskSnapshot } from './team-snapshot';
import {
  TEAM_ERROR_CODES,
  TeamError,
  isTaskBlocked,
  isTerminalTaskStatus,
  type Team,
  type TeamTask,
} from './team-types';

/* ------------------------------------------------------------------ 任务 ---- */

/**
 * 建一条任务：`blockedBy` 校验 + 组装 + （依赖未完成时）初始 `blocked`。
 *
 * 内存与日志都写好，但不通知等待者——调用方负责 `notify`。语句顺序与拆出前一致：
 * 先校验依赖，再取新 id，最后入账。
 */
export function createTaskIn(
  team: Team,
  input: {
    readonly title: string;
    readonly description: string;
    readonly blockedBy?: readonly string[];
    readonly writeScopes?: readonly string[];
  },
  deps: { readonly newId: () => string; readonly append: AppendTeamRecord },
): TeamTask {
  const blockedBy = normalizeBlockedBy(team, input.blockedBy);
  const task: TeamTask = {
    id: deps.newId(),
    teamId: team.id,
    revision: 1,
    title: input.title,
    description: input.description,
    status: 'pending',
    blockedBy,
    writeScopes: [...new Set(input.writeScopes ?? [])],
  };
  if (isTaskBlocked(task, team.tasks)) task.status = 'blocked';
  team.tasks.set(task.id, task);
  deps.append(
    team.id,
    { type: 'task-created', task: { ...task, blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] } },
  );
  return task;
}

/** `blockedBy` 去重 + 存在性校验（依赖不存在时抛 taskNotFound，与拆出前同一错误码）。 */
export function normalizeBlockedBy(team: Team, blockedBy: readonly string[] | undefined): string[] {
  const unique = [...new Set(blockedBy ?? [])];
  for (const dependency of unique) {
    if (!team.tasks.has(dependency)) {
      throw new TeamError(
        TEAM_ERROR_CODES.taskNotFound,
        `blockedBy 里的任务 ${dependency} 不存在。`,
        { taskId: dependency },
      );
    }
  }
  return unique;
}

/**
 * 任务板 CAS 更新：校验 + 就地应用，返回被改的任务。
 *
 * 冲突（`expectedRevision` 不是当前 revision）抛 `TEAM_TASK_STALE_REVISION`，并把当前
 * revision 放进 details —— 调用方据此 refresh 再试，而不是猜。
 */
export function applyTaskPatch(input: {
  readonly team: Team;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly patch: TeamTaskPatch;
  readonly actor: TeamTaskActor | undefined;
}): TeamTask {
  const { team, patch } = input;
  const task = team.tasks.get(input.taskId);
  if (task === undefined) {
    throw new TeamError(TEAM_ERROR_CODES.taskNotFound, `任务 ${input.taskId} 不存在。`, { taskId: input.taskId });
  }
  if (input.expectedRevision !== task.revision) {
    throw new TeamError(
      TEAM_ERROR_CODES.taskStaleRevision,
      `任务 ${task.id} 的 revision 已经变了：期望 ${input.expectedRevision}，当前 ${task.revision}。`
      + '请先用 get_team_task 读回最新 revision 再改。',
      { taskId: task.id, currentRevision: task.revision },
    );
  }
  const actor = input.actor;
  if (actor?.memberId !== undefined) {
    if (task.ownerMemberId !== actor.memberId) {
      throw new TeamError(
        TEAM_ERROR_CODES.taskNotOwned,
        `任务 ${task.id} 不属于当前成员（owner=${task.ownerMemberId ?? '无'}），成员只能更新自己的任务。`,
        { taskId: task.id, ownerMemberId: task.ownerMemberId ?? null },
      );
    }
    if (patch.ownerMemberId !== undefined) {
      throw new TeamError(
        TEAM_ERROR_CODES.overrideRejected,
        '成员不能改任务的 owner；指派由编排者用 dispatch_agent 的 taskId 完成。',
        { taskId: task.id },
      );
    }
  }
  const next = patch.status;
  if (next !== undefined && next !== task.status && isTerminalTaskStatus(task.status)) {
    throw new TeamError(
      TEAM_ERROR_CODES.taskTerminal,
      `任务 ${task.id} 已是终态 ${task.status}，不能再改状态。`,
      { taskId: task.id, status: task.status },
    );
  }
  if ((next === 'in_progress' || next === 'completed') && isTaskBlocked(task, team.tasks)) {
    throw new TeamError(
      TEAM_ERROR_CODES.taskBlocked,
      `任务 ${task.id} 的依赖还没完成（${task.blockedBy.join('、')}），不能进入 ${next}。`,
      { taskId: task.id, blockedBy: [...task.blockedBy] },
    );
  }
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.description !== undefined) task.description = patch.description;
  if (patch.ownerMemberId !== undefined) task.ownerMemberId = patch.ownerMemberId;
  if (next !== undefined) task.status = next;
  task.revision += 1;
  return task;
}

/** 依赖变化后重算 `blocked` ↔ `pending`；终态任务与 `in_progress` 不动。 */
export function refreshBlocked(team: Team, append: AppendTeamRecord): void {
  for (const task of team.tasks.values()) {
    if (isTerminalTaskStatus(task.status) || task.status === 'in_progress') continue;
    const blocked = isTaskBlocked(task, team.tasks);
    if (blocked && task.status === 'pending') {
      task.status = 'blocked';
      append(team.id, { type: 'task-updated', task: taskSnapshot(task) });
    } else if (!blocked && task.status === 'blocked') {
      task.status = 'pending';
      append(team.id, { type: 'task-updated', task: taskSnapshot(task) });
    }
  }
}
