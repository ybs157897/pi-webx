/**
 * Per-session event journal: the in-memory ordered log every subscriber's
 * stream is cut from, dsh's session-history journal in miniature.
 *
 * Each broadcast frame gets a dense, monotonically increasing `seq`. A
 * reconnecting client that knows its last applied seq gets the tail replayed;
 * when the tail no longer reaches back that far, replay is refused and the
 * caller answers `resync-required` so the client rebuilds from a
 * `get_messages` snapshot instead.
 *
 * This is explicitly NOT durable replay: the pi SessionManager's JSONL stays
 * the authoritative record, the journal only bridges brief disconnects, and a
 * journal that dies with its session degrades to snapshot recovery.
 */

import type { JournalEntry, ServerFrame } from '../../src/shared/protocol';

/** Frames retained per session; ~1000 covers long streaming turns with room. */
const CAPACITY = 1000;

export class SessionJournal {
  private seq = 0;
  private readonly ring: JournalEntry[] = [];

  /** Number assigned to the next appended frame. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  /** Seq of the newest frame; 0 when nothing has been journaled yet. */
  get latestSeq(): number {
    return this.seq;
  }

  /** Seq of the oldest retained frame; `latestSeq + 1` when empty. */
  get oldestSeq(): number {
    return this.ring.length > 0 ? (this.ring[0]?.seq ?? 0) : this.seq + 1;
  }

  /** Assign the next seq and retain the frame. */
  append(frame: ServerFrame): JournalEntry {
    this.seq += 1;
    const entry: JournalEntry = { seq: this.seq, frame };
    this.ring.push(entry);
    if (this.ring.length > CAPACITY) this.ring.splice(0, this.ring.length - CAPACITY);
    return entry;
  }

  /**
   * Frames with `seq > fromSeq`, in order — the contiguous replay a reconnecting
   * client needs. `null` when the journal no longer reaches back to `fromSeq`
   * (the client asked too late): the caller must demand a full resync.
   */
  replayFrom(fromSeq: number): JournalEntry[] | null {
    if (!Number.isFinite(fromSeq) || fromSeq < 0) return null;
    if (fromSeq > this.seq) {
      // The client is ahead of us (server restart with a fresh journal): the
      // safest answer is also a resync.
      return fromSeq === this.seq ? [] : null;
    }
    if (fromSeq < this.oldestSeq - 1) return null;
    const start = this.ring.findIndex((entry) => entry.seq > fromSeq);
    return start < 0 ? [] : this.ring.slice(start);
  }
}

/**
 * Per-session prompt-request ledger for idempotent submits and echo retire.
 *
 * `pending` marks a prompt command the host has accepted; the next durable user
 * message claims it (its frame is annotated `source.requestId`) and moves the
 * id to `settled`. A repeat of a known id is answered as accepted without
 * re-submitting to pi — dsh's commands.ts requestId check, whose job is
 * distinct from the HTTP transport's correlation.
 */
export class PromptRequests {
  /** insertion-ordered: front = oldest pending */
  private readonly pending: string[] = [];
  private readonly settled = new Set<string>();
  private readonly seen = new Set<string>();

  constructor(private readonly settledLimit = 256) {}

  /** Record a new id. `false` when the id was already seen — a duplicate submit. */
  add(requestId: string): boolean {
    if (this.seen.has(requestId)) return false;
    this.seen.add(requestId);
    this.pending.push(requestId);
    this.trim();
    return true;
  }

  /** Forget a failed submit entirely, so retrying with the same id re-attempts. */
  forget(requestId: string): void {
    const index = this.pending.indexOf(requestId);
    if (index >= 0) this.pending.splice(index, 1);
    this.settled.delete(requestId);
    this.seen.delete(requestId);
  }

  /** Claim the oldest pending id for an incoming durable user message, if any. */
  consumePending(): string | null {
    while (this.pending.length > 0) {
      const requestId = this.pending.shift();
      if (requestId === undefined) break;
      if (this.settled.has(requestId)) continue;
      this.settled.add(requestId);
      this.trim();
      return requestId;
    }
    return null;
  }

  private trim(): void {
    while (this.settled.size > this.settledLimit) {
      const oldest = this.settled.values().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
      this.seen.delete(oldest);
    }
  }
}
