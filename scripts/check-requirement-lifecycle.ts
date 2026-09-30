import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { WorkbenchStore } from '../server/workbench/store';
import { createWorkbenchRouter } from '../server/workbench/router';
import { getChatroomService, type ChatroomService } from '../server/modules/chatroom/service';
import { saveRequirementDraft, importRequirementTasks } from '../server/modules/requirements/import-tasks';
import { agentFailureDetail } from '../server/module-agents/failures';
import { linkRequirementEntity, readRequirementTrace, type RequirementTrace } from '../server/modules/requirements/lifecycle';

const directory = mkdtempSync(join(tmpdir(), 'pi-webx-requirement-lifecycle-'));
const dbPath = join(directory, 'workbench.sqlite');
const legacyPath = join(directory, 'historical.sqlite');
let store = new WorkbenchStore(dbPath);
let server: ReturnType<express.Express['listen']> | undefined;

type Requirement = { id: string; updatedAt: unknown };

/** Metadata-only fixture: rows are valid and linked, but no model or external tool ran. */
async function fixtureRun(room: ChatroomService, requirement: Requirement, sourceSession: string,
  suffix: string): Promise<{ runId: string; toolCallId: string }> {
  const sent = room.send('requirements', sourceSession, { to: 'codes', body: `核对 fixture ${suffix}`,
    entryKey: `fixture-handoff-${suffix}`, requirementId: requirement.id,
    expectedUpdatedAt: String(requirement.updatedAt) });
  const message = room.storage.claim(sent.id);
  assert.ok(message);
  const sessionId = `fixture-codes-${suffix}`;
  room.prepareConsumptions(message.id, ['codes']);
  room.work.bindSession(message, 'codes', sessionId);
  const run = room.work.beginRun(message, 'codes', sessionId);
  const toolCallId = `fixture-tool-${suffix}`;
  room.work.markToolStart(run.id, toolCallId, 'read');
  room.work.markToolEnd(run.id, toolCallId, false,
    { resultHash: 'a'.repeat(64), resultBytes: 7, exitCode: 0 });
  room.updateConsumption(message.id, 'codes', 'processing');
  await room.withDelivery(sessionId, message, 'codes', async () => {
    room.publishReply('codes', sessionId, { body: `fixture metadata ${suffix}`, entryKey: `answer-${suffix}` });
  });
  room.work.finishRun(run.id, 'succeeded', { lastProcessedSeq: message.seq,
    checkpoint: 'fixture metadata only; no model execution' });
  room.updateConsumption(message.id, 'codes', 'consumed');
  room.storage.settle(message.id, 'delivered', null);
  return { runId: run.id, toolCallId };
}

try {
  const draft = saveRequirementDraft(store, 'fixture-requirements-A', {
    title: '建立可追溯的需求', note: '验收：待办完成并保留执行证据。',
    taskDrafts: [{ title: '完成实现' }],
  });
  let trace = readRequirementTrace(store, draft.id);
  const humanId = trace.humanId;
  assert.match(humanId, /^REQ-\d{6}$/);
  assert.deepEqual([trace.requirementId, trace.requirementVersion, trace.stage, trace.archived],
    [draft.id, 1, 'draft', false]);
  assert.equal(trace.events.some(event => event.type === 'requirement.created'), true);
  assert.equal(readRequirementTrace(store, humanId, 'human').requirementId, draft.id);
  const edited = store.updateRecord('requirements', draft.id, { note: '验收：实现、测试和证据都可核对。' });
  trace = readRequirementTrace(store, draft.id);
  assert.equal(trace.requirementVersion, 2);
  assert.equal(trace.humanId, humanId, 'human-readable REQ identity is stable across edits');

  const imported = importRequirementTasks(store, draft.id, { expectedUpdatedAt: edited.updatedAt });
  assert.equal(imported.tasks.length, 1);
  assert.deepEqual(imported.tasks[0]?.refs, [{ type: 'requirements', id: draft.id }]);
  trace = readRequirementTrace(store, draft.id);
  assert.equal(trace.requirementVersion, 2, 'import bookkeeping keeps the same content revision');
  assert.equal(trace.stage, 'ready');
  assert.equal(trace.links.tasks.some(task => task.id === imported.tasks[0]?.id), true);
  assert.equal(trace.events.some(event => event.type === 'requirement.tasks_imported'), true);
  const task = imported.tasks[0]!;
  const completed = { ...task, done: true, doneAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.sqlite.prepare("UPDATE workbench_records SET payload=? WHERE module='tasks' AND id=?")
    .run(JSON.stringify(completed), task.id);
  trace = readRequirementTrace(store, draft.id);
  assert.equal(trace.links.tasks.find(item => item.id === task.id)?.done, true);
  assert.equal(trace.events.some(event => event.type === 'task.completed'), true,
    'direct SQL task completion is captured by the mutation journal');

  const other = saveRequirementDraft(store, 'fixture-requirements-B', {
    title: '第二个需求', note: '独立来源', taskDrafts: [{ title: '第二个待办' }],
  });
  const room = getChatroomService(store);
  const firstRun = await fixtureRun(room, imported.requirement as Requirement, 'fixture-requirements-A', 'A');
  const otherRun = await fixtureRun(room, other, 'fixture-requirements-B', 'B');
  trace = readRequirementTrace(store, draft.id);
  assert.equal(trace.links.runs.some(run => run.id === firstRun.runId && run.recorded === true
    && run.requirementVersion === trace.requirementVersion && run.status === 'succeeded'), true);
  assert.equal(trace.links.tools.some(tool => tool.runId === firstRun.runId
    && tool.toolCallId === firstRun.toolCallId && tool.recorded === true && tool.status === 'succeeded'), true);
  assert.equal(trace.links.runs.some(run => run.id === otherRun.runId), false);

  assert.equal(agentFailureDetail('Stream ended without finish_reason; hidden token').category,
    'provider_stream_incomplete');
  assert.equal(agentFailureDetail('No API key found: sk-secret-value').summary, '模型认证不可用');
  const prepVersion = trace.requirementVersion;
  const prepRows = [
    { id: 'fixture-prep-failed', status: 'failed', session: 'fixture-old-session', attempt: 1,
      error: 'Stream ended without finish_reason' },
    { id: 'fixture-prep-retried', status: 'succeeded', session: 'fixture-new-session', attempt: 2, error: null },
  ];
  for (const prep of prepRows) {
    store.sqlite.prepare(`INSERT INTO chatroom_work_runs
      (workspace_key,id,task_id,assignment_id,requirement_id,requirement_version,thread_id,agent_id,
       session_id,message_id,attempt,status,error,started_at,finished_at)
      VALUES ('default',?,'fixture-prep-task',NULL,?,?,'fixture-prep-thread','assistant',?,?,?, ?,?,?,?)`)
      .run(prep.id,draft.id,prepVersion,prep.session,`message-${prep.id}`,prep.attempt,prep.status,prep.error,
        '2026-09-30T08:00:00Z','2026-09-30T08:01:00Z');
    linkRequirementEntity(store,draft.id,{kind:'chatroom_run',id:prep.id,requirementVersion:prepVersion,
      refs:{taskId:'fixture-prep-task',agentId:'assistant'}});
  }
  const recovered = readRequirementTrace(store,draft.id);
  assert.equal(recovered.links.runs.find(run=>run.id==='fixture-prep-failed')?.failureCategory,
    'provider_stream_incomplete');
  assert.ok(!recovered.blockers.includes('最新执行仍处于失败、中断或取消状态'),
    'same logical task retry can supersede an earlier prep failure even if its Session changes');

  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter(store));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof Error && 'status' in error ? Number(error.status) : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/workbench`;
  const firstTrace = await fetch(`${base}/requirements/${humanId}/trace`);
  assert.equal(firstTrace.status, 200);
  const cookie = firstTrace.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith('pi_webx_requirement_reviewer='));
  assert.equal((await firstTrace.json() as RequirementTrace).requirementId, draft.id);
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie! }, body: JSON.stringify(body),
  });
  const current = readRequirementTrace(store, draft.id);
  const submission = { expectedUpdatedAt: current.requirement.updatedAt,
    expectedRequirementVersion: current.requirementVersion, summary: '元数据 fixture 交付',
    evidence: [{ kind: 'test', ref: 'fixture://test-result', runId: firstRun.runId,
      toolCallId: firstRun.toolCallId }], runIds: [firstRun.runId] };
  const noRun = await post(`/requirements/${draft.id}/deliveries`, {
    ...submission, entryKey: 'no-run', evidence: [{ kind: 'file', ref: 'fixture://reported-only' }], runIds: [],
  });
  assert.equal(noRun.status, 201);
  const noRunDelivery = (await noRun.json() as { delivery: { id: string; updatedAt: string } }).delivery;
  assert.equal((await post(`/requirements/${draft.id}/deliveries/${noRunDelivery.id}/review`, {
    decision: 'accept', expectedUpdatedAt: noRunDelivery.updatedAt, entryKey: 'accept-no-run',
  })).status, 409, 'reported evidence without an actual Run row cannot be accepted');
  assert.equal((await post(`/requirements/${draft.id}/deliveries`, { ...submission,
    entryKey: 'forged-actor', actor: 'codes' })).status, 400);
  assert.equal((await post(`/requirements/${draft.id}/deliveries`, { ...submission,
    entryKey: 'old-updated-at', expectedUpdatedAt: edited.updatedAt })).status, 409);
  assert.equal((await post(`/requirements/${draft.id}/deliveries`, { ...submission,
    entryKey: 'old-number', expectedRequirementVersion: current.requirementVersion - 1 })).status, 409);
  assert.equal((await post(`/requirements/${draft.id}/deliveries`, { ...submission,
    entryKey: 'foreign-run', runIds: [otherRun.runId] })).status, 409);
  assert.equal((await post(`/requirements/${draft.id}/deliveries`, { ...submission,
    entryKey: 'foreign-tool', evidence: [{ kind: 'test', ref: 'fixture://foreign-tool',
      runId: firstRun.runId, toolCallId: otherRun.toolCallId }] })).status, 409);

  const submittedResponse = await post(`/requirements/${draft.id}/deliveries`,
    { ...submission, entryKey: 'valid-submission' });
  assert.equal(submittedResponse.status, 201);
  const submitted = (await submittedResponse.json() as { delivery: { id: string; updatedAt: string;
    evidence: Array<{ verification: string }> } }).delivery;
  assert.equal(submitted.evidence[0]?.verification, 'observed');
  const duplicate = await post(`/requirements/${draft.id}/deliveries`,
    { ...submission, entryKey: 'valid-submission' });
  assert.equal((await duplicate.json() as { delivery: { id: string } }).delivery.id, submitted.id);
  assert.equal((await post(`/requirements/${draft.id}/deliveries`, {
    ...submission, entryKey: 'valid-submission', summary: 'changed replay',
  })).status, 409);
  const reviewPath = `/requirements/${draft.id}/deliveries/${submitted.id}/review`;
  assert.equal((await post(reviewPath, { decision: 'accept', expectedUpdatedAt: submitted.updatedAt,
    entryKey: 'forged-review', actor: 'codes' })).status, 400);
  const [reviewA, reviewB] = await Promise.all([
    post(reviewPath, { decision: 'accept', expectedUpdatedAt: submitted.updatedAt, entryKey: 'review-a' }),
    post(reviewPath, { decision: 'accept', expectedUpdatedAt: submitted.updatedAt, entryKey: 'review-b' }),
  ]);
  assert.deepEqual([reviewA.status, reviewB.status].sort(), [200, 409], 'only one concurrent review wins');
  const acceptedKey = reviewA.status === 200 ? 'review-a' : 'review-b';
  const acceptedResponse = reviewA.status === 200 ? reviewA : reviewB;
  const accepted = (await acceptedResponse.json() as { delivery: { id: string; status: string;
    reviews: unknown[] } }).delivery;
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.reviews.length, 1);
  assert.equal((await post(reviewPath, { decision: 'accept', expectedUpdatedAt: submitted.updatedAt,
    entryKey: acceptedKey })).status, 200, 'same review entryKey is idempotent');
  assert.equal(readRequirementTrace(store, draft.id).stage, 'delivered');

  const deliveredVersion = readRequirementTrace(store, draft.id).requirementVersion;
  store.updateRecord('requirements', draft.id, { starred: true });
  const starred = readRequirementTrace(store, draft.id);
  assert.equal(starred.requirementVersion, deliveredVersion,
    'starred metadata changes are traced without invalidating the content revision');
  assert.equal(starred.stage, 'delivered', 'accepted delivery survives a metadata-only edit');

  const pendingOldResponse = await post(`/requirements/${draft.id}/deliveries`,
    { ...submission, entryKey: 'old-version-submission',
      expectedUpdatedAt: starred.requirement.updatedAt });
  assert.equal(pendingOldResponse.status, 201);
  const pendingOld = (await pendingOldResponse.json() as { delivery: { id: string; updatedAt: string } }).delivery;
  store.updateRecord('requirements', draft.id, { note: '验收范围有实质修订' });
  const revised = readRequirementTrace(store, draft.id);
  assert.ok(revised.requirementVersion > deliveredVersion, 'content edit starts a new requirement revision');
  assert.notEqual(revised.stage, 'delivered', 'old acceptance does not follow a content revision');
  assert.equal((await post(`/requirements/${draft.id}/deliveries/${pendingOld.id}/review`, {
    decision: 'accept', expectedUpdatedAt: pendingOld.updatedAt, entryKey: 'accept-stale-evidence',
  })).status, 409);
  const beforeImport = readRequirementTrace(store, draft.id);
  const exported = store.read();
  const importedRecord = exported.requirements.find(row => row.id === draft.id)!;
  const stableUpdatedAt = importedRecord.updatedAt;
  importedRecord.title = '导入替换后的新内容';
  store.import(exported);
  trace = readRequirementTrace(store, draft.id);
  assert.equal(trace.requirement.updatedAt, stableUpdatedAt);
  assert.equal(trace.requirement.title, '导入替换后的新内容');
  assert.ok(trace.requirementVersion > beforeImport.requirementVersion,
    'same updatedAt and same ID with different content is a new numeric revision');
  assert.equal(trace.humanId, humanId);
  assert.notEqual(trace.stage, 'delivered', 'accepted old version is not inherited by a newer revision');
  assert.equal((await post(`/requirements/${draft.id}/deliveries`, { ...submission,
    entryKey: 'reuse-old-run', expectedRequirementVersion: trace.requirementVersion })).status, 409);

  const rollbackDraft = saveRequirementDraft(store, 'fixture-rollback', {
    title: '回滚检查', note: '任何失败不应留下部分任务', taskDrafts: [{ title: '会失败的导入' }],
  });
  const rollbackBefore = readRequirementTrace(store, rollbackDraft.id);
  const mutationCount = (store.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_mutations').get() as { n: number }).n;
  const taskCount = store.listRecords('tasks').length;
  store.sqlite.exec(`CREATE TRIGGER reject_lifecycle_fixture BEFORE INSERT ON workbench_records
    WHEN NEW.module='tasks' BEGIN SELECT RAISE(ABORT,'fixture task insert failure'); END`);
  assert.throws(() => importRequirementTasks(store, rollbackDraft.id,
    { expectedUpdatedAt: rollbackDraft.updatedAt }), /fixture task insert failure/);
  store.sqlite.exec('DROP TRIGGER reject_lifecycle_fixture');
  const rollbackAfter = readRequirementTrace(store, rollbackDraft.id);
  assert.equal(store.listRecords('tasks').length, taskCount);
  assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_mutations').get() as { n: number }).n,
    mutationCount, 'journal rows roll back with business data');
  assert.deepEqual(rollbackAfter.events, rollbackBefore.events,
    'projection adds no trace event for rolled-back business writes');

  await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
  assert.equal(store.removeRecord('requirements', draft.id), true);
  const deleted = readRequirementTrace(store, draft.id);
  assert.equal(deleted.archived, true);
  assert.equal(deleted.stage, 'deleted');
  assert.equal(deleted.events.some(event => event.type === 'requirement.deleted'), true);
  store.close();
  store = new WorkbenchStore(dbPath);
  const reopened = readRequirementTrace(store, draft.id);
  assert.equal(reopened.archived, true);
  assert.equal(reopened.humanId, humanId);
  assert.equal(reopened.requirementVersion, deleted.requirementVersion);
  assert.equal(reopened.deliveries.some(delivery => delivery.status === 'accepted'), true);

  const legacy = new Database(legacyPath);
  legacy.exec(`CREATE TABLE workbench_records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL, id TEXT NOT NULL,
    payload TEXT NOT NULL, UNIQUE(module,id)
  )`);
  const oldPayload = JSON.stringify({ id: 'historical-req', title: '存量需求',
    createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' });
  legacy.prepare('INSERT INTO workbench_records(module,id,payload) VALUES (?,?,?)')
    .run('requirements', 'historical-req', oldPayload);
  legacy.close();
  const oldStore = new WorkbenchStore(legacyPath);
  try {
    const historical = readRequirementTrace(oldStore, 'historical-req');
    assert.equal(historical.coverage.historical, true);
    assert.ok(historical.coverage.warnings.some(warning => warning.includes('无法还原')));
    const baseline = historical.events.find(event => event.type === 'requirement.historical');
    assert.equal(baseline?.time, null, 'baseline does not invent a historical event timestamp');
    assert.equal(historical.requirement.updatedAt, '2024-01-01T00:00:00.000Z');
  } finally { oldStore.close(); }

  const collision = new WorkbenchStore(join(directory, 'collision.sqlite'));
  try {
    const original = collision.addRecord('requirements', { title: '序号一的真实需求' });
    assert.equal(readRequirementTrace(collision, original.id, 'id').humanId, 'REQ-000001');
    const replacement = collision.read();
    replacement.requirements.push({ ...original, id: 'REQ-000001', title: '恰好撞名的原始 ID',
      updatedAt: new Date(Date.parse(String(original.updatedAt)) + 1000).toISOString() });
    collision.import(replacement);
    const byId = readRequirementTrace(collision, 'REQ-000001', 'id');
    const byHuman = readRequirementTrace(collision, 'REQ-000001', 'human');
    assert.deepEqual([byId.requirementId, byHuman.requirementId], ['REQ-000001', original.id]);
    assert.throws(() => readRequirementTrace(collision, 'REQ-000001', 'auto'), /冲突/);
    assert.equal(readRequirementTrace(collision, 'REQ-000001').requirementId, 'REQ-000001',
      'internal exact lookup cannot be shadowed by the display number');
    const collisionApp = express();
    collisionApp.use(express.json());
    collisionApp.use('/api/workbench', createWorkbenchRouter(collision));
    server = collisionApp.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const collisionAddress = server.address();
    assert.ok(collisionAddress && typeof collisionAddress !== 'string');
    const collisionBase = `http://127.0.0.1:${collisionAddress.port}/api/workbench/requirements`;
    const ambiguousResponse = await fetch(`${collisionBase}/REQ-000001/trace`);
    assert.equal(ambiguousResponse.status, 409);
    assert.match((await ambiguousResponse.json() as { error: string }).error, /id:原始ID.*req:编号/);
    const idTrace = await fetch(`${collisionBase}/REQ-000001/trace?lookup=id`);
    const humanTrace = await fetch(`${collisionBase}/REQ-000001/trace?lookup=human`);
    assert.equal(idTrace.status, 200);
    assert.equal(humanTrace.status, 200);
    assert.equal((await idTrace.json() as RequirementTrace).requirementId, 'REQ-000001');
    assert.equal((await humanTrace.json() as RequirementTrace).requirementId, original.id);
    assert.equal((await fetch(`${collisionBase}/REQ-000001/trace?lookup=legacy`)).status, 400);
    assert.equal((await fetch(`${collisionBase}/REQ-000001/trace?extra=1`)).status, 400);
    const postCollision = (id: string, body: unknown) => fetch(`${collisionBase}/${encodeURIComponent(id)}/deliveries`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const collisionPayload = { entryKey: 'canonical-collision', summary: '仅验证路由归属',
      expectedUpdatedAt: byId.requirement.updatedAt, expectedRequirementVersion: byId.requirementVersion,
      evidence: [{ kind: 'file', ref: 'fixture://collision' }], runIds: [] };
    const canonical = await postCollision('REQ-000001', collisionPayload);
    assert.equal(canonical.status, 201);
    const canonicalDelivery = await canonical.json() as { trace: RequirementTrace; delivery: { id: string; updatedAt: string } };
    assert.equal(canonicalDelivery.trace.requirementId, 'REQ-000001');
    assert.equal((await postCollision('REQ-000001', { ...collisionPayload, entryKey: 'wrong-root',
      expectedUpdatedAt: byHuman.requirement.updatedAt,
      expectedRequirementVersion: byHuman.requirementVersion })).status, 409,
    'display-number intent cannot silently write the colliding raw-ID root');
    assert.equal((await postCollision('REQ-000002', { ...collisionPayload,
      entryKey: 'human-write' })).status, 404, 'write routes never resolve a human alias');
    const firstCanonical = await postCollision(original.id, { ...collisionPayload,
      entryKey: 'uuid-write', expectedUpdatedAt: byHuman.requirement.updatedAt,
      expectedRequirementVersion: byHuman.requirementVersion });
    assert.equal(firstCanonical.status, 201);
    assert.equal((await firstCanonical.json() as { trace: RequirementTrace }).trace.requirementId, original.id);
    const aliasReview = await fetch(`${collisionBase}/REQ-000002/deliveries/${canonicalDelivery.delivery.id}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', expectedUpdatedAt: canonicalDelivery.delivery.updatedAt,
        entryKey: 'alias-review' }),
    });
    assert.equal(aliasReview.status, 404, 'review also requires the canonical requirement ID');
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  } finally { collision.close(); }
  console.log('PASS requirement lifecycle metadata fixture: SQL/HTTP versions, evidence, review, tombstone and rollback');
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  try { store.close(); } catch { /* already closed */ }
  rmSync(directory, { recursive: true, force: true });
}
