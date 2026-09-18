/**
 * Wire types for the model catalog and the default-model selection.
 *
 * Split deliberately, following deepseek-harness:
 *
 *   1. The **catalog** is a read surface that needs no session. dsh's
 *      `buildModelCatalog()` documents itself as "Build the browser model
 *      catalog without requiring a Session" and its `ModelCatalog` "is not
 *      derived from one Session". Ours is built from pi's `ModelRuntime` plus
 *      the `SettingsManager` default, so the picker works before any session
 *      exists — which is the whole point, since a new session is created by the
 *      first message.
 *
 *   2. The **default selection** is a settings value, and the picker is its
 *      editor (dsh's `agent-default-model`: "the model picker is its editor",
 *      and the settings page does not expose the namespace). Losing this split
 *      is what let pi-webx's picker write nowhere while new sessions fell back
 *      to whatever `settings.json` happened to hold.
 *
 * `ModelCatalog` mirrors dsh's shape: a deployment default, the routable
 * provider ids, provider-grouped model groups, and per-provider failures —
 * where a failed provider is reported beside the groups that succeeded rather
 * than failing the whole read.
 */

import type { PiModel, PiThinkingLevel } from './protocol';

/** The deployment default a blank session starts from. */
export interface CatalogDefault {
  provider: string;
  model: string;
  thinkingLevel?: PiThinkingLevel;
}

/** One provider's advertised models. */
export interface ModelCatalogGroup {
  provider: string;
  /**
   * Provider display name ("Z.AI Coding CN", "OpenAI Codex"). dsh labels its
   * picker groups with the route's display name and falls back to the id, which
   * is what makes its group headers readable where the id alone is a slug.
   */
  name: string;
  models: PiModel[];
}

/** A provider that could not be described; the rest of the catalog still lists. */
export interface ModelCatalogFailure {
  provider: string;
  message: string;
}

/**
 * `GET /api/models` — everything a picker needs, with or without a session.
 *
 * `modelThinkingLevels` carries pi's per-model thinking memory
 * (`SettingsManager.getAllModelThinkingLevels()`), keyed `provider/model`. dsh
 * stores one effort per selection and clears it when a new selection omits one;
 * pi keys the memory by model instead, so a level can never leak onto a model
 * that does not accept it.
 */
export interface ModelCatalog {
  /** `null` when nothing is configured and pi's own fallback applies. */
  default: CatalogDefault | null;
  /** Providers that currently have usable auth; advisory, never a filter. */
  routableProviders: string[];
  groups: ModelCatalogGroup[];
  failures: ModelCatalogFailure[];
  modelThinkingLevels: Record<string, PiThinkingLevel>;
  /** pi's global default thinking level, used when a model has no memory. */
  defaultThinkingLevel?: PiThinkingLevel;
}

/**
 * `PUT /api/models/default` — the picker saving its choice as the deployment
 * default, mirroring dsh's `agentDefaultModel.saveSelection()`.
 *
 * The selection is written whole, which is why the level has three states:
 *
 *   - a level          — remember it for this model;
 *   - `null`           — clear the remembered level, i.e. dsh's `Default`
 *                        entry: the model's own provider decides;
 *   - omitted          — nothing said about the level, so only the previous
 *                        model's memory is dropped when the model changed.
 *
 * dsh needs the same distinction for the same reason: settings layers merge by
 * field, so a value that is merely absent would survive the write and re-apply
 * an effort the newly selected model may reject.
 */
export interface DefaultModelRequest {
  provider: string;
  model: string;
  thinkingLevel?: PiThinkingLevel | null;
}
