/**
 * The sub-agent form's rules, as pure functions.
 *
 * Everything that decides *what a save means* lives here instead of inside the
 * component: what a blank definition is, which edits count as dirty, which
 * drafts the server would reject, and how a draft becomes a PATCH body. The
 * component then owns only state and I/O, and
 * `scripts/check-agent-definitions-ui.ts` can pin every rule without a DOM.
 *
 * Three contract points from `src/shared/agent-definitions.ts` drive the shape:
 *
 *   - `tools: { mode: 'all' }` means "whatever the parent may use", and
 *     `{ mode: 'selected', names: [] }` is a legal pure-reasoning agent — so an
 *     empty selection is a valid form, not an incomplete one.
 *   - A `fixed` model must resolve or the call fails, which is why an
 *     incomplete fixed model is a *blocking* validation error rather than a
 *     silent downgrade to `inherit`.
 *   - `thinkingLevel` belongs to the model: it is dropped when the model is
 *     inherited, because it cannot take effect there and a stored value that
 *     does nothing is worse than none.
 */

import {
  AGENT_NAME_PATTERN,
  DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES,
  DEFAULT_AGENT_MAX_TURNS,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_PROMPT_LENGTH,
  MIN_AGENT_NAME_LENGTH,
  SUBAGENT_COLORS,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentDefinitionPatch,
  type AgentModelSelection,
  type AgentToolPolicy,
  type SubagentColor,
} from '../../shared/agent-definitions';
import { PI_THINKING_LEVELS, type PiThinkingLevel } from '../../shared/protocol';

/**
 * The editable state of one definition in the form.
 *
 * A draft is deliberately *not* `AgentDefinitionInput`: text fields are raw
 * strings (so a half-typed name can be held without being trimmed away), the
 * model is always a discriminated pair rather than two half-set fields, and
 * selected tools are kept even while the mode is `all`, so toggling modes back
 * and forth does not lose the user's ticks.
 */
export interface AgentFormValues {
  name: string;
  description: string;
  systemPrompt: string;
  /** `'inherit'` or `'fixed'`; see {@link validateAgentForm} for the fixed rule. */
  modelMode: 'inherit' | 'fixed';
  /** Provider id of the fixed model; `''` while unset. */
  providerId: string;
  /** Model id of the fixed model; `''` while unset. */
  modelId: string;
  /** Absent means "the model decides". */
  thinkingLevel?: PiThinkingLevel;
  toolsMode: 'all' | 'selected';
  /** Ticked tool names; meaningful in `selected` mode, preserved in `all`. */
  selectedTools: string[];
  /** Free-text tool names typed by hand, always honoured in `selected` mode. */
  extraTools: string[];
  /**
   * Identity colour, or absent for "unspecified".
   *
   * The form expresses "unspecified" by clicking the selected swatch again,
   * which clears this back to absent; the reference has the same three states
   * (colour / no colour) but no dedicated "none" swatch.
   */
  color?: AgentColorName;
  /**
   * Unrendered by the form since the 1:1 pass, but kept on the draft so a save
   * can hand the stored value back untouched.
   */
  maxTurns: number;
  /** Same: unrendered, preserved. */
  maxConcurrentInstances: number;
  /** Whether the child injects AGENTS.md; rendered last. */
  injectAgentsMd: boolean;
  enabled: boolean;
}

/** Lower and upper bounds the form itself enforces, mirroring the server's. */
export const AGENT_MAX_TURNS_RANGE = { min: 1, max: 100 } as const;
export const AGENT_MAX_CONCURRENT_RANGE = { min: 1, max: 4 } as const;

/**
 * Name bounds, taken from the reference verbatim (`SubagentsSection.tsx:892-894`
 * uses 3..50) so both forms agree on length.
 *
 * The *character* rule deliberately differs: the reference accepts only
 * `[a-zA-Z0-9-]`, which would forbid a Chinese name. This product allows any
 * Unicode letter or digit plus `-`. All four rules come from the frozen
 * contract rather than being restated here, so the client cannot drift from the
 * server's validator.
 */
export {
  AGENT_NAME_PATTERN,
  MAX_AGENT_NAME_LENGTH,
  MIN_AGENT_NAME_LENGTH,
} from '../../shared/agent-definitions';

/**
 * The colour swatches, in render order — the reference's own order
 * (`packages/ui/src/lib/subagentColors.ts:3-12`), read straight from the
 * contract so the two cannot disagree.
 */
export const AGENT_COLOR_ORDER: readonly SubagentColor[] = SUBAGENT_COLORS;

/** One identity colour. */
export type AgentColorName = SubagentColor;

/** Chinese colour names, verbatim from the reference locale. */
export const AGENT_COLOR_LABELS: Record<SubagentColor, string> = {
  yellow: '黄色',
  red: '红色',
  orange: '橙色',
  green: '绿色',
  cyan: '青色',
  blue: '蓝色',
  purple: '紫色',
  pink: '粉色',
};

/**
 * Pick a colour, or clear it by picking the one already chosen.
 *
 * The reference's colour row is single-choice with no "none" entry, so this is
 * how the form reaches its "unspecified" state without inventing a ninth swatch.
 */
export function toggleAgentColor(
  current: SubagentColor | undefined,
  next: SubagentColor,
): SubagentColor | undefined {
  return current === next ? undefined : next;
}

/** The blank form: inherit the parent model, all tools, disabled. */
export function createAgentFormValues(): AgentFormValues {
  return {
    name: '',
    description: '',
    systemPrompt: '',
    modelMode: 'inherit',
    providerId: '',
    modelId: '',
    toolsMode: 'all',
    selectedTools: [],
    extraTools: [],
    maxTurns: DEFAULT_AGENT_MAX_TURNS,
    maxConcurrentInstances: DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES,
    injectAgentsMd: false,
    enabled: false,
  };
}

/** Project a stored definition into the form. */
export function agentFormValuesFromDefinition(definition: AgentDefinitionInput): AgentFormValues {
  const fixed = definition.model.mode === 'fixed' ? definition.model : undefined;
  return {
    name: definition.name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    modelMode: definition.model.mode,
    providerId: fixed?.providerId ?? '',
    modelId: fixed?.modelId ?? '',
    ...(definition.thinkingLevel === undefined ? {} : { thinkingLevel: definition.thinkingLevel }),
    toolsMode: definition.tools.mode,
    selectedTools: definition.tools.mode === 'selected' ? [...definition.tools.names] : [],
    extraTools: [],
    ...(definition.color === undefined ? {} : { color: definition.color }),
    maxTurns: definition.maxTurns,
    maxConcurrentInstances: definition.maxConcurrentInstances,
    injectAgentsMd: definition.injectAgentsMd === true,
    enabled: definition.enabled,
  };
}

/**
 * Code-point length, i.e. the way a user counts characters.
 *
 * `String.length` counts UTF-16 units, so an emoji costs 2 and an astral CJK
 * extension character costs 2 — which made the form reject text the server
 * accepts (the server measures code points: `[...value].length`). Every length
 * bound in this file goes through here so the two cannot drift apart again.
 */
export function textLength(value: string): number {
  return [...value].length;
}

/**
 * The most tool names a `selected` policy may carry.
 *
 * Mirrors the server's own cap. It is a *form* error rather than a warning
 * because the server answers 400, and a save that can only fail should be
 * stopped while the user can still see what to remove.
 */
export const MAX_SELECTED_TOOLS = 128;

/**
 * The tool list a draft would store in `selected` mode.
 *
 * Order is the user's (catalog ticks first, then hand-typed names), duplicates
 * are dropped, and blanks never make it in — a typed name with trailing spaces
 * must not become a second entry that differs only by whitespace.
 */
export function selectedToolNames(values: AgentFormValues): string[] {
  const names: string[] = [];
  for (const candidate of [...values.selectedTools, ...values.extraTools]) {
    const name = candidate.trim();
    if (name.length === 0 || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/** Build the wire tool policy from a draft. */
export function toolPolicyFromValues(values: AgentFormValues): AgentToolPolicy {
  return values.toolsMode === 'all' ? { mode: 'all' } : { mode: 'selected', names: selectedToolNames(values) };
}

/** Build the wire model selection from a draft. */
export function modelSelectionFromValues(values: AgentFormValues): AgentModelSelection {
  if (values.modelMode === 'inherit') return { mode: 'inherit' };
  return { mode: 'fixed', providerId: values.providerId.trim(), modelId: values.modelId.trim() };
}

/* -------------------------------------------- model-selection <select> codec */

/**
 * A `<select>` option value must carry two independent strings, and the obvious
 * `provider + '/' + modelId` encoding cannot: a model id may itself contain `/`
 * (the deployment's own `deepseek/deepseek-v4.1-flash` does), so any
 * `split('/')` scheme has to guess where the provider ends. Guessing wrong is
 * not cosmetic — it wrote `modelId: 'deepseek'`, the server rejected the model as
 * unavailable, and the feature could not save at all.
 *
 * The encoding is therefore a JSON tuple, which survives every character either
 * half can contain and needs no escaping rules of its own:
 *
 *   - `''` (empty) → "nothing selected" — the one legal value besides a tuple;
 *   - `'["cmdc","deepseek/deepseek-v4.1-flash"]'` → provider `cmdc`, id the whole
 *     remaining string, slashes and all.
 *
 * The pair is never half-populated: if either id is blank the value is `''`, so
 * "empty" and "a real pair" cannot be confused.
 */

/** Encode a provider/model pair as a `<select>` value; `''` when either is blank. */
export function encodeModelSelection(providerId: string, modelId: string): string {
  const provider = providerId.trim();
  const model = modelId.trim();
  return provider.length === 0 || model.length === 0 ? '' : JSON.stringify([provider, model]);
}

/**
 * Decode a `<select>` value back into a provider/model pair.
 *
 * Returns blank ids for anything that is not a two-string tuple — including the
 * legal empty value, malformed JSON, a bare string, a 1- or 3-element array, and
 * non-string members. Callers therefore get a "no selection" answer instead of a
 * throw, which is what lets the form clear itself rather than crash on a stale
 * `<option>` value.
 */
export function decodeModelSelection(value: string): { providerId: string; modelId: string } {
  const none = { providerId: '', modelId: '' };
  const raw = value.trim();
  if (raw.length === 0) return none;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return none;

  const [providerId, modelId] = parsed;
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return none;
  return { providerId: providerId.trim(), modelId: modelId.trim() };
}

/** The draft's own `<select>` value, through the same codec the options use. */
export function modelSelectionValue(values: AgentFormValues): string {
  return values.modelMode === 'inherit' ? '' : encodeModelSelection(values.providerId, values.modelId);
}

/**
 * True when a draft names a fixed model that is absent from a loaded catalog.
 *
 * The picker keeps such a row visible (labelled as unavailable) so the stored
 * model is shown and round-trips instead of being silently cleared; this is the
 * predicate that decides both.
 */
export function marksUnavailableModel(
  values: AgentFormValues,
  isSelectable: (providerId: string, modelId: string) => boolean,
  catalogLoaded: boolean,
): boolean {
  if (values.modelMode !== 'fixed') return false;
  const provider = values.providerId.trim();
  const model = values.modelId.trim();
  if (provider.length === 0 || model.length === 0) return false;
  // An unread catalog is not evidence that the model is missing.
  if (!catalogLoaded) return false;
  return !isSelectable(provider, model);
}

/** Add one tool name to the draft (no-op when already present or blank). */
export function addToolName(names: readonly string[], name: string): string[] {
  const trimmed = name.trim();
  if (trimmed.length === 0 || names.includes(trimmed)) return [...names];
  return [...names, trimmed];
}

/** Remove one tool name from the draft. */
export function removeToolName(names: readonly string[], name: string): string[] {
  return names.filter((entry) => entry !== name);
}

/** Tick every catalog entry, keeping any hand-typed names after them. */
export function selectAllToolNames(catalogNames: readonly string[], current: readonly string[]): string[] {
  const kept = current.filter((name) => !catalogNames.includes(name));
  return [...catalogNames, ...kept];
}

/**
 * The tick set a switch to `selected` starts from.
 *
 * The reference pre-ticks every tool it offers when the mode flips to custom
 * with nothing chosen (`SubagentsSection.tsx:991-997`), so the user starts from
 * "everything" and removes — rather than from an empty list that silently means
 * "no tools". An already-populated selection is left alone.
 */
export function initialSelectedToolsForCustom(
  catalogNames: readonly string[],
  current: readonly string[],
): string[] {
  return current.length === 0 ? [...catalogNames] : [...current];
}

/** Untick everything; hand-typed names are cleared too ("全不选"). */
export function clearToolNames(): string[] {
  return [];
}

/** Trim a name for comparison and sending; NFKC folds的全角/半角 and compatibility forms. */
export function normalizeAgentName(name: string): string {
  return name.trim().normalize('NFKC');
}

/**
 * Equality key for the "duplicate name" check.
 *
 * Case-folding is the *server's* final word; the form uses the same key so its
 * warning agrees with the rejection instead of contradicting it. Locale-independent
 * `toLowerCase` is deliberate: `toLocaleLowerCase` would make the check depend on
 * the browser's locale.
 */
export function agentNameKey(name: string): string {
  return normalizeAgentName(name).toLowerCase();
}

/** True when the draft differs from what the server last returned. */
export function isAgentFormDirty(values: AgentFormValues, original: AgentDefinitionInput | undefined): boolean {
  const before = original === undefined ? createAgentFormValues() : agentFormValuesFromDefinition(original);
  return !sameFormValues(values, before);
}

/** Field-by-field comparison used by {@link isAgentFormDirty}. */
function sameFormValues(left: AgentFormValues, right: AgentFormValues): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.systemPrompt === right.systemPrompt &&
    left.modelMode === right.modelMode &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.thinkingLevel === right.thinkingLevel &&
    left.toolsMode === right.toolsMode &&
    sameNames(selectedToolNames(left), selectedToolNames(right)) &&
    left.color === right.color &&
    left.injectAgentsMd === right.injectAgentsMd &&
    left.maxTurns === right.maxTurns &&
    left.maxConcurrentInstances === right.maxConcurrentInstances &&
    left.enabled === right.enabled
  );
}

/** Order-insensitive name comparison for the dirty check. */
function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((name) => rightSet.has(name));
}

/** What the form refuses to submit, and why. */
export interface AgentFormProblems {
  /** Messages that block a save. */
  errors: string[];
  /** Messages worth showing but that do not block a save. */
  warnings: string[];
}

/**
 * Validate a draft against the frozen contract plus the form's own bounds.
 * @param values - the draft.
 * @param siblings - other definitions, for the duplicate-name warning.
 * @param original - the definition being edited, so it does not warn about itself.
 */
export function validateAgentForm(
  values: AgentFormValues,
  /** Other *editable* definitions, for the duplicate-name warning. Built-ins are
   *  excluded by the caller: a user definition of the same name shadows one, so
   *  warning about the collision would be wrong. */
  siblings: readonly (AgentDefinitionInput & { id?: string })[] = [],
  original?: AgentDefinitionInput & { id?: string },
): AgentFormProblems {
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = normalizeAgentName(values.name);
  const nameLength = textLength(name);
  // The two name errors are the reference's own copy, verbatim
  // (`i18n/locales/zh-CN.ts:3375-3376`), with the length substituted in.
  if (nameLength < MIN_AGENT_NAME_LENGTH || nameLength > MAX_AGENT_NAME_LENGTH) {
    errors.push(`长度必须在 ${MIN_AGENT_NAME_LENGTH} 到 ${MAX_AGENT_NAME_LENGTH} 个字符之间`);
  } else if (!AGENT_NAME_PATTERN.test(name)) {
    errors.push('仅允许使用字母、数字和连字符');
  }

  const description = values.description.trim();
  if (description.length === 0) errors.push('描述不能为空');
  else if (textLength(description) > MAX_AGENT_DESCRIPTION_LENGTH) {
    errors.push(`描述最多 ${MAX_AGENT_DESCRIPTION_LENGTH} 个字符。`);
  }

  const prompt = values.systemPrompt.trim();
  if (prompt.length === 0) errors.push('系统提示词不能为空');
  else if (textLength(prompt) > MAX_AGENT_PROMPT_LENGTH) {
    errors.push(`系统提示最多 ${MAX_AGENT_PROMPT_LENGTH} 个字符。`);
  }

  if (values.modelMode === 'fixed') {
    if (values.providerId.trim().length === 0) errors.push('选择“指定模型”后必须选择一个提供方。');
    if (values.modelId.trim().length === 0) errors.push('选择“指定模型”后必须选择一个模型。');
  }

  /* The turn budget and concurrency cap are no longer rendered, so they are not
     the user's to fix here: a stored value that violates today's bounds is
     reported by the server, not by a field nobody can see. */

  // A name collides case-insensitively; the server decides, the form warns first.
  const key = agentNameKey(values.name);
  const duplicate = siblings.some(
    (candidate) => candidate.id !== original?.id && agentNameKey(candidate.name) === key,
  );
  if (duplicate) warnings.push('已有同名子智能体（不区分大小写）；保存时以服务端判定为准。');

  const chosenCount = selectedToolNames(values).length;
  if (values.toolsMode === 'selected') {
    if (chosenCount > MAX_SELECTED_TOOLS) {
      errors.push(`自定义工具最多 ${MAX_SELECTED_TOOLS} 项，当前 ${chosenCount} 项。`);
    } else if (chosenCount === 0) {
      // An empty list is legal on purpose (pure reasoning), so this stays a
      // warning — the difference between "no tools" and "forgot to tick" is the
      // user's to make.
      warnings.push('未选择任何工具：该子智能体将只能推理，不能读写文件或执行命令。');
    }
  }

  return { errors, warnings };
}

/**
 * The PATCH body for a draft: only fields that actually changed.
 *
 * An omitted field keeps its stored value, so sending the whole input would turn
 * every save into a blind overwrite of fields the form may not render. The one
 * field that needs a third state is `thinkingLevel`; see
 * {@link thinkingLevelPatch}.
 */
export function patchFromValues(
  values: AgentFormValues,
  original: AgentDefinitionInput,
): AgentDefinitionPatch {
  const before = agentFormValuesFromDefinition(original);
  const after: AgentDefinitionPatch = {};

  const name = normalizeAgentName(values.name);
  if (name !== before.name) after.name = name;
  const description = values.description.trim();
  if (description !== before.description) after.description = description;
  const systemPrompt = values.systemPrompt.trim();
  if (systemPrompt !== before.systemPrompt) after.systemPrompt = systemPrompt;

  if (!sameModel(values, before)) after.model = modelSelectionFromValues(values);
  const thinkingLevel = thinkingLevelPatch(values, before);
  if (thinkingLevel !== OMIT) after.thinkingLevel = thinkingLevel;

  if (!sameNames(selectedToolNames(values), selectedToolNames(before)) || values.toolsMode !== before.toolsMode) {
    after.tools = toolPolicyFromValues(values);
  }

  const color = colorPatch(values, before);
  if (color !== OMIT) after.color = color;
  if (values.injectAgentsMd !== before.injectAgentsMd) after.injectAgentsMd = values.injectAgentsMd;

  /* `maxTurns` / `maxConcurrentInstances` are still compared, because a caller
     may build a draft from something other than `agentFormValuesFromDefinition`.
     The form itself always carries the stored values through unchanged, which is
     what makes "unrendered fields are never modified" true in practice. */
  if (values.maxTurns !== before.maxTurns) after.maxTurns = values.maxTurns;
  if (values.maxConcurrentInstances !== before.maxConcurrentInstances) {
    after.maxConcurrentInstances = values.maxConcurrentInstances;
  }
  if (values.enabled !== before.enabled) after.enabled = values.enabled;

  return after;
}

/** The two groups the list renders, in order. */
export interface AgentListGroups<T> {
  /** Product-shipped, read-only, always enabled. Rendered first. */
  builtin: T[]
  /** Everything the user created. Rendered second. */
  user: T[]
}

/**
 * Split a merged listing into the two groups the UI draws.
 *
 * The server merges built-ins in front of the user's own definitions and lets a
 * user definition *shadow* a built-in of the same name, so the split is a
 * partition by `source` — nothing is dropped and nothing needs a shadow check
 * here.
 */
export function groupAgentDefinitions<T extends Pick<AgentDefinition, 'source'>>(
  agents: readonly T[],
): AgentListGroups<T> {
  return {
    builtin: agents.filter((agent) => agent.source === 'builtin'),
    user: agents.filter((agent) => agent.source !== 'builtin'),
  };
}

/**
 * The footer count.
 *
 * Built-ins have no enable switch, so they are always on: they count toward the
 * total *and* toward the enabled figure. Counting only the user's own definitions
 * would understate a list the user can see.
 */
export function agentDefinitionCounts<T extends Pick<AgentDefinition, 'source' | 'enabled'>>(
  agents: readonly T[],
): { total: number; enabled: number } {
  const groups = groupAgentDefinitions(agents)
  return {
    total: agents.length,
    enabled: groups.user.filter((agent) => agent.enabled).length + groups.builtin.length,
  };
}

/** "Send no `color` key at all", distinct from sending `null`. */
const OMIT = Symbol('omit');

/**
 * The `color` half of a patch, with the same three states as `thinkingLevel`.
 *
 * `color` is optional, so "keep it" and "clear it" cannot both be expressed by
 * omission: clearing needs `null`. Clicking the chosen swatch again is what
 * produces an absent draft colour, i.e. the clear case.
 */
function colorPatch(
  values: AgentFormValues,
  before: AgentFormValues,
): SubagentColor | null | typeof OMIT {
  if (values.color === before.color) return OMIT;
  return values.color ?? null;
}

/**
 * The `thinkingLevel` half of a patch, in the contract's three states.
 *
 * The form renders the level as inherited-by-default, and the panel shows it as
 * absent while the model is inherited — so once a level was ever stored, going
 * back to `inherit` has to say so *explicitly*. JSON has no `undefined`, so
 * omitting the key means "keep the stored level": without `null` the stored
 * value would silently survive the save, and switching the model back to a
 * fixed pair later would resurrect a level the user believes they dropped.
 *
 *   - stored absent → draft absent: nothing to say, key omitted;
 *   - stored level → draft level: the new level;
 *   - stored level → draft inherited/absent: `null`, i.e. clear it;
 *   - stored absent → draft level: the new level.
 *
 * `null` never reaches a draft: {@link AgentFormValues.thinkingLevel} stays
 * `PiThinkingLevel | undefined`, so the value cannot leak back into the form or
 * into a create body (see {@link createInputFromValues}).
 */
function thinkingLevelPatch(
  values: AgentFormValues,
  before: AgentFormValues,
): PiThinkingLevel | null | typeof OMIT {
  // A level is only meaningful beside a fixed model; an inherited draft stores
  // nothing (see agentFormValuesFromDefinition), so `undefined` here means
  // "inherit", whether or not a level is still stored.
  const next = values.modelMode === 'fixed' ? values.thinkingLevel : undefined;
  const stored = before.thinkingLevel;
  if (next === stored) return OMIT;
  return next ?? null;
}

function sameModel(left: AgentFormValues, right: AgentFormValues): boolean {
  if (left.modelMode !== right.modelMode) return false;
  if (left.modelMode === 'inherit') return true;
  return left.providerId.trim() === right.providerId.trim() && left.modelId.trim() === right.modelId.trim();
}

/**
 * Thinking level: only meaningful for a fixed model.
 *
 * `inherit` means the child follows the parent's reasoning configuration, so a
 * level stored alongside it would be ignored — the same rule the reference
 * states for its own inheritance. A level is therefore not sent at all while the
 * draft inherits the model.
 */

/** The POST body for a draft. */
export function createInputFromValues(values: AgentFormValues): AgentDefinitionInput {
  const thinkingLevel = values.modelMode === 'fixed' ? values.thinkingLevel : undefined;
  return {
    name: normalizeAgentName(values.name),
    description: values.description.trim(),
    systemPrompt: values.systemPrompt.trim(),
    model: modelSelectionFromValues(values),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    tools: toolPolicyFromValues(values),
    ...(values.color === undefined ? {} : { color: values.color }),
    injectAgentsMd: values.injectAgentsMd,
    maxTurns: values.maxTurns,
    maxConcurrentInstances: values.maxConcurrentInstances,
    enabled: values.enabled,
  };
}

/**
 * Fold a 409 into the state the UI must show.
 *
 * The server's fresh list replaces the *version* the form will save against, but
 * the draft is handed back untouched: the user's unsaved edits are the one thing
 * a conflict must never silently drop. The caller decides how to re-attach the
 * draft — the contract is only that it survives.
 */
export function reconcileConflict(
  values: AgentFormValues,
  fresh: { revision: number; agents: readonly AgentDefinition[] },
): { draft: AgentFormValues; revision: number; notice: string } {
  return {
    draft: values,
    revision: fresh.revision,
    notice: '配置已被修改，已刷新版本，请检查后重新保存',
  };
}

/** The thinking levels the picker offers when no model is known. */
export function fallbackThinkingLevels(): readonly PiThinkingLevel[] {
  return PI_THINKING_LEVELS;
}
