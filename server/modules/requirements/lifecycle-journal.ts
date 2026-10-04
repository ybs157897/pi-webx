import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LifecycleRoot } from './lifecycle-contracts';

type Mutation = { seq: number; id: string; module: string; record_id: string; operation: string;
  before_payload: string | null; after_payload: string | null; occurred_at: string | null };
type Row = Record<string, unknown> & { id: string };

function content(row: Row): string {
  return JSON.stringify(['title','note','priority','taskDrafts','refs','tags'].map(key => row[key] ?? null));
}

function rootsOf(row: Row | null): string[] {
  return Array.isArray(row?.refs) ? [...new Set(row.refs.flatMap(ref =>
    ref && typeof ref === 'object' && ref.type === 'requirements' && typeof ref.id === 'string' ? [ref.id] : []))] : [];
}

function event(db: Database.Database, root: string, mutation: Mutation, type: string,
  summary: string, version: number | null, refs: Record<string, unknown>): void {
  db.prepare(`INSERT OR IGNORE INTO requirement_lifecycle_events
    (id,requirement_id,event_key,type,actor,summary,refs,requirement_version,occurred_at)
    VALUES (?,?,?,?, 'record', ?,?,?,?)`).run(randomUUID(), root, `mutation:${mutation.id}:${type}`, type,
      summary, JSON.stringify(refs), version, mutation.occurred_at);
}

function link(db: Database.Database, root: string, mutation: Mutation, row: Row,
  removed: boolean, version: number | null): void {
  db.prepare(`INSERT INTO requirement_lifecycle_links
    (requirement_id,kind,entity_id,requirement_version,refs,occurred_at) VALUES (?,'task',?,?,?,?)
    ON CONFLICT(requirement_id,kind,entity_id) DO UPDATE SET refs=excluded.refs`)
    .run(root, row.id, version, JSON.stringify({ title: row.title, done: row.done === true,
      removed, deleted: mutation.operation === 'delete' }), mutation.occurred_at);
}

/** The immutable SQL journal is authoritative; this projection is rebuilt transactionally on access. */
export function synchronizeRequirementMutations(db: Database.Database): void {
  db.transaction(() => {
    const cursor = Number((db.prepare(`SELECT value FROM requirement_lifecycle_meta WHERE key='mutation_cursor'`)
      .get() as { value: string } | undefined)?.value ?? 0);
    const mutations = db.prepare('SELECT * FROM workbench_mutations WHERE seq>? ORDER BY seq')
      .all(cursor) as Mutation[];
    for (const mutation of mutations) {
      const before = mutation.before_payload ? JSON.parse(mutation.before_payload) as Row : null;
      const after = mutation.after_payload ? JSON.parse(mutation.after_payload) as Row : null;
      if (mutation.module === 'requirements') {
        const payload = after ?? before!;
        const prior = db.prepare('SELECT * FROM requirement_lifecycle_roots WHERE requirement_id=?')
          .get(mutation.record_id) as LifecycleRoot | undefined;
        const contentChanged = !prior || mutation.operation === 'delete' || prior.archived === 1
          || content(JSON.parse(prior.payload) as Row) !== content(payload);
        const version = prior ? prior.current_version + (contentChanged ? 1 : 0) : 1;
        const archived = mutation.operation === 'delete' ? 1 : 0;
        const historical = mutation.operation === 'baseline' ? 1 : prior?.historical ?? 0;
        const timestamp = mutation.occurred_at ?? new Date().toISOString();
        db.prepare(`INSERT INTO requirement_lifecycle_roots
          (requirement_id,current_version,current_updated_at,payload,archived,historical,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(requirement_id) DO UPDATE SET
          current_version=excluded.current_version,current_updated_at=excluded.current_updated_at,
          payload=excluded.payload,archived=excluded.archived,updated_at=excluded.updated_at`)
          .run(mutation.record_id, version, String(payload.updatedAt ?? ''), JSON.stringify(payload), archived,
            historical, String(payload.createdAt ?? timestamp), timestamp);
        db.prepare(`INSERT OR IGNORE INTO requirement_lifecycle_versions
          (requirement_id,version,updated_at,payload,archived,recorded_at) VALUES (?,?,?,?,?,?)`)
          .run(mutation.record_id, version, String(payload.updatedAt ?? ''), JSON.stringify(payload), archived, mutation.occurred_at);
        db.prepare(`INSERT OR IGNORE INTO requirement_lifecycle_stamps(requirement_id,updated_at,version) VALUES (?,?,?)`)
          .run(mutation.record_id, String(payload.updatedAt ?? ''), version);
        const type = mutation.operation === 'baseline' ? 'requirement.historical'
          : archived ? 'requirement.deleted' : !prior ? 'requirement.created'
          : prior.archived ? 'requirement.restored' : after?.importedAt && !before?.importedAt
          ? 'requirement.tasks_imported' : contentChanged ? 'requirement.updated' : 'requirement.metadata_updated';
        event(db, mutation.record_id, mutation, type,
          `${type === 'requirement.historical' ? '历史需求接入追踪' : type === 'requirement.created' ? '保存需求草稿'
            : type === 'requirement.tasks_imported' ? '需求已拆分并导入待办' : archived ? '需求记录已删除，追踪保留'
            : type === 'requirement.restored' ? '需求记录重新导入' : contentChanged ? '需求内容已修订' : '需求元信息已更新'}：${String(payload.title ?? '')}`,
          version, { requirementId: mutation.record_id, operation: mutation.operation,
            sourceSessionId: payload.sourceSessionId ?? null, importedTaskIds: payload.importedTaskIds ?? [] });
      } else if (mutation.module === 'tasks') {
        const oldRoots = rootsOf(before), newRoots = rootsOf(after);
        for (const rootId of new Set([...oldRoots, ...newRoots])) {
          const root = db.prepare('SELECT current_version FROM requirement_lifecycle_roots WHERE requirement_id=?')
            .get(rootId) as { current_version: number } | undefined;
          const removed = !newRoots.includes(rootId);
          link(db, rootId, mutation, (after ?? before)!, removed, root?.current_version ?? null);
          const type = mutation.operation === 'baseline' ? 'task.historical' : mutation.operation === 'delete'
            ? 'task.deleted' : removed ? 'task.unlinked' : !oldRoots.includes(rootId) ? 'task.linked'
            : after?.done === true && before?.done !== true ? 'task.completed'
            : before?.done === true && after?.done !== true ? 'task.reopened' : 'task.updated';
          const label = ({ 'task.historical':'历史待办接入追踪','task.deleted':'待办已删除','task.unlinked':'待办解除关联',
            'task.linked':'待办已关联需求','task.completed':'待办已完成','task.reopened':'待办重新打开','task.updated':'待办已更新' } as Record<string,string>)[type];
          event(db, rootId, mutation, type, `${label}: ${String((after ?? before)?.title ?? '')}`,
            root?.current_version ?? null, { taskId: mutation.record_id, done: after?.done ?? false, removed });
        }
      } else if (mutation.operation === 'dataset_replaced') {
        const roots = db.prepare('SELECT requirement_id,current_version FROM requirement_lifecycle_roots').all() as
          Array<{ requirement_id: string; current_version: number }>;
        for (const root of roots) event(db, root.requirement_id, mutation, 'dataset.replaced',
          '需求数据整批替换；旧执行和交付仍保留，需求版本须重新核对', root.current_version,
          { reason: after?.reason ?? 'import' });
      }
      db.prepare(`INSERT INTO requirement_lifecycle_meta(key,value) VALUES ('mutation_cursor',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(mutation.seq));
    }
  }).immediate();
}
