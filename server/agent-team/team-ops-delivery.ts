/**
 * Team 运行时的纯函数操作层（消息与投递）：消息构造/查找、投递状态与认领账本。
 *
 * 从 `team-runtime-ops.ts` 二次拆出（拆分重构，行为不变）：逐字搬迁，不改语句顺序与错误码。
 */

import type { TeamJournalLike } from './team-journal';
import type { AppendTeamRecord } from './team-runtime-contract';
import { messageSnapshot } from './team-snapshot';
import {
  TEAM_ERROR_CODES,
  TEAM_LEAD_ID,
  TeamError,
  type Team,
  type TeamDeliveryMode,
  type TeamDeliveryState,
  type TeamMessage,
  type TeamMessageKind,
  type TeamMessageOrigin,
} from './team-types';

/* ------------------------------------------------------------------ 消息 ---- */

/** `appendMessage` 的入参；`from`/`to` 由调用方（宿主可信上下文）给，模型侧表单里没有这两个字段。 */
export interface TeamMessageInput {
  readonly teamId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: TeamMessageKind;
  readonly payload: unknown;
  readonly deliveryState?: TeamDeliveryState;
  /** P3-B host metadata; never accepted from a model-facing tool. */
  readonly origin?: TeamMessageOrigin;
  readonly deliveredAsToolResult?: boolean;
}

/**
 * 构造一条消息：收件人校验 + seq 递增 + 组装。**不 push、不记日志、不通知**——调用方负责
 * 把它交给账本。校验失败时 seq 不推进（与拆出前的语句顺序一致）。
 */
export function buildMessage(team: Team, input: TeamMessageInput, newId: () => string): TeamMessage {
  // A `member-settle` item IS the member's final text, and in the synchronous dispatch
  // design that text has already reached the orchestrator as `dispatch_agent`'s tool
  // result — so it must never be injected on top of it. The default closes that hole in
  // the runtime instead of trusting every producer to remember the flag; a producer that
  // knows the text did *not* reach the model (a future async settle) passes `false`.
  const deliveredAsToolResult = input.deliveredAsToolResult
    ?? (input.origin === 'member-settle' ? true : undefined);
  if (input.to !== TEAM_LEAD_ID && !team.members.has(input.to)) {
    throw new TeamError(
      TEAM_ERROR_CODES.memberNotFound,
      `收件人 ${input.to} 不是本 Team 的成员。`,
      { to: input.to },
    );
  }
  team.seq += 1;
  return {
    id: newId(),
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
}

/* -------------------------------------------------------------- 投递账本 ---- */

/** messageId 的投递账本，以及它需要的接缝：日志、记录追加与「状态变了」的唤醒。 */
export interface DeliveryLedger {
  readonly claimed: Set<string>;
  readonly journal: TeamJournalLike | undefined;
  readonly appendRecord: AppendTeamRecord;
  readonly notify: (teamId: string) => void;
}

/** 找一条消息；不存在时抛 `memberNotFound`（与拆出前的错误码与文本一致）。 */
export function requireMessage(team: Team, messageId: string): TeamMessage {
  const message = team.messages.find((entry) => entry.id === messageId);
  if (message === undefined) {
    throw new TeamError(TEAM_ERROR_CODES.memberNotFound, `消息 ${messageId} 不存在。`, { messageId });
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
export function claimDelivery(team: Team, messageId: string, ledger: DeliveryLedger): boolean {
  if (ledger.claimed.has(messageId)) return false;
  const message = team.messages.find((entry) => entry.id === messageId);
  if (message === undefined) return false;
  ledger.claimed.add(messageId);
  ledger.appendRecord(team.id, { type: 'delivery-claimed', messageId });
  message.deliveryState = 'inflight';
  ledger.appendRecord(team.id, { type: 'message-updated', message: messageSnapshot(message) });
  ledger.notify(team.id);
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
export function claimDeliverySynced(
  team: Team,
  messageId: string,
  ledger: DeliveryLedger,
): 'claimed' | 'alreadyClaimed' | 'journalUnavailable' {
  if (ledger.claimed.has(messageId)) return 'alreadyClaimed';
  const message = requireMessage(team, messageId);
  const appendSynced = ledger.journal?.appendSynced?.bind(ledger.journal);
  if (appendSynced === undefined) return 'journalUnavailable';

  const previous = message.deliveryState;
  message.deliveryState = 'inflight';
  const written = appendSynced(team.id, [
    { type: 'delivery-claimed', messageId },
    { type: 'message-updated', message: messageSnapshot(message) },
  ]);
  if (written === undefined) {
    // Nothing was flushed, so nothing may look claimed: put the item back exactly as it
    // was and let the next sweep try again.
    message.deliveryState = previous;
    return 'journalUnavailable';
  }
  ledger.claimed.add(messageId);
  ledger.notify(team.id);
  return 'claimed';
}

/**
 * Record a delivery-state change for one message.
 *
 * P3-B's acknowledgement steps (`host-ack`, then the read-back that earns
 * `fresh-reader-visible`) call this; P3-A only has to journal and replay it.
 */
export function setMessageDeliveryState(
  team: Team,
  messageId: string,
  state: TeamDeliveryState,
  extra: { readonly failureReason?: string; readonly deliveryMode?: TeamDeliveryMode } = {},
  append: AppendTeamRecord,
): TeamMessage {
  const message = requireMessage(team, messageId);
  message.deliveryState = state;
  if (extra.failureReason !== undefined) message.failureReason = extra.failureReason;
  if (extra.deliveryMode !== undefined) message.deliveryMode = extra.deliveryMode;
  // A state change means the item is no longer merely waiting.
  if (state !== 'queued') delete message.pendingReason;
  append(team.id, { type: 'message-updated', message: messageSnapshot(message) });
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
export function setMessagePendingReason(
  team: Team,
  messageId: string,
  reason: string,
  append: AppendTeamRecord,
): TeamMessage {
  const message = requireMessage(team, messageId);
  message.pendingReason = reason;
  append(team.id, { type: 'message-updated', message: messageSnapshot(message) });
  return message;
}
