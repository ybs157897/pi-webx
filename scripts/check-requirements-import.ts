import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { createWorkbenchRouter } from '../server/workbench/router';
import { WorkbenchInputError, WorkbenchStore } from '../server/workbench/store';
import { createRequirementsTools } from '../server/modules/requirements/tools';
import { importRequirementTasks, saveRequirementDraft } from '../server/modules/requirements/import-tasks';

const dir = mkdtempSync(join(tmpdir(), 'pi-webx-requirements-'));
const dbPath = join(dir, 'workbench.sqlite');
const store = new WorkbenchStore(dbPath);
const app = express();
app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error instanceof WorkbenchInputError ? error.status : 500)
    .json({ error: error instanceof Error ? error.message : String(error) });
});
const http = app.listen(0, '127.0.0.1');

try {
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/workbench`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const first = saveRequirementDraft(store, 'session-12345678', {
    title: '梳理工作台导入', note: '验收：两条待办可溯源。', priority: 'high',
    taskDrafts: [{ title: '实现导入', priority: 'high' }, { title: '验收导入', due: '2026-09-30', tag: '测试' }],
  });
  assert.equal(first.sourceSessionId, 'session-12345678');
  assert.equal((await post('/requirements', { title: '伪造来源', sourceSessionId: 'session-12345678' })).status, 400);
  const forgedPatch = await fetch(`${base}/requirements/${first.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceSessionId: 'session-87654321' }),
  });
  assert.equal(forgedPatch.status, 400);
  assert.equal(store.listRecords('requirements').find(row => row.id === first.id)?.sourceSessionId, 'session-12345678');
  assert.deepEqual(store.read().tasks, [], 'Agent 保存草稿不能偷偷建待办');
  assert.equal((first.taskDrafts as unknown[]).length, 2);
  assert.throws(() => saveRequirementDraft(store, 'session-87654321', { id: first.id, title: '越权修订' }), /本会话/);
  assert.throws(() => saveRequirementDraft(store, 'session-12345678', { title: '空草稿' }), /待办草稿/);
  assert.throws(() => store.addRecord('requirements', { title: '坏草稿', taskDrafts: [{ title: '' }] }), /草稿/);

  const updated = store.updateRecord('requirements', first.id, {
    taskDrafts: [{ title: '预览时选中的一条', priority: 'high', due: null, tag: '' }],
  });
  assert.equal((updated.taskDrafts as unknown[]).length, 1, 'PATCH 应整数组替换草稿');
  assert.notEqual(updated.updatedAt, first.updatedAt, '同毫秒修订也必须递增 updatedAt');
  const stale = await post(`/requirements/${first.id}/import-tasks`, {
    expectedUpdatedAt: first.updatedAt, tasks: [{ title: '未确认旧内容' }],
  });
  assert.equal(stale.status, 409, '旧预览不能导入新版需求');

  const current = store.listRecords('requirements').find(row => row.id === first.id)!;
  const body = { expectedUpdatedAt: current.updatedAt, tasks: [
    { title: '实现导入', priority: 'high', tag: '后端' },
    { title: '验收导入', priority: 'normal', due: '2026-09-30' },
  ] };
  const [a, b] = await Promise.all([
    post(`/requirements/${first.id}/import-tasks`, body),
    post(`/requirements/${first.id}/import-tasks`, body),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const responses = await Promise.all([a.json(), b.json()]) as Array<{
    tasks: Array<{ id: string; refs: unknown[] }>; requirement: { importedTaskIds: string[]; taskDrafts: unknown[] }; alreadyImported: boolean;
  }>;
  assert.deepEqual(responses.map(item => item.alreadyImported).sort(), [false, true]);
  assert.equal(store.read().tasks.length, 2);
  assert.deepEqual(store.read().tasks.map(task => task.refs), [
    [{ type: 'requirements', id: first.id }], [{ type: 'requirements', id: first.id }],
  ]);
  assert.equal(responses[0]!.requirement.importedTaskIds.length, 2);
  assert.equal(responses[0]!.requirement.taskDrafts.length, 2);
  assert.equal(store.links('requirements', first.id).incoming.length, 2);
  const conflict = await post(`/requirements/${first.id}/import-tasks`, {
    expectedUpdatedAt: current.updatedAt, tasks: [{ title: '换一批' }],
  });
  assert.equal(conflict.status, 409, '已导入的需求不能换批次重复建任务');
  assert.throws(() => saveRequirementDraft(store, 'session-12345678', { id: first.id, title: '重写' }), /已导入/);
  assert.throws(() => store.updateRecord('requirements', first.id, { taskDrafts: [{ title: '重写待办' }] }), /不能再修改/);

  const exported = store.read();
  const copied = new WorkbenchStore(':memory:');
  copied.import(exported);
  assert.deepEqual(copied.listRecords('requirements').find(row => row.id === first.id)?.importedTaskIds,
    responses[0]!.requirement.importedTaskIds, '全库导出再导入须保留幂等标记');
  assert.equal(importRequirementTasks(copied, first.id, body).alreadyImported, true);
  assert.equal(copied.read().tasks.length, 2, '全库导入后不可重复产生待办');
  copied.close();

  const versioned = store.addRecord('requirements', { title: '同毫秒版本', note: '旧正文' });
  const future = new Date(Date.now() + 10_000).toISOString();
  store.sqlite.prepare("UPDATE workbench_records SET payload = ? WHERE module = 'requirements' AND id = ?")
    .run(JSON.stringify({ ...versioned, updatedAt: future }), versioned.id);
  const monotonic = store.updateRecord('requirements', versioned.id, { title: '新标题' });
  assert.equal(monotonic.updatedAt, new Date(Date.parse(future) + 1).toISOString(), '同毫秒更新必须单调前进');
  assert.equal(monotonic.note, '旧正文', '版本时间修正不可改动其它字段');

  const empty = store.addRecord('requirements', { title: '尚未拆解' });
  assert.equal((await post(`/requirements/${empty.id}/import-tasks`, { expectedUpdatedAt: empty.updatedAt })).status, 400);
  assert.equal(store.read().tasks.length, 2);

  const rollbackSource = store.addRecord('requirements', { title: '事务回滚' });
  const originalAdd = store.addRecord.bind(store);
  let additions = 0;
  store.addRecord = ((module: string, fields: unknown) => {
    if (module === 'tasks' && ++additions === 2) throw new Error('simulated second insert failure');
    return originalAdd(module, fields);
  }) as WorkbenchStore['addRecord'];
  assert.throws(() => importRequirementTasks(store, rollbackSource.id, {
    expectedUpdatedAt: rollbackSource.updatedAt, tasks: [{ title: '第一条' }, { title: '第二条' }],
  }), /simulated/);
  store.addRecord = originalAdd;
  assert.equal(store.read().tasks.length, 2, '第二条失败须回滚第一条');
  assert.equal(store.listRecords('requirements').find(row => row.id === rollbackSource.id)?.importedAt, undefined);

  const linked = store.addRecord('requirements', { title: '已有手动关联' });
  store.addRecord('tasks', { title: '已有任务', refs: [{ type: 'requirements', id: linked.id }] });
  assert.equal((await post(`/requirements/${linked.id}/import-tasks`, {
    expectedUpdatedAt: linked.updatedAt, tasks: [{ title: '防重任务' }],
  })).status, 409);

  const tool = createRequirementsTools({ store, limits: { maxToolOutputChars: 24000 } })[0]!;
  const beforeTool = store.read().tasks.length;
  const toolResult = await tool.execute('call-1', { title: '工具草稿', taskDrafts: [{ title: '待确认' }] }, undefined, undefined,
    { sessionManager: { getSessionId: () => 'session-12345678' } } as any);
  assert.equal((toolResult.details as { data: { record: { sourceSessionId: string } } }).data.record.sourceSessionId, 'session-12345678');
  assert.equal(store.read().tasks.length, beforeTool);

  const savedCount = store.read().tasks.length;
  store.close();
  const reopened = new WorkbenchStore(dbPath);
  assert.equal(reopened.read().tasks.length, savedCount, '导入的待办必须在重启后保留');
  assert.equal(reopened.listRecords('requirements').find(row => row.id === first.id)?.importedAt !== undefined, true);
  reopened.close();
  console.log('requirements import: draft source, explicit HTTP import, idempotency, refs, rollback, persistence OK');
} finally {
  http.close();
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
}
