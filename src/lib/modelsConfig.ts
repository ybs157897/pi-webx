/**
 * Typed client for pi's own model configuration file (`~/.pi/agent/models.json`),
 * edited through the bridge's `/api/models-config` endpoints.
 *
 * Deliberately self-contained (it does not import `lib/api.ts`) but written in
 * the same style: same-origin `/api` paths, JSON bodies, and errors unwrapped
 * from `{error: string}` so the bridge's already user-readable Chinese text
 * reaches the UI verbatim.
 *
 * Credentials never cross the wire. A read reports only *how* a key is supplied
 * (`apiKey.source` + a masked `preview`), and a write that omits `apiKey` leaves
 * the configured value untouched — which is what makes saving a redacted view
 * safe. Nothing in this module ever renders or logs a key value.
 */

import type {
  ApiKeyView,
  ModelConfigResponse,
  ModelProviderUpsertRequest,
  ModelSuggestResponse,
  ModelUpsertRequest,
  PiApiKind,
  ProviderView,
} from '../shared/models-config';

/* ---------------------------------------------------------------- transport */

export class ModelConfigApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelConfigApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    throw new ModelConfigApiError(0, `无法连接 pi 服务：${errorText(error)}`);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const message =
      isRecord(payload) && typeof payload['error'] === 'string'
        ? payload['error']
        : `请求失败（${res.status} ${res.statusText}）`;
    throw new ModelConfigApiError(res.status, message);
  }

  return payload as T;
}

function jsonInit(method: 'PUT' | 'POST', body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------- client */

/** Every write answers with the whole file, so callers can replace their state. */
export const modelsConfigApi = {
  read(): Promise<ModelConfigResponse> {
    return request<ModelConfigResponse>('/api/models-config');
  },

  upsertProvider(id: string, body: ModelProviderUpsertRequest): Promise<ModelConfigResponse> {
    return request<ModelConfigResponse>(
      `/api/models-config/providers/${encodeURIComponent(id)}`,
      jsonInit('PUT', body),
    );
  },

  deleteProvider(id: string): Promise<ModelConfigResponse> {
    return request<ModelConfigResponse>(`/api/models-config/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  upsertModel(
    providerId: string,
    modelId: string,
    body: ModelUpsertRequest,
  ): Promise<ModelConfigResponse> {
    return request<ModelConfigResponse>(
      `/api/models-config/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
      jsonInit('PUT', body),
    );
  },

  deleteModel(providerId: string, modelId: string): Promise<ModelConfigResponse> {
    return request<ModelConfigResponse>(
      `/api/models-config/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
      { method: 'DELETE' },
    );
  },

  /**
   * "Smart configuration": the fields pi's own catalogue knows for a model id.
   * `match: null` means pi does not list the id — the editor then keeps what is
   * typed instead of guessing.
   */
  suggest(modelId: string): Promise<ModelSuggestResponse> {
    return request<ModelSuggestResponse>(
      '/api/models-config/suggest',
      jsonInit('POST', { modelId }),
    );
  },
};

export type ModelsConfigApi = typeof modelsConfigApi;

/* ------------------------------------------------------------------ helpers */

/** Providers in a stable display order; the wire ships them as an unordered map. */
export function sortedProviders(config: ModelConfigResponse | null | undefined): ProviderView[] {
  if (!config) return [];
  return Object.values(config.providers).sort((left, right) => left.id.localeCompare(right.id));
}

/** Human label for the tooltip of the credential dot. */
export function apiKeyTooltip(apiKey: ApiKeyView): string {
  switch (apiKey.source) {
    case 'shell':
      return '密钥已配置（shell 指令）';
    case 'env':
      return `密钥已配置（环境变量 ${apiKey.preview ?? ''}）`.trim();
    case 'literal':
      return '密钥已配置（已存储）';
    case 'none':
      return '未配置密钥';
  }
}

/** Same information as a sentence, for the read-only line beside the key input. */
export function apiKeySummary(apiKey: ApiKeyView): string {
  switch (apiKey.source) {
    case 'shell':
      return '已通过 shell 指令配置';
    case 'env':
      return `已通过环境变量 ${apiKey.preview ?? ''} 配置`.trim();
    case 'literal':
      return apiKey.preview ? `已存储密钥（${apiKey.preview}）` : '已存储密钥';
    case 'none':
      return '未配置密钥';
  }
}

export const PI_API_KIND_LABELS: Record<PiApiKind, string> = {
  'openai-completions': 'openai-completions（Chat Completions）',
  'openai-responses': 'openai-responses（Responses API）',
  'anthropic-messages': 'anthropic-messages（Messages API）',
  'google-generative-ai': 'google-generative-ai（Gemini）',
};

/** Mirrors the server's own rule (`/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`). */
export const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function providerIdError(id: string): string | undefined {
  const trimmed = id.trim();
  if (trimmed.length === 0) return 'Provider ID 不能为空';
  if (!PROVIDER_ID_PATTERN.test(trimmed)) {
    return 'Provider ID 只能包含字母、数字、点、下划线和连字符，且必须以字母或数字开头';
  }
  return undefined;
}

export function httpUrlError(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Base URL 不是合法 URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Base URL 只允许 http/https 协议';
  }
  return undefined;
}

/** Numbers are optional on the wire but, when present, must be positive integers. */
export function positiveIntError(value: string, label: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^\d+$/.test(trimmed)) return `${label}必须是正整数`;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return `${label}必须是正整数`;
  return undefined;
}

export function positiveIntOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Narrow an unknown thrown value to its display text (bridge errors verbatim). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------- asserts */

/**
 * Usage assert: every field below is sent by the drawer's save path, so a change
 * to the wire contract that drops one of them fails `tsc` here first.
 */
const sampleProviderBody: ModelProviderUpsertRequest = {
  name: '示例 Provider',
  baseUrl: 'https://api.example.com/v1',
  api: 'openai-completions',
  authHeader: false,
  apiKey: { value: '$EXAMPLE_API_KEY' },
  models: [
    {
      id: 'example-model',
      name: 'Example Model',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
};

export type ModelProviderUpsertRequestAssertion = typeof sampleProviderBody;

const sampleModelBody: ModelUpsertRequest = {
  id: 'example-model',
  name: 'Example Model',
  api: 'openai-responses',
  reasoning: false,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 64000,
};

export type ModelUpsertRequestAssertion = typeof sampleModelBody;

const sampleView: ProviderView = {
  id: 'example',
  name: 'Example',
  baseUrl: 'https://api.example.com/v1',
  api: 'anthropic-messages',
  apiKey: { has: true, source: 'env', preview: '$EXAMPLE_API_KEY' },
  authHeader: false,
  models: [{ id: 'example-model' }],
};

export type ProviderViewAssertion = typeof sampleView;

const sampleApi: ModelsConfigApi = modelsConfigApi;

export type ModelsConfigApiAssertion = typeof sampleApi;
