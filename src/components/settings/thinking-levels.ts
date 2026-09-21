/**
 * The reasoning-levels row's selection fold, as a pure function.
 *
 * A tick means the level is written into the saved `thinkingLevelMap`, so the
 * state is a set of levels — but the row's order is pi's vocabulary, not the
 * tick sequence. Keeping that fold out of the component is what lets
 * `scripts/check-model-editor.ts` pin the order contract without a DOM.
 */

import { PI_THINKING_LEVELS, type PiThinkingLevel } from '../../shared/protocol'

/**
 * Tick or untick one level in the selection, always in pi's own low→high
 * order. Unticking only removes; ticking is a filter over the vocabulary, so
 * it can never grow duplicates whatever the incoming array looked like.
 */
export function toggleThinkingLevel(
  current: readonly PiThinkingLevel[],
  level: PiThinkingLevel,
): PiThinkingLevel[] {
  if (current.includes(level)) return current.filter((entry) => entry !== level)
  return PI_THINKING_LEVELS.filter((entry) => current.includes(entry) || entry === level)
}
