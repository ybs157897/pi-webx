/**
 * P2 Team 数据模型与错误码。
 *
 * **P2 的 Team 状态全部在内存**（由 `PiHost` 持有）：进程重启即丢，磁盘上不会有任何
 * Team 记录。落盘队列（TeamJournal / inbox）是 P3 的事——先由 spike 把边界钉死：
 * SDK 的会话写入路径没有 fsync、`SessionManager` 没有 flush，重新 `open()` 读回只能证明
 * 「同一 OS 内新读者可见」，分不出页缓存与稳定存储（见
 * `/tmp/pi-webx-agent-team-spike/persistence-spike.md` 与独立复核 `verify-spike.md`）。
 *
 * 因此本文件的状态名只声明可证的两级：`queued`（内存里记下了）与 `fresh-reader-visible`
 * （独立读者能看到）。spike 与复核里属于「稳定存储」级别的那个词（要等 fsync 之后才配说）
 * 在这里一律不出现：P2 不写盘，也不做读回。
 *
 * 另一条同样重要：`from` / `to` / `teamId` **由宿主可信上下文填**，模型侧工具的表单里
 * 没有这三个字段（见 `team-tools.ts`）：它们是身份，不是参数。
 */

import type {
  TeamDeliveryMode, TeamDeliveryState, TeamMemberStatus,
  TeamMessageKind, TeamMessageOrigin, TeamTaskStatus,
} from '../../src/shared/agent-team';
export type {
  TeamDeliveryMode, TeamDeliveryState, TeamMemberStatus, TeamMemberView,
  TeamMessageKind, TeamMessageOrigin, TeamMessageView, TeamProjection,
  TeamTaskStatus, TeamTaskView,
} from '../../src/shared/agent-team';

/** P2 的 Team 状态是内存态，重启即丢；本常量是给调用方与文档的显式提醒。 */
export const TEAM_STATE_IS_IN_MEMORY = true;

/**
 * 编排者（Lead）在 `from`/`to` 里使用的稳定标识。
 *
 * 不是成员 id：编排者是**父会话自己**，它没有 `TeamMember` 记录。成员永远只能给这个
 * 收件人发消息（`TEAM_MESSAGE_RECIPIENT_DENIED` 之外没有第二个地址）。
 */
export const TEAM_LEAD_ID = 'lead';

/** 一次 `wait_team` 返回的结果文本上限，与 `subagent` 工具的结果上限一致。 */
export const MAX_TEAM_RESULT_CHARACTERS = 32000;

/** 一个成员：由一次 `dispatch_agent` 创建，绑一个 worker 会话。 */
export interface TeamMember {
  readonly id: string;
  readonly teamId: string;
  /** 派发时读到的定义 id 与 revision（`expectedDefinitionRevision` 与之比对）。 */
  readonly definitionId: string;
  readonly definitionRevision: number;
  /** 冻结快照的 sha256 前 16 位：同一 revision 下内容变了也能看出来。 */
  readonly definitionSnapshotHash: string;
  /**
   * **P2 中是内存 run 标识，不是可恢复的持久会话 id。**
   *
   * 记的是 dispatch 返回的 `runId`：worker 会话用 `SessionManager.inMemory`，本来就没有磁盘会话
   * 文件，所以这里**不冒充** pi 的 `sessionId`，也不能拿它 `open()` 回来。跨重启的会话关联要等
   * P3 的 TeamJournal（那才谈得上「持久会话关联」）。
   */
  sessionId: string;
  status: TeamMemberStatus;
  readonly createdAt: number;
  /** 已交回的最终文本（`wait_team` 只回它，且按 {@link MAX_TEAM_RESULT_CHARACTERS} 截断）。 */
  resultText?: string;
  /**
   * 落到当前状态的稳定原因码（闭集，见 {@link TEAM_INTERRUPT_REASONS}）。
   *
   * 目前只有**优雅停机**写它（`host-shutdown`）。P3-A 的重放把 in-flight 成员记成
   * `interrupted` 时仍然只写散文 `resultText`：那次的真实原因是「进程没能优雅收尾」，
   * 与 `host-shutdown` 不是同一件事，不能借用同一个码。
   */
  statusReason?: string;
  /** 与该成员有关的最后一条消息 seq：读者用它做增量拉取游标。 */
  lastSeq: number;
}

/** 任务板上的一条任务。`revision` 是 CAS 依据。 */
export interface TeamTask {
  readonly id: string;
  readonly teamId: string;
  /** 从 1 开始，每次成功更新 +1；`update_team_task` 的 `expectedRevision` 与之比对。 */
  revision: number;
  title: string;
  description: string;
  status: TeamTaskStatus;
  ownerMemberId?: string;
  /** 依赖的任务 id：其中任一未 `completed` 时，本任务为 `blocked`。 */
  blockedBy: string[];
  /** 建议的写入范围（字符串前缀）。P2 只记录与展示，不做强制（隔离是 P5）。 */
  writeScopes: string[];
}

/**
 * 一条 Team 消息。`payload` 是模型给的不可信内容，读的人必须自己当数据看。
 *
 * P3-B 追加的五个字段**全部可选、全部由宿主填写**（模型侧工具的表单里没有它们），
 * 因此它们属于可信侧，投影里平铺而不是放进 `untrustedPayload`。
 */
export interface TeamMessage {
  readonly id: string;
  readonly teamId: string;
  /** 宿主填：成员 id 或 {@link TEAM_LEAD_ID}。 */
  readonly from: string;
  /** 宿主填：成员 id 或 {@link TEAM_LEAD_ID}。 */
  readonly to: string;
  readonly kind: TeamMessageKind;
  readonly payload: unknown;
  deliveryState: TeamDeliveryState;
  readonly seq: number;
  /** 这条项是怎么来的：成员结算、成员主动发言，还是编排者自己发的。 */
  readonly origin?: TeamMessageOrigin;
  /**
   * 这段文本是否**已经**通过 `dispatch_agent` 的工具结果交给模型。
   *
   * `true` ⇒ 编排者已经读过它，再注入就是重复打扰（{@link TeamMessageOrigin} 为
   * `member-settle` 的成功路径就是这种）。`false`/缺省 ⇒ 还没到过模型眼里，可投递。
   */
  deliveredAsToolResult?: boolean;
  /**
   * 为什么一个**可投递**的项还没被投递（硬要求：不烧掉唯一机会时的可观测原因）。
   *
   * 目前唯一的值是 {@link TEAM_PENDING_REASONS.noLiveSession}：宿主重启后重放出来的
   * Team，其父会话没有活跃绑定 —— 此时不 claim、不注入、也不谎报 `failed`。
   */
  pendingReason?: string;
  /** `failed` 的原因文本，让失败在投影里可读而不是一个光秃秃的状态。 */
  failureReason?: string;
  /** 这次注入实际走了哪条 SDK 分支（代价归属：起了一轮 vs 排队等下一轮边界）。 */
  deliveryMode?: TeamDeliveryMode;
}

/**
 * 可投递项「还没投」的稳定原因码。
 *
 * **闭集**：这些值会进 journal、投影与测试断言，所以它们只能是常量——**绝不把成员产出的
 * 文本拼进 reason**（那会把不可信内容洗成宿主字段）。要细节就放 `details` 里的宿主值。
 */
export const TEAM_PENDING_REASONS = {
  /** 没有活的编排者会话可以投递：不 claim、不注入、不写 failed，项留在 queued。 */
  noLiveSession: 'no-live-session',
  /**
   * 认领记录无法落地（journal 未配置、不可用，或写入/fsync 失败）⇒ **不投递**。
   *
   * at-most-once 的前提是「认领先落盘，再发送」；没有落地的认领就发送，正是同一份文本
   * 进入模型上下文两次的来源。项留在 `queued`（不是 `failed`），所以 journal 恢复后下一
   * 次扫描仍可投递。
   */
  journalUnavailable: 'journal-unavailable',
} as const;

/**
 * 投递失败的稳定原因码（同样闭集，同样不含任何成员文本）。
 *
 * 只有两种情况会写 `failed`：**有活目标**但投递前置条件被否（发送者已取消/中断/失败），
 * 或者 `sendCustomMessage` 真的抛了错。
 */
export const TEAM_FAILURE_REASONS = {
  memberCancelled: 'member-cancelled',
  /**
   * 发送者处于 `cancelling`：**显式**取消已经下达、只是停止还没得到确认。
   *
   * 与 `memberInterrupted` 的区别是这整条规则的要点：取消是「别再说话了」，中断是
   * 「宿主把它弄丢了」。前者拒投，后者照投（它中断前留下的消息是它自己的话）。
   */
  memberCancelling: 'member-cancelling',
  memberInterrupted: 'member-interrupted',
  memberFailed: 'member-failed',
  sendFailed: 'send-failed',
} as const;

/**
 * 成员被「未确认的停止」收尾时的稳定原因码（闭集）。
 *
 * 与 {@link TEAM_FAILURE_REASONS} 分开，因为这不是投递失败：`interrupted` 说的是**成员的停止
 * 没有得到确认**——这一次是宿主优雅停机。人读的解释仍然写在 `resultText` 里，这里只放机器可
 * 判定、可断言、可入 journal 的码。
 */
export const TEAM_INTERRUPT_REASONS = {
  /** 宿主优雅停机：worker 的停止没有得到确认，成员记 interrupted。 */
  hostShutdown: 'host-shutdown',
  /**
   * 重放归一：日志说明这个成员当时还在 `running`/`cancelling`，而进程已经不在了。
   *
   * 与 `host-shutdown` **不是同一件事**，所以是两个码：优雅停机是「我们关了它，它没回话」，
   * 重放归一只是「它没能优雅收尾」——可能崩溃、可能被 kill，也可能日志之后才被读到。把两者
   * 合并成一个码，面板与审计就再也分不出「正常收工」和「上次没收拾干净」。
   */
  restartReplay: 'restart-replay',
} as const;

/** 一个 Team：父会话 + 成员 + 任务板 + 消息。 */
export interface Team {
  readonly id: string;
  readonly parentSessionId: string;
  readonly createdAt: number;
  readonly members: Map<string, TeamMember>;
  readonly tasks: Map<string, TeamTask>;
  readonly messages: TeamMessage[];
  /** 单调递增的消息序号。 */
  seq: number;
}

/**
 * 一次 `wait_team` 的返回。
 *
 * 三条硬语义：`settled` **只**含已 settle 成员（未 settle 的绝不出现，也不给它们的部分文本）；
 * 文本按 {@link MAX_TEAM_RESULT_CHARACTERS} 截断并带 `truncated`；`timedOut: true` 表示
 * 「窗口到了但还有人在跑」，此时 `pending` 列出它们——所以「超时仍在跑」与「已 settle」
 * 一眼可辨，不会把「还没好」当成「没有」。
 */
export interface TeamWaitView {
  readonly settled: readonly {
    readonly memberId: string;
    readonly status: TeamMemberStatus;
    readonly text: string;
    readonly truncated: boolean;
  }[];
  readonly pending: readonly string[];
  readonly timedOut: boolean;
}

/* -------------------------------------------------------------- 编排角色 ---- */

/**
 * 内置编排角色。
 *
 * 它是**角色描述**，不是 `AgentDefinition`：不进定义列表、没有存储记录、没有任何 CRUD 路径
 * 能改它（`server/builtin-agents.ts` 一个字都不动）。它只陈述三件事：职责是调度**已启用**
 * 的定义、工具面是 {@link TEAM_ORCHESTRATOR_TOOL_NAMES}、模型默认继承父会话。
 *
 * 「只读策略」指的是**它不是用户可编辑的定义**，不是「编排者只能读文件」：Team 模式会话的
 * 活动工具 = 父会话原有工具 + 这 9 个，编排者要能自己读文件、核事实、汇总（见 `host.ts` 的
 * `refreshTeamTools`）。
 */
export const TEAM_ORCHESTRATOR_ROLE = Object.freeze({
  /** 仅用于日志与断言；**不会**出现在 `AgentDefinitionsResponse` 里。 */
  id: 'builtin:team-orchestrator',
  name: 'Team orchestrator',
  /** 工具面就是这个固定集合，不接受模型覆写。 */
  tools: 'team-orchestrator',
  /** 模型继承父会话（P2 没有 UI 选择）。 */
  model: 'inherit',
  /** 不落盘、不进定义存储、没有 PATCH/DELETE 路径。 */
  readOnly: true,
} as const);

/* --------------------------------------------------------------- 工具名 ---- */

/**
 * 模型侧**恰好**这 9 个编排工具（Team 模式会话）。
 *
 * 顺序即文档顺序；`team-tools.ts` 按它构造，`host.ts` 按它装配活动集，
 * check 按它断言「一个不多一个不少」。
 */
export const TEAM_ORCHESTRATOR_TOOL_NAMES: readonly string[] = [
  'list_team_members',
  'dispatch_agent',
  'send_team_message',
  'list_team_tasks',
  'get_team_task',
  'create_team_task',
  'update_team_task',
  'wait_team',
  'interrupt_agent',
];

/**
 * 成员会话**只**拿这两个 Team 工具。
 *
 * `update_team_task` 只能改自己 owner 的任务，`send_team_message` 只能发给
 * {@link TEAM_LEAD_ID}（成员工具的表单里连 `to`/`from` 都没有）。
 */
export const TEAM_WORKER_TOOL_NAMES: readonly string[] = ['update_team_task', 'send_team_message'];

/**
 * 成员被明确拒绝的 Team 工具：9 个减去那 2 个。
 *
 * 派发时它们既不在白名单里、又进 `excludeTools`（两层防护），所以递归派发与 Team 查询在
 * 成员会话里根本不存在。
 */
export const TEAM_WORKER_FORBIDDEN_TOOL_NAMES: readonly string[] = TEAM_ORCHESTRATOR_TOOL_NAMES
  .filter((name) => !TEAM_WORKER_TOOL_NAMES.includes(name));

/* --------------------------------------------------------------- 错误码 ---- */

/** 稳定错误码：模型按它决定下一步（例如 `DEFINITION_REVISION_STALE` 要求 refresh 后重试）。 */
export const TEAM_ERROR_CODES = {
  /** 定义读不到（既不是内置也没存过）。 */
  definitionUnknown: 'TEAM_DEFINITION_UNKNOWN',
  /** 定义存在但已停用：只拦新派发，不杀在跑成员。 */
  definitionDisabled: 'TEAM_DEFINITION_DISABLED',
  /** `expectedDefinitionRevision` 与当前 revision 不符——要求重新读取后再派。 */
  definitionRevisionStale: 'DEFINITION_REVISION_STALE',
  /** 试图覆写 model/systemPrompt/tools 等，或传了未知键。 */
  overrideRejected: 'TEAM_OVERRIDE_REJECTED',
  /** 参数形状不合法（缺字段、类型不对）。 */
  invalidArguments: 'TEAM_INVALID_ARGUMENTS',
  teamNotFound: 'TEAM_NOT_FOUND',
  memberNotFound: 'TEAM_MEMBER_NOT_FOUND',
  /** 成员已 settle，不能再取消。 */
  memberSettled: 'TEAM_MEMBER_SETTLED',
  /**
   * 成员不在 `running` 中，因此不能再写任务板或回信。
   *
   * 这不是「会话已经 abort 所以调不到工具」的重复保险，而是**唯一**与传输无关的屏障：
   * 会话被取消/结束之后，P3 的持久会话与消息重投会让工具重新可达，届时只有这条状态校验
   * 拦得住「终止的成员继续改任务板」。
   */
  memberNotActive: 'TEAM_MEMBER_NOT_ACTIVE',
  taskNotFound: 'TEAM_TASK_NOT_FOUND',
  /** 任务板 CAS 冲突：`expectedRevision` 不是当前 revision。 */
  taskStaleRevision: 'TEAM_TASK_STALE_REVISION',
  /** 依赖未完成，不能进入 in_progress/completed。 */
  taskBlocked: 'TEAM_TASK_BLOCKED',
  /** 成员只能改自己 owner 的任务。 */
  taskNotOwned: 'TEAM_TASK_NOT_OWNED',
  /** 终态任务不能再改状态。 */
  taskTerminal: 'TEAM_TASK_TERMINAL',
  /** 收件人不允许（成员只能发给 lead）。 */
  recipientDenied: 'TEAM_MESSAGE_RECIPIENT_DENIED',
  /** 同一个 `requestId` 已经在处理/已处理，不能重复派发。 */
  requestDuplicate: 'TEAM_REQUEST_DUPLICATE',
} as const;

export type TeamErrorCode = typeof TEAM_ERROR_CODES[keyof typeof TEAM_ERROR_CODES];

/**
 * 一个带稳定 code 的 Team 失败。
 *
 * 与 `subagent` 工具同一条约定：**抛出去**（SDK 只有 throw 才会把工具调用标成 `isError: true`），
 * 因此把归因写进 message，并让 code 结构化可读，供宿主与测试直接取。
 */
export class TeamError extends Error {
  readonly code: TeamErrorCode;
  /** 出错的实体（team/task/member），便于调用方与日志定位。 */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: TeamErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    this.details = details;
  }
}

/* ----------------------------------------------------------------- 判据 ---- */

/** 成员是否已 settle：`running`/`cancelling` 之外都是终局。 */
export function isSettledMemberStatus(status: TeamMemberStatus): boolean {
  return status !== 'running' && status !== 'cancelling';
}

/** 任务是否已到终态：终态不能再改状态。 */
export function isTerminalTaskStatus(status: TeamTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** 一条任务是否被依赖挡住：任一 `blockedBy` 任务尚未 completed。 */
export function isTaskBlocked(task: TeamTask, tasks: ReadonlyMap<string, TeamTask>): boolean {
  return task.blockedBy.some((id) => tasks.get(id)?.status !== 'completed');
}

/**
 * 把结果文本裁到 {@link MAX_TEAM_RESULT_CHARACTERS}。
 *
 * 返回 `truncated` 而不是悄悄截断：调用方要能知道文本被裁过。
 */
export function boundTeamText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEAM_RESULT_CHARACTERS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEAM_RESULT_CHARACTERS), truncated: true };
}
