import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AgentId } from '../server/module-agents/contracts';
import type { ChatroomMessage } from '../server/modules/chatroom/contracts';
import { createChatroomRouter } from '../server/modules/chatroom/router';
import { getChatroomService } from '../server/modules/chatroom/service';
import { WorkbenchStore } from '../server/workbench/store';

const directory = mkdtempSync(join(tmpdir(), 'pi-webx-chatroom-work-'));
const dbPath = join(directory, 'workbench.sqlite');
let store = new WorkbenchStore(dbPath);
let room = getChatroomService(store);
const userKey = room.ensureUserSession();

function claim(message: ChatroomMessage): ChatroomMessage {
  const claimed = room.storage.claim(message.id);
  assert.ok(claimed);
  return claimed;
}

async function turn(message: ChatroomMessage, agentId: AgentId, sessionId: string,
  act: () => void): Promise<void> {
  const claimed = claim(message);
  room.prepareConsumptions(message.id, [agentId]);
  room.work.bindSession(claimed, agentId, sessionId);
  const run = room.work.beginRun(claimed, agentId, sessionId);
  room.updateConsumption(message.id, agentId, 'processing');
  await room.withDelivery(sessionId, claimed, agentId, async () => {
    act();
    room.publishReply(agentId, sessionId, { body: '已记录当前回合。', entryKey: `answer:${message.id}` });
  });
  room.work.finishRun(run.id, 'succeeded', { lastProcessedSeq: message.seq });
  room.updateConsumption(message.id, agentId, 'consumed');
  room.storage.settle(message.id, 'delivered', null);
}

try {
  const first = room.sendUser(userKey, { body: '@需求管理 设计并落实接口', entryKey: 'initial' });
  let taskA = '';
  let handoff!: ChatroomMessage;
  await turn(first, 'requirements', 'req-work-session', () => {
    const accepted = room.work.accept('req-work-session', 'requirements',
      { action: 'accept', title: '设计并落实接口', entryKey: 'accept-a' });
    taskA = accepted.id;
    handoff = room.send('requirements', 'req-work-session',
      { to: 'codes', body: '实现接口', entryKey: 'handoff-codes' });
  });
  assert.equal(room.work.publicTask(taskA)?.status, 'running', '消费成功不等于任务完成');
  assert.equal(room.work.getBinding(first, 'requirements').sessionId, null,
    '工作认领后清空讨论会话绑定');
  const linked = room.storage.sqlite.prepare(`SELECT parent_run_id FROM chatroom_work_handoffs
    WHERE workspace_key = ? AND message_id = ?`).get('default', handoff.id) as { parent_run_id: string } | undefined;
  assert.ok(linked?.parent_run_id, 'handoff and parent run are committed together');
  assert.equal(handoff.context.collaborationTaskId, taskA);

  await turn(handoff, 'codes', 'codes-work-session', () => {
    const joined = room.work.accept('codes-work-session', 'codes',
      { action: 'accept', title: '实现接口', entryKey: 'join-a' });
    assert.equal(joined.id, taskA, 'target agent joins inherited task');
  });
  assert.deepEqual(room.work.publicTask(taskA)?.assignments.map(item => item.agentId), ['requirements', 'codes']);
  assert.equal(room.work.getBinding(handoff, 'codes').sessionId, 'codes-work-session');

  const beforeProgressVersion = room.work.publicTask(taskA)!.version;
  const progress = room.sendUser(userKey, { body: '@需求管理 补充进度', entryKey: 'progress-version',
    threadId: first.threadId, collaborationTaskId: taskA });
  await turn(progress, 'requirements', 'req-work-session', () => {
    room.work.update('req-work-session', 'requirements', { action: 'update', taskId: taskA,
      status: 'waiting_for_user', summary: '等待补充，代码成员仍在工作', entryKey: 'progress-version-update' });
  });
  assert.equal(room.work.publicTask(taskA)?.status, 'running', '其他成员仍工作时聚合状态保持 running');
  assert.ok(room.work.publicTask(taskA)!.version > beforeProgressVersion,
    '成员摘要及状态变化即使不改变聚合状态也使旧任务版本失效');
  await assert.rejects(room.taskAction(userKey, taskA, { action: 'cancel', entryKey: 'stale-progress-cancel',
    expectedVersion: beforeProgressVersion }), /状态已变化/);

  const second = room.sendUser(userKey, { body: '@需求管理 设计另一个需求',
    entryKey: 'second', threadId: first.threadId });
  assert.equal(room.work.getBinding(second, 'requirements').scope, 'discussion',
    'same-thread conversation without a unique task returns to discussion');
  assert.equal(room.work.getBinding(second, 'requirements').sessionId, null);
  let taskB = '';
  await turn(second, 'requirements', 'req-second-session', () => {
    taskB = room.work.accept('req-second-session', 'requirements',
      { action: 'accept', title: '另一个需求', entryKey: 'accept-b' }).id;
  });
  assert.notEqual(taskA, taskB);
  const taskMessage = room.sendUser(userKey, { body: '@需求管理 补充第一个任务', entryKey: 'task-a-followup',
    threadId: first.threadId, collaborationTaskId: taskA });
  assert.deepEqual([room.work.getBinding(taskMessage, 'requirements').scope,
    room.work.getBinding(taskMessage, 'requirements').sessionId], ['assignment', 'req-work-session']);
  assert.equal(room.work.getBinding(taskMessage, 'codes').sessionId, 'codes-work-session');
  assert.equal(room.historySince(first.threadId, first.seq, taskMessage.seq).at(-1)?.id, taskMessage.id);

  const interrupted = claim(taskMessage);
  room.work.bindSession(interrupted, 'requirements', 'req-work-session');
  const uncertain = room.work.beginRun(interrupted, 'requirements', 'req-work-session');
  room.work.markToolStart(uncertain.id, 'write-1', 'write');
  const unknownB = room.sendUser(userKey, { body: '@需求管理 第二任务结果待核对', entryKey: 'unknown-b',
    threadId: first.threadId, collaborationTaskId: taskB });
  const claimedUnknownB = claim(unknownB);
  room.work.bindSession(claimedUnknownB, 'requirements', 'req-second-session');
  const uncertainB = room.work.beginRun(claimedUnknownB, 'requirements', 'req-second-session');
  room.work.markToolStart(uncertainB.id, 'write-b', 'write');
  store.close();
  store = new WorkbenchStore(dbPath);
  room = getChatroomService(store);
  assert.equal(room.work.getRun(uncertain.id)?.status, 'needs_review');
  assert.equal(room.work.publicTask(taskA)?.status, 'needs_review');
  assert.equal(room.work.publicTask(taskB)?.needsReview, true);
  assert.equal(room.storage.byId(taskMessage.id)?.deliveryStatus, 'failed');
  assert.throws(() => room.work.beginRun(room.storage.byId(taskMessage.id)!, 'requirements', 'req-work-session'),
    /核对/, 'old side effects are never replayed');
  assert.throws(() => room.sendUser(userKey, { body: '@需求管理 直接续做', entryKey: 'unreviewed',
    threadId: first.threadId, collaborationTaskId: taskA }), /恢复/);
  const ambiguous = room.sendUser(userKey, { body: '@需求管理 同话题另聊',
    entryKey: 'ambiguous-after-uncertain', threadId: first.threadId });
  assert.equal(room.work.getBinding(ambiguous, 'requirements').needsReview, true,
    'ambiguous discussion cannot route around an unreviewed tool outcome');

  const app = express();
  app.use(express.json());
  app.use('/api/chatroom', createChatroomRouter(room));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/chatroom`;
  try {
    const feed = await fetch(`${base}/messages`);
    assert.equal(feed.status, 200);
    const cookie = feed.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('pi_webx_chatroom_user='));
    const data = await feed.json() as { tasks: Array<{ id: string; version: number }> };
    assert.equal(data.tasks.length, 2);
    assert.doesNotMatch(JSON.stringify(data.tasks), /req-work-session|codes-work-session|source_context|checkpoint/);
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie! }, body: JSON.stringify(body),
    });
    const versionA = room.work.publicTask(taskA)!.version;
    assert.equal((await post(`/tasks/${taskA}/actions`, { action: 'resume', entryKey: 'resume-a',
      expectedVersion: versionA, agentId: 'requirements' })).status, 409);
    assert.equal((await post(`/tasks/${taskA}/actions`, { action: 'resume', entryKey: 'resume-a',
      expectedVersion: versionA, agentId: 'requirements', reviewed: true, senderId: 'codes' })).status, 400);
    const resume = { action: 'resume', entryKey: 'resume-a', expectedVersion: versionA,
      agentId: 'requirements', reviewed: true };
    const resumedResponse = await post(`/tasks/${taskA}/actions`, resume);
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json() as { task: { status: string }; message: { id: string } };
    assert.equal(resumed.task.status, 'running');
    assert.equal(room.work.getBinding(ambiguous, 'requirements').needsReview, true,
      'another unreviewed task still guards ambiguous discussion');
    assert.equal((await post(`/tasks/${taskA}/actions`, resume)).status, 200);
    assert.equal(((await (await post(`/tasks/${taskA}/actions`, resume)).json()) as { message: { id: string } }).message.id,
      resumed.message.id, 'resume action is idempotent');
    const reordered = { reviewed: true, agentId: 'requirements', expectedVersion: versionA,
      entryKey: 'resume-a', action: 'resume' };
    assert.equal(((await (await post(`/tasks/${taskA}/actions`, reordered)).json()) as { message: { id: string } }).message.id,
      resumed.message.id, 'idempotency is independent of JSON field order');
    assert.equal((await post(`/tasks/${taskA}/actions`, { ...resume, expectedVersion: versionA + 1,
      entryKey: 'stale' })).status, 409);
    assert.equal((await post('/messages', { body: '@需求管理 伪造身份', entryKey: 'forged',
      senderId: 'codes' })).status, 400);
    assert.equal((await post('/messages', { body: '@需求管理 跨话题', entryKey: 'cross-thread',
      threadId: taskB, collaborationTaskId: taskA })).status, 409);

    const cancelUnknown = { action: 'cancel', entryKey: 'cancel-unknown-b',
      expectedVersion: room.work.publicTask(taskB)!.version };
    assert.equal((await post(`/tasks/${taskB}/actions`, cancelUnknown)).status, 200);
    assert.equal(room.work.publicTask(taskB)?.status, 'cancelled');
    assert.equal(room.work.publicTask(taskB)?.needsReview, true,
      'cancel preserves the unknown side-effect marker');
    const versionB = room.work.publicTask(taskB)!.version;
    assert.equal((await post(`/tasks/${taskB}/actions`, { action: 'review', entryKey: 'review-b',
      expectedVersion: versionB, reviewed: false })).status, 409);
    assert.equal((await post(`/tasks/${taskB}/actions`, { action: 'review', entryKey: 'review-b',
      expectedVersion: versionB - 1, reviewed: true })).status, 409);
    const review = { action: 'review', entryKey: 'review-b', expectedVersion: versionB, reviewed: true };
    const reviewedResponse = await post(`/tasks/${taskB}/actions`, review);
    assert.equal(reviewedResponse.status, 200);
    const reviewedTask = (await reviewedResponse.json() as { task: { status: string; needsReview: boolean } }).task;
    assert.deepEqual([reviewedTask.status, reviewedTask.needsReview], ['cancelled', false]);
    assert.equal((await post(`/tasks/${taskB}/actions`, review)).status, 200);
    assert.equal(room.work.getRun(uncertainB.id)?.status, 'needs_review', 'review retains the historical run');
    assert.equal(room.work.getBinding(ambiguous, 'requirements').needsReview, false,
      'review unlocks ordinary discussion in the same thread');
    assert.equal((await post(`/tasks/${taskB}/actions`, { action: 'resume', entryKey: 'resume-cancelled',
      expectedVersion: room.work.publicTask(taskB)!.version, agentId: 'requirements' })).status, 409);
    const ordinary = await post('/messages', { body: '@需求管理 同话题新需求',
      entryKey: 'after-review', threadId: first.threadId });
    assert.equal(ordinary.status, 201);
    const ordinaryId = (await ordinary.json() as { message: { id: string } }).message.id;
    assert.equal(room.work.getBinding(room.storage.byId(ordinaryId)!, 'requirements').scope, 'discussion');

    const claimedA = claim(room.storage.byId(resumed.message.id)!);
    room.work.bindSession(claimedA, 'requirements', 'req-work-session');
    const runningA = room.work.beginRun(claimedA, 'requirements', 'req-work-session');
    let aborted = false;
    room.work.registerCancelRun(async runId => {
      assert.equal(runId, runningA.id);
      aborted = true;
      assert.equal(room.work.finishRun(runId, 'failed', { error: 'abort settled' }).status, 'cancelled',
        'cancel is durable before abort completion races');
    });
    const cancel = { action: 'cancel', entryKey: 'cancel-a', expectedVersion: room.work.publicTask(taskA)!.version };
    const cancelledResponse = await post(`/tasks/${taskA}/actions`, cancel);
    assert.equal(cancelledResponse.status, 200);
    assert.equal((await cancelledResponse.json() as { task: { status: string } }).task.status, 'cancelled');
    assert.equal(aborted, true);
    assert.equal((await post(`/tasks/${taskA}/actions`, cancel)).status, 200);
    assert.equal(room.work.getRun(runningA.id)?.status, 'cancelled');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
} finally {
  await room.stop();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

async function beforeTimeout(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1500);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function checkEligibleScheduler(): Promise<void> {
  const schedulerDir = mkdtempSync(join(tmpdir(), 'pi-webx-chatroom-scheduler-'));
  const schedulerStore = new WorkbenchStore(join(schedulerDir, 'workbench.sqlite'));
  const schedulerRoom = getChatroomService(schedulerStore);
  const schedulerUser = schedulerRoom.ensureUserSession();
  let releaseCodes = () => {};
  let releaseBroadcast = () => {};
  try {
    const codeHold = new Promise<void>(resolve => { releaseCodes = resolve; });
    const backlog = Array.from({ length: 6 }, (_, index) => schedulerRoom.sendUser(schedulerUser,
      { body: `@代码开发 排队工作 ${index}`, entryKey: `backlog-${index}` }));
    const logs = schedulerRoom.sendUser(schedulerUser,
      { body: '@日志查询 独立查询', entryKey: 'logs-independent' });
    let active = 0; let peak = 0; let activeCodes = 0; let peakCodes = 0;
    let logsDone!: () => void;
    const logsFinished = new Promise<void>(resolve => { logsDone = resolve; });
    const unregisterFirst = schedulerRoom.registerRunner(async message => {
      active += 1; peak = Math.max(peak, active);
      const agent = message.recipientId!;
      schedulerRoom.prepareConsumptions(message.id, [agent]);
      schedulerRoom.updateConsumption(message.id, agent, 'processing');
      try {
        if (agent === 'codes') {
          activeCodes += 1; peakCodes = Math.max(peakCodes, activeCodes);
          await codeHold;
        }
        await schedulerRoom.withDelivery(`scheduler-${message.id}`, message, agent, async () => {
          schedulerRoom.publishReply(agent, `scheduler-${message.id}`,
            { body: '已处理', entryKey: `answer-${message.id}` });
        });
        schedulerRoom.updateConsumption(message.id, agent, 'consumed');
        if (message.id === logs.id) logsDone();
      } finally {
        if (agent === 'codes') activeCodes -= 1;
        active -= 1;
      }
    });
    await beforeTimeout(logsFinished, 'logs behind codes backlog');
    assert.equal(schedulerRoom.storage.byId(logs.id)?.consumptions[0]?.status, 'consumed');
    assert.equal(schedulerRoom.storage.byId(backlog[0]!.id)?.deliveryStatus, 'running');
    assert.equal(peakCodes, 1, 'one active addressed delivery per member');
    assert.ok(peak <= 4 && peak > 1, 'independent members overlap within the worker limit');
    assert.equal(backlog.slice(1).every(item => schedulerRoom.storage.byId(item.id)?.deliveryStatus === 'pending'), true,
      'same-member backlog does not occupy global workers');
    releaseCodes();
    await schedulerRoom.drain();
    assert.equal(backlog.every(item => schedulerRoom.storage.byId(item.id)?.deliveryStatus === 'delivered'), true);
    unregisterFirst();
  } finally { releaseCodes(); }

  try {
    const codeHold = new Promise<void>(resolve => { releaseCodes = resolve; });
    const broadcastHold = new Promise<void>(resolve => { releaseBroadcast = resolve; });
    const blocker = schedulerRoom.sendUser(schedulerUser,
      { body: '@代码开发 先处理', entryKey: 'broadcast-blocker' });
    const broadcast = schedulerRoom.sendUser(schedulerUser,
      { body: '群内广播，需要代码开发处理', entryKey: 'pending-broadcast' });
    const targetLogs = schedulerRoom.sendUser(schedulerUser,
      { body: '@日志查询 广播后独立查询', entryKey: 'post-broadcast-logs' });
    let logsStarted = false;
    let logsDone!: () => void;
    const logsFinished = new Promise<void>(resolve => { logsDone = resolve; });
    schedulerRoom.registerRunner(async message => {
      if (message.id === broadcast.id) {
        schedulerRoom.prepareConsumptions(message.id, ['codes', 'logs']);
        schedulerRoom.updateConsumption(message.id, 'logs', 'evaluating');
        schedulerRoom.updateConsumption(message.id, 'logs', 'skipped');
        schedulerRoom.recordClaimants(message.id, ['codes']);
        schedulerRoom.updateConsumption(message.id, 'codes', 'processing');
        await broadcastHold;
        await schedulerRoom.withDelivery(`scheduler-${message.id}`, message, 'codes', async () => {
          schedulerRoom.publishReply('codes', `scheduler-${message.id}`,
            { body: '广播已处理', entryKey: `answer-${message.id}` });
        });
        schedulerRoom.updateConsumption(message.id, 'codes', 'consumed');
        return;
      }
      const agent = message.recipientId!;
      schedulerRoom.prepareConsumptions(message.id, [agent]);
      schedulerRoom.updateConsumption(message.id, agent, 'processing');
      if (message.id === blocker.id) await codeHold;
      if (message.id === targetLogs.id) logsStarted = true;
      await schedulerRoom.withDelivery(`scheduler-${message.id}`, message, agent, async () => {
        schedulerRoom.publishReply(agent, `scheduler-${message.id}`,
          { body: '已处理', entryKey: `answer-${message.id}` });
      });
      schedulerRoom.updateConsumption(message.id, agent, 'consumed');
      if (message.id === targetLogs.id) logsDone();
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(schedulerRoom.storage.byId(broadcast.id)?.deliveryStatus, 'pending');
    assert.equal(logsStarted, false, 'later logs cannot overtake an earlier pending broadcast');
    releaseCodes();
    await beforeTimeout(logsFinished, 'logs after terminal broadcast receipt');
    assert.equal(schedulerRoom.storage.byId(broadcast.id)?.deliveryStatus, 'running');
    assert.equal(schedulerRoom.storage.byId(targetLogs.id)?.consumptions[0]?.status, 'consumed',
      'terminal logs receipt releases logs while broadcast codes remains active');
    releaseBroadcast();
    await schedulerRoom.drain();
  } finally { releaseCodes(); releaseBroadcast(); }
  await schedulerRoom.stop();
  schedulerStore.close();
  rmSync(schedulerDir, { recursive: true, force: true });
}

await checkEligibleScheduler();
console.log('PASS chatroom work: durable scopes, review/cancel, and member-eligible bounded scheduling');
