/**
 * The model catalog and the default-model selection — the two things a picker
 * needs before (or instead of) a session.
 *
 * Ported from deepseek-harness, whose split this module keeps:
 *
 *   - `buildModelCatalog()` is the read surface. dsh documents it as "Build the
 *     browser model catalog without requiring a Session"; ours reads pi's
 *     `ModelRuntime` and `SettingsManager` directly, so no `AgentSession` is
 *     created, checked out, or touched to render the picker. That is what makes
 *     the picker work in the detached state a lazily-created session starts in.
 *   - `saveDefaultModelSelection()` is the write surface. dsh's
 *     `agentDefaultModel.saveSelection()` exists because "the model picker is
 *     its editor": the picker both applies a choice to its session and records
 *     it as the deployment default, so the next blank session starts from it.
 *
 * Both go through pi's own seams rather than hand-written file I/O — the
 * deliberate choice dsh makes with its settings and credentials capabilities,
 * and the reason its own readers/writers cannot drift from the product's:
 *
 *   - Models come from the shared `ModelRuntime`, the same object the sessions
 *     resolve against, so the picker cannot advertise a model a session would
 *     reject.
 *   - The default is written by `SettingsManager`, which locks the file
 *     (`FileSettingsStorage.withLock`) and merges only the fields it marked
 *     modified — the same path pi's CLI uses, so a change here is visible to
 *     the CLI and vice versa.
 *
 * Failure is loud: a settings write is reported after `flush()` drains, so a
 * selection that could not be persisted is an error the caller sees rather than
 * a silent divergence between what the picker shows and what the next session
 * will use.
 */

import {
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import {
  type ModelRuntime,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import type { PiModel, PiThinkingLevel } from '../src/shared/protocol';
import type {
  CatalogDefault,
  DefaultModelRequest,
  ModelCatalog,
  ModelCatalogFailure,
  ModelCatalogGroup,
} from '../src/shared/model-catalog';

/** A settings write could not be persisted; the client must hear about it. */
export class ModelCatalogError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** pi's model record is structurally the wire model; the cast drops SDK types. */
function toWireModel(model: Model<any>): PiModel {
  return model as unknown as PiModel;
}

function isThinkingLevel(value: string): value is PiThinkingLevel {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}

/**
 * One `SettingsManager` per agent dir, reused so its write queue and in-memory
 * view stay coherent across requests (a fresh manager per request would re-read
 * the file and could resurrect a view an in-flight write already superseded).
 */
const settingsManagers = new Map<string, SettingsManager>();

function settingsFor(cwd: string): SettingsManager {
  const agentDir = getAgentDir();
  const key = `${agentDir}\u0000${cwd}`;
  const existing = settingsManagers.get(key);
  if (existing) return existing;
  const created = SettingsManager.create(cwd, agentDir);
  settingsManagers.set(key, created);
  return created;
}

/**
 * The deployment default a blank session starts from, read from pi's settings.
 *
 * `provider` and `model` are read together: a half-configured default (pi's
 * settings allow them to be set independently) is reported as absent rather
 * than pairing one file's provider with another file's model.
 */
function readDefault(settings: SettingsManager): CatalogDefault | null {
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  if (!provider || !model) return null;
  const stored = settings.getModelThinkingLevel(provider, model);
  return {
    provider,
    model,
    ...(stored !== undefined && stored !== null ? { thinkingLevel: stored as PiThinkingLevel } : {}),
  };
}

/**
 * Build the picker's catalog without touching a session.
 *
 * Scope is the deliberate part. dsh's own picker lists only the providers this
 * deployment can actually run — its Models page is where the rest get added — so
 * the groups here are the auth-checked ones. Listing pi's whole builtin catalog
 * instead (forty providers, most without credentials) buries the handful a user
 * can use, and is what forced a search box into the picker in the first place.
 *
 * @param runtime - the shared pi model runtime the sessions resolve against.
 * @param cwd - workspace whose project settings apply to the default lookup.
 * @returns the default, routable providers, provider groups, and any failures.
 */
export async function buildModelCatalog(runtime: ModelRuntime, cwd: string): Promise<ModelCatalog> {
  const settings = settingsFor(cwd);

  // Availability is advisory, exactly as dsh documents its catalog: it drives
  // the picker's list and diagnostics and never rejects a request. A provider
  // that fails the auth check is reported in `failures` beside the providers
  // that succeeded, so one broken credential cannot empty the picker.
  const failures: ModelCatalogFailure[] = [];
  const routable: string[] = [];
  const groups: ModelCatalogGroup[] = [];

  // Provider labels ride along so the picker can head each group with the same
  // display name the settings page uses instead of a raw id.
  const providerNames = new Map<string, string>();
  let providers: string[] = [];
  try {
    for (const provider of runtime.getProviders()) {
      providers.push(provider.id);
      const label = typeof provider.name === 'string' ? provider.name.trim() : '';
      if (label.length > 0) providerNames.set(provider.id, label);
    }
  } catch (error) {
    failures.push({ provider: '*', message: errorMessage(error) });
  }

  const groupFor = (providerId: string, models: readonly Model<any>[]): ModelCatalogGroup => ({
    provider: providerId,
    name: providerNames.get(providerId) ?? providerId,
    models: models.map((model) => toWireModel(model)),
  });

  // One availability pass keeps the per-provider checks off the hot path: the
  // runtime already resolves auth per provider and caches the result.
  let available: readonly Model<any>[] = [];
  try {
    available = (await runtime.getAvailable()) as readonly Model<any>[];
  } catch (error) {
    failures.push({ provider: '*', message: errorMessage(error) });
  }

  const availableProviders = new Set(available.map((model) => model.provider));

  for (const providerId of providers) {
    try {
      // Session-independent by construction: `getModels` is the runtime's own
      // catalogue read and needs neither a session nor an auth round trip.
      const models = runtime.getModels(providerId) as readonly Model<any>[];
      if (models.length === 0) continue;
      if (!availableProviders.has(providerId)) continue;
      routable.push(providerId);
      groups.push(groupFor(providerId, models));
    } catch (error) {
      failures.push({ provider: providerId, message: errorMessage(error) });
    }
  }

  // A deployment with no usable credential anywhere would otherwise open an
  // empty picker with no way forward. dsh never meets this case: its catalog is
  // exactly the configured routes and its Models page is the way in. The full
  // list is the fallback, so the picker still shows what could be configured and
  // the settings page is where a key gets added.
  if (groups.length === 0) {
    for (const providerId of providers) {
      try {
        const models = runtime.getModels(providerId) as readonly Model<any>[];
        if (models.length > 0) groups.push(groupFor(providerId, models));
      } catch {
        // Already reported above.
      }
    }
  }

  const defaultThinkingLevel = settings.getDefaultThinkingLevel();
  return {
    default: readDefault(settings),
    routableProviders: routable,
    groups,
    failures,
    modelThinkingLevels: settings.getAllModelThinkingLevels() as Record<string, PiThinkingLevel>,
    ...(defaultThinkingLevel !== undefined && defaultThinkingLevel !== null
      ? { defaultThinkingLevel: defaultThinkingLevel as PiThinkingLevel }
      : {}),
  };
}

/**
 * Record a picker selection as the deployment default.
 *
 * The selection is written whole, mirroring dsh's rule that an omitted effort
 * clears a stored one: the level is stored against the *new* model and removed
 * from the previous model's memory when the caller does not supply one, so a
 * later session cannot inherit an effort the new model rejects.
 *
 * @param runtime - unused today, kept so a future validation step can check the
 *   selection against the runtime without changing call sites.
 * @param cwd - workspace whose project settings apply.
 * @param body - the accepted selection.
 * @returns the rebuilt catalog, so the caller replaces its state in one step.
 */
export async function saveDefaultModelSelection(
  runtime: ModelRuntime,
  cwd: string,
  body: DefaultModelRequest,
): Promise<ModelCatalog> {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (provider.length === 0 || model.length === 0) {
    throw new ModelCatalogError(400, 'provider 与 model 都不能为空');
  }
  if (
    body.thinkingLevel !== undefined &&
    body.thinkingLevel !== null &&
    !isThinkingLevel(body.thinkingLevel)
  ) {
    throw new ModelCatalogError(400, `不支持的思考等级：${String(body.thinkingLevel)}`);
  }

  const settings = settingsFor(cwd);
  const previous = readDefault(settings);

  settings.setDefaultModelAndProvider(provider, model);

  if (body.thinkingLevel === null) {
    // dsh's `Default`: forget the remembered level so the model's own provider
    // default applies, rather than leaving a level the user just moved away from.
    settings.removeModelThinkingLevel(provider, model);
  } else if (body.thinkingLevel !== undefined) {
    settings.setModelThinkingLevel(provider, model, body.thinkingLevel as ModelThinkingLevel);
  } else if (previous !== null && (previous.provider !== provider || previous.model !== model)) {
    // The previous model keeps no level for a model that is no longer selected;
    // leaving it would re-apply a level the user just moved away from.
    settings.removeModelThinkingLevel(previous.provider, previous.model);
  }

  // Writes are queued inside SettingsManager; `flush` is the durability point
  // and `drainErrors` is where a failed write surfaces. Reporting it is the
  // difference between "the picker moved" and "the next session will use it".
  await settings.flush();
  const errors = settings.drainErrors();
  if (errors.length > 0) {
    const first = errors[0];
    throw new ModelCatalogError(
      500,
      `默认模型未能写入 settings.json：${first === undefined ? '未知错误' : errorMessage(first.error)}`,
    );
  }

  return buildModelCatalog(runtime, cwd);
}
