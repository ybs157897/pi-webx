/**
 * Turn folding: the single rule that decides which rows of a turn's region fold
 * away, and the fold windows both the live reducer (`finalizeTurn`) and a
 * history rebuild (`deriveTurnProcesses`) go through.
 *
 * Part of the transcript reducer; `answerIndexOf` is re-exported by `./index.ts`
 * because the message view has to agree with the fold about which entry is the
 * answer.
 */

import type { TranscriptEntry, TranscriptState, TurnProcess } from '../../shared/transcript';

/* ---------------------------------------------------------------- turn fold */

/**
 * The entry a turn's answer was written in: the last step that ended with text
 * and no tool calls (dsh's `latestAnswer`).
 *
 * Exported because more than the fold needs to know it. A turn is a *process* —
 * narration, tool calls, more narration — and only its last prose step is the
 * answer; everything before it is machinery the reader did not ask for. The
 * transcript uses that to decide which rows fold away, and the message view uses
 * it to decide which message offers to be copied. Both must agree: a copy button
 * on a step that is about to be folded into a summary row is an offer to copy
 * something that will not be on screen a second later.
 *
 * Returns the index within `region`, or -1 when the region holds no answer.
 */
export function answerIndexOf(region: readonly TranscriptEntry[]): number {
  for (let index = region.length - 1; index >= 0; index -= 1) {
    const entry = region[index];
    if (
      entry &&
      entry.kind === 'assistant' &&
      entry.tools.length === 0 &&
      entry.text.trim().length > 0
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Fold one turn's region into a summary — the single rule both live turns
 * (`turn_end`) and rebuilt history (a snapshot) go through.
 *
 * The anchor is the turn's answer (see `answerIndexOf`). Everything before it
 * that is step-shaped folds, and the answer's own reasoning folds with them
 * (dsh hides the answer's reasoning in its compact view too); the user's
 * message and session-level rows (notices, compaction) never fold. A region
 * with neither steps nor answer reasoning folds nothing.
 */
function foldRegion(region: readonly TranscriptEntry[]): TurnProcess | null {
  const anchorIndex = answerIndexOf(region);
  if (anchorIndex < 0) return null;
  const anchor = region[anchorIndex];
  if (!anchor || anchor.kind !== 'assistant') return null;

  const hidden = region
    .slice(0, anchorIndex)
    .filter(
      (entry) => entry.kind === 'assistant' || entry.kind === 'toolResult' || entry.kind === 'bash',
    );
  const anchorThought = anchor.thinking.trim().length > 0;
  if (hidden.length === 0 && !anchorThought) return null;

  let messages = 0;
  let toolCalls = 0;
  let thought = anchorThought;
  for (const entry of hidden) {
    if (entry.kind !== 'assistant') continue;
    messages += 1;
    toolCalls += entry.tools.length;
    if (entry.thinking.trim().length > 0) thought = true;
  }
  return {
    hiddenIds: hidden.map((entry) => entry.id),
    anchorId: anchor.id,
    messages,
    toolCalls,
    thought,
    anchorThought,
  };
}

/** Close the active turn's window, if it has one worth folding. */
export function finalizeTurn(state: TranscriptState): TranscriptState {
  const active = state.activeTurn;
  if (active === null) return state;

  let start = 0;
  if (active.startId !== null) {
    const found = state.entries.findIndex((entry) => entry.id === active.startId);
    // A history rebuild between turn start and end leaves the marker pointing
    // at nothing; folding a guess would hide the wrong rows.
    if (found < 0) return { ...state, activeTurn: null };
    start = found + 1;
  }
  const region = state.entries.slice(Math.min(start, state.entries.length));
  const folded = foldRegion(region);
  if (folded === null) return { ...state, activeTurn: null };
  return {
    ...state,
    activeTurn: null,
    turnProcesses: { ...state.turnProcesses, [active.id]: folded },
  };
}

/**
 * Turn boundaries reconstructed from a message list: a user message opens a
 * turn, everything after it until the next user message belongs to it. Equal
 * by construction to what the live reducer would have computed.
 */
export function deriveTurnProcesses(entries: readonly TranscriptEntry[]): {
  turnProcesses: Record<number, TurnProcess>;
  turnSeq: number;
} {
  const turnProcesses: Record<number, TurnProcess> = {};
  let turnSeq = 0;
  let region: TranscriptEntry[] = [];
  const commit = (): void => {
    if (region.length === 0) return;
    turnSeq += 1;
    const folded = foldRegion(region);
    if (folded !== null) turnProcesses[turnSeq] = folded;
  };
  for (const entry of entries) {
    if (entry.kind === 'user') {
      commit();
      region = [entry];
      continue;
    }
    region.push(entry);
  }
  commit();
  return { turnProcesses, turnSeq };
}
