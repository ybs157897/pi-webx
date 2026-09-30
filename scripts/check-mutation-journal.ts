import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WorkbenchStore } from '../server/workbench/store';

type Mutation = {
  seq: number; id: string; module: string; record_id: string; operation: string;
  before_payload: string | null; after_payload: string | null; occurred_at: string | null;
};
const directory = mkdtempSync(join(tmpdir(), 'pi-webx-mutations-'));
const legacyPath = join(directory, 'legacy.sqlite');
const bulkPath = join(directory, 'bulk.sqlite');
const rows = (store: WorkbenchStore): Mutation[] => store.sqlite.prepare(
  'SELECT * FROM workbench_mutations ORDER BY seq').all() as Mutation[];

try {
  const raw = new Database(legacyPath);
  raw.exec(`CREATE TABLE workbench_records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL, id TEXT NOT NULL,
    payload TEXT NOT NULL, UNIQUE(module,id)
  )`);
  const originalReq = JSON.stringify({ id: 'req-legacy', title: '旧需求' });
  const originalTask = JSON.stringify({ id: 'task-legacy', title: '旧待办' });
  const insert = raw.prepare('INSERT INTO workbench_records(module,id,payload) VALUES (?,?,?)');
  insert.run('requirements', 'req-legacy', originalReq);
  insert.run('tasks', 'task-legacy', originalTask);
  insert.run('works', 'work-legacy', JSON.stringify({ id: 'work-legacy', title: '待迁移工作' }));
  raw.close();

  let store = new WorkbenchStore(legacyPath);
  try {
    let history = rows(store);
    assert.deepEqual(history.map(row => row.operation), ['baseline', 'baseline', 'insert'],
      'old records are observed once before migrations; migrated tasks enter as inserts');
    assert.deepEqual(history.slice(0, 2).map(row => [row.module, row.record_id, row.occurred_at]), [
      ['requirements', 'req-legacy', null], ['tasks', 'task-legacy', null],
    ], 'baseline does not invent original mutation timestamps');
    assert.equal(history[0]?.after_payload, originalReq);
    assert.equal(history[1]?.after_payload, originalTask);
    assert.equal(history[2]?.module, 'tasks');
    assert.equal(history[2]?.record_id, 'work-legacy');
    assert.match(history[2]?.occurred_at ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    store.close();
    store = new WorkbenchStore(legacyPath);
    assert.deepEqual(rows(store).map(row => row.operation), ['baseline', 'baseline', 'insert'],
      'reopening does not append another baseline or replay migration');
    assert.equal((store.sqlite.prepare(`SELECT value FROM workbench_meta WHERE key = 'mutation_journal_baseline_v1'`)
      .get() as { value: string }).value, '1');

    const updatedReq = JSON.stringify({ id: 'req-legacy', title: '直接 SQL 更新' });
    store.sqlite.prepare(`UPDATE workbench_records SET payload = ?
      WHERE module = 'requirements' AND id = 'req-legacy'`).run(updatedReq);
    history = rows(store);
    assert.equal(history.at(-1)?.operation, 'update');
    assert.deepEqual([history.at(-1)?.before_payload, history.at(-1)?.after_payload], [originalReq, updatedReq]);
    store.sqlite.prepare(`UPDATE workbench_records SET payload = payload
      WHERE module = 'requirements' AND id = 'req-legacy'`).run();
    assert.equal(rows(store).length, history.length, 'unchanged payload creates no update event');

    const direct = JSON.stringify({ id: 'task-direct', title: '直接 SQL 新增' });
    store.sqlite.prepare('INSERT INTO workbench_records(module,id,payload) VALUES (?,?,?)')
      .run('tasks', 'task-direct', direct);
    store.sqlite.prepare(`DELETE FROM workbench_records WHERE module = 'tasks' AND id = 'task-direct'`).run();
    assert.deepEqual(rows(store).slice(-2).map(row => [row.operation, row.before_payload, row.after_payload]), [
      ['insert', null, direct], ['delete', direct, null],
    ]);
    store.sqlite.prepare(`UPDATE workbench_records SET module = 'tasks'
      WHERE module = 'requirements' AND id = 'req-legacy'`).run();
    assert.deepEqual(rows(store).slice(-2).map(row => [row.module, row.operation]), [
      ['requirements', 'delete'], ['tasks', 'insert'],
    ], 'identity moves emit a tombstone followed by a new entity');
    const count = rows(store).length;
    assert.throws(() => store.sqlite.transaction(() => {
      store.sqlite.prepare(`DELETE FROM workbench_records WHERE module = 'tasks' AND id = 'task-legacy'`).run();
      throw new Error('rollback');
    })(), /rollback/);
    assert.equal(rows(store).length, count, 'trigger rows roll back with the source write');
    const ids = rows(store).map(row => row.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => /^[a-f0-9]{32}$/.test(id)));
  } finally { store.close(); }

  const bulk = new WorkbenchStore(bulkPath);
  try {
    const task = bulk.addRecord('tasks', { title: '导入前待办' });
    const replacement = bulk.read();
    replacement.tasks = [{ ...task, title: '导入后待办' }];
    const before = rows(bulk).length;
    bulk.import(replacement);
    const changes = rows(bulk).slice(before);
    assert.deepEqual(changes.map(row => row.operation), ['delete', 'insert', 'dataset_replaced']);
    assert.equal(changes.at(-1)?.module, '*');
    assert.equal(changes.at(-1)?.record_id, '*');
    assert.deepEqual(JSON.parse(changes.at(-1)!.after_payload!),
      { reason: 'import', requirements: [], tasks: [task.id] });
    assert.ok(changes[0]!.seq < changes[1]!.seq && changes[1]!.seq < changes[2]!.seq);

    bulk.sqlite.exec(`CREATE TRIGGER mutation_fixture_reject BEFORE INSERT ON workbench_records
      WHEN NEW.module = 'tasks' BEGIN SELECT RAISE(ABORT, 'fixture import rejected'); END`);
    const stable = rows(bulk);
    assert.throws(() => bulk.import(replacement), /fixture import rejected/);
    assert.deepEqual(rows(bulk), stable, 'failed bulk replace rolls back row events and marker');
    bulk.sqlite.exec('DROP TRIGGER mutation_fixture_reject');
    bulk.resetAll();
    assert.equal(rows(bulk).at(-1)?.operation, 'dataset_replaced', 'reset uses the same boundary');
    bulk.loadDemo();
    assert.equal(rows(bulk).at(-1)?.operation, 'dataset_replaced', 'demo uses the same boundary');
  } finally { bulk.close(); }
  console.log('PASS mutation journal: direct SQL, one-time baseline, migration, bulk boundary and rollback');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
