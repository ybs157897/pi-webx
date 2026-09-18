/**
 * Wire contract for pi's native model configuration file
 * (`~/.pi/agent/models.json`). pi loads and hot-reloads it, so editing here
 * configures the pi CLI and pi-webx together.
 *
 * Credentials never cross the wire: every read returns only *how* a key is
 * supplied, and a write that omits the key leaves the configured value alone.
 */

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

export interface ProviderModelView {
  id: string;
  name?: string;
  api?: PiApiKind;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderView {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: PiApiKind;
  apiKey: ApiKeyView;
  authHeader?: boolean;
  models: ProviderModelView[];
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
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
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
}
