/**
 * The `piWebx` extension half of the model editor, as a pure function.
 *
 * The editor writes two vocabularies: what pi honours (context window, output
 * limit, input kinds, reasoning map) goes to pi's native keys, and everything
 * pi has no concept for yet goes to the entry's `piWebx` namespace. That second
 * half is where the form and the *stored* file can disagree — the form renders
 * a fixed set of chips, while a hand-edited `models.json` can carry keys no chip
 * represents — so the rule for what a save may touch lives here rather than
 * inside the component's state, where it would only be testable by clicking.
 *
 * The rule is one sentence: **a save rewrites the keys the form renders and
 * inherits every key it does not.** Dropping an unrendered key would delete a
 * value the reader stored and cannot see, on an unrelated edit.
 */

import type { ModelExtension } from '../../shared/models-config'

/**
 * The extension input kinds the editor draws a chip for.
 *
 * `audio` is deliberately absent: the reference's row is 文本 / 图片 / 视频 /
 * PDF. It stays a legal *stored* key (`ModelExtension['inputFormat']` keeps it,
 * and the inherit rule below carries it through a save), it just has no chip —
 * a chip is a claim the app can send that kind, and pi consumes only text and
 * images.
 */
export const EXTENSION_CHIPS = ['video', 'pdf'] as const

/** One of the extension input kinds that has a chip. */
export type ExtensionChip = (typeof EXTENSION_CHIPS)[number]

/** Capability flags the editor draws a chip for. */
export type CapabilityKey = 'jsonSchemaOutput' | 'nativeWebSearch' | 'midConversationSystem'

/** Chip labels for the capability flags, in the reference's order. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  jsonSchemaOutput: '结构化输出',
  nativeWebSearch: '原生联网搜索',
  midConversationSystem: '对话中系统消息',
}

/** Everything the editor's chips and textarea currently say. */
export interface ExtensionSelection {
  /** Per-chip input kinds; absent kinds are inherited from {@link base}. */
  inputs: Record<ExtensionChip, boolean>
  /** Per-chip capability flags; absent flags are inherited from {@link base}. */
  capabilities: Record<CapabilityKey, boolean>
  /** The JSONata textarea's text; empty clears the stored map. */
  reasoningLevelMap: string
}

/**
 * Fold the form's selection back into a `piWebx` extension.
 *
 * @param base - the extension the row already had, whose unrendered keys survive.
 * @param selection - what the form's chips and textarea say now.
 * @returns the extension to store, or `undefined` when nothing is left to say.
 */
export function buildModelExtension(
  base: ModelExtension | undefined,
  selection: ExtensionSelection,
): ModelExtension | undefined {
  const next: ModelExtension = { ...base }
  const inputFormat: NonNullable<ModelExtension['inputFormat']> = { ...base?.inputFormat }
  for (const kind of EXTENSION_CHIPS) {
    if (selection.inputs[kind]) inputFormat[kind] = true
    else delete inputFormat[kind]
  }
  if (Object.keys(inputFormat).length > 0) next.inputFormat = inputFormat
  else delete next.inputFormat

  const capabilityFlags: NonNullable<ModelExtension['capabilities']> = { ...base?.capabilities }
  for (const key of Object.keys(CAPABILITY_LABELS) as CapabilityKey[]) {
    if (selection.capabilities[key]) capabilityFlags[key] = true
    else delete capabilityFlags[key]
  }
  if (Object.keys(capabilityFlags).length > 0) next.capabilities = capabilityFlags
  else delete next.capabilities

  const map = selection.reasoningLevelMap.trim()
  if (map.length > 0) next.reasoningLevelMap = map
  else delete next.reasoningLevelMap

  return Object.keys(next).length === 0 ? undefined : next
}
