import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createWorkbenchRouter } from '../server/workbench/router';
import { WorkbenchInputError, WorkbenchStore } from '../server/workbench/store';
import { applyLifePlan, captureLifeTasks, proposeLifePlan, readLifeContext } from '../server/modules/life/service';
import { createLifeTools, LIFE_TOOL_NAMES } from '../server/modules/life/tools';

const directory = mkdtempSync(join(tmpdir(), 'pi-webx-life-'));
const path = join(directory, 'data.sqlite');
const store = new WorkbenchStore(path);
const app = express();
app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error instanceof WorkbenchInputError ? error.status : 500)
    .json({ error: error instanceof Error ? error.message : String(error) });
});
const server = app.listen(0, '127.0.0.1');

try {
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/workbench`;
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const patch = (url: string, body: unknown) => fetch(`${base}${url}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const capture = { entries: [
    { entryKey: 'cat-food', originalText: '快没猫粮了', title: '买猫粮', tag: '采购' },
    { entryKey: 'property-fee', originalText: '周五前交物业费', title: '交物业费', due: '2026-10-02', durationMinutes: 20 },
  ] };
  const collected = captureLifeTasks(store, 'life-session-12345678', capture);
  const [cat, fee] = collected.entries.map(item => item.record);
  assert.equal(collected.entries.every(item => !item.alreadyCaptured), true);
  assert.equal(cat!.originalText, '快没猫粮了');
  assert.equal(cat!.due, null, '随手记录不能默认今天截止');
  assert.equal(cat!.plannedDate, null);
  assert.equal(cat!.durationMinutes, 30);
  assert.equal(fee!.due, '2026-10-02');
  const clearedDue = await patch(`/tasks/${fee!.id}`, { due: null });
  assert.equal(clearedDue.status, 200);
  assert.equal(store.read().tasks.find(task => task.id === fee!.id)?.due, null, '手动清空截止日应持久化');
  const feeRestored = store.updateRecord('tasks', fee!.id, { due: '2026-10-02' });
  assert.equal((await post('/tasks', { title: '伪造来源', captureSessionId: 'life-session-12345678' })).status, 400);
  assert.equal((await post('/tasks', { title: '只有日期的固定安排', kind: 'fixed', plannedDate: '2026-09-30' })).status, 400);
  assert.equal(captureLifeTasks(store, 'life-session-12345678', capture).entries.every(item => item.alreadyCaptured), true);
  assert.equal(store.read().tasks.length, 2);
  assert.throws(() => captureLifeTasks(store, 'life-session-12345678', {
    entries: [{ entryKey: 'cat-food', originalText: '改成别的', title: '改成别的' }],
  }), /entryKey/);
  assert.throws(() => captureLifeTasks(store, 'life-session-12345678', { entries: [
    { entryKey: 'third', title: '缺少原话' }, { entryKey: 'fourth', originalText: '记一下', title: '记一下' },
  ] }), /原话/);
  assert.equal(store.read().tasks.length, 2, '无效批次不能部分写入');

  const fixed = store.addRecord('tasks', {
    title: '家庭聚餐', kind: 'fixed', plannedDate: '2026-09-30', startTime: '18:00', endTime: '20:00', due: null,
  });
  assert.equal((await post('/lifePlans', { title: '伪造草稿', sourceSessionId: 'fake' })).status, 400);
  assert.equal((await patch(`/lifePlans/${fixed.id}`, { appliedAt: '2026-09-29T00:00:00Z' })).status, 400);
  assert.equal((await post('/tasks', { title: '冲突', plannedDate: '2026-09-30', startTime: '19:00', endTime: '20:30' })).status, 409);
  assert.equal((await patch(`/tasks/${fixed.id}`, { startTime: null })).status, 400, '时段必须成对');
  assert.equal((await patch(`/tasks/${fixed.id}`, { plannedDate: null, startTime: null, endTime: null })).status, 200);
  const restored = store.updateRecord('tasks', fixed.id, { plannedDate: '2026-09-30', startTime: '18:00', endTime: '20:00' });
  assert.equal(restored.due, null, '清空和重排不能改变截止日');

  const beforePlan = store.read().tasks;
  const proposal = proposeLifePlan(store, 'life-session-12345678', {
    planKey: 'tomorrow-plan', note: '下午留出休息时间', entries: [
      { taskId: cat!.id, expectedUpdatedAt: cat!.updatedAt, plannedDate: '2026-09-30', startTime: '09:00', endTime: '09:30', reason: '顺路购买' },
      { taskId: fee!.id, expectedUpdatedAt: feeRestored.updatedAt, plannedDate: '2026-09-30', startTime: '10:00', endTime: '10:20' },
    ],
  });
  assert.equal(proposal.alreadyProposed, false);
  assert.deepEqual(store.read().tasks, beforePlan, '生成建议不能修改待办');
  assert.equal(store.read().lifePlans.length, 1);
  assert.equal(readLifeContext(store).plans.length, 1);
  assert.equal(proposeLifePlan(store, 'life-session-12345678', {
    planKey: 'tomorrow-plan', note: '下午留出休息时间', entries: proposal.plan.entries,
  }).alreadyProposed, true);
  assert.equal((await post(`/life/plans/${proposal.plan.id}/apply`, { expectedUpdatedAt: 'stale' })).status, 409);
  assert.equal((await post(`/life/plans/${proposal.plan.id}/apply`, { expectedUpdatedAt: proposal.plan.updatedAt })).status, 200);
  const applied = store.read();
  assert.equal(applied.tasks.find(task => task.id === fee!.id)?.due, '2026-10-02', '排期不能改截止日');
  assert.equal(applied.tasks.find(task => task.id === cat!.id)?.plannedDate, '2026-09-30');
  assert.equal(applied.lifePlans[0]?.appliedAt !== null, true);
  assert.equal(applyLifePlan(store, proposal.plan.id, { expectedUpdatedAt: proposal.plan.updatedAt }).alreadyApplied, true);
  assert.equal(store.read().tasks.find(task => task.id === cat!.id)?.updatedAt, applied.tasks.find(task => task.id === cat!.id)?.updatedAt);
  assert.equal(readLifeContext(store).plans.length, 0);

  const stale = proposeLifePlan(store, 'life-session-12345678', {
    planKey: 'stale-plan', entries: [{ taskId: cat!.id,
      expectedUpdatedAt: String(applied.tasks.find(task => task.id === cat!.id)?.updatedAt),
      plannedDate: '2026-10-01', startTime: '09:00', endTime: '09:30' }],
  });
  store.updateRecord('tasks', cat!.id, { note: '在楼下超市买' });
  const beforeStale = store.read().tasks;
  assert.equal((await post(`/life/plans/${stale.plan.id}/apply`, { expectedUpdatedAt: stale.plan.updatedAt })).status, 409);
  assert.deepEqual(store.read().tasks, beforeStale, '版本过期整批回滚');

  const currentCat = store.read().tasks.find(task => task.id === cat!.id)!;
  const currentFee = store.read().tasks.find(task => task.id === fee!.id)!;
  assert.throws(() => proposeLifePlan(store, 'life-session-12345678', {
    planKey: 'conflicting-plan', entries: [
      { taskId: currentCat.id, expectedUpdatedAt: currentCat.updatedAt, plannedDate: '2026-10-01', startTime: '11:00', endTime: '12:00' },
      { taskId: currentFee.id, expectedUpdatedAt: currentFee.updatedAt, plannedDate: '2026-10-01', startTime: '11:30', endTime: '12:30' },
    ],
  }), /重叠/);
  assert.throws(() => proposeLifePlan(store, 'life-session-12345678', {
    planKey: 'fixed-plan', entries: [{ taskId: fixed.id, expectedUpdatedAt: restored.updatedAt,
      plannedDate: '2026-10-01', startTime: '18:00', endTime: '20:00' }],
  }), /固定安排/);

  const swap = proposeLifePlan(store, 'life-session-12345678', {
    planKey: 'swap-times', entries: [
      { taskId: currentCat.id, expectedUpdatedAt: currentCat.updatedAt, plannedDate: '2026-09-30', startTime: '10:00', endTime: '10:20' },
      { taskId: currentFee.id, expectedUpdatedAt: currentFee.updatedAt, plannedDate: '2026-09-30', startTime: '09:00', endTime: '09:30' },
    ],
  });
  assert.equal(applyLifePlan(store, swap.plan.id, { expectedUpdatedAt: swap.plan.updatedAt }).tasks.length, 2,
    '同一批次可互换原有时段');
  assert.equal(store.read().tasks.find(task => task.id === currentCat.id)?.startTime, '10:00');
  assert.equal(store.read().tasks.find(task => task.id === currentFee.id)?.startTime, '09:00');

  const dateOnly = store.addRecord('tasks', { title: '预约洗牙', due: '2026-10-10' });
  const datePlan = proposeLifePlan(store, 'life-session-12345678', { planKey: 'date-only', entries: [
    { taskId: dateOnly.id, expectedUpdatedAt: dateOnly.updatedAt, plannedDate: '2026-10-03' },
  ] });
  assert.equal((await fetch(`${base}/life/plans/${datePlan.plan.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(store.read().lifePlans.some(plan => plan.id === datePlan.plan.id), false);
  assert.equal(store.read().tasks.find(task => task.id === dateOnly.id)?.plannedDate, null);

  const exported = store.read();
  const copied = new WorkbenchStore(':memory:');
  copied.import(exported);
  assert.equal(copied.read().lifePlans.length, exported.lifePlans.length);
  assert.equal(copied.read().tasks.find(task => task.id === cat!.id)?.originalText, '快没猫粮了');
  assert.equal(captureLifeTasks(copied, 'life-session-12345678', capture).entries.every(item => item.alreadyCaptured), true,
    '恢复导出后同一会话重试不能重复创建待办');
  assert.equal(copied.read().tasks.length, exported.tasks.length);
  copied.import({ profile: exported.profile, tasks: [{ id: dateOnly.id, title: '旧版事项', done: false, due: null, priority: 'normal', tag: '' }] });
  assert.equal(copied.read().tasks[0]?.plannedDate, undefined, '旧数据允许缺少新字段');
  copied.close();

  const reopened = new WorkbenchStore(path);
  assert.equal(reopened.read().lifePlans.length, exported.lifePlans.length);
  assert.equal(reopened.read().tasks.find(task => task.id === fee!.id)?.due, '2026-10-02');
  reopened.close();

  const tools = createLifeTools({ store, limits: { maxToolOutputChars: 20000 } });
  assert.deepEqual(tools.map(tool => tool.name), Object.values(LIFE_TOOL_NAMES));
  console.log('life secretary persistence, HTTP, idempotence, scheduling and legacy data: OK');
} finally {
  server.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
