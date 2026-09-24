/**
 * Snapshot rebuild: `applySnapshot` turns a `get_messages` reply back into the
 * transcript (connect / reconnect / session switch), re-deriving the turn folds
 * and the trailing error the live stream would have produced.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point.
 */

import type {
  ApplySnapshot,
  AssistantEntry,
  TranscriptEntry,
} from '../../shared/transcript';

import {
  contentImageCount,
  contentImages,
  contentText,
  contentThinking,
  contentToolCalls,
  toUsage,
} from './blocks';
import { lastEntryAt } from './entries';
import { deriveTurnProcesses } from './fold';
import { asBoolean, asNumber, asRecord, asString, timestampOf } from './guards';
import { attachToolResultIn, restoredToolRuns } from './tool-runs';

/* --------------------------------------------------------------- snapshot */

/**
 * `lastError` derived from rebuilt history: only a trailing assistant turn that
 * ended with `stopReason === 'error'` is worth surfacing.
 */
function deriveLastError(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== 'assistant') continue;
    if (entry.stopReason === 'error') return entry.error ?? 'Assistant turn ended with an error';
    return null;
  }
  return null;
}

/**
 * Rebuild the transcript from `get_messages`.
 *
 * Live-session facts that history cannot express (`running`, `compacting`,
 * `retrying`, `queued`, `title`) are carried over untouched: the session may
 * perfectly well still be mid-run when a client reconnects and asks for the
 * message list. `streamingEntryId` is dropped because the entries it pointed at
 * no longer exist, and `lastError` is re-derived from the rebuilt history.
 */
export const applySnapshot: ApplySnapshot = (state, messages) => {
  let entries: TranscriptEntry[] = [];

  messages.forEach((message, index) => {
    const rec = asRecord(message);
    const role = asString(rec?.role);
    if (!rec || !role) return; // unknown roles are ignored silently

    const fallbackAt = lastEntryAt(entries, 0);
    switch (role) {
      case 'custom': {
        // Same rule as the live path: only what the extension marked visible.
        if (rec.display !== true) break;
        entries.push({
          kind: 'custom',
          id: `snap-${index}`,
          at: timestampOf(rec, fallbackAt),
          customType: asString(rec.customType) ?? 'custom',
          text: contentText(rec.content),
          details: rec.details,
        });
        break;
      }
      case 'user': {
        const at = timestampOf(rec, fallbackAt);
        entries.push({
          kind: 'user',
          id: `snap-${index}`,
          at,
          text: contentText(rec.content),
          imageCount: contentImageCount(rec.content),
          images: contentImages(rec.content),
        });
        break;
      }
      case 'assistant': {
        const at = timestampOf(rec, fallbackAt);
        const id = `snap-${index}`;
        const entry: AssistantEntry = {
          kind: 'assistant',
          id,
          at,
          text: contentText(rec.content),
          thinking: contentThinking(rec.content),
          streaming: false,
          tools: restoredToolRuns(contentToolCalls(rec.content), at, id),
        };
        const usage = toUsage(rec.usage);
        if (usage) entry.usage = usage;
        const model = asString(rec.model);
        if (model !== undefined) entry.model = model;
        const provider = asString(rec.provider);
        if (provider !== undefined) entry.provider = provider;
        const stopReason = asString(rec.stopReason);
        if (stopReason !== undefined) entry.stopReason = stopReason;
        const error = asString(rec.errorMessage);
        if (error !== undefined) entry.error = error;
        entries.push(entry);
        break;
      }
      case 'toolResult': {
        // Attaches to the matching run anywhere in the entries built so far -
        // typically the assistant turn just above - and appends a standalone
        // entry (identical ids to a fresh snapshot) only for orphaned history.
        const at = timestampOf(rec, fallbackAt);
        const next = attachToolResultIn(entries, rec, at, `snap-${index}`, true);
        if (next) entries = next;
        break;
      }
      case 'bashExecution': {
        const at = timestampOf(rec, fallbackAt);
        entries.push({
          kind: 'bash',
          id: `snap-${index}`,
          at,
          command: asString(rec.command) ?? '',
          output: asString(rec.output) ?? '',
          exitCode: asNumber(rec.exitCode) ?? null,
          cancelled: asBoolean(rec.cancelled) ?? false,
          truncated: asBoolean(rec.truncated) ?? false,
          streaming: false,
        });
        break;
      }
      default:
        // Unknown roles are ignored silently.
        break;
    }
  });

  const derived = deriveLastError(entries);
  // Turn folds are re-derived from the rebuilt list, so a reopened session
  // shows the same compact view the live stream produced.
  const { turnProcesses, turnSeq } = deriveTurnProcesses(entries);
  return {
    ...state,
    entries,
    streamingEntryId: null,
    turnProcesses,
    turnSeq,
    activeTurn: null,
    lastError: derived ?? state.lastError,
  };
};
