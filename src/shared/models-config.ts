/**
 * Wire contract for pi's native model configuration file
 * (`~/.pi/agent/models.json`). pi loads and hot-reloads it, so editing here
 * configures the pi CLI and pi-webx together.
 *
 * Credentials never cross the wire: every read returns only *how* a key is
 * supplied, and a write that omits the key leaves the configured value alone.
 *
 * Model fields divide in two, mirroring how the reference (ZCode) describes a
 * model:
 *
 *   - what pi itself consumes (`contextWindow`, `maxTokens`, `input`,
 *     `reasoning` + `thinkingLevelMap`, …) — written to pi's native keys;
 *   - what pi has no concept for yet (video/audio/pdf input kinds, capability
 *     flags, a JSONata-style reasoning map, the enabled toggles) — kept in the
 *     `piWebx` namespace of the same entry. pi ignores unknown keys; the
 *     toggles are honoured by pi-webx's own catalog builder.
 */

import type { PiThinkingLevel } from './protocol';

export type PiApiKind =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export const PI_API_KINDS: readonly PiApiKind[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

export type ApiKeySource = 'shell' | 'env' | 'literal' | 'none';

export interface ApiKeyView {
  has: boolean;
  source: ApiKeySource;
  /** masked; never the literal value */
  preview?: string;
}

/**
 * pi-webx's namespace inside one model entry. Field names follow the reference
 * (ZCode's `inputFormat` / `supports*` / `reasoningLevel.map`), so the two
 * configurations read the same even though only pi-webx knows this block.
 */
export interface ModelExtension {
  /** Hides the model from pickers; enforced by the catalog builder. */
  enabled?: boolean;
  /** Input kinds pi's native `input` cannot carry (text/image ride there). */
  inputFormat?: {
    audio?: boolean;
    video?: boolean;
    pdf?: boolean;
  };
  /** Capability flags; recorded for parity, not consumed by pi. */
  capabilities?: {
    jsonSchemaOutput?: boolean;
    nativeWebSearch?: boolean;
    midConversationSystem?: boolean;
    toolCall?: boolean;
  };
  /** The reference's `reasoningLevel.map`: a JSONata expression; not consumed by pi. */
  reasoningLevelMap?: string;
}

/** pi-webx's namespace inside one provider entry. */
export interface ProviderExtension {
  /** Hides the provider from pickers; enforced by the catalog builder. */
  enabled?: boolean;
}

export interface ProviderModelView {
  id: string;
  name?: string;
  api?: PiApiKind;
  reasoning?: boolean;
  /**
   * Which pi thinking levels this model supports, and the provider-specific
   * value each maps to (`null` marks a level unsupported). This is what pi's
   * own level clamp reads.
   */
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  piWebx?: ModelExtension;
}

export interface ProviderView {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: PiApiKind;
  apiKey: ApiKeyView;
  authHeader?: boolean;
  models: ProviderModelView[];
  piWebx?: ProviderExtension;
}

export interface ModelConfigResponse {
  /** bumps on every successful write; clients can refetch when it changes */
  revision: number;
  /** absolute path of the file being edited */
  path: string;
  providers: Record<string, ProviderView>;
}

export interface ModelUpsertRequest {
  id: string;
  name?: string;
  api?: PiApiKind;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  piWebx?: ModelExtension;
}

export interface ModelProviderUpsertRequest {
  /** '' clears the field; omitted keeps the configured value. */
  name?: string;
  /** '' clears the field; omitted keeps the configured value. */
  baseUrl?: string;
  /** '' clears the field; omitted keeps the configured value. */
  api?: PiApiKind | '';
  authHeader?: boolean;
  /**
   * Omitted → keep the configured key. `{remove:true}` deletes the field.
   * `{value}` sets it (literal, `$ENV`, or `!shell` — pi resolves it).
   */
  apiKey?: { remove?: boolean; value?: string };
  models?: ModelUpsertRequest[];
  piWebx?: ProviderExtension;
}

/**
 * "Smart configuration": suggested fields for a model id, looked up in pi's
 * own bundled model catalogue — the pi-webx equivalent of the reference's
 * model rules matching.
 */
export interface ModelSuggestRequest {
  modelId: string;
}

export interface ModelSuggestMatch {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelSuggestResponse {
  /** null when pi's catalogue does not know the id */
  match: ModelSuggestMatch | null;
}
