/**
 * P3-A: the append-only Team journal.
 *
 * **What this is, and what it is not.** It appends one JSON object per line to a
 * per-team file and reads those lines back so a restart can rebuild the in-memory
 * Team. It is **not** a promise that a power loss keeps the last write: every line
 * here goes out through `appendFileSync`, with **no fsync** — the same order of
 * guarantee pi's own session store offers (a study of the SDK found zero `fsync`
 * calls on its write path, and a fresh reader cannot tell a page-cache hit from
 * stable storage). The honest phrasing everywhere in this module is therefore
 * "appended via appendFile", never the word for power-loss safety.
 *
 * **One exception, on purpose**: {@link TeamJournal.appendSynced} writes a given set
 * of records and fsyncs them before returning. The injector uses it for exactly one
 * pair of lines per delivery attempt (the claim plus the `inflight` state), because
 * at-most-once injection depends on the claim being on stable storage *before* the
 * text is sent. Every other record keeps the cheap path; the module-wide "no fsync"
 * statement above is about the general journal, not about that one call.
 *
 * **Layout**: `<dir>/<teamId>.jsonl`, one file per team. Per-team files are what
 * the design actually needs (a team's writers are already serialised), and they
 * keep a corrupt line's blast radius to one team.
 *
 * **Record shape**: `{ v, seq, ts, teamId, type, ...snapshot }`, where `v` is the
 * schema version and each record carries the entity **after** the change rather
 * than a diff. Snapshots cost a few hundred bytes more than patches and make the
 * replay a straight "last write wins" per entity, which is the property the
 * round-trip check asserts; compaction is future work.
 *
 * **Reader policy**: a torn final line is dropped (that is the crash-in-the-middle
 * case), every other unreadable line is skipped and **counted** — unknown schema
 * version, unknown record type, malformed JSON, or a record belonging to another
 * team. Nothing is ever silently ignored, and nothing throws: a corrupt journal
 * must not stop the host from starting.
 *
 * **Known boundaries** (from the persistence study's review): no lock file — one
 * host per process is the construction, and a lock file cannot survive its
 * holder's death anyway, so a second process appending concurrently is **not**
 * supported. Payloads live inline in the record; the study's separate
 * `results/<messageId>.json` existed to make an envelope write atomic, which a
 * single appended line already is from the reader's point of view.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The only schema version this build writes and reads. */
export const TEAM_JOURNAL_SCHEMA_VERSION = 1;

/** Every record type a P3-A journal may hold. */
export const TEAM_JOURNAL_RECORD_TYPES: readonly string[] = [
  'team-created',
  'member-added',
  'member-updated',
  'task-created',
  'task-updated',
  'message-queued',
  'message-updated',
  'delivery-claimed',
];

/** One ledger line. `seq` is per team and monotonic; `ts` is wall clock, for humans. */
export interface TeamJournalRecord {
  readonly v: number;
  readonly seq: number;
  readonly ts: number;
  readonly teamId: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

/** One line the reader refused, and why. */
export interface TeamJournalSkip {
  readonly line: number;
  readonly reason:
    | 'torn-final-line'
    | 'bad-json'
    | 'unknown-version'
    | 'unknown-type'
    | 'foreign-team'
    /**
     * A blank or whitespace-only line *between* records — counted rather than
     * ignored, so a reader can tell "nothing there" from "skipped silently". The
     * empty element produced by a normal trailing newline is not counted: it is not
     * a line, and counting it would put a `blank-line` on every healthy file.
     */
    | 'blank-line';
}

/** What one journal file yielded. */
export interface TeamJournalReadResult {
  /** Records in file order, schema-checked. */
  readonly records: readonly TeamJournalRecord[];
  /** Highest `seq` seen — the number the next append continues from. */
  readonly maxSeq: number;
  /** Lines the reader refused or dropped, with reasons. */
  readonly skipped: readonly TeamJournalSkip[];
  /** Bytes read, so a caller can report what a replay cost instead of assuming. */
  readonly bytes: number;
}

/**
 * The slice of the journal the runtime needs; a test can pass a recording double.
 *
 * `appendSynced` is separate from `append` because it is the **only** call that
 * forces bytes to stable storage, and a double that does not implement it is
 * honestly saying "I cannot promise a flush" — which the injector then
 * treats as "do not deliver" (see `claimDeliverySynced`).
 */
export interface TeamJournalLike {
  /** Returns the written record, or `undefined` when the journal is unavailable. */
  append(teamId: string, record: { readonly type: string } & Record<string, unknown>): TeamJournalRecord | undefined;
  /**
   * Append records and **fsync** them before returning.
   *
   * Returns `undefined` when the journal is unavailable or the write/flush failed —
   * and that answer is what keeps a delivery from happening on top of a claim that
   * never landed.
   */
  appendSynced?(
    teamId: string,
    records: readonly ({ readonly type: string } & Record<string, unknown>)[],
  ): readonly TeamJournalRecord[] | undefined;
}

export interface TeamJournalOptions {
  readonly dir: string;
  readonly now?: () => number;
}

/** Reject anything that could escape the journal directory. */
function safeTeamId(teamId: string): string {
  if (teamId.length === 0) throw new Error('team id must not be empty');
  if (teamId.includes('/') || teamId.includes('\\') || teamId.includes('..') || teamId.includes('\0')) {
    throw new Error(`team id is not usable as a file name: ${JSON.stringify(teamId)}`);
  }
  return teamId.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class TeamJournal implements TeamJournalLike {
  private readonly dir: string;
  private readonly now: () => number;
  /** Next `seq` per team, seeded from the file the first time a team is touched. */
  private readonly nextSeq = new Map<string, number>();
  /**
   * Why this journal cannot write, if it cannot.
   *
   * Preparing the directory is the one step that can fail before any Team exists
   * — the path may be occupied by a regular file (`EEXIST`), unreadable
   * (`EACCES`), or a directory we may not create in. None of that is a reason for
   * the whole host to fail to start: the journal goes read-only/no-op, every Team
   * still lives in memory, and {@link disabled} carries the reason so the caller
   * can say so out loud exactly once.
   */
  private readonly unavailable: string | undefined;

  constructor(options: TeamJournalOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
    }
  }

  /** The reason no record can be written, or `undefined` when the journal works. */
  get disabled(): string | undefined {
    return this.unavailable;
  }

  /** Where this journal writes; the host surfaces it for operators and tests. */
  get directory(): string {
    return this.dir;
  }

  /** The file one team's records live in. */
  fileFor(teamId: string): string {
    return join(this.dir, `${safeTeamId(teamId)}.jsonl`);
  }

  /**
   * Append one record. The `v`, `seq` and `ts` fields are assigned here so no
   * caller can invent them; everything else in `record` is the caller's snapshot.
   */
  append(teamId: string, record: { readonly type: string } & Record<string, unknown>): TeamJournalRecord | undefined {
    if (this.unavailable !== undefined) return undefined;
    safeTeamId(teamId);
    const seq = this.sequenceFor(teamId);
    this.nextSeq.set(teamId, seq + 1);
    const full: TeamJournalRecord = {
      v: TEAM_JOURNAL_SCHEMA_VERSION,
      seq,
      ts: this.now(),
      teamId,
      ...record,
    };
    // `appendFileSync` creates the file when missing; no fsync (see the module note).
    appendFileSync(this.fileFor(teamId), `${JSON.stringify(full)}\n`);
    return full;
  }

  /**
   * Append these records and **fsync** them before returning — the one flushed path.
   *
   * Deliberately narrow: the whole journal keeps its `appendFileSync`-speed path, and
   * only the delivery claim pays the flush. That is an explicit trade: one fsync per
   * delivery attempt costs a disk round trip on a path that is already handing text to
   * a model, and it buys the guarantee the injector needs — **the claim is on stable
   * storage before a single byte of the message is sent**. Without it the claim can sit
   * in the page cache, and a crash that loses the tail brings the item back as
   * deliverable, which is exactly how the same text reached one model context twice.
   *
   * Returns `undefined` when nothing was flushed, so the caller must not proceed.
   * Records are written in one `open`/`write`/`fsync`/`close`, so a caller appending a
   * claim *and* the state change it implies gets both or neither.
   */
  appendSynced(
    teamId: string,
    records: readonly ({ readonly type: string } & Record<string, unknown>)[],
  ): readonly TeamJournalRecord[] | undefined {
    if (this.unavailable !== undefined) return undefined;
    safeTeamId(teamId);
    const file = this.fileFor(teamId);
    const full: TeamJournalRecord[] = [];
    for (const record of records) {
      const seq = this.sequenceFor(teamId);
      this.nextSeq.set(teamId, seq + 1);
      full.push({ v: TEAM_JOURNAL_SCHEMA_VERSION, seq, ts: this.now(), teamId, ...record });
    }
    const payload = full.map((record) => `${JSON.stringify(record)}\n`).join('');
    let fd: number | undefined;
    try {
      fd = openSync(file, 'a');
      writeSync(fd, payload);
      fsyncSync(fd);
    } catch {
      // A failed flush is not a partial write we can reason about: the caller
      // is told nothing landed and must not act as if it had.
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Closing a handle we already flushed changes nothing the caller can act on.
        }
      }
    }
    return full;
  }

  /** Continue a team's numbering from `seq` (used after a replay). */
  seed(teamId: string, seq: number): void {
    const current = this.nextSeq.get(teamId) ?? 0;
    if (seq + 1 > current) this.nextSeq.set(teamId, seq + 1);
  }

  /** Read one team's journal. `undefined` when the team has no file. */
  readTeam(teamId: string): TeamJournalReadResult | undefined {
    if (this.unavailable !== undefined) return undefined;
    const file = this.fileFor(teamId);
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    const parsed = parseJournal(file, text, teamId);
    return { ...parsed, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /** Team ids that have a journal file on disk, sorted for a stable replay order. */
  listTeamIds(): string[] {
    if (this.unavailable !== undefined) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort();
  }

  private sequenceFor(teamId: string): number {
    const known = this.nextSeq.get(teamId);
    if (known !== undefined) return known;
    const existing = this.readTeam(teamId);
    const next = (existing?.maxSeq ?? 0) + 1;
    this.nextSeq.set(teamId, next);
    return next;
  }
}

/**
 * Parse one journal file.
 *
 * The torn-line rule is the only place file position matters: a final line that
 * does not parse is assumed to be a write that was cut off, and is dropped. Any
 * other unreadable line is skipped with a reason, so a damaged journal degrades
 * to "fewer records" instead of "no host".
 */
export function parseJournal(file: string, text: string, teamId: string): TeamJournalReadResult {
  void file;
  const records: TeamJournalRecord[] = [];
  const skipped: TeamJournalSkip[] = [];
  let maxSeq = 0;
  const lines = text.split('\n');
  // A trailing newline produces one empty element; it is not a line at all.
  const endsWithNewline = text.endsWith('\n') || text.length === 0;
  const lastIndex = lines.length - 1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      // The empty element a trailing newline produces is not a line at all, so it is
      // neither replayed nor counted. A blank line *between* records is counted, so
      // "there is nothing on that line" is never silent.
      if (index === lastIndex && endsWithNewline) continue;
      skipped.push({ line: lineNumber, reason: 'blank-line' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({
        line: lineNumber,
        reason: index === lastIndex && !endsWithNewline ? 'torn-final-line' : 'bad-json',
      });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      skipped.push({ line: lineNumber, reason: 'bad-json' });
      continue;
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate['v'] !== TEAM_JOURNAL_SCHEMA_VERSION) {
      skipped.push({ line: lineNumber, reason: 'unknown-version' });
      continue;
    }
    if (typeof candidate['type'] !== 'string' || !TEAM_JOURNAL_RECORD_TYPES.includes(candidate['type'])) {
      skipped.push({ line: lineNumber, reason: 'unknown-type' });
      continue;
    }
    if (candidate['teamId'] !== teamId) {
      skipped.push({ line: lineNumber, reason: 'foreign-team' });
      continue;
    }
    if (typeof candidate['seq'] !== 'number' || !Number.isInteger(candidate['seq']) || candidate['seq'] < 1) {
      skipped.push({ line: lineNumber, reason: 'bad-json' });
      continue;
    }
    records.push(candidate as unknown as TeamJournalRecord);
    maxSeq = Math.max(maxSeq, candidate['seq']);
  }

  return { records, maxSeq, skipped, bytes: Buffer.byteLength(text, 'utf8') };
}
