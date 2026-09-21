import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StoredSession } from '../src/shared/protocol';

/** Bytes of a session file scanned while looking for the first user message. */
const HEAD_BYTES = 192 * 1024;
/** Extra bytes read from the end when the head holds no user message. */
const TAIL_BYTES = 64 * 1024;
/**
 * Bytes read from the end of a transcript while looking for its last prompt.
 *
 * Only the tail is needed: a transcript is append-only, so the newest user
 * message is the last one in the file. A prompt whose own line is larger than
 * this window (an inlined image) pushes that line's start out of the slice; the
 * scan then answers with the newest entry fully inside it, which is still a real
 * time for this conversation. The answer is cached per file version, so this
 * read happens once per write, not once per poll.
 */
const LAST_PROMPT_TAIL_BYTES = 64 * 1024;
/** Header reads are tiny; this only guards against pathological files. */
const HEADER_SNIFF_BYTES = 8 * 1024;
/** Upper bound on files we are willing to open per request. */
const MAX_CANDIDATE_FILES = 500;
/** Upper bound on files inspected for the config quick-pick list. */
const CONFIG_SCAN_LIMIT = 200;
const PREVIEW_MAX_CHARS = 200;

export const DEFAULT_STORED_LIMIT = 30;
export const MAX_STORED_LIMIT = 200;

interface SessionHeader {
  id: string;
  cwd: string;
  timestamp: string;
}

interface Candidate {
  file: string;
  size: number;
  mtimeMs: number;
}

export interface ListStoredSessionsOptions {
  /** Only sessions whose header cwd matches exactly. */
  cwd?: string;
  limit?: number;
}

/** `<home>/.pi/agent/sessions` - pi's default session store. */
export function sessionsRoot(): string {
  return path.join(homedir(), '.pi', 'agent', 'sessions');
}

/**
 * Per-file metadata cache — the piece that makes listing cheap enough to poll.
 *
 * deepseek-harness states the rule this implements: "Session listing does not
 * use either field to open cold logs: it reads headers plus identity-checked
 * projection-cache hints only, so a cache or Session-format upgrade never turns
 * startup into a body scan." Its listing is cheap because a previous pass
 * already summarised each file; ours had no such memory, so every listing
 * re-read a bounded slice of *every* transcript (up to ~190 KB each), which is
 * why the stored list could only be refreshed at boot.
 *
 * Two facts make the cache safe to keep across writes:
 *
 *   - The header is the file's first line, so it is immutable for a given file.
 *   - The preview is the *first* user message. A growing transcript cannot
 *     change it, only add after it — the same reason dsh can persist a title
 *     projection and replay only the tail.
 *
 * A file whose size/mtime moved is therefore re-validated for its header (tiny)
 * while its already-found preview is kept; the *last* prompt is read from the
 * tail, because that one does move with every write.
 */
interface CachedMeta {
  sizeBytes: number;
  mtimeMs: number;
  header: SessionHeader;
  preview: string | null;
  /** dsh's `lastPromptAt`: the durable time of the newest prompt in the log. */
  lastPromptAt: number | null;
}

const metaCache = new Map<string, CachedMeta>();
/** Give up caching rather than growing without bound on a pathological store. */
const META_CACHE_LIMIT = 2000;

function remember(file: string, entry: CachedMeta): void {
  if (metaCache.size >= META_CACHE_LIMIT) metaCache.clear();
  metaCache.set(file, entry);
}

function forgetMissing(seen: Set<string>): void {
  if (metaCache.size === 0) return;
  for (const file of [...metaCache.keys()]) {
    if (!seen.has(file)) metaCache.delete(file);
  }
}

export function clampStoredLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_STORED_LIMIT;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_STORED_LIMIT);
}


/**
 * Discover past pi sessions on disk, newest first.
 *
 * Only the first line (the session header) and a bounded slice of each file are
 * read. Malformed or unreadable files are skipped - a broken transcript must
 * never break the listing.
 */
export async function listStoredSessions(
  options: ListStoredSessionsOptions = {},
): Promise<StoredSession[]> {
  const limit = clampStoredLimit(options.limit);
  const candidates = await collectCandidates(MAX_CANDIDATE_FILES);
  const seen = new Set(candidates.map((candidate) => candidate.file));

  const matched: {
    header: SessionHeader;
    candidate: Candidate;
    preview: string | null;
    updatedAt: number;
  }[] = [];
  for (const candidate of candidates) {
    const meta = await metaFor(candidate);
    if (!meta) continue;
    if (options.cwd !== undefined && meta.header.cwd !== options.cwd) continue;
    matched.push({ header: meta.header, candidate, preview: meta.preview, updatedAt: meta.updatedAt });
  }

  forgetMissing(seen);
  // Newest activity first — dsh's `orderByRecency`, with the session id as the
  // deterministic tie-break. The candidate pass above already sorted by mtime,
  // so equal keys keep that order.
  matched.sort((a, b) => b.updatedAt - a.updatedAt || compareId(a.header.id, b.header.id));

  const sessions: StoredSession[] = [];
  for (const { header, candidate, preview, updatedAt } of matched.slice(0, limit)) {
    sessions.push({
      path: candidate.file,
      id: header.id,
      cwd: header.cwd,
      startedAt: header.timestamp,
      updatedAt,
      sizeBytes: candidate.size,
      preview,
    });
  }
  return sessions;
}

/** Session id ordering, for a deterministic tie-break between equal times. */
function compareId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * One candidate's metadata, from the cache when the file has not changed.
 *
 * @returns the header, preview and recency key, or `null` for a file that is not
 *   a readable session (malformed, or vanished).
 */
async function metaFor(
  candidate: Candidate,
): Promise<{ header: SessionHeader; preview: string | null; updatedAt: number } | null> {
  const cached = metaCache.get(candidate.file);
  if (
    cached !== undefined &&
    cached.sizeBytes === candidate.size &&
    cached.mtimeMs === candidate.mtimeMs
  ) {
    return {
      header: cached.header,
      preview: cached.preview,
      updatedAt: sessionUpdatedAt(cached.header, candidate, cached.lastPromptAt),
    };
  }

  const header = await readHeader(candidate.file);
  if (!header) {
    metaCache.delete(candidate.file);
    return null;
  }

  // A transcript only ever grows, so a preview already found stays valid; only
  // the "no user message yet" case is worth reading the body again.
  const preview =
    cached !== undefined && cached.preview !== null
      ? cached.preview
      : await readPreview(candidate.file, candidate.size);
  // Unlike the preview, the newest prompt moves with every write that matters,
  // so it is re-read whenever the file changed at all.
  const lastPromptAt = await readLastPromptAt(candidate.file, candidate.size);

  remember(candidate.file, {
    sizeBytes: candidate.size,
    mtimeMs: candidate.mtimeMs,
    header,
    preview,
    lastPromptAt,
  });
  return { header, preview, updatedAt: sessionUpdatedAt(header, candidate, lastPromptAt) };
}

/**
 * The time a session is ordered and labelled by — dsh's
 * `updatedAt = max(header.createdAt, lastPromptAt)`.
 *
 * A session's own *start* is the wrong fact here: the header timestamp is fixed
 * when the conversation opens, so a conversation you returned to months later
 * would still sort as months old. The bridge's process-object `createdAt` is
 * worse in the other direction — one click on an old row mints a new session
 * object, and the row jumps to the top of the list announcing "刚刚". The last
 * prompt is what actually moved, and pi writes it into the log.
 */
function sessionUpdatedAt(
  header: SessionHeader,
  candidate: Candidate,
  lastPromptAt: number | null,
): number {
  const created = Date.parse(header.timestamp);
  const base = Number.isFinite(created) ? created : candidate.mtimeMs;
  return Math.max(base, lastPromptAt ?? 0);
}

/**
 * Newest prompt timestamp inside a transcript slice, or `null` when the slice
 * holds no complete prompt line.
 *
 * Scanned backwards: the last prompt is the newest one, and a file caught
 * mid-write has a partial final line to skip. Only `role: "user"` messages
 * count — pi records tool results as their own `toolResult` role, and its
 * bookkeeping entries (`model_change`, `custom`, …) carry timestamps of *this
 * process*, which is exactly the fact we must not order by.
 */
export function lastPromptAtFromTail(tail: string): number | null {
  const lines = tail.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'message') continue;

    const message = parsed.message;
    if (!isRecord(message) || message.role !== 'user') continue;

    const at = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }

  return null;
}

/** Read the tail of a transcript and resolve its last prompt time. */
async function readLastPromptAt(file: string, size: number): Promise<number | null> {
  if (size <= 0) return null;
  const start = Math.max(0, size - LAST_PROMPT_TAIL_BYTES);
  const raw = await readRange(file, start, size - start);
  return lastPromptAtFromTail(raw.toString('utf8'));
}

/**
 * Distinct cwds from recent stored sessions, newest first. Used for the
 * quick-pick list in `/api/config`.
 */
export async function recentStoredCwds(): Promise<string[]> {
  const candidates = await collectCandidates(CONFIG_SCAN_LIMIT);
  const found: { cwd: string; key: number }[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const meta = await metaFor(candidate);
    if (!meta) continue;
    const { header } = meta;
    if (header.cwd.length === 0 || seen.has(header.cwd)) continue;
    seen.add(header.cwd);
    found.push({ cwd: header.cwd, key: meta.updatedAt });
  }

  found.sort((a, b) => b.key - a.key);
  return found.map((entry) => entry.cwd);
}

/** Every `*.jsonl` under each sessions subdirectory, newest mtime first. */
async function collectCandidates(max: number): Promise<Candidate[]> {
  const root = sessionsRoot();
  const candidates: Candidate[] = [];

  let dirs: string[];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return candidates;
  }

  for (const dir of dirs) {
    let files: string[];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      files = entries
        .filter((entry) => entry.isFile() && isSessionFile(entry.name))
        .map((entry) => path.join(dir, entry.name));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const stat = await fsp.stat(file);
        candidates.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, max);
}

function isSessionFile(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false;
  if (name.endsWith('.mode.json')) return false;
  return true;
}

/** Parse the first line of a session file (`{type:"session", id, timestamp, cwd}`). */
async function readHeader(file: string): Promise<SessionHeader | null> {
  let raw: Buffer;
  try {
    raw = await readRange(file, 0, HEADER_SNIFF_BYTES);
  } catch {
    return null;
  }

  const newline = raw.indexOf(0x0a);
  // No newline inside the sniff window means the header is not a sane single
  // line; treat the file as malformed rather than guessing.
  if (newline === -1) return null;

  const line = raw.subarray(0, newline).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.type !== 'session') return null;

  const cwd = parsed.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;

  return {
    id: typeof parsed.id === 'string' ? parsed.id : '',
    cwd,
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
  };
}

/** First user message text, truncated. Only bounded head+tail slices are read. */
async function readPreview(file: string, size: number): Promise<string | null> {
  const headLength = Math.min(HEAD_BYTES, size);
  if (headLength > 0) {
    const head = await readRange(file, 0, headLength);
    const preview = firstUserText(head.toString('utf8'), false);
    if (preview !== null) return preview;
  }

  if (size > HEAD_BYTES) {
    const start = size - TAIL_BYTES;
    const tail = await readRange(file, start, TAIL_BYTES);
    return firstUserText(tail.toString('utf8'), true);
  }

  return null;
}

async function readRange(file: string, position: number, length: number): Promise<Buffer> {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function firstUserText(block: string, skipFirstLine: boolean): string | null {
  const lines = block.split('\n');
  const start = skipFirstLine ? 1 : 0;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'message') continue;

    const message = parsed.message;
    if (!isRecord(message) || message.role !== 'user') continue;

    const text = extractText(message.content);
    if (text === null) continue;

    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) continue;

    return normalized.length > PREVIEW_MAX_CHARS
      ? `${normalized.slice(0, PREVIEW_MAX_CHARS)}…`
      : normalized;
  }

  return null;
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
