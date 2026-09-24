/**
 * Team 运行时的纯函数操作层（等待）：只读投影、事件驱动等待循环与唤醒。
 *
 * 从 `team-runtime-ops.ts` 二次拆出（拆分重构，行为不变）：逐字搬迁，不改语句顺序与错误码。
 */

import {
  boundTeamText,
  isSettledMemberStatus,
  type Team,
  type TeamMember,
  type TeamWaitView,
} from './team-types';

/* -------------------------------------------------------------- 等待投影 ---- */

/** 已 settle 成员的只读投影：文本按上限截断并带 `truncated`；顺序与 `wanted` 一致。 */
export function settledMemberEntries(team: Team, wanted: readonly string[]): TeamWaitView['settled'] {
  return wanted
    .map((id) => team.members.get(id))
    .filter((member): member is TeamMember => member !== undefined && isSettledMemberStatus(member.status))
    .map((member) => {
      const bounded = boundTeamText(member.resultText ?? '');
      return { memberId: member.id, status: member.status, text: bounded.text, truncated: bounded.truncated };
    });
}

/** 仍在跑（未 settle）的成员 id；顺序与 `wanted` 一致。 */
export function pendingMemberIds(team: Team, wanted: readonly string[]): string[] {
  return wanted.filter((id) => {
    const member = team.members.get(id);
    return member !== undefined && !isSettledMemberStatus(member.status);
  });
}

/**
 * 事件驱动的等待循环：被唤醒（状态变了）与窗口到点，两者取先。
 *
 * 已知边界（独立验证者登记，行为不改）：超时**不取消**任何成员——它只是停止等待，成员照旧跑。
 */
export async function waitForSettledView(input: {
  readonly teamId: string;
  readonly team: Team;
  readonly wanted: readonly string[];
  readonly deadline: number;
  readonly now: () => number;
  readonly raceChange: (teamId: string, timeoutMs: number) => Promise<void>;
}): Promise<TeamWaitView> {
  // A guard against a caller clock that never advances (a frozen `now` in a
  // test, say): without it the loop below would wait forever instead of
  // reporting a timeout. 10k rounds of an event-driven wait is far beyond any
  // real conversation's lifetime.
  for (let round = 0; round < 10_000; round += 1) {
    const settled = settledMemberEntries(input.team, input.wanted);
    const pending = pendingMemberIds(input.team, input.wanted);
    if (pending.length === 0) return { settled, pending, timedOut: false };
    const remaining = input.deadline - input.now();
    if (remaining <= 0) return { settled, pending, timedOut: true };
    await input.raceChange(input.teamId, remaining);
  }
  // Only reachable with a non-advancing clock; reporting a timeout is the honest
  // answer, since the window has been waited out by every measure available.
  return {
    settled: settledMemberEntries(input.team, input.wanted),
    pending: pendingMemberIds(input.team, input.wanted),
    timedOut: true,
  };
}

/* ------------------------------------------------------------ 等待与唤醒 ---- */

/** 唤醒一个 team 的全部等待者；`wait_team` 因此是事件驱动而不是轮询。 */
export function notifyWaiters(waiters: ReadonlyMap<string, Set<() => void>>, teamId: string): void {
  const waiting = waiters.get(teamId);
  if (waiting === undefined) return;
  for (const wake of [...waiting]) wake();
}

/**
 * 等到「状态变了」或超时，两者取先。
 *
 * 计时器由调用方注入（`delay`），所以测试可以零延迟断言；唤醒只生效一次，
 * 并把 `wake` 自己从等待者集合里摘掉。
 */
export function raceChange(
  waiters: Map<string, Set<() => void>>,
  teamId: string,
  timeoutMs: number,
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const wake = (): void => {
      if (done) return;
      done = true;
      waiters.get(teamId)?.delete(wake);
      resolve();
    };
    const waiting = waiters.get(teamId) ?? new Set<() => void>();
    waiting.add(wake);
    waiters.set(teamId, waiting);
    void delay(timeoutMs).then(wake);
  });
}
