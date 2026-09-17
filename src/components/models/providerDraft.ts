/**
 * Draft state for the provider editor.
 *
 * The wire view is awkward to edit directly: optionals are absent rather than
 * empty, numbers arrive as numbers, and the key is masked. The editor therefore
 * works on its own draft shape (strings everywhere, write-only key fields) and
 * converts back on save. `validateProviderDraft` mirrors the server's own checks
 * so a bad row is named before the request is sent, and `buildProviderPayload`
 * only ever emits `apiKey` when the user actually touched it.
 */

import { httpUrlError, positiveIntError, positiveIntOrUndefined, providerIdError } from '../../lib/modelsConfig';
import type {
  ApiKeyView,
  ModelProviderUpsertRequest,
  ModelUpsertRequest,
  PiApiKind,
  ProviderModelView,
  ProviderView,
} from '../../shared/models-config';

export interface ModelDraft {
  /** stable list key: `id` is user-editable while the row is on screen */
  key: string;
  /**
   * The wire `api` of this model. Not exposed in the UI, but carried through so
   * a save does not silently drop a per-model override pi already had.
   */
  api?: PiApiKind;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  /** subset of `text` / `image` */
  input: string[];
}

export interface ProviderDraft {
  /** create mode: the id is editable and must not collide with an existing one */
  isNew: boolean;
  id: string;
  name: string;
  baseUrl: string;
  api: PiApiKind;
  authHeader: boolean;
  /** write-only: '' keeps whatever the file already has */
  apiKey: string;
  /** the user asked to drop the stored key on save */
  apiKeyRemove: boolean;
  models: ModelDraft[];
}

export const DEFAULT_API_KIND: PiApiKind = 'openai-completions';

/* ------------------------------------------------------------------- factory */

let keySeq = 0;

function nextModelKey(): string {
  keySeq += 1;
  return `model-${keySeq}`;
}

export function createModelDraft(model?: ProviderModelView): ModelDraft {
  return {
    key: nextModelKey(),
    ...(model?.api !== undefined ? { api: model.api } : {}),
    id: model?.id ?? '',
    name: model?.name ?? '',
    contextWindow: model?.contextWindow !== undefined ? String(model.contextWindow) : '',
    maxTokens: model?.maxTokens !== undefined ? String(model.maxTokens) : '',
    reasoning: model?.reasoning === true,
    input: model?.input !== undefined ? [...model.input] : ['text'],
  };
}

/** `provider === undefined` starts a brand new provider. */
export function createProviderDraft(provider?: ProviderView): ProviderDraft {
  if (provider === undefined) {
    return {
      isNew: true,
      id: '',
      name: '',
      baseUrl: '',
      api: DEFAULT_API_KIND,
      authHeader: false,
      apiKey: '',
      apiKeyRemove: false,
      models: [],
    };
  }
  return {
    isNew: false,
    id: provider.id,
    name: provider.name ?? '',
    baseUrl: provider.baseUrl ?? '',
    api: provider.api ?? DEFAULT_API_KIND,
    authHeader: provider.authHeader === true,
    apiKey: '',
    apiKeyRemove: false,
    models: provider.models.map((model) => createModelDraft(model)),
  };
}

/* ---------------------------------------------------------------- validation */

export interface DraftErrors {
  /** everything that blocks a save, already worded for the user */
  messages: string[];
  id?: string;
  baseUrl?: string;
  /** model draft key → message for that row */
  models: Record<string, string>;
}

/** `第 2 个模型（Kimi K3）`, so a message always names the offending row. */
function modelRowLabel(model: ModelDraft, index: number): string {
  const hint = model.name.trim() || model.id.trim();
  return hint.length > 0 ? `第 ${index + 1} 个模型（${hint}）` : `第 ${index + 1} 个模型`;
}

export function validateProviderDraft(
  draft: ProviderDraft,
  options?: { existingIds?: readonly string[] },
): DraftErrors {
  const messages: string[] = [];
  const modelErrors: Record<string, string> = {};

  const id = draft.id.trim();
  const idProblem = providerIdError(id);
  if (idProblem !== undefined) {
    messages.push(idProblem);
  } else if (draft.isNew && (options?.existingIds ?? []).includes(id)) {
    messages.push(`Provider ID 已存在：${id}，请直接编辑该 provider`);
  }

  const baseUrl = draft.baseUrl.trim();
  let baseUrlProblem: string | undefined;
  if (baseUrl.length === 0) {
    if (draft.isNew) baseUrlProblem = 'Base URL 不能为空';
  } else {
    baseUrlProblem = httpUrlError(baseUrl);
  }
  if (baseUrlProblem !== undefined) messages.push(baseUrlProblem);

  const seen = new Map<string, number>();
  draft.models.forEach((model, index) => {
    const label = modelRowLabel(model, index);
    const push = (detail: string) => {
      modelErrors[model.key] = detail;
      messages.push(`${label}：${detail}`);
    };

    const modelId = model.id.trim();
    if (modelId.length === 0) {
      push('模型 ID 不能为空');
    } else {
      const first = seen.get(modelId);
      if (first !== undefined) {
        push(`模型 ID 重复：${modelId}（与第 ${first + 1} 个模型重复）`);
      } else {
        seen.set(modelId, index);
      }
    }

    const contextProblem = positiveIntError(model.contextWindow, '上下文窗口');
    if (contextProblem !== undefined) push(contextProblem);
    const maxTokensProblem = positiveIntError(model.maxTokens, '最大输出');
    if (maxTokensProblem !== undefined) push(maxTokensProblem);
  });

  return {
    messages,
    models: modelErrors,
    ...(idProblem !== undefined ? { id: idProblem } : {}),
    ...(baseUrlProblem !== undefined ? { baseUrl: baseUrlProblem } : {}),
  };
}

/* ------------------------------------------------------------------- payload */

export function buildModelPayload(model: ModelDraft): ModelUpsertRequest {
  const id = model.id.trim();
  const name = model.name.trim();
  const contextWindow = positiveIntOrUndefined(model.contextWindow);
  const maxTokens = positiveIntOrUndefined(model.maxTokens);
  const input = Array.from(new Set(model.input.filter((kind) => kind === 'text' || kind === 'image')));

  return {
    id,
    ...(name.length > 0 ? { name } : {}),
    ...(model.api !== undefined ? { api: model.api } : {}),
    ...(model.reasoning ? { reasoning: true } : {}),
    ...(input.length > 0 ? { input } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

/**
 * The save body. `apiKey` appears only when the user typed a value or asked to
 * clear the key — an omitted `apiKey` is what tells the server to keep the
 * configured credential as-is.
 */
export function buildProviderPayload(draft: ProviderDraft): ModelProviderUpsertRequest {
  const name = draft.name.trim();
  const baseUrl = draft.baseUrl.trim();
  const keyValue = draft.apiKey.trim();

  const apiKey = draft.apiKeyRemove
    ? { remove: true }
    : keyValue.length > 0
      ? { value: keyValue }
      : undefined;

  return {
    ...(name.length > 0 ? { name } : {}),
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
    api: draft.api,
    authHeader: draft.authHeader,
    models: draft.models.map((model) => buildModelPayload(model)),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

/** Preserved verbatim from the view so the editor can describe the stored key. */
export function storedApiKey(provider: ProviderView | undefined): ApiKeyView {
  return provider?.apiKey ?? { has: false, source: 'none' };
}

/* ------------------------------------------------------------------- asserts */

/**
 * Usage assert: the editor constructs and saves exactly this shape, so a change
 * to the draft contract fails `tsc` here first.
 */
const sampleDraft: ProviderDraft = {
  isNew: true,
  id: 'example',
  name: '示例',
  baseUrl: 'https://api.example.com/v1',
  api: DEFAULT_API_KIND,
  authHeader: false,
  apiKey: '',
  apiKeyRemove: false,
  models: [
    {
      key: 'model-1',
      id: 'example-model',
      name: 'Example',
      contextWindow: '128000',
      maxTokens: '8192',
      reasoning: true,
      input: ['text'],
    },
  ],
};

export type ProviderDraftAssertion = typeof sampleDraft;

const sampleErrors: DraftErrors = validateProviderDraft(sampleDraft, { existingIds: [] });

export type DraftErrorsAssertion = typeof sampleErrors;
