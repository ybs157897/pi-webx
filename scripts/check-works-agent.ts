import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { createWorksTools } from '../server/modules/works';
import { readWorksContext, scheduleWorks } from '../server/modules/works/schedule';
import { createWorkbenchRouter } from '../server/workbench/router';
import { statusFromError } from '../server/http-errors';
import { WorkbenchStore } from '../server/workbench/store';

const dir = mkdtempSync(join(tmpdir(), 'pi-webx-works-'));
const dbPath = join(dir, 'workbench.sqlite');
const store = new WorkbenchStore(dbPath);
const app = express();
app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(statusFromError(error)).json({ error: error instanceof Error ? error.message : String(error) });
});
const http = app.listen(0, '127.0.0.1');

try {
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/workbench`;
  const post = (module: string, body: unknown) => fetch(`${base}/${module}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const patch = (module: string, id: string, body: unknown) => fetch(`${base}/${module}/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const task = store.addRecord('tasks', { title: '完成规划评审', due: '2030-10-01' });
  const legacy = store.addRecord('works', { title: '旧工作记录，没有排期' });
  assert.equal(legacy.scheduledDate, null);
  assert.equal(legacy.startTime, null);
  assert.equal(legacy.endTime, null);

  const tools = createWorksTools({ store, limits: { maxToolOutputChars: 24000 } });
  assert.deepEqual(tools.map(tool => tool.name), ['works_context', 'works_schedule']);
  const ctx = { sessionManager: { getSessionId: () => 'works-session-12345678' } } as any;
  const contextResult = await tools[0]!.execute('context', {}, undefined, undefined, ctx);
  const context = (contextResult.details as { data: ReturnType<typeof readWorksContext> }).data;
  assert.match(context.now.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(context.now.localDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(context.now.localTime, /^\d{2}:\d{2}$/);
  assert.ok(context.now.timeZone);
  assert.equal(context.tasks[0]?.id, task.id);
  assert.equal(context.works[0]?.id, legacy.id);
  assert.equal(context.schedule.length, 0);
  assert.equal(context.truncated, false);

  const firstPlan = { entries: [
    { entryKey: 'review', title: '评审规划', scheduledDate: '2030-10-01', startTime: '09:00', endTime: '10:00', taskIds: [task.id] },
    { entryKey: 'implementation', title: '实施规划', scheduledDate: '2030-10-01', startTime: '10:00', endTime: '11:00' },
  ] };
  const savedResult = await tools[1]!.execute('schedule', firstPlan, undefined, undefined, ctx);
  const saved = (savedResult.details as { data: ReturnType<typeof scheduleWorks> }).data;
  assert.equal(saved.entries.length, 2);
  assert.deepEqual(saved.entries.map(item => item.alreadyApplied), [false, false]);
  const review = saved.entries[0]!.record;
  const implementation = saved.entries[1]!.record;
  assert.deepEqual(review.refs, [{ type: 'tasks', id: task.id }]);
  assert.equal(store.listRecords('tasks')[0]?.due, '2030-10-01', '工作助理不得改待办内容');
  assert.equal(store.listRecords('tasks')[0]?.done, false);
  assert.equal(store.links('works', review.id).outgoing[0]?.id, task.id);

  const replay = scheduleWorks(store, 'works-session-12345678', firstPlan);
  assert.deepEqual(replay.entries.map(item => item.alreadyApplied), [true, true]);
  assert.equal(store.listRecords('works').length, 3, '重放不得重复新增工作');
  assert.equal(replay.entries[0]?.record.updatedAt, review.updatedAt, '重放不应修改版本');

  const updated = scheduleWorks(store, 'works-session-12345678', { entries: [{
    ...firstPlan.entries[0], expectedUpdatedAt: review.updatedAt,
    startTime: '08:30', endTime: '09:30',
  }] }).entries[0]!.record;
  assert.equal(updated.id, review.id, '复用 entryKey 必须修改同一条工作');
  assert.equal(updated.startTime, '08:30');
  assert.notEqual(updated.updatedAt, review.updatedAt);
  assert.equal(store.listRecords('works').length, 3);
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', { entries: [{
    ...firstPlan.entries[0], expectedUpdatedAt: review.updatedAt,
    startTime: '08:00', endTime: '09:00',
  }] }), /重新读取上下文/);

  const countBeforeRollback = store.listRecords('works').length;
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', { entries: [
    { entryKey: 'rollback-first', title: '事务第一条', scheduledDate: '2030-10-01', startTime: '13:00', endTime: '14:00' },
    { entryKey: 'rollback-second', title: '冲突第二条', scheduledDate: '2030-10-01', startTime: '09:00', endTime: '10:00' },
  ] }), /重叠/);
  assert.equal(store.listRecords('works').length, countBeforeRollback);
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', { entries: [
    { entryKey: 'invalid-day', title: '无效日期', scheduledDate: '2030-02-30', startTime: '13:00', endTime: '14:00' },
  ] }), /日期/);
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', { entries: [
    { entryKey: 'invalid-time', title: '倒置时间', scheduledDate: '2030-10-02', startTime: '15:00', endTime: '14:00' },
  ] }), /结束时间/);
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', { entries: [
    { entryKey: 'unknown-id', id: 'missing-00000000', expectedUpdatedAt: updated.updatedAt,
      title: '错误改期', scheduledDate: '2030-10-02', startTime: '13:00', endTime: '14:00' },
  ] }), /不存在/);
  const completed = store.addRecord('works', { title: '已完成历史工作', status: 'done',
    scheduledDate: '2030-10-01', startTime: '09:00', endTime: '10:00' });
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', { entries: [
    { entryKey: 'completed', id: completed.id, expectedUpdatedAt: completed.updatedAt,
      title: '已完成历史工作', scheduledDate: '2030-10-02', startTime: '13:00', endTime: '14:00' },
  ] }), /已完成工作/);

  const after = readWorksContext(store);
  assert.equal(after.schedule.length, 2);
  assert.equal(after.schedule[0]?.id, updated.id);
  assert.equal(after.schedule[0]?.updatedAt, updated.updatedAt);
  const limited = readWorksContext(store, { limit: 1 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.returned.schedule, 1);
  assert.equal(limited.hasMore, true);
  const nextPage = readWorksContext(store, { limit: 1, offset: 1 });
  assert.equal(nextPage.schedule[0]?.id, implementation.id);
  assert.equal(nextPage.hasMore, true, '工作列表仍有下一页时需要继续提示翻页');
  assert.equal(readWorksContext(store, { limit: 1, offset: 2 }).hasMore, false);
  const shortTools = createWorksTools({ store, limits: { maxToolOutputChars: 1200 } });
  const shortResult = await shortTools[0]!.execute('short', {}, undefined, undefined, ctx);
  assert.doesNotThrow(() => JSON.parse(shortResult.content[0]!.text), '工具输出截断后仍须是完整 JSON');

  const swap = scheduleWorks(store, 'works-session-12345678', { entries: [
    { entryKey: 'review', id: review.id, expectedUpdatedAt: updated.updatedAt, title: '评审规划', scheduledDate: '2030-10-01', startTime: '10:00', endTime: '11:00' },
    { entryKey: 'implementation', id: implementation.id, expectedUpdatedAt: implementation.updatedAt, title: '实施规划', scheduledDate: '2030-10-01', startTime: '08:30', endTime: '09:30' },
  ] });
  assert.equal(swap.entries[0]?.record.startTime, '10:00', '同批次互换时段须按最终状态校验');
  assert.equal(swap.entries[1]?.record.startTime, '08:30');
  const staleReplay = { entries: [
    { entryKey: 'externally-edited', title: '外部修改后重放', scheduledDate: '2030-10-05', startTime: '09:00', endTime: '10:00' },
  ] };
  const externallyEdited = scheduleWorks(store, 'works-session-12345678', staleReplay).entries[0]!.record;
  store.updateRecord('works', externallyEdited.id, { title: '人工改过的标题' });
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', staleReplay), /后来被修改/);
  assert.throws(() => scheduleWorks(store, 'works-session-12345678', { entries: [
    { ...staleReplay.entries[0], id: review.id },
  ] }), /已绑定另一条/);

  const incomplete = await post('works', { title: '只有日期', scheduledDate: '2030-10-03' });
  assert.equal(incomplete.status, 400, '通用 HTTP 新增不得写半截排期');
  const invalid = await post('works', { title: '时间不完整', startTime: '09:00' });
  assert.equal(invalid.status, 400);
  const manualResponse = await post('works', { title: 'HTTP 新增排期', scheduledDate: '2030-10-03', startTime: '09:00', endTime: '10:00' });
  assert.equal(manualResponse.status, 200);
  const manual = (await manualResponse.json() as { record: { id: string } }).record;
  assert.equal((await patch('works', manual.id, { endTime: '08:59' })).status, 400);
  assert.equal((await patch('works', manual.id, { startTime: '09:30', endTime: '10:30' })).status, 200,
    '修改自身不应误判为时间冲突');
  const other = await post('works', { title: 'HTTP 重叠', scheduledDate: '2030-10-03', startTime: '10:00', endTime: '11:00' });
  assert.equal(other.status, 409);
  const cleared = await patch('works', manual.id, { scheduledDate: '', startTime: '', endTime: '' });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { record: { scheduledDate: unknown } }).record.scheduledDate, null);

  const exported = store.read();
  const copied = new WorkbenchStore(':memory:');
  copied.import(exported);
  assert.equal(copied.listRecords('works').find(row => row.id === review.id)?.startTime, '10:00');
  const oldData = copied.read();
  const oldWork = oldData.works.find(row => row.id === legacy.id)!;
  delete oldWork.scheduledDate;
  delete oldWork.startTime;
  delete oldWork.endTime;
  copied.import(oldData);
  assert.equal(copied.listRecords('works').find(row => row.id === legacy.id)?.scheduledDate, undefined,
    '旧数据无排期字段仍可导入');
  const broken = copied.read();
  const brokenWork = broken.works.find(row => row.id === legacy.id)!;
  brokenWork.scheduledDate = '2030-10-04';
  assert.throws(() => copied.import(broken), /同时填写/);
  copied.close();

  store.close();
  const reopened = new WorkbenchStore(dbPath);
  assert.equal(reopened.listRecords('works').find(row => row.id === review.id)?.startTime, '10:00');
  assert.equal(scheduleWorks(reopened, 'works-session-12345678', { entries: [
    { entryKey: 'review', id: review.id, expectedUpdatedAt: updated.updatedAt, title: '评审规划', scheduledDate: '2030-10-01', startTime: '10:00', endTime: '11:00' },
  ] }).entries[0]?.alreadyApplied, true, '同一会话的幂等绑定须跨数据库重启保留');
  reopened.close();
  console.log('works agent: context, atomic schedule, idempotency, HTTP validation, refs, import and persistence OK');
} finally {
  http.close();
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
}
