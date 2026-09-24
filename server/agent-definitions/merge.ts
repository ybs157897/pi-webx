/**
 * The stored shape, the merge rules and the read side of the definitions file.
 *
 * "Stored" is deliberately not `AgentDefinition`: `source` and `readOnly` are
 * derived on the way out, and a file carrying them is rejected on read. Every
 * rule here re-establishes a whole definition so the file can never hold
 * something a later read would reject as malformed — and so a PATCH `null` can
 * never reach the disk or the DTO.
 *
 * See `./index.ts` for the module's guarantees and `./store.ts` for the file
 * I/O and the queue that serializes it.
 */

import type {
  AgentDefinitionInput,
  AgentDefinitionPatch,
} from '../../src/shared/agent-definitions';

import {
  DEFINITION_FIELDS,
  NULL_CLEARS_FIELDS,
  OPTIONAL_INPUT_FIELDS,
  REQUIRED_INPUT_FIELDS,
  assertOnlyKeys,
  fail,
  isRecord,
  parseField,
  parseStoredName,
  requireIntegerInRange,
  requireIsoTimestamp,
  requireText,
} from './validation';

/** Schema version of the on-disk file. Anything else is a 500, not a migration. */
export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------ raw disk shape */

/**
 * An agent **as it exists on disk**.
 *
 * Deliberately not `AgentDefinition`: `source` and `readOnly` are derived on the
 * way out (like the response's `path`), because writing them would make the file
 * claim things only the code can know — and a file carrying them is rejected on
 * read, so a write must never put them there.
 */
export type StoredAgent = AgentDefinitionInput & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export interface RawDiskFile {
  schemaVersion: number;
  revision: number;
  agents: StoredAgent[];
}

/**
 * Every field *except* the name, with the strict per-field rules.
 *
 * The name is the caller's business because its rule differs by direction:
 * reading a stored file checks the shape only (history is not re-judged), while
 * accepting a write applies the full rule — and a write that does not touch the
 * name must not re-judge the stored one, or a definition saved before the rule
 * could never have its description changed.
 */
export function parseDefinitionFieldsExceptName(
  value: Record<string, unknown>,
  status: number,
  where: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (field === 'name') continue;
    if (!Object.hasOwn(value, field)) fail(status, `${where} 缺少字段：${field}`);
    out[field] = parseField(field, value[field], status);
  }
  for (const field of OPTIONAL_INPUT_FIELDS) {
    if (Object.hasOwn(value, field)) out[field] = parseField(field, value[field], status);
  }
  return out;
}

/**
 * Apply a parsed patch to a stored definition.
 *
 * The one asymmetry: the {@link NULL_CLEARS_FIELDS} (`thinkingLevel`, `color`)
 * *remove* the property when the patch sends `null`, so the merged object carries
 * no key at all — which is how "follow the parent's level" and "no colour" are
 * spelled everywhere else. A key the patch omits leaves the existing value alone.
 */
export function mergeDefinitionPatch(
  target: StoredAgent,
  patch: AgentDefinitionPatch,
): StoredAgent {
  const merged = { ...target } as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (value === null && NULL_CLEARS_FIELDS.includes(field)) {
      delete merged[field];
      continue;
    }
    merged[field] = value;
  }
  return merged as unknown as StoredAgent;
}

/**
 * Post-merge validation before a PATCH is written.
 *
 * Every value the patch supplied was already checked field-by-field; this pass
 * re-establishes the whole definition so the file can never end up holding
 * something a later read would reject as malformed. The name is judged by the
 * read-side rule here, because a patch that leaves the name alone is not a name
 * write — the strict rule was applied to the patch's own value when it had one.
 */
export function validateMergedForWrite(merged: StoredAgent, status: number): AgentDefinitionInput {
  const source = merged as unknown as Record<string, unknown>;
  return {
    name: parseStoredName(source['name'], 'name', status),
    ...parseDefinitionFieldsExceptName(source, status, 'definition'),
  } as unknown as AgentDefinitionInput;
}

/** Identity and bookkeeping of a stored definition, as it must appear on disk. */
export function parseStoredDefinition(value: unknown, index: number, status: number): StoredAgent {
  const where = `agents[${String(index)}]`;
  if (!isRecord(value)) fail(status, `${where} 必须是对象`);
  assertOnlyKeys(value, [...DEFINITION_FIELDS, 'id', 'revision', 'createdAt', 'updatedAt'], where, status);
  const id = requireText(value['id'], `${where}.id`, 128, status);
  const revision = requireIntegerInRange(value['revision'], `${where}.revision`, 1, Number.MAX_SAFE_INTEGER, status);
  const createdAt = requireIsoTimestamp(value['createdAt'], `${where}.createdAt`, status);
  const updatedAt = requireIsoTimestamp(value['updatedAt'], `${where}.updatedAt`, status);
  // The name goes through the read-side rule, not the write-side one: a file
  // written before the current rule must still load.
  const stored = {
    name: parseStoredName(value['name'], `${where}.name`, status),
    ...parseDefinitionFieldsExceptName(value, status, where),
  };
  return { ...(stored as unknown as AgentDefinitionInput), id, revision, createdAt, updatedAt };
}

/** Case-insensitive identity for uniqueness: NFKC, then case-fold. */
function nameKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/** Duplicates *within* one file: two entries may not share a name key. */
export function assertUniqueNames(agents: readonly StoredAgent[], status: number): void {
  const seen = new Map<string, string>();
  for (const agent of agents) {
    const key = nameKey(agent.name);
    const previous = seen.get(key);
    if (previous !== undefined) {
      fail(status, `定义文件中存在同名智能体：${agent.name}（id ${previous} 与 ${agent.id}，名称不区分大小写）`);
    }
    seen.set(key, agent.id);
  }
}

/** A new or renamed entry must not collide with any *other* entry. */
export function assertNameFree(
  agents: readonly StoredAgent[],
  name: string,
  status: number,
  ignoreId?: string,
): void {
  const key = nameKey(name);
  for (const agent of agents) {
    if (ignoreId !== undefined && agent.id === ignoreId) continue;
    if (nameKey(agent.name) === key) {
      fail(status, `已有同名智能体：${agent.name}（名称不区分大小写）`);
    }
  }
}

export function parseStoredFile(raw: unknown, status: number): RawDiskFile {
  if (!isRecord(raw)) fail(status, '定义文件顶层必须是 JSON 对象');
  const schemaVersion = raw['schemaVersion'];
  if (schemaVersion !== SCHEMA_VERSION) {
    fail(status, `不支持的定义文件 schemaVersion：${String(schemaVersion)}（本版本只认 ${String(SCHEMA_VERSION)}）`);
  }
  const revision = raw['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    fail(status, '定义文件的 revision 必须是非负安全整数');
  }
  const agentsRaw = raw['agents'];
  if (!Array.isArray(agentsRaw)) fail(status, '定义文件的 agents 必须是数组');
  const agents = agentsRaw.map((entry, index) => parseStoredDefinition(entry, index, status));
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) fail(status, `定义文件存在重复 id：${agent.id}`);
    ids.add(agent.id);
  }
  assertUniqueNames(agents, status);
  return { schemaVersion: SCHEMA_VERSION, revision, agents };
}
