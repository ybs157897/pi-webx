/**
 * Entry ids and entry surgery: every append or in-place replacement of a
 * transcript entry goes through one of these helpers.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point,
 * so nothing here is exported to consumers.
 */

import type { TranscriptEntry, TranscriptState } from '../../shared/transcript';

/* ---------------------------------------------------------------------- ids */

/**
 * Ids for live entries. Derived from the timestamp plus the entry count rather
 * than a module counter, so folding the same state twice yields the same ids.
 * Entries are only ever appended by this reducer, so the pair stays unique.
 */
export function liveEntryId(kind: string, at: number, entryCount: number): string {
  return `live-${kind}-${at.toString(36)}-${entryCount.toString(36)}`;
}

export function lastEntryAt(entries: readonly TranscriptEntry[], fallback: number): number {
  const last = entries[entries.length - 1];
  return last ? last.at : fallback;
}

/* ------------------------------------------------------------ entry surgery */

export function appendEntry(state: TranscriptState, entry: TranscriptEntry): TranscriptState {
  return { ...state, entries: [...state.entries, entry] };
}

/** Replace one entry by id. Returns the same state when nothing matched/changed. */
export function replaceEntry(
  state: TranscriptState,
  id: string,
  update: (entry: TranscriptEntry) => TranscriptEntry,
): TranscriptState {
  const index = state.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return state;
  const current = state.entries[index];
  if (!current) return state;
  const next = update(current);
  if (next === current) return state;
  const entries = state.entries.slice();
  entries[index] = next;
  return { ...state, entries };
}
