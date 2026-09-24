/**
 * Team 运行时的对外契约：等待窗口常量、构造选项、任务补丁形状、记录追加入口与定义指纹。
 *
 * 从 `team-runtime.ts` 拆出（拆分重构，行为不变）：这些是运行时与调用方（host、工具面、
 * check 脚本）之间的稳定接缝，单独成文件让 `team-runtime.ts` 只留编排与内存状态。
 */

import { createHash } from 'node:crypto';

import type { FrozenDefinition } from '../pi/subagent-tool';
import type { TeamJournalLike } from './team-journal';
import type { TeamMessage, TeamTaskStatus } from './team-types';

/** `wait_team` 的默认与最大等待窗口；默认值让「忘记传 timeoutMs」也不会挂住一个 turn。 */
export const DEFAULT_TEAM_WAIT_MS = 30_000;
export const MAX_TEAM_WAIT_MS = 600_000;

export interface TeamRuntimeOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  /** 等待窗口的计时器，测试可替换以便零延迟断言。 */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * Where state changes are appended so a restart can rebuild them (P3-A).
   *
   * Omitted means pure memory, which is exactly P2's behaviour — the many runtime
   * doubles in tests keep working unchanged, and a host that wants the journal
   * passes one in.
   */
  readonly journal?: TeamJournalLike;
  /**
   * Called after an inbox item is recorded (P3-B's injection trigger).
   *
   * The inbox has exactly one birth point — {@link AgentTeamRuntime.appendMessage} —
   * so an observer here covers both a member's out-of-band message and a settle
   * result without any tool having to cooperate. It must not throw: a broken
   * observer must not fail the message that was already recorded.
   */
  readonly onInboxItem?: (message: TeamMessage) => void;
}

/** 谁在改任务：编排者（宿主，不受 ownership 限制）或某个成员。 */
export interface TeamTaskActor {
  readonly memberId?: string;
}

export interface TeamTaskPatch {
  readonly status?: TeamTaskStatus;
  readonly title?: string;
  readonly description?: string;
  readonly ownerMemberId?: string;
}

/* ------------------------------------------- 记录追加入口（操作层的接缝） ---- */

/** 一条要追加的记录；形状与 `TeamJournalLike.append` 的入参一致。 */
type TeamRecord = { readonly type: string } & Record<string, unknown>;

/** 追加一条记录（运行时把它接到自己的 `appendRecord` 上；没有 journal 时是空操作）。 */
export type AppendTeamRecord = (teamId: string, record: TeamRecord) => void;

/**
 * The `wait_team` timer.
 *
 * **Known boundary**, registered by the independent verifier and deliberately not
 * changed: the timer is `unref()`d, so it does not by itself keep the event loop
 * alive. In a process with no other handle — a one-off script that calls
 * `wait_team` and nothing else — Node can therefore exit 0 mid-wait instead of
 * reporting a timeout. The server is unaffected: express keeps handles open for
 * the whole request, so the wait ends with a result or a timeout as documented.
 * Un-ref'ing is kept because the opposite (a referenced timer) would pin the
 * process awake for up to `MAX_TEAM_WAIT_MS` after the caller is gone.
 */
export const DEFAULT_DELAY = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** 冻结定义的内容指纹：同一 revision 下内容变了也能看出来（前 16 位十六进制）。 */
export function definitionSnapshotHash(definition: FrozenDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);
}
