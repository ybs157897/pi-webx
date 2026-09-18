/**
 * Typed client for the bridge's model catalog, plus the two derivations the
 * picker needs from it.
 *
 * Mirrors deepseek-harness's `ui-model-selection` split: the catalog is read
 * once per host generation and shared by every picker, while each session's
 * *current* value is layered on top. Ours reads the same `/api/models` shape
 * whether or not a session exists, which is what lets the empty state — the
 * normal state of a lazily-created session — still offer a working picker.
 */

import type { PiModel, PiThinkingLevel } from '../shared/protocol';
import type { DefaultModelRequest, ModelCatalog } from '../shared/model-catalog';

export class ModelCatalogApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelCatalogApiError';
    this.status = status;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    throw new ModelCatalogApiError(0, `无法连接 pi 服务：${errorText(error)}`);
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
    throw new ModelCatalogApiError(res.status, message);
  }

  return payload as T;
}

export const modelCatalogApi = {
  read(cwd?: string): Promise<ModelCatalog> {
    const query = cwd !== undefined && cwd.length > 0 ? `?cwd=${encodeURIComponent(cwd)}` : '';
    return request<ModelCatalog>(`/api/models${query}`);
  },

  /** Record the picker's choice as the deployment default; answers with the catalog. */
  saveDefault(body: DefaultModelRequest & { cwd?: string }): Promise<ModelCatalog> {
    return request<ModelCatalog>('/api/models/default', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
};


/* ---------------------------------------------------------------- derivation */

/**
 * The reasoning stops the product offers.
 *
 * pi's vocabulary is wider — `off`, `minimal`, `medium`, `xhigh` included — and
 * each model advertises which levels it honours through its own
 * `thinkingLevelMap`. What a user chooses between here is deliberately narrower:
 * three stops, so the choice is one decision rather than a seven-way slider
 * across near-synonyms.
 */
export const THINKING_LEVEL_CHOICES: readonly PiThinkingLevel[] = ['low', 'high', 'max'];

/**
 * Narrow whatever a session or a model advertises to those three stops.
 *
 * An empty answer stays empty. It used to fall back to the stops themselves
 * ("a menu that cannot be chosen from is worse than one that may be refused"),
 * which turned out to be the worse menu: a model that honours none of them
 * accepts `set_thinking_level`, keeps reporting its old level, and leaves the
 * user clicking entries that cannot take effect and are never marked current.
 * The vocabulary belongs to the model — no levels means the surface says so.
 */
export function offeredThinkingLevels(levels: readonly PiThinkingLevel[]): PiThinkingLevel[] {
  return THINKING_LEVEL_CHOICES.filter((level) => levels.includes(level));
}

/**
 * Levels pi accepts for one model, read from the model's own capability.
 *
 * This mirrors pi's `getSupportedThinkingLevels` (`pi-ai/dist/models.js`), which
 * is also what `session.setThinkingLevel` clamps against, so what the composer
 * offers and what a session will keep cannot drift apart:
 *
 *   - a model that does not reason supports `off` alone — pi does not even send
 *     `reasoning_effort` for it (`model.reasoning` gates every branch in the
 *     OpenAI-completions request builder), so any other choice is silently
 *     clamped back;
 *   - a reasoning model supports the extended list minus levels its
 *     `thinkingLevelMap` pins to `null`, and `xhigh`/`max` count as supported
 *     only when the map names them explicitly.
 *
 * The product's three stops are then intersected with that (`THINKING_LEVEL_CHOICES`),
 * so `off`-only models end up offering nothing — which is the honest answer.
 */
export function thinkingLevelsForModel(model: PiModel | undefined): PiThinkingLevel[] {
  if (model?.reasoning !== true) return [];
  const map = model['thinkingLevelMap'];
  const supported = (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).filter((level) => {
    const mapped = isRecord(map) ? map[level] : undefined;
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
  return offeredThinkingLevels(supported);
}

/** Every model in the catalog, in the order the bridge grouped them. */
export function catalogModels(catalog: ModelCatalog | null): PiModel[] {
  if (catalog === null) return [];
  return catalog.groups.flatMap((group) => group.models);
}

/** Provider display names for the picker's group headers. */
export function catalogLabels(catalog: ModelCatalog | null): Record<string, string> {
  if (catalog === null) return {};
  return Object.fromEntries(catalog.groups.map((group) => [group.provider, group.name]));
}

/** The catalog's default as a `(provider, id)` selection, or `null` when unset. */
export function catalogDefaultSelection(
  catalog: ModelCatalog | null,
): { provider: string; id: string } | null {
  const fallback = catalog?.default;
  return fallback === undefined || fallback === null
    ? null
    : { provider: fallback.provider, id: fallback.model };
}

/**
 * The level chosen for one model, or `null` for "nothing chosen".
 *
 * This is the *choice*, not the level that will be used: an absent choice is
 * dsh's `Default` — the model's own provider decides. Returning the deployment
 * default here instead would make the picker's `Default` entry unmarkable and a
 * click on it look like a no-op, because clearing the choice would immediately
 * read back as the same level.
 *
 * dsh's rule for the same situation is that an omitted effort must not be
 * replaced by one the newly selected model rejects ("an absent selected effort
 * clears any inherited effort, restoring the selected model's provider/default
 * behavior"). Keying the memory `provider/model` already stops a level leaking
 * from another model; the advertised-level check keeps a stale choice from
 * being reported for a model that refuses it.
 */
export function rememberedThinkingLevel(
  catalog: ModelCatalog | null,
  selection: { provider: string; id: string } | null,
  model: PiModel | undefined,
): PiThinkingLevel | null {
  if (catalog === null || selection === null) return null;
  const remembered = catalog.modelThinkingLevels[`${selection.provider}/${selection.id}`];
  if (remembered === undefined) return null;
  return thinkingLevelsForModel(model).includes(remembered) ? remembered : null;
}

/**
 * The level actually in force for one model: the choice, else pi's global
 * default, else nothing. Used for readouts, never for marking the choice.
 */
export function effectiveThinkingLevel(
  catalog: ModelCatalog | null,
  selection: { provider: string; id: string } | null,
  model: PiModel | undefined,
): PiThinkingLevel | null {
  const chosen = rememberedThinkingLevel(catalog, selection, model);
  if (chosen !== null) return chosen;
  const fallback = catalog?.defaultThinkingLevel;
  if (fallback === undefined) return null;
  return thinkingLevelsForModel(model).includes(fallback) ? fallback : null;
}

const sampleCatalog: ModelCatalog = {
  default: { provider: 'example', model: 'example-model', thinkingLevel: 'high' },
  routableProviders: ['example'],
  groups: [
    {
      provider: 'example',
      name: 'Example',
      models: [
        { id: 'example-model', name: 'Example', api: 'openai-completions', provider: 'example' },
      ],
    },
  ],
  failures: [],
  modelThinkingLevels: { 'example/example-model': 'high' },
  defaultThinkingLevel: 'medium',
};

export type ModelCatalogAssertion = typeof sampleCatalog;
export type ModelCatalogApiAssertion = typeof modelCatalogApi;
