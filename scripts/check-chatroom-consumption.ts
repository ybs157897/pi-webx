import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { WorkbenchStore } from '../server/workbench/store';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createChatroomRouter } from '../server/modules/chatroom/router';
import type { ChatroomReadResult } from '../server/modules/chatroom/contracts';

const directory = mkdtempSync(join(tmpdir(), 'pi-webx-consumption-'));
const dbPath = join(directory, 'workbench.sqlite');
let store = new WorkbenchStore(dbPath);
let room = getChatroomService(store);
let user = room.ensureUserSession();
const app = express();
app.use(express.json());
app.use('/api/chatroom', createChatroomRouter(room));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/api/chatroom/messages`;
const watch = async (seq: number) => {
  const response = await fetch(`${base}?after=${seq}&watch=${seq}`);
  assert.equal(response.status, 200);
  return (await response.json() as ChatroomReadResult).updates[0]!;
};

try {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let processed!: () => void;
  const ready = new Promise<void>(resolve => { processed = resolve; });
  let calls = 0;
  room.registerRunner(async message => {
    calls += 1;
    const snapshot = room.prepareConsumptions(message.id, ['requirements', 'logs', 'codes']);
    assert.deepEqual(snapshot.map(item => item.status), ['pending', 'pending', 'pending']);
    assert.deepEqual(room.prepareConsumptions(message.id, ['assistant']), snapshot, '订阅快照不能在处理中扩张');
    room.recordClaimants(message.id, ['requirements']);
    room.updateConsumption(message.id, 'requirements', 'processing');
    assert.throws(() => room.updateConsumption(message.id, 'requirements', 'consumed'), /公开回复/,
      '不能仅凭订阅或认领确认消费成功');
    await room.withDelivery(`consumer-${message.id}`, message, 'requirements', async () => {
      room.publishReply('requirements', `consumer-${message.id}`, { body: '本条处理完成。', entryKey: 'reply' });
    });
    room.updateConsumption(message.id, 'requirements', 'consumed');
    room.updateConsumption(message.id, 'requirements', 'consumed');
    room.updateConsumption(message.id, 'logs', 'evaluating');
    room.updateConsumption(message.id, 'logs', 'skipped');
    room.updateConsumption(message.id, 'codes', 'evaluating');
    room.updateConsumption(message.id, 'codes', 'failed', '认领判断超时');
    assert.throws(() => room.updateConsumption(message.id, 'logs', 'processing'), /状态转换/);
    processed();
    await hold;
  });
  const first = room.sendUser(user, { body: '请处理并公开回复', entryKey: 'mixed' });
  await ready;
  const live = await watch(first.seq);
  assert.equal(live.deliveryStatus, 'running');
  assert.deepEqual(live.consumptions.map(item => [item.agentId, item.status]), [
    ['requirements', 'consumed'], ['logs', 'skipped'], ['codes', 'failed'],
  ], 'HTTP watch 在总体状态不变时也须返回逐成员 ACK');
  assert.ok(live.consumptions.every(item => item.startedAt && item.finishedAt));
  assert.equal(live.consumptions[2]?.error, '认领判断超时');
  assert.doesNotMatch(JSON.stringify(live), /senderSessionId|claimants|context|taskVersions/);
  release();
  await room.drain();
  const settled = await watch(first.seq);
  assert.equal(settled.deliveryStatus, 'delivered');
  assert.match(settled.error ?? '', /部分成员消费失败.*代码开发/,
    '已有成员成功也必须保留其他成员的失败摘要');
  assert.equal(room.sendUser(user, { body: '请处理并公开回复', entryKey: 'mixed' }).id, first.id);
  await room.drain();
  assert.equal(calls, 1, '重试同一发送不会再次执行成员消费');
  await room.stop();
  store.close();
  store = new WorkbenchStore(dbPath);
  room = getChatroomService(store);
  assert.deepEqual(room.storage.byId(first.id)?.consumptions, settled.consumptions, '成员 ACK 跨数据库重开保留');
  user = room.ensureUserSession(user);

  const interrupted = room.sendUser(user, { body: '部分已完成、部分中断', entryKey: 'interrupted' });
  const running = room.storage.claim(interrupted.id)!;
  room.prepareConsumptions(interrupted.id, ['requirements', 'logs', 'codes']);
  room.recordClaimants(interrupted.id, ['requirements']);
  room.updateConsumption(interrupted.id, 'requirements', 'processing');
  await room.withDelivery('completed-before-restart', running, 'requirements', async () => {
    room.publishReply('requirements', 'completed-before-restart', { body: '已完成部分', entryKey: 'completed' });
  });
  room.updateConsumption(interrupted.id, 'requirements', 'consumed');
  room.updateConsumption(interrupted.id, 'logs', 'evaluating');
  const stillPending = room.sendUser(user, { body: '@日志查询 尚未执行', entryKey: 'pending' });
  store.close();
  store = new WorkbenchStore(dbPath);
  room = getChatroomService(store);
  const restored = room.storage.byId(interrupted.id)!;
  assert.equal(restored.deliveryStatus, 'failed');
  assert.deepEqual(restored.consumptions.map(item => item.status), ['consumed', 'failed', 'failed']);
  assert.match(restored.consumptions[1]?.error ?? '', /重启中断/);
  assert.equal(restored.consumptions[2]?.startedAt, null, '未开始的成员不能捏造已处理时间');
  assert.equal(room.storage.byId(stillPending.id)?.deliveryStatus, 'pending');
  const replayed: string[] = [];
  room.registerRunner(async message => {
    replayed.push(message.id);
    room.prepareConsumptions(message.id, ['logs']);
    room.updateConsumption(message.id, 'logs', 'processing');
    await room.withDelivery('pending-after-restart', message, 'logs', async () => {
      room.publishReply('logs', 'pending-after-restart', { body: '恢复后完成', entryKey: 'recovered' });
    });
    room.updateConsumption(message.id, 'logs', 'consumed');
  });
  await room.drain();
  assert.deepEqual(replayed, [stillPending.id], '只恢复尚未开始的消息，不重跑中断任务');
  assert.equal(room.storage.byId(stillPending.id)?.consumptions[0]?.status, 'consumed');
  await room.stop();

  const acked = room.sendUser(user, { body: '@日志查询 ACK 已落库但整体状态尚未落库', entryKey: 'acked-before-crash' });
  const ackedRunning = room.storage.claim(acked.id)!;
  room.prepareConsumptions(acked.id, ['logs']);
  room.updateConsumption(acked.id, 'logs', 'processing');
  await room.withDelivery('acked-before-crash', ackedRunning, 'logs', async () => {
    room.publishReply('logs', 'acked-before-crash', { body: '完整处理成功', entryKey: 'acked' });
  });
  room.updateConsumption(acked.id, 'logs', 'consumed');
  store.close();
  store = new WorkbenchStore(dbPath);
  room = getChatroomService(store);
  assert.equal(room.storage.byId(acked.id)?.deliveryStatus, 'delivered', '终态 ACK 可恢复整体状态，无需重新执行');
  assert.equal(room.storage.byId(acked.id)?.consumptions[0]?.status, 'consumed');

  room.registerRunner(async () => {});
  const missingAck = room.sendUser(user, { body: '@日志查询 没有任何 ACK', entryKey: 'no-ack' });
  await room.drain();
  assert.equal(room.storage.byId(missingAck.id)?.deliveryStatus, 'failed', '空运行器不能把订阅冒充消费成功');
  assert.match(room.storage.byId(missingAck.id)?.error ?? '', /没有成员确认/);
  await room.stop();

  room.registerRunner(async message => {
    room.prepareConsumptions(message.id, ['logs']);
    room.updateConsumption(message.id, 'logs', 'processing');
    // A runner that resolves before ACK must not silently leave active records behind.
  });
  const unfinished = room.sendUser(user, { body: '@日志查询 未完成的消费', entryKey: 'unfinished' });
  await room.drain();
  assert.equal(room.storage.byId(unfinished.id)?.deliveryStatus, 'failed');
  assert.equal(room.storage.byId(unfinished.id)?.consumptions[0]?.status, 'failed');
  assert.match(room.storage.byId(unfinished.id)?.error ?? '', /消费未完成/);
  console.log('PASS chatroom consumption: member ACK, partial failures, HTTP watch, idempotency and restart recovery');
} finally {
  await room.stop();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
