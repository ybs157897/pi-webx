import { existsSync, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StoredSession } from '../src/shared/protocol';

/** Bytes of a session file scanned while looking for the first user message. */
const HEAD_BYTES = 192 * 1024;
/** Extra bytes read from the end when the head holds no user message. */
const TAIL_BYTES = 64 * 1024;
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

export function clampStoredLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_STORED_LIMIT;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_STORED_LIMIT);
}

export class StoredSessionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deletes one persisted session transcript. The path must be a `.jsonl` file
 * directly inside pi's session store — this is a destructive, user-initiated
 * action, so anything outside that exact directory is refused.
 */
export async function deleteStoredSession(target: string): Promise<void> {
  const cleaned = typeof target === 'string' ? target.trim() : '';
  if (cleaned.length === 0) throw new StoredSessionError(400, 'path 不能为空');
  if (!path.isAbsolute(cleaned)) throw new StoredSessionError(400, 'path 必须是绝对路径');
  if (cleaned.includes('\0')) throw new StoredSessionError(400, 'path 不合法');

  const root = sessionsRoot();
  const resolved = path.resolve(cleaned);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.length === 0) {
    throw new StoredSessionError(400, '只能删除 pi 会话目录里的文件');
  }
  // pi's layout is sessions/<escaped-cwd>/<file>.jsonl — exactly one level deep.
  const parent = path.dirname(resolved);
  const parentRelative = path.relative(root, parent);
  if (
    parentRelative.length === 0 ||
    parentRelative.startsWith('..') ||
    path.isAbsolute(parentRelative) ||
    parentRelative.includes('/')
  ) {
    throw new StoredSessionError(400, '只能删除会话工作区目录下的 .jsonl 文件');
  }
  if (path.extname(resolved) !== '.jsonl') {
    throw new StoredSessionError(400, '只能删除 .jsonl 会话文件');
  }
  if (!existsSync(resolved)) throw new StoredSessionError(404, '会话文件不存在');

  await fsp.unlink(resolved).catch((error: unknown) => {
    throw new StoredSessionError(500, `删除失败：${errorMessage(error)}`);
  });
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

  const matched: { header: SessionHeader; candidate: Candidate }[] = [];
  for (const candidate of candidates) {
    const header = await readHeader(candidate.file);
    if (!header) continue;
    if (options.cwd !== undefined && header.cwd !== options.cwd) continue;
    matched.push({ header, candidate });
  }

  matched.sort((a, b) => sortKey(b) - sortKey(a));

  const sessions: StoredSession[] = [];
  for (const { header, candidate } of matched.slice(0, limit)) {
    sessions.push({
      path: candidate.file,
      id: header.id,
      cwd: header.cwd,
      startedAt: header.timestamp,
      sizeBytes: candidate.size,
      preview: await readPreview(candidate.file, candidate.size),
    });
  }
  return sessions;
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
    const header = await readHeader(candidate.file);
    if (!header) continue;
    if (header.cwd.length === 0 || seen.has(header.cwd)) continue;
    seen.add(header.cwd);
    found.push({ cwd: header.cwd, key: sortKey({ header, candidate }) });
  }

  found.sort((a, b) => b.key - a.key);
  return found.map((entry) => entry.cwd);
}

function sortKey(entry: { header: SessionHeader; candidate: Candidate }): number {
  const parsed = Date.parse(entry.header.timestamp);
  return Number.isFinite(parsed) ? parsed : entry.candidate.mtimeMs;
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
