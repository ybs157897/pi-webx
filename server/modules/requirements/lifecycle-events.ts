import { randomUUID } from 'node:crypto';
import { WorkbenchInputError } from '../../workbench/store';
import type { LifecycleEventInput, LifecycleLinkInput, LifecycleRoot, LifecycleStore, RequirementVersion } from './lifecycle-contracts';
import { ensureLifecycleSchema } from './lifecycle-schema';
import { synchronizeRequirementMutations } from './lifecycle-journal';

export function ensureRequirementLifecycle(store: LifecycleStore): void {
  ensureLifecycleSchema(store.sqlite);
  synchronizeRequirementMutations(store.sqlite);
}

export type RequirementLookup = 'id' | 'human' | 'auto';

export function lifecycleRoot(store: LifecycleStore, id: string, lookup: RequirementLookup = 'id'): LifecycleRoot {
  ensureRequirementLifecycle(store);
  const exact = lookup === 'human' ? undefined : store.sqlite.prepare(
    'SELECT * FROM requirement_lifecycle_roots WHERE requirement_id=?').get(id) as LifecycleRoot | undefined;
  const number = /^REQ-(\d+)$/.exec(id)?.[1];
  const seq = number === undefined ? NaN : Number(number);
  const human = lookup === 'id' || !Number.isSafeInteger(seq) || seq < 1 ? undefined
    : store.sqlite.prepare('SELECT * FROM requirement_lifecycle_roots WHERE seq=?').get(seq) as LifecycleRoot | undefined;
  if (lookup === 'auto' && exact && human && exact.requirement_id !== human.requirement_id) {
    throw new WorkbenchInputError('需求 ID 与展示编号冲突，请使用 id:原始ID 或 req:编号查询', 409);
  }
  const root = lookup === 'human' ? human : exact ?? human;
  if (!root) throw new WorkbenchInputError('需求不存在或尚未进入追踪', 404);
  return root;
}

export function getRequirementVersion(store: LifecycleStore, id: string, updatedAt?: string): number | undefined {
  const root = lifecycleRoot(store, id);
  if (updatedAt === undefined) return root.current_version;
  const versions = store.sqlite.prepare(`SELECT DISTINCT version FROM requirement_lifecycle_stamps
    WHERE requirement_id=? AND updated_at=?`).all(root.requirement_id, updatedAt) as Array<{ version: number }>;
  return versions.length === 1 ? versions[0]!.version : undefined;
}

function versionOf(store: LifecycleStore, root: LifecycleRoot, input: RequirementVersion | undefined): number | null {
  if (input === null) return null;
  if (input === undefined) return root.current_version;
  if (typeof input === 'string') return getRequirementVersion(store, root.requirement_id, input) ?? null;
  const exists = store.sqlite.prepare('SELECT 1 FROM requirement_lifecycle_versions WHERE requirement_id=? AND version=?')
    .get(root.requirement_id, input);
  if (!exists) throw new WorkbenchInputError('需求修订版本不存在', 409);
  return input;
}

function safeRefs(refs: Record<string, unknown> = {}): string {
  const json = JSON.stringify(refs);
  if (json.length > 16_000 || /"(?:apiKey|authorization|access_token|password|thinking|arguments)"\s*:/i.test(json)) {
    throw new WorkbenchInputError('追踪引用包含过大或私有内容');
  }
  return json;
}

export function recordRequirementEvent(store: LifecycleStore, requirementId: string, input: LifecycleEventInput): void {
  const root = lifecycleRoot(store, requirementId);
  if (!input.eventKey || input.eventKey.length > 500 || !input.type || input.type.length > 100
    || !input.summary || input.summary.length > 4000) throw new WorkbenchInputError('追踪事件不合法');
  const version = versionOf(store, root, input.requirementVersion);
  store.sqlite.prepare(`INSERT OR IGNORE INTO requirement_lifecycle_events
    (id,requirement_id,event_key,type,actor,summary,refs,requirement_version,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), root.requirement_id, input.eventKey, input.type, input.actor ?? 'system', input.summary,
      safeRefs(input.refs), version, input.occurredAt ?? new Date().toISOString());
}

export function linkRequirementEntity(store: LifecycleStore, requirementId: string, input: LifecycleLinkInput): void {
  const root = lifecycleRoot(store, requirementId);
  if (!input.id || input.id.length > 500 || !input.kind || input.kind.length > 100) throw new WorkbenchInputError('追踪关联不合法');
  const competing = store.sqlite.prepare(`SELECT requirement_id FROM requirement_lifecycle_links
    WHERE kind=? AND entity_id=? AND requirement_id<>? LIMIT 1`).get(input.kind, input.id, root.requirement_id);
  if (competing && input.kind.startsWith('chatroom_')) throw new WorkbenchInputError('执行记录已属于其他需求', 409);
  store.sqlite.prepare(`INSERT INTO requirement_lifecycle_links
    (requirement_id,kind,entity_id,requirement_version,refs,occurred_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(requirement_id,kind,entity_id) DO UPDATE SET refs=excluded.refs`)
    .run(root.requirement_id, input.kind, input.id, versionOf(store, root, input.requirementVersion),
      safeRefs(input.refs), input.occurredAt ?? new Date().toISOString());
}
