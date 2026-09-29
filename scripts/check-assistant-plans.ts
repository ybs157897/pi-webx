/**
 * 我的助理（assistant）门禁：待办收集幂等、方案草稿→确认→取消全链路、HTTP 写入口
 * 守卫、works/lifePlans 旧数据迁移与旧导出导入兼容。
 *
 * 钉死的行为：生成草稿不改动任何待办；只有 `POST /plans/:id/apply` 才整批落库，
 * 版本过期整批回滚、固定安排不被建议挪动、重复确认幂等；通用 CRUD 不得伪造
 * 方案与待办来源；旧库（works / lifePlans / works_schedule_entries）与旧导出
 * JSON 都并入 tasks / plans，迁移可重复执行且不重复建记录。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';

import { createWorkbenchRouter } from '../server/workbench/router';
import { WorkbenchInputError, WorkbenchStore } from '../server/workbench/store';
import {
  applyAssistantPlan, captureAssistantTasks, discardAssistantPlan, proposeAssistantPlan, readAssistantContext,
} from '../server/modules/assistant/service';
import { ASSISTANT_TOOL_NAMES, createAssistantTools } from '../server/modules/assistant/tools';

const directory = mkdtempSync(join(tmpdir(), 'pi-webx-assistant-'));
const dbPath = join(directory, 'workbench.sqlite');
const store = new WorkbenchStore(dbPath);
const app = express();
app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error instanceof WorkbenchInputError ? error.status : 500)
    .json({ error: error instanceof Error ? error.message : String(error) });
});
const server = app.listen(0, '127.0.0.1');

const SESSION = 'assistant-session-12345678';
const capture = { entries: [
  { entryKey: 'cat-food', originalText: '快没猫粮了', title: '买猫粮', tag: '采购' },
  { entryKey: 'property-fee', originalText: '周五前交物业费', title: '交物业费', due: '2026-10-02', durationMinutes: 20 },
] };

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error?: string }).error ?? '';
}

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
  assert.equal((await fetch(`${base}/health`)).status, 200, 'router must be mounted before 404 assertions');

  /* 收集：原话保留、无默认截止日、同会话幂等、换内容 409 */
  const collected = captureAssistantTasks(store, SESSION, capture);
  const [cat, fee] = collected.entries.map(item => item.record);
  assert.equal(collected.entries.every(item => item.alreadyCaptured === false), true);
  assert.equal(cat!.originalText, '快没猫粮了');
  assert.equal(cat!.title, '买猫粮');
  assert.equal(cat!.tag, '采购');
  assert.equal(cat!.due, null, '随手记录不能默认今天截止');
  assert.equal(cat!.plannedDate, null);
  assert.equal(cat!.durationMinutes, 30, '未说明时长用默认值，不能成为截止日');
  assert.equal(cat!.captureSessionId, SESSION);
  assert.equal(cat!.captureEntryKey, 'cat-food');
  assert.match(String(cat!.captureFingerprint), /^[0-9a-f]{64}$/);
  assert.equal(fee!.due, '2026-10-02');
  assert.equal([...store.read().tasks].length, 2);

  const forgedCapturePost = await post('/tasks', { title: '伪造来源', captureSessionId: SESSION });
  assert.equal(forgedCapturePost.status, 400);
  assert.match(await errorOf(forgedCapturePost), /我的助理/, '伪造收集来源的报错要指出归属');
  const forgedCapturePatch = await patch(`/tasks/${cat!.id}`, { captureFingerprint: 'a'.repeat(64) });
  assert.equal(forgedCapturePatch.status, 400);
  assert.match(await errorOf(forgedCapturePatch), /我的助理/);

  const retried = captureAssistantTasks(store, SESSION, capture);
  assert.equal(retried.entries.every(item => item.alreadyCaptured === true), true, '整批重试不得重复创建');
  assert.equal(retried.entries[0]?.record.id, cat!.id, '幂等重试要返回原记录');
  assert.equal(retried.entries[0]?.record.updatedAt, cat!.updatedAt, '幂等重试不得改动记录版本');
  assert.equal(store.read().tasks.length, 2);
  assert.throws(() => captureAssistantTasks(store, SESSION, {
    entries: [{ entryKey: 'cat-food', originalText: '改成别的', title: '改成别的' }],
  }), (error: unknown) => error instanceof WorkbenchInputError && error.status === 409 && /entryKey/.test(error.message),
  '同 key 换内容必须 409');
  assert.throws(() => captureAssistantTasks(store, SESSION, { entries: [
    { entryKey: 'third', title: '缺少原话' }, { entryKey: 'fourth', originalText: '记一下', title: '记一下' },
  ] }), /原话/);
  assert.equal(store.read().tasks.length, 2, '无效批次不能部分写入');

  /* 固定安排：不能被建议挪动；清空排期不改变截止日 */
  const fixed = store.addRecord('tasks', {
    title: '家庭聚餐', kind: 'fixed', plannedDate: '2026-09-30', startTime: '18:00', endTime: '20:00', due: null,
  });
  assert.equal((await post('/tasks', { title: '时段冲突', plannedDate: '2026-09-30', startTime: '19:00', endTime: '20:30' })).status, 409);
  assert.equal((await patch(`/tasks/${fixed.id}`, { startTime: null })).status, 400, '时段必须成对');
  assert.equal((await patch(`/tasks/${fixed.id}`, { plannedDate: null, startTime: null, endTime: null })).status, 200);
  const restored = store.updateRecord('tasks', fixed.id, { plannedDate: '2026-09-30', startTime: '18:00', endTime: '20:00' });
  assert.equal(restored.due, null, '清空和重排不能改变截止日');

  /* 草稿→确认→取消：草稿阶段不动待办，确认才整批落库 */
  const beforePlan = store.read().tasks;
  const proposal = proposeAssistantPlan(store, SESSION, {
    planKey: 'tomorrow-plan', note: '下午留出休息时间', entries: [
      { taskId: cat!.id, expectedUpdatedAt: cat!.updatedAt, plannedDate: '2026-09-30', startTime: '09:00', endTime: '09:30', reason: '顺路购买' },
      { taskId: fee!.id, expectedUpdatedAt: fee!.updatedAt, plannedDate: '2026-09-30', startTime: '10:00', endTime: '10:20' },
    ],
  });
  assert.equal(proposal.alreadyProposed, false);
  assert.equal(proposal.plan.appliedAt, null, '草稿必须带未确认标记');
  assert.equal(proposal.plan.sourceSessionId, SESSION);
  assert.deepEqual(store.read().tasks, beforePlan, '生成建议不能修改待办');
  assert.equal(store.read().plans.length, 1);
  assert.equal(readAssistantContext(store).plans.length, 1, '未确认草稿进入助理上下文');
  assert.equal(readAssistantContext(store).totals.tasks, 3);
  assert.equal(proposeAssistantPlan(store, SESSION, {
    planKey: 'tomorrow-plan', note: '下午留出休息时间', entries: proposal.plan.entries,
  }).alreadyProposed, true, '同 planKey 同内容重试幂等');
  assert.throws(() => proposeAssistantPlan(store, SESSION, {
    planKey: 'tomorrow-plan', entries: [{ taskId: cat!.id, expectedUpdatedAt: cat!.updatedAt, plannedDate: '2026-09-30' }],
  }), /planKey/);

  assert.equal((await post(`/plans/${proposal.plan.id}/apply`, {})).status, 400, '确认必须带草稿版本');
  assert.equal((await post(`/plans/${proposal.plan.id}/apply`, { expectedUpdatedAt: 'stale' })).status, 409);
  assert.equal((await post(`/plans/missing-plan-0001/apply`, { expectedUpdatedAt: 'x' })).status, 404);
  const appliedResponse = await post(`/plans/${proposal.plan.id}/apply`, { expectedUpdatedAt: proposal.plan.updatedAt });
  assert.equal(appliedResponse.status, 200);
  const appliedBody = await appliedResponse.json() as { tasks: unknown[]; alreadyApplied: boolean };
  assert.equal(appliedBody.tasks.length, 2, '确认必须在同一事务内更新整批事项');
  assert.equal(appliedBody.alreadyApplied, false);
  const applied = store.read();
  assert.equal(applied.tasks.find(task => task.id === cat!.id)?.plannedDate, '2026-09-30');
  assert.equal(applied.tasks.find(task => task.id === cat!.id)?.startTime, '09:00');
  assert.equal(applied.tasks.find(task => task.id === fee!.id)?.due, '2026-10-02', '排期不能改截止日');
  assert.equal(applied.tasks.find(task => task.id === cat!.id)?.due, null);
  assert.equal(applied.plans.find(plan => plan.id === proposal.plan.id)?.appliedAt !== null, true);
  assert.equal(store.listRecords('tasks').find(task => task.id === fixed.id)?.plannedDate, '2026-09-30', '固定安排不受影响');
  assert.equal(applyAssistantPlan(store, proposal.plan.id, { expectedUpdatedAt: proposal.plan.updatedAt }).alreadyApplied, true);
  assert.equal(store.read().tasks.find(task => task.id === cat!.id)?.updatedAt,
    applied.tasks.find(task => task.id === cat!.id)?.updatedAt, '重复确认不得再次写库');
  assert.equal(readAssistantContext(store).plans.length, 0, '已确认草稿退出助理上下文');

  /* 版本过期：整批回滚，一条都不落库 */
  const currentCat = store.read().tasks.find(task => task.id === cat!.id)!;
  const currentFee = store.read().tasks.find(task => task.id === fee!.id)!;
  const pending = proposeAssistantPlan(store, SESSION, { planKey: 'rollback-plan', entries: [
    { taskId: currentCat.id, expectedUpdatedAt: currentCat.updatedAt, plannedDate: '2026-10-01', startTime: '09:00', endTime: '09:30' },
    { taskId: currentFee.id, expectedUpdatedAt: currentFee.updatedAt, plannedDate: '2026-10-01', startTime: '10:00', endTime: '10:20' },
  ] });
  store.updateRecord('tasks', currentFee.id, { note: '在楼下超市缴费' });
  const beforeRollback = store.read().tasks;
  assert.equal((await post(`/plans/${pending.plan.id}/apply`, { expectedUpdatedAt: pending.plan.updatedAt })).status, 409);
  assert.deepEqual(store.read().tasks, beforeRollback, '版本过期时整批回滚');
  assert.equal(store.read().plans.find(plan => plan.id === pending.plan.id)?.appliedAt, null, '失败的确认不得标记已应用');

  /* 草稿校验：重叠、已固定、同批次互换时段 */
  const latestCat = store.read().tasks.find(task => task.id === cat!.id)!;
  const latestFee = store.read().tasks.find(task => task.id === fee!.id)!;
  assert.throws(() => proposeAssistantPlan(store, SESSION, { planKey: 'overlapping-plan', entries: [
    { taskId: latestCat.id, expectedUpdatedAt: latestCat.updatedAt, plannedDate: '2026-10-01', startTime: '11:00', endTime: '12:00' },
    { taskId: latestFee.id, expectedUpdatedAt: latestFee.updatedAt, plannedDate: '2026-10-01', startTime: '11:30', endTime: '12:30' },
  ] }), /重叠/);
  assert.throws(() => proposeAssistantPlan(store, SESSION, { planKey: 'fixed-plan', entries: [
    { taskId: fixed.id, expectedUpdatedAt: restored.updatedAt, plannedDate: '2026-10-01', startTime: '18:00', endTime: '20:00' },
  ] }), /固定安排/);
  const swap = proposeAssistantPlan(store, SESSION, { planKey: 'swap-times', entries: [
    { taskId: latestCat.id, expectedUpdatedAt: latestCat.updatedAt, plannedDate: '2026-09-30', startTime: '10:00', endTime: '10:20' },
    { taskId: latestFee.id, expectedUpdatedAt: latestFee.updatedAt, plannedDate: '2026-09-30', startTime: '09:00', endTime: '09:30' },
  ] });
  assert.equal(applyAssistantPlan(store, swap.plan.id, { expectedUpdatedAt: swap.plan.updatedAt }).tasks.length, 2,
    '同一批次可互换原有时段');
  assert.equal(store.read().tasks.find(task => task.id === latestCat.id)?.startTime, '10:00');
  assert.equal(store.read().tasks.find(task => task.id === latestFee.id)?.startTime, '09:00');

  /* 确认之间任务被固定：应用阶段同样拒绝 */
  const movingTarget = store.read().tasks.find(task => task.id === cat!.id)!;
  const fixedLater = proposeAssistantPlan(store, SESSION, { planKey: 'fixed-after-propose', entries: [
    { taskId: movingTarget.id, expectedUpdatedAt: movingTarget.updatedAt, plannedDate: '2026-10-02', startTime: '09:00', endTime: '09:30' },
  ] });
  store.updateRecord('tasks', movingTarget.id, { kind: 'fixed', plannedDate: '2026-09-30', startTime: '10:00', endTime: '10:20' });
  assert.equal((await post(`/plans/${fixedLater.plan.id}/apply`, { expectedUpdatedAt: fixedLater.plan.updatedAt })).status, 409);
  assert.equal(store.read().tasks.find(task => task.id === movingTarget.id)?.startTime, '10:00', '被拒的确认不得改动固定安排');
  store.updateRecord('tasks', movingTarget.id, { kind: 'flexible' });

  /* 取消草稿：只有未确认的草稿可删，已应用 409 */
  const dateOnly = store.addRecord('tasks', { title: '预约洗牙', due: '2026-10-10' });
  const datePlan = proposeAssistantPlan(store, SESSION, { planKey: 'date-only', entries: [
    { taskId: dateOnly.id, expectedUpdatedAt: dateOnly.updatedAt, plannedDate: '2026-10-03' },
  ] });
  const discarded = await fetch(`${base}/plans/${datePlan.plan.id}`, { method: 'DELETE' });
  assert.equal(discarded.status, 200);
  assert.equal(store.read().plans.some(plan => plan.id === datePlan.plan.id), false, '取消后草稿不再出现在方案列表');
  assert.equal(store.read().tasks.find(task => task.id === dateOnly.id)?.plannedDate, null, '取消草稿不能改动待办');
  assert.equal((await fetch(`${base}/plans/${proposal.plan.id}`, { method: 'DELETE' })).status, 409, '已应用的方案不能取消');
  assert.equal((await fetch(`${base}/plans/missing-plan-0001`, { method: 'DELETE' })).status, 404);
  assert.throws(() => discardAssistantPlan(store, proposal.plan.id), /已应用/);

  /* 通用 CRUD 守卫：方案只能由助理生成、只能走确认接口 */
  const forgedPlanPost = await post('/plans', { title: '伪造草稿', sourceSessionId: 'fake' });
  assert.equal(forgedPlanPost.status, 400);
  assert.match(await errorOf(forgedPlanPost), /只能由我的助理生成/);
  const forgedPlanPatch = await patch(`/plans/${dateOnly.id}`, { appliedAt: '2026-09-29T00:00:00Z' });
  assert.equal(forgedPlanPatch.status, 400);
  assert.match(await errorOf(forgedPlanPatch), /只能通过确认接口应用/);

  /* 旧路由退役：/life/plans/* 全部 404 */
  assert.equal((await post('/life/plans/any-plan-id/apply', { expectedUpdatedAt: 'x' })).status, 404);
  assert.equal((await fetch(`${base}/life/plans/any-plan-id`, { method: 'DELETE' })).status, 404);
  assert.equal((await post('/lifePlans', { title: '旧模块写入口' })).status, 400, '旧模块名不再是可写模块');

  /* 全库导出再导入：方案与待办保留，收集幂等去重仍成立 */
  const exported = store.read();
  const copied = new WorkbenchStore(':memory:');
  copied.import(exported);
  assert.equal(copied.read().plans.length, exported.plans.length);
  assert.equal(copied.read().tasks.find(task => task.id === cat!.id)?.originalText, '快没猫粮了');
  assert.equal(captureAssistantTasks(copied, SESSION, capture).entries.every(item => item.alreadyCaptured), true,
    '恢复导出后同一会话重试不能重复创建待办');
  assert.equal(copied.read().tasks.length, exported.tasks.length);
  copied.close();

  /* 重启后：确认过的排期与幂等键都还在 */
  const reopened = new WorkbenchStore(dbPath);
  assert.equal(reopened.read().plans.length, exported.plans.length);
  assert.equal(reopened.read().tasks.find(task => task.id === fee!.id)?.due, '2026-10-02');
  assert.equal(captureAssistantTasks(reopened, SESSION, capture).entries.every(item => item.alreadyCaptured), true,
    '同一会话的幂等绑定须跨数据库重启保留');
  reopened.close();

  /* 旧导出 JSON：works 并入 tasks、lifePlans 改挂 plans，冲突 id 重生成，时段冲突 409 */
  const beforeLegacyImport = JSON.stringify(store.read());
  const conflictingImport = {
    profile: { name: '我' },
    tasks: [{ id: 'import-task-0001', title: '导入前的待办', plannedDate: '2026-11-02', startTime: '09:00', endTime: '10:00', kind: 'fixed', done: false, due: null, priority: 'normal', tag: '' }],
    works: [{ id: 'import-work-0001', title: '时段冲突的旧工作', status: 'todo', scheduledDate: '2026-11-02', startTime: '09:30', endTime: '10:30' }],
  };
  assert.equal((await post('/import', conflictingImport)).status, 409, '旧工作并入待办后仍要过时段冲突校验');
  assert.equal(JSON.stringify(store.read()), beforeLegacyImport, '被拒的导入不得留下半截数据');

  const legacyExport = {
    profile: { name: '我', motto: '旧导出' },
    tasks: [{ id: 'import-task-0001', title: '导入前的待办', done: false, due: null, priority: 'normal', tag: '' }],
    works: [
      { id: 'import-task-0001', title: 'id 冲突的旧工作', status: 'done', scheduledDate: '2026-11-02', startTime: '09:00', endTime: '10:00', tags: ['汇报'] },
      { id: 'import-work-0002', title: '没有排期的旧工作', status: 'todo' },
    ],
    lifePlans: [{
      id: 'import-plan-0001', title: '安排建议', sourceSessionId: SESSION, planKey: 'imported-plan',
      entries: [{ taskId: 'import-task-0001', expectedUpdatedAt: '2026-10-01T00:00:00.000Z', plannedDate: '2026-11-03' }],
      note: '旧方案', appliedAt: null,
    }],
  };
  assert.equal((await post('/import', legacyExport)).status, 200);
  const importedState = store.read();
  assert.equal(importedState.profile.motto, '旧导出');
  assert.equal(importedState.tasks.length, 3);
  assert.equal(importedState.plans.length, 1, 'lifePlans 键必须并入 plans');
  assert.equal(importedState.plans[0]?.planKey, 'imported-plan');
  assert.equal(importedState.plans[0]?.sourceSessionId, SESSION);
  assert.equal(importedState.tasks.find(task => task.id === 'import-task-0001')?.title, '导入前的待办');
  const importedConflict = importedState.tasks.find(task => task.title === 'id 冲突的旧工作')!;
  assert.notEqual(importedConflict.id, 'import-task-0001', '并入时 id 冲突必须重新生成');
  assert.match(importedConflict.id, /^[0-9a-f-]{36}$/);
  assert.equal(importedConflict.done, true, 'works 的 status 映射到 done');
  assert.equal(importedConflict.plannedDate, '2026-11-02', 'scheduledDate 映射到 plannedDate');
  assert.equal(importedConflict.startTime, '09:00');
  assert.equal(importedConflict.endTime, '10:00');
  assert.equal(importedConflict.kind, 'fixed', '带时段的旧工作视为固定安排');
  assert.equal(importedConflict.tag, '汇报');
  assert.equal(importedConflict.due, null);
  const importedUndated = importedState.tasks.find(task => task.title === '没有排期的旧工作')!;
  assert.equal(importedUndated.plannedDate, null);
  assert.equal(importedUndated.startTime, null);
  assert.equal(importedUndated.kind, 'flexible');
  assert.equal(importedUndated.done, false);

  /* 旧库迁移：works → tasks、lifePlans → plans、绑定表删除、重复打开幂等 */
  migrateLegacyModules();

  /* 工具名：配置名到 pi 工具名的映射精确且唯一 */
  assert.deepEqual(ASSISTANT_TOOL_NAMES, {
    'assistant.context': 'assistant_context',
    'assistant.capture': 'assistant_capture',
    'assistant.proposePlan': 'assistant_propose_plan',
  });
  const tools = createAssistantTools({ store, limits: { maxToolOutputChars: 24000 } });
  assert.deepEqual(tools.map(tool => tool.name), ['assistant_context', 'assistant_capture', 'assistant_propose_plan']);
  console.log('assistant plans: capture idempotence, draft/apply/discard lifecycle, write guards, legacy migration and import OK');
} finally {
  server.close();
  try { store.close(); } catch { /* already closed */ }
  rmSync(directory, { recursive: true, force: true });
}

/** 预置旧库（works / lifePlans / works_schedule_entries），验证启动迁移与幂等。 */
function migrateLegacyModules(): void {
  const legacyDir = mkdtempSync(join(tmpdir(), 'pi-webx-assistant-migrate-'));
  const legacyPath = join(legacyDir, 'legacy.sqlite');
  try {
    new WorkbenchStore(legacyPath).close();
    const stamp = '2026-10-01T02:00:00.000Z';
    const raw = new Database(legacyPath);
    raw.exec(`CREATE TABLE works_schedule_entries (
      session_id TEXT NOT NULL, entry_key TEXT NOT NULL, work_id TEXT NOT NULL,
      PRIMARY KEY (session_id, entry_key)
    )`);
    const insert = raw.prepare('INSERT INTO workbench_records (module, id, payload) VALUES (?, ?, ?)');
    insert.run('tasks', 'shared-legacy-id', JSON.stringify({
      id: 'shared-legacy-id', title: '迁移前就存在的待办', done: false, due: null,
      priority: 'normal', tag: '', createdAt: stamp, updatedAt: stamp,
    }));
    insert.run('works', 'legacy-work-0001', JSON.stringify({
      id: 'legacy-work-0001', title: '旧工作（带时段）', status: 'done', scheduledDate: '2026-10-05',
      startTime: '09:00', endTime: '10:30', note: '从旧工作助理迁入', tags: ['汇报'], refs: [],
      createdAt: '2026-09-30T02:00:00.000Z', updatedAt: stamp,
    }));
    insert.run('works', 'legacy-work-0002', JSON.stringify({
      id: 'legacy-work-0002', title: '旧工作（无排期）', status: 'todo',
    }));
    insert.run('works', 'shared-legacy-id', JSON.stringify({
      id: 'shared-legacy-id', title: '旧工作（id 冲突）', status: 'done',
      scheduledDate: '2026-10-06', startTime: '09:00', endTime: '10:00', tags: [],
    }));
    insert.run('lifePlans', 'legacy-plan-0001', JSON.stringify({
      id: 'legacy-plan-0001', title: '安排建议', sourceSessionId: 'legacy-session-1', planKey: 'legacy-plan',
      entries: [{ taskId: 'legacy-work-0002', expectedUpdatedAt: stamp, plannedDate: '2026-10-07', startTime: null, endTime: null }],
      note: '旧方案', appliedAt: null, createdAt: stamp, updatedAt: stamp,
    }));
    raw.prepare('INSERT INTO works_schedule_entries (session_id, entry_key, work_id) VALUES (?, ?, ?)')
      .run('legacy-session-1', 'legacy-plan', 'legacy-work-0001');
    raw.close();

    const migrated = new WorkbenchStore(legacyPath);
    const state = migrated.read();
    assert.equal(state.tasks.length, 4, 'works 记录必须全部并入 tasks');
    assert.equal(state.plans.length, 1, 'lifePlans 记录必须改挂 plans');
    assert.equal(state.plans[0]?.id, 'legacy-plan-0001');
    assert.equal(state.plans[0]?.note, '旧方案');

    const scheduled = state.tasks.find(task => task.id === 'legacy-work-0001')!;
    assert.equal(scheduled.title, '旧工作（带时段）');
    assert.equal(scheduled.plannedDate, '2026-10-05', 'scheduledDate 必须映射到 plannedDate');
    assert.equal(scheduled.startTime, '09:00');
    assert.equal(scheduled.endTime, '10:30');
    assert.equal(scheduled.kind, 'fixed', '带时段的旧工作迁移为固定安排');
    assert.equal(scheduled.done, true, 'status=done 映射为已完成待办');
    assert.equal(scheduled.doneAt, stamp);
    assert.equal(scheduled.due, null);
    assert.equal(scheduled.note, '从旧工作助理迁入');
    assert.equal(scheduled.tag, '汇报');
    assert.equal(scheduled.updatedAt, stamp, '迁移必须保留原版本时间');

    const unscheduled = state.tasks.find(task => task.id === 'legacy-work-0002')!;
    assert.equal(unscheduled.plannedDate, null);
    assert.equal(unscheduled.startTime, null);
    assert.equal(unscheduled.endTime, null);
    assert.equal(unscheduled.kind, 'flexible');
    assert.equal(unscheduled.done, false);
    assert.equal(unscheduled.doneAt, null);

    assert.equal(state.tasks.find(task => task.id === 'shared-legacy-id')?.title, '迁移前就存在的待办');
    const conflicted = state.tasks.find(task => task.title === '旧工作（id 冲突）')!;
    assert.notEqual(conflicted.id, 'shared-legacy-id', '与现有待办 id 冲突时必须重新生成');
    assert.match(conflicted.id, /^[0-9a-f-]{36}$/);
    assert.equal(conflicted.done, true);

    const idSnapshot = state.tasks.map(task => task.id).sort();
    migrated.close();
    const inspected = new Database(legacyPath, { readonly: true });
    const modules = (inspected.prepare('SELECT DISTINCT module FROM workbench_records ORDER BY module').all() as Array<{ module: string }>)
      .map(row => row.module);
    assert.deepEqual(modules, ['plans', 'tasks'], '旧模块键必须清空');
    assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'works_schedule_entries'").get(), undefined,
      'works 的幂等绑定表必须删除');
    inspected.close();

    const again = new WorkbenchStore(legacyPath);
    assert.deepEqual(again.read().tasks.map(task => task.id).sort(), idSnapshot, '重复打开不得重复迁移或换 id');
    assert.equal(again.read().tasks.length, 4);
    assert.equal(again.read().plans.length, 1);
    again.close();
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }
}
