import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createWorkbenchRouter } from '../server/workbench/router';
import { WorkbenchStore } from '../server/workbench/store';

const dir = mkdtempSync(join(tmpdir(), 'pi-webx-workbench-'));
const path = join(dir, 'workbench.sqlite');
let store = new WorkbenchStore(path);
let http: ReturnType<express.Express['listen']> | undefined;

try {
  assert.equal(store.read().tasks.length, 0);
  const task = store.addRecord('tasks', { title: '验证 SQLite 保存', due: '2026-09-23' });
  assert.equal(task.title, '验证 SQLite 保存');
  assert.equal(store.updateRecord('tasks', task.id, { done: true }).done, true);
  const exercise = store.addRecord('exercises', { type: '跑步', minutes: 30 });
  assert.equal(exercise.minutes, 30);
  const profile = store.putAtomProfile('pets', { name: '小猫' });
  assert.equal(profile.name, '小猫');
  const diary = store.addAtomRecord('pets', { title: '学会握手' });
  assert.equal(diary.title, '学会握手');
  assert.throws(() => store.addRecord('exercises', { type: '跑步', minutes: 2000 }), /上限/);
  store.close();

  store = new WorkbenchStore(path);
  assert.equal(store.read().tasks[0]?.done, true);
  assert.equal(store.read().pets.records[0]?.title, '学会握手');

  const imported = store.read();
  imported.tasks = [{ ...task, title: '从旧 JSON 导入' }];
  store.import(imported);
  assert.equal(store.read().tasks[0]?.title, '从旧 JSON 导入');
  assert.throws(() => store.import({ ...imported, tasks: [{ ...task, due: '2026-02-31' }] }), /日期/);
  assert.equal(store.read().tasks[0]?.title, '从旧 JSON 导入', 'failed import must roll back');

  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter(store));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/workbench`;
  const state = await fetch(`${base}/state`).then((response) => response.json()) as { data: { tasks: Array<{ title: string }> } };
  assert.equal(state.data.tasks[0]?.title, '从旧 JSON 导入');
  const createdResponse = await fetch(`${base}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '走 HTTP 新增' }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { record: { id: string } };
  const patchedResponse = await fetch(`${base}/tasks/${created.record.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }),
  });
  assert.equal((await patchedResponse.json() as { record: { done: boolean } }).record.done, true);
  const deleteResponse = await fetch(`${base}/tasks/${created.record.id}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.equal(store.read().tasks.length, 1);
  console.log('workbench SQLite: persistence, validation, import rollback and HTTP CRUD passed');
} finally {
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
