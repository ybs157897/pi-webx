/**
 * Notice construction: the retry / extension-error rows appended to the
 * transcript, and the "attempt 2/3 in 2s" wording they share.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point,
 * so nothing here is exported to consumers.
 */

import type { NoticeEntry, NoticeLevel, RetryInfo, TranscriptState } from '../../shared/transcript';

import { liveEntryId } from './entries';
import { asNumber, asString, type Dict } from './guards';

/* ---------------------------------------------------------------- notices */

function formatDelay(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

export function retryInfo(source: Dict): RetryInfo {
  const info: RetryInfo = {};
  const attempt = asNumber(source.attempt);
  if (attempt !== undefined) info.attempt = attempt;
  const maxAttempts = asNumber(source.maxAttempts);
  if (maxAttempts !== undefined) info.maxAttempts = maxAttempts;
  const delayMs = asNumber(source.delayMs);
  if (delayMs !== undefined) info.delayMs = delayMs;
  const error = asString(source.errorMessage);
  if (error !== undefined) info.error = error;
  return info;
}

/** Human-readable "attempt 2/3 in 2s" tail shared by the retry notices. */
export function attemptSummary(info: RetryInfo): string {
  const parts: string[] = [];
  if (info.attempt !== undefined) {
    parts.push(info.maxAttempts !== undefined ? `attempt ${info.attempt}/${info.maxAttempts}` : `attempt ${info.attempt}`);
  }
  const delay = formatDelay(info.delayMs);
  if (delay) parts.push(`in ${delay}`);
  return parts.join(' ');
}

export function makeNotice(
  state: TranscriptState,
  level: NoticeLevel,
  text: string,
  detail: string | undefined,
): NoticeEntry {
  const at = Date.now();
  const entry: NoticeEntry = {
    kind: 'notice',
    id: liveEntryId('notice', at, state.entries.length),
    at,
    level,
    text,
  };
  if (detail) entry.detail = detail;
  return entry;
}
