/**
 * P2 Team 运行时：**内存态**的成员、任务板与消息账本。
 *
 * 不落盘、不注入、不调度——调度（capacity、worker 会话、abort）复用现有
 * `SubagentWorkerRunner`，由 `host.ts` 注入（见 `TeamRuntimeDispatch`）。这一层只负责：
 * 记录状态、跑 CAS、判 `blockedBy`、把 settle 事件通知给 `wait_team`，以及给出只读投影。
 *
 * 边界（照 spike 结论，P2 不越界）：
 *   - 全部状态在内存：进程重启即丢，磁盘上没有任何 Team 文件（`TEAM_STATE_IS_IN_MEMORY`）。
 *   - 消息只记 `deliveryState: 'queued'`，**不做**会话注入（`sendCustomMessage` 的投递与读回是 P3）；
 *     因此类型里虽然留了 `fresh-reader-visible` 等状态，这里永远不推进到它们。
 *   - 不声明「稳定存储」级别：那要等 fsync 之后才配说（spike 复核的措辞边界）。
 *
 * 拆分重构（行为与导出面不变，见文件尾的再导出）：契约在 `team-runtime-contract.ts`，
 * 记录编解码在 `team-snapshot.ts`，只读投影在 `team-views.ts`，纯函数操作按职责在
 * `team-ops-members.ts` / `team-ops-tasks.ts` / `team-ops-delivery.ts` /
 * `team-ops-replay.ts` / `team-ops-wait.ts`；本文件只留编排与内存状态。
 */

import { randomUUID } from 'node:crypto';

import type { FrozenDefinition } from '../pi/subagent-tool';
import type { TeamJournalLike, TeamJournalRecord } from './team-journal';
import {
  DEFAULT_DELAY,
  DEFAULT_TEAM_WAIT_MS,
  MAX_TEAM_WAIT_MS,
  type AppendTeamRecord,
  type TeamRuntimeOptions,
  type TeamTaskActor,
  type TeamTaskPatch,
} from './team-runtime-contract';
import {
  buildMessage,
  claimDelivery,
  claimDeliverySynced,
  setMessageDeliveryState,
  setMessagePendingReason,
  type DeliveryLedger,
  type TeamMessageInput,
} from './team-ops-delivery';
import {
  buildMember,
  markMembersInterrupted,
  requestMemberCancellation,
  requireMemberIn,
  settleMemberIn,
} from './team-ops-members';
import { hydrateTeam } from './team-ops-replay';
import { applyTaskPatch, createTaskIn, refreshBlocked } from './team-ops-tasks';
import { notifyWaiters, raceChange, waitForSettledView } from './team-ops-wait';
import { memberSnapshot, messageSnapshot, taskSnapshot } from './team-snapshot';
import {
  TEAM_ERROR_CODES,
  TeamError,
  isSettledMemberStatus,
  type Team,
  type TeamDeliveryMode,
  type TeamDeliveryState,
  type TeamMember,
  type TeamMemberStatus,
  type TeamMessage,
  type TeamProjection,
  type TeamTask,
  type TeamWaitView,
} from './team-types';
import { projectTeam } from './team-views';

export class AgentTeamRuntime {
  private readonly teams = new Map<string, Team>();
  /** memberId → 取消该成员的钩子（由宿主在派发时登记）。 */
  private readonly cancels = new Map<string, (reason: string) => void>();
  /** `${teamId}:${requestId}` → 该请求已经创建/记录的实体 id。 */
  private readonly requests = new Map<string, string>();
  /** 每个 team 的「状态变了」通知者，供 `wait_team` 精确唤醒而不是轮询。 */
  private readonly waiters = new Map<string, Set<() => void>>();
  /**
   * `parentSessionId → teamId`，**包括从日志重放出来的**。
   *
   * 它是 F1 那条会话别名在重启之后仍然可用的原因：team id 由 `newId()` 生成、从不发给客户端，
   * 而客户端手里只有会话 id；会话本身可能连转录都没落盘（没有 assistant 回合），所以不能靠
   * 「活会话表」来找。这里的映射来自 `team-created` 记录里宿主填的 `parentSessionId`。
   */
  private readonly parentIndex = new Map<string, string>();
  /**
   * messageId 的投递账本。
   *
   * P3-A 只记录「这条消息的投递机会已经被用掉」：真正的注入是 P3-B。账本跟着
   * journal 走（`delivery-claimed` 记录），所以**重启之后同一条 messageId 也不会
   * 拿到第二次机会**——这正是「至少一次投递 + 目标侧去重」里属于我们这一侧的那一半。
   */
  private readonly claimed = new Set<string>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly delay: (ms: number) => Promise<void>;
  /**
   * 追加式日志；不传就是纯内存（P2 的行为，测试与无日志场景）。
   *
   * 写入发生在**状态改变之后**：先改内存、再 append。崩溃窗口的后果是「内存里已经发生、
   * 日志里没有」——重启后那次改变不见，这与「append 到磁盘、可重放」的诚实口径一致
   * （模块顶部的边界说明），不承诺跨掉电的完整性。
   */
  private readonly journal: TeamJournalLike | undefined;
  private readonly onInboxItem: ((message: TeamMessage) => void) | undefined;
  /** 纯函数操作层（`team-ops-*.ts`）用的记录追加入口；包一层以保住 `this` 绑定。 */
  private readonly append: AppendTeamRecord;
  /** 投递账本与它需要的接缝：日志、记录追加、唤醒。 */
  private readonly ledger: DeliveryLedger;

  constructor(options: TeamRuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.delay = options.delay ?? DEFAULT_DELAY;
    this.journal = options.journal;
    this.onInboxItem = options.onInboxItem;
    this.append = (teamId, record): void => this.appendRecord(teamId, record);
    this.ledger = {
      claimed: this.claimed,
      journal: this.journal,
      appendRecord: this.append,
      notify: (teamId): void => this.notify(teamId),
    };
  }

  /** Team ids currently in memory, sorted — the replay path uses this to skip. */
  listTeams(): string[] {
    return [...this.teams.keys()].sort();
  }

  /* --------------------------------------------------------------- 生命周期 */

  /** 建一个 Team。父会话 id 是宿主给的真实会话身份，模型无法指定。 */
  createTeam(parentSessionId: string): Team {
    const team: Team = {
      id: this.newId(),
      parentSessionId,
      createdAt: this.now(),
      members: new Map(),
      tasks: new Map(),
      messages: [],
      seq: 0,
    };
    this.teams.set(team.id, team);
    this.parentIndex.set(parentSessionId, team.id);
    this.appendRecord(team.id, { type: 'team-created', parentSessionId, createdAt: team.createdAt });
    return team;
  }

  get(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  /** The team a session orchestrates, including one rebuilt from the journal. */
  findTeamByParentSession(parentSessionId: string): string | undefined {
    return this.parentIndex.get(parentSessionId);
  }

  /**
   * 丢掉一个 Team（父会话被杀、装配中途失败）。
   *
   * 只清内存引用与等待者/取消钩子，**不**假装取消：调用方负责先 `cancelTeam`（或先
   * `markInterrupted`），否则会有成员在别人的账上继续跑。返回它是否真的存在过。
   */
  dropTeam(teamId: string): boolean {
    const team = this.teams.get(teamId);
    if (team === undefined) return false;
    if (this.parentIndex.get(team.parentSessionId) === teamId) this.parentIndex.delete(team.parentSessionId);
    for (const member of team.members.values()) this.cancels.delete(member.id);
    this.waiters.delete(teamId);
    for (const key of [...this.requests.keys()]) {
      if (key.startsWith(`${teamId}:`)) this.requests.delete(key);
    }
    return this.teams.delete(teamId);
  }

  /** 只读投影；未知名返回 `undefined`（路由据此回 404）。 */
  snapshot(teamId: string): TeamProjection | undefined {
    const team = this.teams.get(teamId);
    if (team === undefined) return undefined;
    return projectTeam(team);
  }

  /* ------------------------------------------------------------------ 成员 */

  /** 登记一个成员。`sessionId` 在派发返回后由 {@link settleMember} 补上（runId）。 */
  addMember(input: { readonly teamId: string; readonly definition: FrozenDefinition }): TeamMember {
    const team = this.requireTeam(input.teamId);
    const member = buildMember(team, input.definition, { newId: this.newId, now: this.now });
    team.members.set(member.id, member);
    this.appendRecord(team.id, { type: 'member-added', member: memberSnapshot(member) });
    this.notify(team.id);
    return member;
  }

  registerMemberCancel(memberId: string, cancel: (reason: string) => void): void {
    this.cancels.set(memberId, cancel);
  }

  /**
   * 收尾一个成员：写状态、结果文本与 `sessionId`（= 派发返回的 `runId`）。
   *
   * 结果文本按 {@link MAX_TEAM_RESULT_CHARACTERS} 截断后**原样存**（不裁剪），
   * 由 `wait_team` 输出时再报 `truncated`——这样只读投影与工具看到的是同一份事实。
   */
  settleMember(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly status: TeamMemberStatus;
    readonly text?: string;
    readonly sessionId?: string;
  }): TeamMember {
    const team = this.requireTeam(input.teamId);
    const member = settleMemberIn(team, input, this.append);
    this.notify(input.teamId);
    return member;
  }

  /**
   * 请求取消一个成员：状态先到 `cancelling`，再把原因交给宿主登记的取消钩子
   * （AbortSignal 经现有 adapter 下传 worker）。真正落到 `cancelled` 由派发方在
   * worker 收尾时调 {@link settleMember} —— 取消是协作式的，不假装立刻停住。
   *
   * 实现是 `team-ops-members.ts` 的 `requestMemberCancellation`（同一个操作）。
   */
  interruptMember(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly reason?: string;
  }): TeamMember {
    const member = this.requireMember(input.teamId, input.memberId);
    if (isSettledMemberStatus(member.status)) {
      throw new TeamError(
        TEAM_ERROR_CODES.memberSettled,
        `成员 ${member.id} 已经结束（${member.status}），不能取消。`,
        { memberId: member.id, status: member.status },
      );
    }
    requestMemberCancellation({
      team: this.requireTeam(input.teamId),
      member,
      reason: input.reason ?? '编排者取消了该成员。',
      cancels: this.cancels,
      append: this.append,
    });
    this.notify(input.teamId);
    return member;
  }

  /**
   * 宿主收尾：把所有未 settle 的成员记成 `interrupted`（停止没有得到确认）。
   *
   * `statusReason` 是**闭集码**（见 {@link TEAM_INTERRUPT_REASONS}），与 `reason`（人读的散文，
   * 只在成员还没有结果文本时补上去）分开：前端与断言读的是码，人不该为了判断原因去 grep 散文。
   * 已 settle 的成员（含协作式取消确认过的 `cancelled`）不动——它们不需要第二次结论。
   *
   * P2 全内存，所以这个状态只在本次进程内可见；让它跨重启可见是 P3 的 journal 的事。
   */
  markInterrupted(teamId: string, reason: string, statusReason?: string): number {
    const team = this.requireTeam(teamId);
    const marked = markMembersInterrupted(team, reason, statusReason, this.append);
    if (marked > 0) this.notify(teamId);
    return marked;
  }

  /** 取消整个 Team（宿主关闭或 `POST /cancel`）：逐个请求取消，返回被请求的数量。 */
  cancelTeam(teamId: string, reason?: string): number {
    const team = this.requireTeam(teamId);
    let asked = 0;
    for (const member of [...team.members.values()]) {
      if (isSettledMemberStatus(member.status)) continue;
      requestMemberCancellation({
        team,
        member,
        reason: reason ?? 'Team 被取消。',
        cancels: this.cancels,
        append: this.append,
      });
      asked += 1;
    }
    if (asked > 0) this.notify(teamId);
    return asked;
  }

  /* ------------------------------------------------------------------ 任务 */

  createTask(input: {
    readonly teamId: string;
    readonly title: string;
    readonly description: string;
    readonly blockedBy?: readonly string[];
    readonly writeScopes?: readonly string[];
  }): TeamTask {
    const team = this.requireTeam(input.teamId);
    const task = createTaskIn(team, input, { newId: this.newId, append: this.append });
    this.notify(team.id);
    return task;
  }

  getTask(teamId: string, taskId: string): TeamTask | undefined {
    return this.teams.get(teamId)?.tasks.get(taskId);
  }

  /**
   * 任务板 CAS 更新。
   *
   * 冲突（`expectedRevision` 不是当前 revision）抛 `TEAM_TASK_STALE_REVISION`，并把当前
   * revision 放进 details —— 调用方据此 refresh 再试，而不是猜。校验与应用在
   * `team-ops-tasks.ts` 的 `applyTaskPatch`，这里只负责记日志、重算依赖与唤醒。
   */
  updateTask(input: {
    readonly teamId: string;
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly patch: TeamTaskPatch;
    readonly actor?: TeamTaskActor;
  }): TeamTask {
    const team = this.requireTeam(input.teamId);
    const task = applyTaskPatch({
      team,
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      patch: input.patch,
      actor: input.actor,
    });
    this.appendRecord(team.id, { type: 'task-updated', task: taskSnapshot(task) });
    // A derived blocked↔pending change is a real state change a replay must see, so
    // each promoted/demoted task is appended too — but *without* a revision bump
    // (see `refreshBlocked`), which is why the snapshot carries its own revision.
    refreshBlocked(team, this.append);
    this.notify(team.id);
    return task;
  }

  /**
   * 宿主侧的指派（`dispatch_agent` 带 `taskId` 时）：写上 owner 并进入 `in_progress`。
   *
   * 内部用当前 revision 做 CAS，因此和模型侧走的是同一条路径与同一套拒绝规则
   * （被依赖挡住时照样 `TEAM_TASK_BLOCKED`）。
   */
  assignTask(teamId: string, taskId: string, memberId: string): TeamTask {
    const task = this.getTask(teamId, taskId);
    if (task === undefined) {
      throw new TeamError(TEAM_ERROR_CODES.taskNotFound, `任务 ${taskId} 不存在。`, { taskId });
    }
    return this.updateTask({
      teamId,
      taskId,
      expectedRevision: task.revision,
      patch: { ownerMemberId: memberId, status: 'in_progress' },
    });
  }

  /* ------------------------------------------------------------------ 消息 */

  /**
   * 记录一条消息。`from`/`to` 由调用方（宿主可信上下文）给，模型侧表单里没有这两个字段。
   *
   * P2 只记 `queued`：**不做会话注入**，所以没有投递尝试、也就没有 `inflight`/`candidate`/
   * `fresh-reader-visible`。这不是「已投递」，只是「宿主记下了」。
   *
   * 校验与组装在 `team-ops-delivery.ts` 的 `buildMessage`（收件人必须是本 Team 成员或
   * {@link TEAM_LEAD_ID}）；这里负责入账、推进成员游标、记日志与唤醒。
   */
  appendMessage(input: TeamMessageInput): TeamMessage {
    const team = this.requireTeam(input.teamId);
    const message = buildMessage(team, input, this.newId);
    team.messages.push(message);
    for (const memberId of [message.from, message.to]) {
      const member = team.members.get(memberId);
      if (member === undefined) continue;
      member.lastSeq = message.seq;
      // The cursor move is part of the member's state (readers page with it), so it
      // is journaled with the member — otherwise a replay would restore `lastSeq`
      // from before this message and the round-trip would drift.
      this.appendRecord(team.id, { type: 'member-updated', member: memberSnapshot(member) });
    }
    this.appendRecord(team.id, { type: 'message-queued', message: messageSnapshot(message) });
    this.notify(team.id);
    if (this.onInboxItem !== undefined) {
      try {
        this.onInboxItem(message);
      } catch {
        // An observer failure is not a reason to lose a message that is already
        // recorded; the item simply waits for the next trigger.
      }
    }
    return message;
  }

  /**
   * 内存态的投递认领（读侧视图）。实现见 `team-ops-delivery.ts` 的 `claimDelivery`：
   * 只有第一次调用拿到 `true`；消息不存在也回 `false`。
   */
  claimDelivery(teamId: string, messageId: string): boolean {
    return claimDelivery(this.requireTeam(teamId), messageId, this.ledger);
  }

  /**
   * 认领投递并**先让认领落到磁盘**——注入器唯一可以用的认领。实现见
   * `team-ops-delivery.ts` 的 `claimDeliverySynced`（含 `journalUnavailable` 的语义）。
   */
  claimDeliverySynced(teamId: string, messageId: string): 'claimed' | 'alreadyClaimed' | 'journalUnavailable' {
    return claimDeliverySynced(this.requireTeam(teamId), messageId, this.ledger);
  }

  /** Whether a delivery attempt has already been claimed for this message. */
  deliveryClaimed(messageId: string): boolean {
    return this.claimed.has(messageId);
  }

  /** Messages that are still `queued` and have never had their one attempt claimed. */
  pendingDeliveries(teamId: string): readonly TeamMessage[] {
    const team = this.requireTeam(teamId);
    return team.messages.filter((message) => message.deliveryState === 'queued' && !this.claimed.has(message.id));
  }

  /**
   * Record a delivery-state change for one message.
   *
   * P3-B's acknowledgement steps (`host-ack`, then the read-back that earns
   * `fresh-reader-visible`) call this; P3-A only has to journal and replay it.
   */
  setMessageDeliveryState(
    teamId: string,
    messageId: string,
    state: TeamDeliveryState,
    extra: { readonly failureReason?: string; readonly deliveryMode?: TeamDeliveryMode } = {},
  ): TeamMessage {
    const team = this.requireTeam(teamId);
    const message = setMessageDeliveryState(team, messageId, state, extra, this.append);
    this.notify(teamId);
    return message;
  }

  /**
   * Record why an injectable item has not been injected yet.
   *
   * `reason` must be one of the closed constants in `TEAM_PENDING_REASONS`: it is
   * host-side metadata and must never carry text produced by a member. Nothing is
   * claimed and no state moves — the item stays `queued`, which is the point:
   * "no live session right now" is not a failure and must not burn the one
   * delivery attempt.
   */
  setMessagePendingReason(teamId: string, messageId: string, reason: string): TeamMessage {
    const team = this.requireTeam(teamId);
    const message = setMessagePendingReason(team, messageId, reason, this.append);
    this.notify(teamId);
    return message;
  }

  /** Every inbox item, in sequence order — what an injector sweeps. */
  inbox(teamId: string): readonly TeamMessage[] {
    return [...this.requireTeam(teamId).messages].sort((left, right) => left.seq - right.seq);
  }

  /* -------------------------------------------------------------- 等待/幂等 */

  /**
   * 等到成员 settle（或超时）。**只返回已 settle 成员**的最终文本，仍在跑的只在 `pending` 里列 id。
   *
   * 等待是事件驱动的：`settleMember` / `interruptMember` / `message` 都会唤醒它，所以
   * 「成员刚结束」与「wait 返回」之间没有轮询延迟。
   *
   * **已知边界（独立验证者登记，行为不改）**：超时**不取消**任何成员——它只是停止等待，
   * 成员照旧跑。因此「超时之后并发槽位何时释放」取决于被中止的 turn 是否真的退出：验证者的
   * 真装配实验里，一个不响应 abort 的 stream 在 2 秒后 `capacity.size` 仍是 1。要真正停下
   * 成员得用 `interrupt_agent`（它下传 AbortSignal），而且即使那样，租约也要等 run 自己收尾
   * 才归还——这是现有 worker 生命周期的语义，不是 `wait_team` 能保证的事。
   */
  async waitForSettled(
    teamId: string,
    options: { readonly memberIds?: readonly string[]; readonly timeoutMs?: number } = {},
  ): Promise<TeamWaitView> {
    const team = this.requireTeam(teamId);
    const wanted = options.memberIds === undefined ? [...team.members.keys()] : [...options.memberIds];
    for (const id of wanted) this.requireMember(teamId, id);
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TEAM_WAIT_MS, 0), MAX_TEAM_WAIT_MS);
    const deadline = this.now() + timeoutMs;
    return waitForSettledView({
      teamId,
      team,
      wanted,
      deadline,
      now: this.now,
      raceChange: (id, ms) => raceChange(this.waiters, id, ms, this.delay),
    });
  }

  /**
   * 幂等键查询。
   *
   * P2 的语义：**同一个 `requestId` 再来一次会被拒绝**（`TEAM_REQUEST_DUPLICATE`），而不是
   * 静默重放——内存里没有足够信息证明「上次那次到底做完了什么」，假装成功比重说一遍更危险。
   * 调用方可以列成员/任务或 `wait_team` 去看真实结果。
   */
  rememberRequest(teamId: string, requestId: string, entityId: string): void {
    this.requests.set(`${teamId}:${requestId}`, entityId);
  }

  requestOwner(teamId: string, requestId: string): string | undefined {
    return this.requests.get(`${teamId}:${requestId}`);
  }

  /* ----------------------------------------------------------------- 内部 */

  /** Append one record, when a journal is attached. A journal failure must not
   * take the runtime down: the in-memory state is already the source of truth for
   * this process, and the caller learns about a broken journal by the fact that a
   * restart loses more than it should. */
  private appendRecord(teamId: string, record: { readonly type: string } & Record<string, unknown>): void {
    if (this.journal === undefined) return;
    this.journal.append(teamId, record);
  }

  /**
   * Rebuild one team from its journal records — the P3-A replay.
   *
   * Records are applied in order; each carries the entity **after** its change, so
   * the last record for an entity wins and replaying twice is a no-op. Two things
   * are deliberately *not* replayed from the file:
   *
   *   - **A live member cannot be revived.** A member whose last recorded status is
   *     `running` or `cancelling` belonged to an in-memory worker session that died
   *     with the process; it is recorded here as `interrupted` (the same state P2
   *     used for an unconfirmed stop). Its `TEAM_MEMBER_NOT_ACTIVE` guard therefore
   *     still refuses any attempt to write the task board from it.
   *   - **A settled member's text is restored**, because it was appended while the
   *     member settled.
   *
   * Returns what the rebuild changed, so a caller can report it instead of guessing.
   * The record loop and the closing normalisation live in `team-ops-replay.ts`
   * (`replayRecords` / `normalizeRestoredMembers`).
   */
  hydrate(input: { readonly teamId: string; readonly records: readonly TeamJournalRecord[] }): {
    readonly teamId: string;
    /** Whether a team actually exists in memory after this replay. */
    readonly created: boolean;
    readonly members: number;
    readonly tasks: number;
    readonly messages: number;
    readonly interrupted: number;
    readonly claimed: number;
  } {
    const journal = this.journal;
    return hydrateTeam({
      teamId: input.teamId,
      records: input.records,
      now: this.now,
      teams: this.teams,
      parentIndex: this.parentIndex,
      claimed: this.claimed,
      // Continue the record numbering after the highest replayed seq.
      seed: journal !== undefined && 'seed' in journal
        ? (teamId, seq): void => {
          (journal as { seed(teamId: string, seq: number): void }).seed(teamId, seq);
        }
        : undefined,
    });
  }

  requireTeam(teamId: string): Team {
    const team = this.teams.get(teamId);
    if (team === undefined) {
      throw new TeamError(TEAM_ERROR_CODES.teamNotFound, `Team ${teamId} 不存在。`, { teamId });
    }
    return team;
  }

  requireMember(teamId: string, memberId: string): TeamMember {
    return requireMemberIn(this.requireTeam(teamId), memberId);
  }

  private notify(teamId: string): void {
    notifyWaiters(this.waiters, teamId);
  }
}

/* --------------------------------------------- 原路径再导出（导出面不变） ---- */

/**
 * 原本从这个文件导出的名字全部仍然从**这个路径**可用：调用方（`server/pi/host.ts`、
 * `scripts/check-agent-team*.ts`，以及 `scripts/check-agent-team-browser.mjs` 那个带
 * `.ts` 扩展名的动态 import）零改动。实现分别在契约与快照/投影模块里。
 */
export {
  DEFAULT_TEAM_WAIT_MS,
  MAX_TEAM_WAIT_MS,
  definitionSnapshotHash,
} from './team-runtime-contract';
export type {
  TeamRuntimeOptions,
  TeamTaskActor,
  TeamTaskPatch,
} from './team-runtime-contract';
