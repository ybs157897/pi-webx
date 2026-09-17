/**
 * Model-row helpers shared by the provider editors, ported from
 * deepseek-harness's `ui-settings-models` DeepSeekModelsEditor: capacities are
 * typed as K/M-suffixed text (`256K`, `1M`) and stored as plain token counts,
 * and one per-row validator names the first row the file would reject.
 */

import type { ProviderModelView } from '../../shared/models-config'

/** One model row; fields this editor does not show survive an edit untouched. */
export type ModelDraft = ProviderModelView

/** Accepted capacity spellings: a decimal count with an optional K/M suffix. */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i

/** Decimal suffix scales — `1M` is 1000K, matching how model capacities are quoted. */
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const

/**
 * Read a typed capacity, so a user can write `256K` or `1M` instead of counting
 * zeroes. The stored value stays a plain token count.
 * @param text - raw field text.
 * @returns the count; `undefined` when blank (unset), `NaN` when unreadable
 * (rejected by {@link validateModels} before any write).
 */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.test(trimmed) ? trimmed.match(CAPACITY_PATTERN) : null
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale
  // A decimal multiple is exact in intent but not in binary floating point
  // (2.3 * 1e6 lands a few ULPs high), so an integral intent snaps back.
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/**
 * Spell a stored count back in the shortest form that survives a round trip
 * through {@link parseCapacity}; a count that is not a whole number of
 * thousands stays written out.
 * @param value - stored capacity.
 * @returns the field text.
 */
export function formatCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % CAPACITY_SCALE.m === 0) return String(value / CAPACITY_SCALE.m) + 'M'
  if (value % CAPACITY_SCALE.k === 0) return String(value / CAPACITY_SCALE.k) + 'K'
  return String(value)
}

/** Convert a stored array into editable rows without dropping hidden fields. */
export function modelDrafts(value: readonly ProviderModelView[] | undefined): ModelDraft[] {
  return (value ?? []).map(model => ({ ...model }))
}

/** A validation failure naming the first offending model row. */
export interface ModelsValidationFailure {
  /** Zero-based model position. */
  index: number
  /** Copy key owned by the Models settings section. */
  key: 'modelIdRequired' | 'modelIdDuplicate' | 'modelContextInvalid' | 'modelMaxTokensInvalid'
}

/**
 * Validate the row constraints the wire contract cannot express.
 * @param value - the drafted model rows.
 * @returns the first invalid row, or undefined when the file will accept it.
 */
export function validateModels(value: readonly ModelDraft[]): ModelsValidationFailure | undefined {
  const seen = new Set<string>()
  for (const [index, model] of value.entries()) {
    // Compared trimmed: surrounding whitespace is a paste artifact the provider
    // would never match, and an untrimmed compare lets `model ` slip past the
    // duplicate check against its own twin.
    const trimmed = model.id.trim()
    if (trimmed.length === 0) return { index, key: 'modelIdRequired' }
    if (seen.has(trimmed)) return { index, key: 'modelIdDuplicate' }
    seen.add(trimmed)
    const contextWindow = model.contextWindow
    if (contextWindow !== undefined
      && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
      return { index, key: 'modelContextInvalid' }
    }
    const maxTokens = model.maxTokens
    if (maxTokens !== undefined
      && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
      return { index, key: 'modelMaxTokensInvalid' }
    }
  }
  return undefined
}
