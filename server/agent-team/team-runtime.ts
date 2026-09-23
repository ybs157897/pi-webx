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
 */

import { createHash, randomUUID } from 'node:crypto';

import type { FrozenDefinition } from '../pi/subagent-tool';
import type {
  TeamJournalLike,
  TeamJournalRecord,
} from './team-journal';
import {
  TEAM_ERROR_CODES,
  TEAM_INTERRUPT_REASONS,
  TEAM_LEAD_ID,
  TeamError,
  boundTeamText,
  isSettledMemberStatus,
  isTaskBlocked,
  isTerminalTaskStatus,
  type Team,
  type TeamDeliveryState,
  type TeamMember,
  type TeamMemberStatus,
  type TeamMemberView,
  type TeamMessage,
  type TeamDeliveryMode,
  type TeamMessageKind,
  type TeamMessageOrigin,
  type TeamMessageView,
  type TeamProjection,
  type TeamTask,
  type TeamTaskStatus,
  type TeamTaskView,
  type TeamWaitView,
} from './team-types';

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
const DEFAULT_DELAY = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** 冻结定义的内容指纹：同一 revision 下内容变了也能看出来（前 16 位十六进制）。 */
export function definitionSnapshotHash(definition: FrozenDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);
}

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

  constructor(options: TeamRuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.delay = options.delay ?? DEFAULT_DELAY;
    this.journal = options.journal;
    this.onInboxItem = options.onInboxItem;
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
    return {
      teamId: team.id,
      parentSessionId: team.parentSessionId,
      createdAt: team.createdAt,
      members: [...team.members.values()].map(toMemberView),
      tasks: [...team.tasks.values()].map(toTaskView),
      messages: team.messages.map(toMessageView),
      notes: [
        '投递语义是 **at-most-once**：认领记录先 fsync 落盘再发送，因此重启不会重复投递；'
        + '代价是 fsync 之后、发送之前崩溃会让这一条丢一次，重放后表现为 inflight 且没有 candidate。'
        + '残余边界（普通崩溃拿不到）：**已经 fsync 的认领记录本身被删除或截断**（不是崩溃丢尾），'
        + '**且**目标会话的转录也读不回该 messageId（全新转录 / 无读回接缝）时，同一段文本会再次投递。',
        '消息按 deliveryState 走：queued 待投、inflight 已认领（此刻它不该再被投第二次）、'
        + 'candidate 已交出但读回未确认、fresh-reader-visible 读回已确认、failed 是闭集原因拒绝或发送失败。',
        '没有 journal（或 journal 不可用）的运行时**不投递**：认领无法落盘时，项留在 queued 并把'
        + 'pendingReason 记为 journal-unavailable —— 「没落地就不投」是 at-most-once 的前提。',
        'from/to/teamId 由宿主填写；消息 payload 与任务标题/描述是模型文本，读作不可信数据。',
        '成员的 sessionId 在 P2 是内存 run 标识（dispatch 的 runId），不是可恢复的持久会话 id，'
        + '不能据此 open() 回一个会话；跨重启的会话关联由 P3 的 TeamJournal 引入。',
      ],
    };
  }

  /* ------------------------------------------------------------------ 成员 */

  /** 登记一个成员。`sessionId` 在派发返回后由 {@link settleMember} 补上（runId）。 */
  addMember(input: { readonly teamId: string; readonly definition: FrozenDefinition }): TeamMember {
    const team = this.requireTeam(input.teamId);
    const member: TeamMember = {
      id: this.newId(),
      teamId: team.id,
      definitionId: input.definition.id,
      definitionRevision: input.definition.revision,
      definitionSnapshotHash: definitionSnapshotHash(input.definition),
      sessionId: '',
      status: 'running',
      createdAt: this.now(),
      lastSeq: team.seq,
    };
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
    const member = this.requireMember(input.teamId, input.memberId);
    member.status = input.status;
    if (input.sessionId !== undefined) member.sessionId = input.sessionId;
    if (input.text !== undefined) member.resultText = input.text;
    this.appendRecord(input.teamId, { type: 'member-updated', member: memberSnapshot(member) });
    this.notify(input.teamId);
    return member;
  }

  /**
   * 请求取消一个成员：状态先到 `cancelling`，再把原因交给宿主登记的取消钩子
   * （AbortSignal 经现有 adapter 下传 worker）。真正落到 `cancelled` 由派发方在
   * worker 收尾时调 {@link settleMember} —— 取消是协作式的，不假装立刻停住。
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
    member.status = 'cancelling';
    this.appendRecord(input.teamId, { type: 'member-updated', member: memberSnapshot(member) });
    const reason = input.reason ?? '编排者取消了该成员。';
    const cancel = this.cancels.get(member.id);
    if (cancel !== undefined) cancel(reason);
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
    let marked = 0;
    for (const member of team.members.values()) {
      if (isSettledMemberStatus(member.status)) continue;
      member.status = 'interrupted';
      member.resultText ??= reason;
      if (statusReason !== undefined) member.statusReason = statusReason;
      this.appendRecord(teamId, { type: 'member-updated', member: memberSnapshot(member) });
      marked += 1;
    }
    if (marked > 0) this.notify(teamId);
    return marked;
  }

  /** 取消整个 Team（宿主关闭或 `POST /cancel`）：逐个请求取消，返回被请求的数量。 */
  cancelTeam(teamId: string, reason?: string): number {
    const team = this.requireTeam(teamId);
    let asked = 0;
    for (const member of [...team.members.values()]) {
      if (isSettledMemberStatus(member.status)) continue;
      member.status = 'cancelling';
      this.appendRecord(teamId, { type: 'member-updated', member: memberSnapshot(member) });
      const cancel = this.cancels.get(member.id);
      if (cancel !== undefined) cancel(reason ?? 'Team 被取消。');
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
    const blockedBy = [...new Set(input.blockedBy ?? [])];
    for (const dependency of blockedBy) {
      if (!team.tasks.has(dependency)) {
        throw new TeamError(
          TEAM_ERROR_CODES.taskNotFound,
          `blockedBy 里的任务 ${dependency} 不存在。`,
          { taskId: dependency },
        );
      }
    }
    const task: TeamTask = {
      id: this.newId(),
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
    this.appendRecord(team.id, { type: 'task-created', task: { ...task, blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] } });
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
   * revision 放进 details —— 调用方据此 refresh 再试，而不是猜。
   */
  updateTask(input: {
    readonly teamId: string;
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly patch: TeamTaskPatch;
    readonly actor?: TeamTaskActor;
  }): TeamTask {
    const team = this.requireTeam(input.teamId);
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
      if (input.patch.ownerMemberId !== undefined) {
        throw new TeamError(
          TEAM_ERROR_CODES.overrideRejected,
          '成员不能改任务的 owner；指派由编排者用 dispatch_agent 的 taskId 完成。',
          { taskId: task.id },
        );
      }
    }
    const next = input.patch.status;
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
    if (input.patch.title !== undefined) task.title = input.patch.title;
    if (input.patch.description !== undefined) task.description = input.patch.description;
    if (input.patch.ownerMemberId !== undefined) task.ownerMemberId = input.patch.ownerMemberId;
    if (next !== undefined) task.status = next;
    task.revision += 1;
    this.appendRecord(team.id, { type: 'task-updated', task: taskSnapshot(task) });
    // A derived blocked↔pending change is a real state change a replay must see, so
    // each promoted/demoted task is appended too — but *without* a revision bump
    // (see `refreshBlocked`), which is why the snapshot carries its own revision.
    this.refreshBlocked(team);
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

  /** 依赖变化后重算 `blocked` ↔ `pending`；终态任务不动。 */
  private refreshBlocked(team: Team): void {
    for (const task of team.tasks.values()) {
      if (isTerminalTaskStatus(task.status) || task.status === 'in_progress') continue;
      const blocked = isTaskBlocked(task, team.tasks);
      if (blocked && task.status === 'pending') {
        task.status = 'blocked';
        this.appendRecord(team.id, { type: 'task-updated', task: taskSnapshot(task) });
      } else if (!blocked && task.status === 'blocked') {
        task.status = 'pending';
        this.appendRecord(team.id, { type: 'task-updated', task: taskSnapshot(task) });
      }
    }
  }

  /* ------------------------------------------------------------------ 消息 */

  /**
   * 记录一条消息。`from`/`to` 由调用方（宿主可信上下文）给，模型侧表单里没有这两个字段。
   *
   * P2 只记 `queued`：**不做会话注入**，所以没有投递尝试、也就没有 `inflight`/`candidate`/
   * `fresh-reader-visible`。这不是「已投递」，只是「宿主记下了」。
   */
  appendMessage(input: {
    readonly teamId: string;
    readonly from: string;
    readonly to: string;
    readonly kind: TeamMessageKind;
    readonly payload: unknown;
    readonly deliveryState?: TeamDeliveryState;
    /** P3-B host metadata; never accepted from a model-facing tool. */
    readonly origin?: TeamMessageOrigin;
    readonly deliveredAsToolResult?: boolean;
  }): TeamMessage {
    // A `member-settle` item IS the member's final text, and in the synchronous dispatch
    // design that text has already reached the orchestrator as `dispatch_agent`'s tool
    // result — so it must never be injected on top of it. The default closes that hole in
    // the runtime instead of trusting every producer to remember the flag; a producer that
    // knows the text did *not* reach the model (a future async settle) passes `false`.
    const deliveredAsToolResult = input.deliveredAsToolResult
      ?? (input.origin === 'member-settle' ? true : undefined);
    const team = this.requireTeam(input.teamId);
    if (input.to !== TEAM_LEAD_ID && !team.members.has(input.to)) {
      throw new TeamError(
        TEAM_ERROR_CODES.memberNotFound,
        `收件人 ${input.to} 不是本 Team 的成员。`,
        { to: input.to },
      );
    }
    team.seq += 1;
    const message: TeamMessage = {
      id: this.newId(),
      teamId: team.id,
      from: input.from,
      to: input.to,
      kind: input.kind,
      payload: input.payload,
      deliveryState: input.deliveryState ?? 'queued',
      seq: team.seq,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(deliveredAsToolResult === undefined ? {} : { deliveredAsToolResult }),
    };
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
   * Claim the single delivery attempt for one message, **in memory only**.
   *
   * The claim is journaled through the cheap path, so the answer survives a restart
   * *as long as the journal's tail survives* — which is not the same as flushed. The
   * injector must use {@link claimDeliverySynced} instead; this variant is the P3-A
   * ledger view used by readers, tests and the wait/pending queries.
   *
   * `true` means "you own the one attempt"; `false` means it was already taken, or the
   * message does not exist.
   */
  claimDelivery(teamId: string, messageId: string): boolean {
    const team = this.requireTeam(teamId);
    if (this.claimed.has(messageId)) return false;
    const message = team.messages.find((entry) => entry.id === messageId);
    if (message === undefined) return false;
    this.claimed.add(messageId);
    this.appendRecord(teamId, { type: 'delivery-claimed', messageId });
    message.deliveryState = 'inflight';
    this.appendRecord(teamId, { type: 'message-updated', message: messageSnapshot(message) });
    this.notify(teamId);
    return true;
  }

  /**
   * Claim the one delivery attempt **and get the claim onto disk first**.
   *
   * This is the only claim the injector may use. The claim line and the `inflight`
   * state line are written together and `fsync`ed before this returns `'claimed'`, so
   * "the attempt is spent" is on stable storage *before* the caller sends anything.
   * The localised cost (one fsync per delivery attempt) and what it buys are documented
   * on {@link TeamJournalLike.appendSynced}.
   *
   * `'journalUnavailable'` means **nothing landed**: no journal is attached, the journal
   * is disabled, or the write/flush failed. The message is left exactly as it was
   * (`queued`, unclaimed, no in-memory claim) so a later sweep — after the journal
   * recovers — can try again. A caller must never send in that case: delivering on a
   * claim that is not on disk is what makes the same text reach a model twice.
   *
   * The failure mode this deliberately accepts is **at-most-once**: if the process dies
   * after the flush and before the send, that item is never delivered. A replay shows it
   * as `inflight` with no `candidate`, which is exactly how a reader can tell this apart
   * from "delivered but unconfirmed".
   */
  claimDeliverySynced(teamId: string, messageId: string): 'claimed' | 'alreadyClaimed' | 'journalUnavailable' {
    const team = this.requireTeam(teamId);
    if (this.claimed.has(messageId)) return 'alreadyClaimed';
    const message = team.messages.find((entry) => entry.id === messageId);
    if (message === undefined) {
      throw new TeamError(TEAM_ERROR_CODES.memberNotFound, `消息 ${messageId} 不存在。`, { messageId });
    }
    const appendSynced = this.journal?.appendSynced?.bind(this.journal);
    if (appendSynced === undefined) return 'journalUnavailable';

    const previous = message.deliveryState;
    message.deliveryState = 'inflight';
    const written = appendSynced(teamId, [
      { type: 'delivery-claimed', messageId },
      { type: 'message-updated', message: messageSnapshot(message) },
    ]);
    if (written === undefined) {
      // Nothing was flushed, so nothing may look claimed: put the item back exactly as it
      // was and let the next sweep try again.
      message.deliveryState = previous;
      return 'journalUnavailable';
    }
    this.claimed.add(messageId);
    this.notify(teamId);
    return 'claimed';
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
    const message = team.messages.find((entry) => entry.id === messageId);
    if (message === undefined) {
      throw new TeamError(TEAM_ERROR_CODES.memberNotFound, `消息 ${messageId} 不存在。`, { messageId });
    }
    message.deliveryState = state;
    if (extra.failureReason !== undefined) message.failureReason = extra.failureReason;
    if (extra.deliveryMode !== undefined) message.deliveryMode = extra.deliveryMode;
    // A state change means the item is no longer merely waiting.
    if (state !== 'queued') delete message.pendingReason;
    this.appendRecord(teamId, { type: 'message-updated', message: messageSnapshot(message) });
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
    const message = team.messages.find((entry) => entry.id === messageId);
    if (message === undefined) {
      throw new TeamError(TEAM_ERROR_CODES.memberNotFound, `消息 ${messageId} 不存在。`, { messageId });
    }
    message.pendingReason = reason;
    this.appendRecord(teamId, { type: 'message-updated', message: messageSnapshot(message) });
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
    // A guard against a caller clock that never advances (a frozen `now` in a
    // test, say): without it the loop below would wait forever instead of
    // reporting a timeout. 10k rounds of an event-driven wait is far beyond any
    // real conversation's lifetime.
    for (let round = 0; round < 10_000; round += 1) {
      const settled = wanted
        .map((id) => team.members.get(id))
        .filter((member): member is TeamMember => member !== undefined && isSettledMemberStatus(member.status))
        .map((member) => {
          const bounded = boundTeamText(member.resultText ?? '');
          return { memberId: member.id, status: member.status, text: bounded.text, truncated: bounded.truncated };
        });
      const pending = wanted.filter((id) => {
        const member = team.members.get(id);
        return member !== undefined && !isSettledMemberStatus(member.status);
      });
      if (pending.length === 0) return { settled, pending, timedOut: false };
      const remaining = deadline - this.now();
      if (remaining <= 0) return { settled, pending, timedOut: true };
      await this.raceChange(teamId, remaining);
    }
    // Only reachable with a non-advancing clock; reporting a timeout is the honest
    // answer, since the window has been waited out by every measure available.
    const settled = wanted
      .map((id) => team.members.get(id))
      .filter((member): member is TeamMember => member !== undefined && isSettledMemberStatus(member.status))
      .map((member) => {
        const bounded = boundTeamText(member.resultText ?? '');
        return { memberId: member.id, status: member.status, text: bounded.text, truncated: bounded.truncated };
      });
    return {
      settled,
      pending: wanted.filter((id) => {
        const member = team.members.get(id);
        return member !== undefined && !isSettledMemberStatus(member.status);
      }),
      timedOut: true,
    };
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
    let team = this.teams.get(input.teamId);
    let interrupted = 0;
    let maxSeq = 0;
    for (const record of input.records) {
      maxSeq = Math.max(maxSeq, record.seq);
      switch (record.type) {
        case 'team-created': {
          const parentSessionId = typeof record['parentSessionId'] === 'string' ? record['parentSessionId'] : '';
          const createdAt = typeof record['createdAt'] === 'number' ? record['createdAt'] : this.now();
          team = {
            id: input.teamId,
            parentSessionId,
            createdAt,
            members: new Map(),
            tasks: new Map(),
            messages: [],
            seq: 0,
          };
          this.teams.set(team.id, team);
          // The alias index: a client only ever holds the session id, and after a
          // restart the session may have no transcript at all.
          this.parentIndex.set(parentSessionId, team.id);
          break;
        }
        case 'member-added':
        case 'member-updated': {
          if (team === undefined) break;
          const member = readMember(record['member'], input.teamId);
          if (member === undefined) break;
          team.members.set(member.id, member);
          break;
        }
        case 'task-created':
        case 'task-updated': {
          if (team === undefined) break;
          const task = readTask(record['task'], input.teamId);
          if (task === undefined) break;
          team.tasks.set(task.id, task);
          break;
        }
        case 'message-queued':
        case 'message-updated': {
          if (team === undefined) break;
          const message = readMessage(record['message'], input.teamId);
          if (message === undefined) break;
          const existing = team.messages.findIndex((entry) => entry.id === message.id);
          if (existing === -1) team.messages.push(message);
          else team.messages[existing] = message;
          team.seq = Math.max(team.seq, message.seq);
          break;
        }
        case 'delivery-claimed': {
          const messageId = typeof record['messageId'] === 'string' ? record['messageId'] : undefined;
          if (messageId !== undefined) this.claimed.add(messageId);
          break;
        }
        default:
          break;
      }
    }
    if (team === undefined) {
      return { teamId: input.teamId, created: false, members: 0, tasks: 0, messages: 0, interrupted: 0, claimed: 0 };
    }
    // The process is gone, so nothing that was mid-flight can still be running.
    //
    // These members are written here, not in the journal: the record that put them in
    // `running` is the last word the process managed, and this replay is the reader that
    // draws the conclusion. The code says *which* kind of unconfirmed stop this is —
    // `restart-replay`, never `host-shutdown` (graceful shutdown is a different event,
    // written by {@link markInterrupted} while the process was still alive).
    for (const member of team.members.values()) {
      if (member.status === 'running' || member.status === 'cancelling') {
        member.status = 'interrupted';
        member.resultText ??= '宿主重启：成员会话是内存态的，无法恢复，停止未得到确认。';
        member.statusReason = TEAM_INTERRUPT_REASONS.restartReplay;
        interrupted += 1;
      }
    }
    // Continue the record numbering after the highest replayed seq.
    if (this.journal !== undefined && 'seed' in this.journal) {
      (this.journal as { seed(teamId: string, seq: number): void }).seed(input.teamId, maxSeq);
    }
    return {
      teamId: team.id,
      // "A team exists in memory after this replay" — the only thing a caller may
      // report as rebuilt. (`existed` is not part of the answer: replaying over live
      // state is the caller's own decision to make, and the answer stays truthful.)
      created: this.teams.has(team.id),
      members: team.members.size,
      tasks: team.tasks.size,
      messages: team.messages.length,
      interrupted,
      claimed: this.claimed.size,
    };
  }

  requireTeam(teamId: string): Team {
    const team = this.teams.get(teamId);
    if (team === undefined) {
      throw new TeamError(TEAM_ERROR_CODES.teamNotFound, `Team ${teamId} 不存在。`, { teamId });
    }
    return team;
  }

  requireMember(teamId: string, memberId: string): TeamMember {
    const member = this.requireTeam(teamId).members.get(memberId);
    if (member === undefined) {
      throw new TeamError(
        TEAM_ERROR_CODES.memberNotFound,
        `成员 ${memberId} 不存在。`,
        { teamId, memberId },
      );
    }
    return member;
  }

  private notify(teamId: string): void {
    const waiters = this.waiters.get(teamId);
    if (waiters === undefined) return;
    for (const wake of [...waiters]) wake();
  }

  private raceChange(teamId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const wake = (): void => {
        if (done) return;
        done = true;
        this.waiters.get(teamId)?.delete(wake);
        resolve();
      };
      const waiters = this.waiters.get(teamId) ?? new Set<() => void>();
      waiters.add(wake);
      this.waiters.set(teamId, waiters);
      void this.delay(timeoutMs).then(wake);
    });
  }
}

/* ------------------------------------------------------------ 快照与读回 ---- */

/**
 * The recorded shape of an entity.
 *
 * Snapshots rather than diffs: the replay is then "the last record for this id
 * wins", which is what makes the round-trip assertion meaningful. The copies are
 * shallow-but-explicit so a later in-memory mutation cannot rewrite history.
 */
function memberSnapshot(member: TeamMember): Record<string, unknown> {
  return {
    id: member.id,
    teamId: member.teamId,
    definitionId: member.definitionId,
    definitionRevision: member.definitionRevision,
    definitionSnapshotHash: member.definitionSnapshotHash,
    sessionId: member.sessionId,
    status: member.status,
    createdAt: member.createdAt,
    ...(member.resultText === undefined ? {} : { resultText: member.resultText }),
    ...(member.statusReason === undefined ? {} : { statusReason: member.statusReason }),
    lastSeq: member.lastSeq,
  };
}

function taskSnapshot(task: TeamTask): Record<string, unknown> {
  return {
    id: task.id,
    teamId: task.teamId,
    revision: task.revision,
    title: task.title,
    description: task.description,
    status: task.status,
    ...(task.ownerMemberId === undefined ? {} : { ownerMemberId: task.ownerMemberId }),
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
  };
}

function messageSnapshot(message: TeamMessage): Record<string, unknown> {
  return {
    id: message.id,
    teamId: message.teamId,
    from: message.from,
    to: message.to,
    kind: message.kind,
    payload: message.payload,
    deliveryState: message.deliveryState,
    seq: message.seq,
    ...(message.origin === undefined ? {} : { origin: message.origin }),
    ...(message.deliveredAsToolResult === undefined ? {} : { deliveredAsToolResult: message.deliveredAsToolResult }),
    ...(message.pendingReason === undefined ? {} : { pendingReason: message.pendingReason }),
    ...(message.failureReason === undefined ? {} : { failureReason: message.failureReason }),
    ...(message.deliveryMode === undefined ? {} : { deliveryMode: message.deliveryMode }),
  };
}

/** Read one member snapshot back. A record that does not describe a member is dropped. */
function readMember(value: unknown, teamId: string): TeamMember | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const status = record['status'];
  if (typeof id !== 'string' || typeof status !== 'string') return undefined;
  return {
    id,
    teamId,
    definitionId: typeof record['definitionId'] === 'string' ? record['definitionId'] : '',
    definitionRevision: typeof record['definitionRevision'] === 'number' ? record['definitionRevision'] : 0,
    definitionSnapshotHash: typeof record['definitionSnapshotHash'] === 'string' ? record['definitionSnapshotHash'] : '',
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    status: status as TeamMemberStatus,
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
    ...(typeof record['resultText'] === 'string' ? { resultText: record['resultText'] } : {}),
    ...(typeof record['statusReason'] === 'string' ? { statusReason: record['statusReason'] } : {}),
    lastSeq: typeof record['lastSeq'] === 'number' ? record['lastSeq'] : 0,
  };
}

/** Read one task snapshot back. */
function readTask(value: unknown, teamId: string): TeamTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string') return undefined;
  return {
    id,
    teamId,
    revision: typeof record['revision'] === 'number' ? record['revision'] : 1,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    description: typeof record['description'] === 'string' ? record['description'] : '',
    status: (typeof record['status'] === 'string' ? record['status'] : 'pending') as TeamTaskStatus,
    ...(typeof record['ownerMemberId'] === 'string' ? { ownerMemberId: record['ownerMemberId'] } : {}),
    blockedBy: Array.isArray(record['blockedBy']) ? (record['blockedBy'] as string[]) : [],
    writeScopes: Array.isArray(record['writeScopes']) ? (record['writeScopes'] as string[]) : [],
  };
}

/** Read one message snapshot back. */
function readMessage(value: unknown, teamId: string): TeamMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string') return undefined;
  return {
    id,
    teamId,
    from: typeof record['from'] === 'string' ? record['from'] : '',
    to: typeof record['to'] === 'string' ? record['to'] : '',
    kind: (typeof record['kind'] === 'string' ? record['kind'] : 'result') as TeamMessageKind,
    payload: record['payload'] ?? null,
    deliveryState: (typeof record['deliveryState'] === 'string' ? record['deliveryState'] : 'queued') as TeamDeliveryState,
    seq: typeof record['seq'] === 'number' ? record['seq'] : 0,
    ...(typeof record['origin'] === 'string' ? { origin: record['origin'] as TeamMessageOrigin } : {}),
    ...(typeof record['deliveredAsToolResult'] === 'boolean' ? { deliveredAsToolResult: record['deliveredAsToolResult'] } : {}),
    ...(typeof record['pendingReason'] === 'string' ? { pendingReason: record['pendingReason'] } : {}),
    ...(typeof record['failureReason'] === 'string' ? { failureReason: record['failureReason'] } : {}),
    ...(typeof record['deliveryMode'] === 'string' ? { deliveryMode: record['deliveryMode'] as TeamDeliveryMode } : {}),
  };
}

/* ------------------------------------------------------------------ 投影 ---- */

function toMemberView(member: TeamMember): TeamMemberView {
  return {
    memberId: member.id,
    definitionId: member.definitionId,
    definitionRevision: member.definitionRevision,
    definitionSnapshotHash: member.definitionSnapshotHash,
    sessionId: member.sessionId,
    status: member.status,
    createdAt: member.createdAt,
    lastSeq: member.lastSeq,
    hasResult: member.resultText !== undefined,
    ...(member.statusReason === undefined ? {} : { statusReason: member.statusReason }),
    ...(member.resultText === undefined ? {} : { untrustedResult: boundTeamText(member.resultText) }),
  };
}

function toTaskView(task: TeamTask): TeamTaskView {
  return {
    taskId: task.id,
    revision: task.revision,
    status: task.status,
    ...(task.ownerMemberId === undefined ? {} : { ownerMemberId: task.ownerMemberId }),
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    untrusted: { title: task.title, description: task.description },
  };
}

function toMessageView(message: TeamMessage): TeamMessageView {
  return {
    messageId: message.id,
    seq: message.seq,
    from: message.from,
    to: message.to,
    kind: message.kind,
    deliveryState: message.deliveryState,
    ...(message.origin === undefined ? {} : { origin: message.origin }),
    ...(message.deliveredAsToolResult === undefined ? {} : { deliveredAsToolResult: message.deliveredAsToolResult }),
    ...(message.pendingReason === undefined ? {} : { pendingReason: message.pendingReason }),
    ...(message.failureReason === undefined ? {} : { failureReason: message.failureReason }),
    ...(message.deliveryMode === undefined ? {} : { deliveryMode: message.deliveryMode }),
    untrustedPayload: message.payload,
  };
}
