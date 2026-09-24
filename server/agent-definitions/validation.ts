/**
 * Request-side validation for agent definitions.
 *
 * Every rule here answers "may this input be written?", with the HTTP status the
 * caller decides (400 for a request body, 500 for the on-disk file — see
 * `./merge.ts`). The write-side name rule and the field list are the contract's,
 * not this module's invention.
 */

import { PI_THINKING_LEVELS, type PiThinkingLevel } from '../../src/shared/protocol';
import {
  AGENT_NAME_PATTERN,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_PROMPT_LENGTH,
  MIN_AGENT_NAME_LENGTH,
  SUBAGENT_COLORS,
  type AgentDefinitionInput,
  type AgentDefinitionPatch,
  type AgentModelSelection,
  type AgentToolPolicy,
  type SubagentColor,
} from '../../src/shared/agent-definitions';

import { isRestrictedAgentTool } from './policy';

/* ------------------------------------------------------------------- limits */

/** Upper bound on `tools: { mode: 'selected', names }`. */
const MAX_SELECTED_TOOLS = 128;

const MIN_MAX_TURNS = 1;
const MAX_MAX_TURNS = 100;
const MIN_MAX_CONCURRENT = 1;
const MAX_MAX_CONCURRENT = 4;

/* ------------------------------------------------------------------- errors */

/** A failure with an HTTP status the router can hand straight to the client. */
export class AgentDefinitionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* -------------------------------------------------------------- validation */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function fail(status: number, message: string): never {
  throw new AgentDefinitionError(status, message);
}

/**
 * Reject any key outside the allowlist.
 *
 * Strict rather than forgiving: a dropped unknown key is a client bug the user
 * never sees, and `id`/`revision`/`timestamp`/`role`/`modelOverride` arriving in
 * a body must be an error, not a silent no-op.
 */
export function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  status: number,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(status, `${where}含未知字段：${key}`);
  }
}

/** Code-point length, so a name of emoji is counted the way a user counts it. */
function textLength(value: string): number {
  return [...value].length;
}

export function requireText(
  value: unknown,
  field: string,
  max: number,
  status: number,
): string {
  if (typeof value !== 'string') fail(status, `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(status, `${field} 不能为空`);
  if (textLength(trimmed) > max) fail(status, `${field} 最多 ${max} 个字符`);
  return trimmed;
}

export function requireBoolean(value: unknown, field: string, status: number): boolean {
  if (typeof value !== 'boolean') fail(status, `${field} 必须是布尔值`);
  return value;
}

export function requireIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  status: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(status, `${field} 必须是整数`);
  }
  if (value < min || value > max) fail(status, `${field} 必须在 ${min}..${max} 之间`);
  return value;
}

export function requireIsoTimestamp(value: unknown, field: string, status: number): string {
  if (typeof value !== 'string') fail(status, `${field} 必须是 ISO 时间字符串`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(status, `${field} 不是合法的时间：${value}`);
  return value;
}

function parseModelSelection(value: unknown, status: number): AgentModelSelection {
  if (!isRecord(value)) fail(status, 'model 必须是对象');
  const mode = value['mode'];
  if (mode === 'inherit') {
    assertOnlyKeys(value, ['mode'], 'model', status);
    return { mode: 'inherit' };
  }
  if (mode === 'fixed') {
    assertOnlyKeys(value, ['mode', 'providerId', 'modelId'], 'model', status);
    return {
      mode: 'fixed',
      providerId: requireText(value['providerId'], 'model.providerId', 200, status),
      modelId: requireText(value['modelId'], 'model.modelId', 200, status),
    };
  }
  return fail(status, 'model.mode 只能是 inherit 或 fixed');
}

function parseThinkingLevel(value: unknown, status: number): PiThinkingLevel {
  if (typeof value !== 'string') fail(status, 'thinkingLevel 必须是字符串');
  const found = PI_THINKING_LEVELS.find((level) => level === value);
  if (found === undefined) {
    fail(status, `thinkingLevel 必须是 ${PI_THINKING_LEVELS.join(' / ')} 之一`);
  }
  return found;
}

/**
 * An identity colour from {@link SUBAGENT_COLORS}.
 *
 * The list is the contract, so membership is checked against it rather than
 * against a hand-written set; the message spells the options out because the
 * form surfaces the server's text.
 */
function parseColor(value: unknown, status: number): SubagentColor {
  const found = SUBAGENT_COLORS.find((color) => color === value);
  if (found === undefined) {
    fail(status, `颜色必须是 ${SUBAGENT_COLORS.join('/')} 之一`);
  }
  return found;
}

function parseToolPolicy(value: unknown, status: number): AgentToolPolicy {
  if (!isRecord(value)) fail(status, 'tools 必须是对象');
  const mode = value['mode'];
  if (mode === 'all') {
    // `all` means "whatever the parent may use"; a `names` list beside it is a
    // contradiction, not a hint.
    assertOnlyKeys(value, ['mode'], 'tools', status);
    return { mode: 'all' };
  }
  if (mode === 'selected') {
    assertOnlyKeys(value, ['mode', 'names'], 'tools', status);
    const raw = value['names'];
    if (!Array.isArray(raw)) fail(status, 'tools.names 必须是数组');
    if (raw.length > MAX_SELECTED_TOOLS) {
      fail(status, `tools.names 最多 ${MAX_SELECTED_TOOLS} 项`);
    }
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'string') fail(status, 'tools.names 的每一项都必须是字符串');
      const name = entry.trim();
      if (name.length === 0) fail(status, 'tools.names 不能包含空名字');
      if (seen.has(name)) fail(status, `tools.names 重复：${name}`);
      seen.add(name);
      if (isRestrictedAgentTool(name)) {
        fail(status, `tools.names 不能包含系统派发/管理工具：${name}`);
      }
      names.push(name);
    }
    // An empty list is legal on purpose: pure reasoning, no tools, no minimum.
    return { mode: 'selected', names };
  }
  return fail(status, 'tools.mode 只能是 all 或 selected');
}

/**
 * Fields every definition must carry.
 *
 * `thinkingLevel`, `color` and `injectAgentsMd` are absent from this list on
 * purpose: they are optional, and their absence is a meaningful state.
 */
export const REQUIRED_INPUT_FIELDS = [
  'name',
  'description',
  'systemPrompt',
  'model',
  'tools',
  'maxTurns',
  'maxConcurrentInstances',
  'enabled',
] as const;

/** Optional fields: validated when present, absence is legal. */
export const OPTIONAL_INPUT_FIELDS = ['thinkingLevel', 'color', 'injectAgentsMd'] as const;

/** Field-level validators shared by requests (400) and stored files (500). */
export const DEFINITION_FIELDS = [...REQUIRED_INPUT_FIELDS, ...OPTIONAL_INPUT_FIELDS] as const;

/**
 * Fields where a PATCH `null` *deletes* the property.
 *
 * Both are optional with no "none" spelling of their own, so without `null` a UI
 * could set them once and never take them back.
 */
export const NULL_CLEARS_FIELDS: readonly string[] = ['thinkingLevel', 'color'];

/**
 * Write-side name rule: {@link MIN_AGENT_NAME_LENGTH}..
 * {@link MAX_AGENT_NAME_LENGTH} code points of Unicode letters, Unicode digits
 * and `-`.
 *
 * The two messages are ZCode's, verbatim, because the settings form shows the
 * server's text when it has one. Length is counted in **code points**, so a
 * Chinese name of three characters passes while `ab` does not.
 */
function parseAgentName(value: unknown, status: number): string {
  if (typeof value !== 'string') fail(status, '名称必须是字符串');
  const trimmed = value.trim();
  const length = textLength(trimmed);
  if (length < MIN_AGENT_NAME_LENGTH || length > MAX_AGENT_NAME_LENGTH) {
    fail(
      status,
      `长度必须在 ${String(MIN_AGENT_NAME_LENGTH)} 到 ${String(MAX_AGENT_NAME_LENGTH)} 个字符之间`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(trimmed)) fail(status, '仅允许使用字母、数字和连字符');
  return trimmed;
}

/**
 * Read-side name check: the *shape* only.
 *
 * Names stored before the current rule existed are not re-judged — a historical
 * `ab` or `my_agent` must read back, not turn the whole file into a 500. The
 * value is returned exactly as stored (no trimming), so reading never rewrites
 * what the user has.
 */
export function parseStoredName(value: unknown, where: string, status: number): string {
  if (typeof value !== 'string') fail(status, `${where} 必须是字符串`);
  if (value.trim().length === 0) fail(status, `${where} 不能为空`);
  return value;
}

/** Parse one field of a definition. Absent optional fields stay absent. */
export function parseField(
  field: (typeof DEFINITION_FIELDS)[number],
  value: unknown,
  status: number,
): unknown {
  switch (field) {
    case 'name':
      return parseAgentName(value, status);
    case 'description':
      return requireText(value, 'description', MAX_AGENT_DESCRIPTION_LENGTH, status);
    case 'systemPrompt':
      return requireText(value, 'systemPrompt', MAX_AGENT_PROMPT_LENGTH, status);
    case 'model':
      return parseModelSelection(value, status);
    case 'thinkingLevel':
      return parseThinkingLevel(value, status);
    case 'color':
      return parseColor(value, status);
    case 'injectAgentsMd':
      return requireBoolean(value, 'injectAgentsMd', status);
    case 'tools':
      return parseToolPolicy(value, status);
    case 'maxTurns':
      return requireIntegerInRange(value, 'maxTurns', MIN_MAX_TURNS, MAX_MAX_TURNS, status);
    case 'maxConcurrentInstances':
      return requireIntegerInRange(
        value,
        'maxConcurrentInstances',
        MIN_MAX_CONCURRENT,
        MAX_MAX_CONCURRENT,
        status,
      );
    case 'enabled':
      return requireBoolean(value, 'enabled', status);
  }
}

/** Full input, as POST carries it. Missing required fields are an error. */
export function parseDefinitionInput(value: unknown, status: number): AgentDefinitionInput {
  if (!isRecord(value)) fail(status, 'definition 必须是对象');
  assertOnlyKeys(value, DEFINITION_FIELDS, 'definition', status);
  const input: Record<string, unknown> = {};
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (!(field in value)) fail(status, `definition 缺少必填字段：${field}`);
    input[field] = parseField(field, value[field], status);
  }
  for (const field of OPTIONAL_INPUT_FIELDS) {
    if (Object.hasOwn(value, field)) input[field] = parseField(field, value[field], status);
  }
  return input as unknown as AgentDefinitionInput;
}

/** Partial input, as PATCH carries it. `{}` is a legal no-op. */
export function parseDefinitionPatch(value: unknown, status: number): AgentDefinitionPatch {
  if (!isRecord(value)) fail(status, 'patch 必须是对象');
  assertOnlyKeys(value, DEFINITION_FIELDS, 'patch', status);
  const patch: Record<string, unknown> = {};
  for (const field of DEFINITION_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (NULL_CLEARS_FIELDS.includes(field)) {
      // `null` clears the property; anything else still has to be a real value.
      patch[field] = raw === null ? null : parseField(field, raw, status);
      continue;
    }
    // Every other field rejects null in its own validator: a null `name` is a
    // malformed request, not "unset".
    patch[field] = parseField(field, raw, status);
  }
  return patch as AgentDefinitionPatch;
}

