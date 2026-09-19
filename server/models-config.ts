/**
 * Model configuration: reads and writes pi's own `~/.pi/agent/models.json`.
 *
 * pi loads that file natively and hot-reloads it, so configuring here gives the
 * same providers/models in the pi CLI — there is no pi-webx-only store. Two
 * rules taken from deepseek-harness's settings handling:
 *
 *   1. Credentials never cross the wire. A read returns only *how* a key is
 *      supplied, and a write that omits the key leaves the value alone.
 *   2. Read-modify-write under a lock, preserving every field this code does
 *      not model (compat, samplingParams, modelOverrides, headers and so on).
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type {
  ModelConfigResponse,
  ModelExtension,
  ModelProviderUpsertRequest,
  ModelUpsertRequest,
  ProviderExtension,
  ProviderView,
} from '../src/shared/models-config';
import { PI_THINKING_LEVELS, type PiThinkingLevel } from '../src/shared/protocol';

/**
 * The file pi itself loads, derived from pi's own `getAgentDir()`.
 *
 * It used to be spelled out as `~/.pi/agent/models.json`, which quietly stopped
 * being the same file the moment `PI_AGENT_DIR` was set: the drawer wrote one
 * models.json and the runtime read another, with every symptom of a save that
 * does not take effect.
 */
const CONFIG_PATH = path.join(getAgentDir(), 'models.json');
const BACKUP_SUFFIX = '.bak-piwebx';

const API_KINDS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

export type ApiKind = (typeof API_KINDS)[number];

const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_MODELS = 200;
const MAX_TEXT = 4000;

const BANG = String.fromCharCode(33);
const DOLLAR = String.fromCharCode(36);
const OPEN_BRACE = String.fromCharCode(123);
const CLOSE_BRACE = String.fromCharCode(125);

export class ModelConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* --------------------------------------------------------------- primitives */

interface RawRecord {
  [key: string]: unknown;
}

interface RawConfig {
  providers: Record<string, RawRecord>;
}

let writeChain: Promise<void> = Promise.resolve();
let backedUp = false;
let revision = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFileSyncSafe(): string {
  try {
    return readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return '';
  }
}

function readRaw(): RawConfig {
  if (!existsSync(CONFIG_PATH)) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSyncSafe());
  } catch (error) {
    throw new ModelConfigError(
      500,
      `models.json 无法解析（${errorMessage(error)}），请先手工修复该文件。`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ModelConfigError(500, 'models.json 顶层必须是 JSON 对象');
  }
  const record = parsed as RawRecord;
  const providers = record['providers'];
  if (providers === undefined) return { providers: {} };
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    throw new ModelConfigError(500, 'models.json 的 providers 字段必须是对象');
  }
  return { providers: providers as Record<string, RawRecord> };
}

/**
 * Labels which of pi's three key spellings is configured. The value is never
 * returned to the client — only the source and a masked tail for literals.
 */
function classifyKey(value: string): ProviderView['apiKey'] {
  if (value.charAt(0) === BANG) return { has: true, source: 'shell' };
  if (value.charAt(0) === DOLLAR) {
    const body =
      value.charAt(1) === OPEN_BRACE ? value.slice(2, value.indexOf(CLOSE_BRACE)) : value.slice(1);
    if (ENV_NAME.test(body)) return { has: true, source: 'env', preview: DOLLAR + body };
  }
  const tail = value.length > 4 ? value.slice(-4) : '';
  return { has: true, source: 'literal', preview: '••••' + tail };
}

function toView(id: string, raw: RawRecord): ProviderView {
  const list = Array.isArray(raw['models']) ? (raw['models'] as RawRecord[]) : [];
  const api = typeof raw['api'] === 'string' ? (raw['api'] as ApiKind) : undefined;
  const key = raw['apiKey'];
  return {
    id,
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] as string } : {}),
    ...(typeof raw['baseUrl'] === 'string' ? { baseUrl: raw['baseUrl'] as string } : {}),
    ...(api ? { api } : {}),
    apiKey:
      typeof key === 'string' && key.length > 0
        ? classifyKey(key)
        : { has: false, source: 'none' },
    ...(raw['authHeader'] === true ? { authHeader: true } : {}),
    models: list.slice(0, MAX_MODELS).map((model) => ({
      id: typeof model['id'] === 'string' ? model['id'] : '',
      ...(typeof model['name'] === 'string' ? { name: model['name'] as string } : {}),
      ...(typeof model['api'] === 'string' ? { api: model['api'] as ApiKind } : {}),
      ...(model['reasoning'] === true ? { reasoning: true } : {}),
      ...(Array.isArray(model['input']) ? { input: (model['input'] as string[]).slice(0, 4) } : {}),
      ...(typeof model['contextWindow'] === 'number'
        ? { contextWindow: model['contextWindow'] as number }
        : {}),
      ...(typeof model['maxTokens'] === 'number'
        ? { maxTokens: model['maxTokens'] as number }
        : {}),
      ...(viewThinkingLevelMap(model['thinkingLevelMap']) !== undefined
        ? { thinkingLevelMap: viewThinkingLevelMap(model['thinkingLevelMap']) }
        : {}),
      ...(viewModelExtension(model['piWebx']) !== undefined
        ? { piWebx: viewModelExtension(model['piWebx']) }
        : {}),
    })),
    ...(viewProviderExtension(raw['piWebx']) !== undefined
      ? { piWebx: viewProviderExtension(raw['piWebx']) }
      : {}),
  };
}

/** The native map as the client sees it: pi levels only, `null` kept as-is. */
function viewThinkingLevelMap(
  value: unknown,
): Partial<Record<PiThinkingLevel, string | null>> | undefined {
  const map = cleanThinkingLevelMap(value, { allowEmpty: false });
  return map === undefined || Object.keys(map).length === 0 ? undefined : map;
}

function viewModelExtension(value: unknown): ModelExtension | undefined {
  const ext = cleanModelExtension(value, { allowEmpty: false });
  return ext === undefined || Object.keys(ext).length === 0 ? undefined : ext;
}

function viewProviderExtension(value: unknown): ProviderExtension | undefined {
  const ext = cleanProviderExtension(value, { allowEmpty: false });
  return ext === undefined || Object.keys(ext).length === 0 ? undefined : ext;
}

function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

function cleanInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

function assertHttpUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ModelConfigError(400, `${field} 不是合法 URL：${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelConfigError(400, `${field} 只允许 http/https 协议`);
  }
  return value.replace(/\/+$/, '');
}

function collectInputKinds(value: unknown): string[] {
  const kinds: string[] = [];
  if (!Array.isArray(value)) return kinds;
  for (const entry of value as unknown[]) {
    const text = cleanText(entry, 20);
    if (text === 'text' || text === 'image') kinds.push(text);
  }
  return kinds;
}

/* ----------------------------------------------------------------- extension */

/**
 * pi's `thinkingLevelMap`, cleaned: pi levels only, values `string | null`.
 * `allowEmpty: false` is the read path (an empty map is reported as absent);
 * the write path accepts `{}` as the honest "no levels configured".
 */
function cleanThinkingLevelMap(
  value: unknown,
  options: { allowEmpty: boolean },
): Partial<Record<PiThinkingLevel, string | null>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Partial<Record<PiThinkingLevel, string | null>> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(PI_THINKING_LEVELS as readonly string[]).includes(key)) continue;
    if (entry === null) {
      out[key as PiThinkingLevel] = null;
      continue;
    }
    const text = cleanText(entry, 200);
    if (text !== undefined) out[key as PiThinkingLevel] = text;
  }
  if (!options.allowEmpty && Object.keys(out).length === 0) return undefined;
  return out;
}

/** The `piWebx` block on one model entry; unknown inner keys are dropped. */
function cleanModelExtension(
  value: unknown,
  options: { allowEmpty: boolean },
): ModelExtension | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const body = value as RawRecord;
  const out: ModelExtension = {};

  if (typeof body['enabled'] === 'boolean') out.enabled = body['enabled'];

  const inputFormat = body['inputFormat'];
  if (typeof inputFormat === 'object' && inputFormat !== null) {
    const flags = inputFormat as RawRecord;
    const kinds: NonNullable<ModelExtension['inputFormat']> = {};
    for (const kind of ['audio', 'video', 'pdf'] as const) {
      if (typeof flags[kind] === 'boolean') kinds[kind] = flags[kind] as boolean;
    }
    if (Object.keys(kinds).length > 0) out.inputFormat = kinds;
  }

  const capabilities = body['capabilities'];
  if (typeof capabilities === 'object' && capabilities !== null) {
    const flags = capabilities as RawRecord;
    const caps: NonNullable<ModelExtension['capabilities']> = {};
    for (const name of [
      'jsonSchemaOutput',
      'nativeWebSearch',
      'midConversationSystem',
      'toolCall',
    ] as const) {
      if (typeof flags[name] === 'boolean') caps[name] = flags[name] as boolean;
    }
    if (Object.keys(caps).length > 0) out.capabilities = caps;
  }

  const map = body['reasoningLevelMap'];
  if (typeof map === 'string' && map.trim().length > 0) {
    out.reasoningLevelMap = map.trim().slice(0, MAX_TEXT);
  }

  if (!options.allowEmpty && Object.keys(out).length === 0) return undefined;
  return out;
}

function cleanProviderExtension(
  value: unknown,
  options: { allowEmpty: boolean },
): ProviderExtension | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: ProviderExtension = {};
  if (typeof (value as RawRecord)['enabled'] === 'boolean') {
    out.enabled = (value as RawRecord)['enabled'] as boolean;
  }
  if (!options.allowEmpty && Object.keys(out).length === 0) return undefined;
  return out;
}

/**
 * One model entry, cleanly. `existing` is the raw entry with the same id, when
 * there is one: its unmodelled fields (cost, compat, headers, samplingParams, …)
 * are carried over, which is the read-modify-write rule this file promises —
 * rebuilding the entry from the request alone used to drop them.
 */
function buildModelEntry(
  body: RawRecord,
  existing: RawRecord | undefined,
): RawRecord {
  const id = cleanText(body['id'] as unknown, 200);
  if (!id) throw new ModelConfigError(400, '每个模型都需要非空 id');

  const model: RawRecord = { ...(existing ?? {}), id };
  // Modelled fields are the request's to decide: absent means absent.
  for (const key of ['name', 'api', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'piWebx']) {
    delete model[key];
  }

  const name = cleanText(body['name'] as unknown, 200);
  if (name) model['name'] = name;
  const api = cleanText(body['api'] as unknown, 40);
  if (api) {
    if (!(API_KINDS as readonly string[]).includes(api)) {
      throw new ModelConfigError(400, `不支持的 api 类型：${api}`);
    }
    model['api'] = api;
  }
  if (body['reasoning'] === true) model['reasoning'] = true;
  const kinds = collectInputKinds(body['input']);
  if (kinds.length > 0) model['input'] = Array.from(new Set(kinds));
  const contextWindow = cleanInt(body['contextWindow']);
  if (contextWindow) model['contextWindow'] = contextWindow;
  const maxTokens = cleanInt(body['maxTokens']);
  if (maxTokens) model['maxTokens'] = maxTokens;

  // Present ⇒ replace (an empty map clears the field); absent ⇒ keep existing.
  if ('thinkingLevelMap' in body) {
    const map = cleanThinkingLevelMap(body['thinkingLevelMap'], { allowEmpty: true });
    if (map !== undefined && Object.keys(map).length > 0) model['thinkingLevelMap'] = map;
  }
  if ('piWebx' in body) {
    const ext = cleanModelExtension(body['piWebx'], { allowEmpty: true });
    if (ext !== undefined && Object.keys(ext).length > 0) model['piWebx'] = ext;
  }
  return model;
}

function normalizeModels(
  input: unknown,
  existing: readonly RawRecord[],
): RawRecord[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new ModelConfigError(400, 'models 必须是数组');
  const byId = new Map<string, RawRecord>();
  for (const entry of existing) {
    if (typeof entry['id'] === 'string') byId.set(entry['id'], entry);
  }
  const seen = new Set<string>();
  const out: RawRecord[] = [];
  for (const raw of input.slice(0, MAX_MODELS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const body = raw as RawRecord;
    const id = cleanText(body['id'] as unknown, 200);
    if (!id) throw new ModelConfigError(400, '每个模型都需要非空 id');
    if (seen.has(id)) throw new ModelConfigError(400, `模型 id 重复：${id}`);
    seen.add(id);
    out.push(buildModelEntry(body, byId.get(id)));
  }
  return out;
}

async function persist(config: RawConfig): Promise<void> {
  const previous = writeChain;
  const task = previous.then(async () => {
    if (!backedUp && existsSync(CONFIG_PATH)) {
      const backup = CONFIG_PATH + BACKUP_SUFFIX;
      if (!existsSync(backup)) {
        const snapshot = readFileSyncSafe();
        try {
          await writeFile(backup, snapshot, { mode: 0o600 });
        } catch {
          // A missing backup must not block the edit.
        }
      }
      backedUp = true;
    }
    await mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
    const tmp = CONFIG_PATH + '.tmp-' + String(process.pid);
    await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, CONFIG_PATH);
    revision += 1;
  });
  writeChain = task.catch(() => undefined);
  await task;
}

/* -------------------------------------------------------------------- API */

export function describeModelConfig(): ModelConfigResponse {
  const config = readRaw();
  const providers: Record<string, ProviderView> = {};
  for (const [id, raw] of Object.entries(config.providers)) {
    providers[id] = toView(id, raw);
  }
  return { revision, path: CONFIG_PATH, providers };
}

/**
 * Server-internal read of one provider's raw settings. Unlike
 * `describeModelConfig` this may surface the *unresolved* `apiKey` (literal /
 * `$ENV` / `!shell`), because callers such as model discovery have to talk to
 * the provider themselves. The value must never cross the wire back to a client.
 */
export function readProviderCredentials(
  id: string,
): { baseUrl?: string; apiKey?: string } | undefined {
  const providerId = cleanText(id, 120);
  if (!providerId) return undefined;
  const raw = readRaw().providers[providerId];
  if (!raw) return undefined;
  const baseUrl = cleanText(raw['baseUrl'], MAX_TEXT);
  const apiKey = cleanText(raw['apiKey'], MAX_TEXT);
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/**
 * Which entries the model picker must hide, read from `piWebx.enabled`.
 *
 * The toggle is pi-webx's own (pi has no enable/disable concept), so this is
 * where it becomes real: `buildModelCatalog` filters with this before listing.
 */
export function readCatalogVisibility(): {
  disabledProviders: Set<string>;
  disabledModels: Map<string, Set<string>>;
} {
  const disabledProviders = new Set<string>();
  const disabledModels = new Map<string, Set<string>>();
  try {
    const config = readRaw();
    for (const [id, raw] of Object.entries(config.providers)) {
      const ext = cleanProviderExtension(raw['piWebx'], { allowEmpty: false });
      if (ext?.enabled === false) disabledProviders.add(id);
      const list = Array.isArray(raw['models']) ? (raw['models'] as RawRecord[]) : [];
      const hidden = new Set<string>();
      for (const model of list) {
        const modelExt = cleanModelExtension(model['piWebx'], { allowEmpty: false });
        if (modelExt?.enabled === false && typeof model['id'] === 'string') {
          hidden.add(model['id']);
        }
      }
      if (hidden.size > 0) disabledModels.set(id, hidden);
    }
  } catch {
    // A file that cannot be read hides nothing: the picker stays useful and
    // the settings page is where the parse error is reported.
  }
  return { disabledProviders, disabledModels };
}

export async function upsertProvider(
  id: string,
  body: ModelProviderUpsertRequest,
): Promise<ModelConfigResponse> {
  const providerId = cleanText(id, 120);
  if (!providerId || !PROVIDER_ID.test(providerId)) {
    throw new ModelConfigError(400, `provider id 不合法：${id}`);
  }
  const config = readRaw();
  const existing = config.providers[providerId];
  const next: RawRecord = { ...(existing ?? {}) };

  // A string field sent as '' clears it (the editor form's honest "empty");
  // omitted keeps whatever is configured, which is what makes saving a
  // redacted view safe.
  if (typeof body['baseUrl'] === 'string') {
    const baseUrl = cleanText(body['baseUrl'], MAX_TEXT);
    if (baseUrl === undefined) delete next['baseUrl'];
    else next['baseUrl'] = assertHttpUrl(baseUrl, 'baseUrl');
  }

  if (typeof body['api'] === 'string') {
    const api = cleanText(body['api'], 40);
    if (api === undefined) {
      delete next['api'];
    } else {
      if (!(API_KINDS as readonly string[]).includes(api)) {
        throw new ModelConfigError(400, `不支持的 api 类型：${api}`);
      }
      next['api'] = api;
    }
  }

  if (typeof body['name'] === 'string') {
    const name = cleanText(body['name'], 200);
    if (name === undefined) delete next['name'];
    else next['name'] = name;
  }
  // Explicit boolean wins both ways, so a saved editor form can turn it off.
  if (typeof body['authHeader'] === 'boolean') {
    if (body['authHeader']) next['authHeader'] = true;
    else delete next['authHeader'];
  }

  if ('piWebx' in body) {
    const ext = cleanProviderExtension(body['piWebx'], { allowEmpty: true });
    if (ext !== undefined && Object.keys(ext).length > 0) next['piWebx'] = ext;
    else delete next['piWebx'];
  }

  // Blank/absent key keeps whatever is configured; only an explicit shape
  // changes it. That is what makes saving a redacted view safe.
  const keyUpdate = body['apiKey'];
  if (keyUpdate !== null && typeof keyUpdate === 'object') {
    if (keyUpdate['remove'] === true) {
      delete next['apiKey'];
    } else if (typeof keyUpdate['value'] === 'string') {
      const value = keyUpdate['value'].trim();
      if (value.length === 0) throw new ModelConfigError(400, 'apiKey 不能是空字符串');
      next['apiKey'] = value.slice(0, MAX_TEXT);
    }
  }

  const existingModels = Array.isArray(existing?.['models'])
    ? (existing?.['models'] as RawRecord[])
    : [];
  const models = normalizeModels(body['models'], existingModels);
  if (models !== undefined) next['models'] = models;

  if (!next['baseUrl'] && !next['api']) {
    throw new ModelConfigError(400, 'provider 至少需要 baseUrl 或 api 之一');
  }

  config.providers[providerId] = next;
  await persist(config);
  return describeModelConfig();
}

export async function deleteProvider(id: string): Promise<ModelConfigResponse> {
  const providerId = cleanText(id, 120);
  if (!providerId) throw new ModelConfigError(400, 'provider id 不能为空');
  const config = readRaw();
  if (!config.providers[providerId]) {
    throw new ModelConfigError(404, `provider 不存在：${providerId}`);
  }
  delete config.providers[providerId];
  await persist(config);
  return describeModelConfig();
}

export async function upsertModel(
  providerId: string,
  body: ModelUpsertRequest,
): Promise<ModelConfigResponse> {
  const id = cleanText(providerId, 120);
  if (!id || !PROVIDER_ID.test(id)) {
    throw new ModelConfigError(400, `provider id 不合法：${providerId}`);
  }
  const config = readRaw();
  const provider = config.providers[id];
  if (!provider) throw new ModelConfigError(404, `provider 不存在：${id}`);

  const list = Array.isArray(provider['models']) ? (provider['models'] as RawRecord[]) : [];
  const modelId = cleanText(body['id'] as unknown, 200);
  if (!modelId) throw new ModelConfigError(400, '模型 id 不能为空');

  const index = list.findIndex((entry) => entry['id'] === modelId);
  // The existing raw entry is the merge base: unmodelled fields it carries
  // (cost, compat, headers, …) survive an edit instead of being dropped.
  const model = buildModelEntry({ ...body, id: modelId }, index >= 0 ? list[index] : undefined);

  if (index >= 0) list[index] = model;
  else list.push(model);
  if (list.length > MAX_MODELS) {
    throw new ModelConfigError(400, `每个 provider 最多 ${MAX_MODELS} 个模型`);
  }

  provider['models'] = list;
  await persist(config);
  return describeModelConfig();
}

export async function deleteModel(
  providerId: string,
  modelId: string,
): Promise<ModelConfigResponse> {
  const id = cleanText(providerId, 120);
  const target = cleanText(modelId, 200);
  if (!id || !target) throw new ModelConfigError(400, 'provider id 与模型 id 不能为空');
  const config = readRaw();
  const provider = config.providers[id];
  if (!provider) throw new ModelConfigError(404, `provider 不存在：${id}`);
  const list = Array.isArray(provider['models']) ? (provider['models'] as RawRecord[]) : [];
  const next = list.filter((entry) => entry['id'] !== target);
  if (next.length === list.length) throw new ModelConfigError(404, `模型不存在：${target}`);
  provider['models'] = next;
  await persist(config);
  return describeModelConfig();
}

export { CONFIG_PATH };
