/**
 * 待发送队列（dsh 的 queue dock）在桥接层的语义。
 *
 *   npx tsx scripts/check-queue.ts
 *
 * 队列归桥接层所有，不归 pi：pi 自己的 steer/followUp 队列只有字符串，没有任何
 * 逐条身份，所以「插话这一条 / 删掉那一条」根本无从下手。这里钉住的正是那层身份
 * 与守卫——行有 id、动作只动被点名的那一行、空闲时不给插话、快照带得回队列。
 *
 * 不涉及模型：队列为空时任何一轮都起不来，所以这里只验证**排队本身**，不验证
 * 「轮次结束后自动发出去」——那条由 agent_settled 驱动，需要真实的一轮。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PiHost, type HostedSession } from '../server/pi/host';
import type { PiQueuedPrompt } from '../src/shared/protocol';

let failures = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

/** Every `queue_update` the host published, so the projection can be asserted. */
function collectQueueFrames(host: PiHost, hosted: HostedSession): PiQueuedPrompt[][] {
  const frames: PiQueuedPrompt[][] = [];
  host.subscribe(hosted, {
    frame: (entry) => {
      const frame = entry.frame as { t?: string; event?: { type?: string; pending?: PiQueuedPrompt[] } };
      if (frame.t === 'pi' && frame.event?.type === 'queue_update') {
        frames.push(frame.event.pending ?? []);
      }
    },
    close: () => {},
  });
  return frames;
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-webx-queue-'));
const host = new PiHost();

try {
  const hosted = await host.create({ cwd: temp });
  const frames = collectQueueFrames(host, hosted);

  const seed = (rows: Array<{ id: string; text: string; imageCount?: number }>): void => {
    hosted.queue = rows.map((row, index) => ({
      id: row.id,
      text: row.text,
      ...(row.imageCount === undefined
        ? {}
        : { images: Array.from({ length: row.imageCount }, () => ({ type: 'image' as const, data: '', mimeType: 'image/png' })) }),
      createdAt: index + 1,
    }));
    void host.command(hosted.id, { type: 'get_state' });
  };

  await check('待发送里的图片只以数量出现，正文与 id 照原样给出去', async () => {
    seed([{ id: 'q1', text: '先别动', imageCount: 2 }]);
    const response = await host.command(hosted.id, { type: 'get_messages' });
    const data = response.data as { queue?: PiQueuedPrompt[] };
    assert.deepEqual(data.queue, [{ id: 'q1', text: '先别动', imageCount: 2, createdAt: 1 }]);
  });

  await check('编辑只改被点名的那一行，另一行原样', async () => {
    seed([
      { id: 'q1', text: '第一行' },
      { id: 'q2', text: '第二行' },
    ]);
    const response = await host.command(hosted.id, {
      type: 'update_queue',
      id: 'q2',
      action: { kind: 'edit', text: '  第二行（改过）  ' },
    });
    assert.equal(response.success, true, JSON.stringify(response));
    assert.deepEqual(hosted.queue.map((row) => row.text), ['第一行', '第二行（改过）']);
  });

  await check('空白内容不算编辑，行也不动', async () => {
    seed([{ id: 'q1', text: '第一行' }]);
    const response = await host.command(hosted.id, {
      type: 'update_queue',
      id: 'q1',
      action: { kind: 'edit', text: '   ' },
    });
    assert.equal(response.success, false);
    assert.deepEqual(hosted.queue.map((row) => row.text), ['第一行']);
  });

  await check('删除只删被点名的那一行', async () => {
    seed([
      { id: 'q1', text: '第一行' },
      { id: 'q2', text: '第二行' },
    ]);
    const response = await host.command(hosted.id, { type: 'update_queue', id: 'q1', action: { kind: 'remove' } });
    assert.equal(response.success, true);
    assert.deepEqual(hosted.queue.map((row) => row.id), ['q2']);
  });

  await check('空闲时不给插话——steer 的投递窗口只在运行中', async () => {
    seed([{ id: 'q1', text: '第一行' }]);
    const response = await host.command(hosted.id, { type: 'update_queue', id: 'q1', action: { kind: 'steer' } });
    assert.equal(response.success, false);
    assert.match(String(response.error), /仅运行中/);
    // 失败不能吞掉用户写的东西。
    assert.deepEqual(hosted.queue.map((row) => row.id), ['q1']);
  });

  await check('点名一个已经不在队列里的 id：报错，不动别人', async () => {
    seed([{ id: 'q1', text: '第一行' }]);
    const response = await host.command(hosted.id, { type: 'update_queue', id: 'gone', action: { kind: 'remove' } });
    assert.equal(response.success, false);
    assert.deepEqual(hosted.queue.map((row) => row.id), ['q1']);
  });

  await check('每次改动都广播整份投影，浏览器只认最后一帧', async () => {
    seed([{ id: 'q1', text: '甲' }]);
    await host.command(hosted.id, { type: 'update_queue', id: 'q1', action: { kind: 'edit', text: '乙' } });
    await host.command(hosted.id, { type: 'update_queue', id: 'q1', action: { kind: 'remove' } });
    assert.deepEqual(frames.at(-1), []);
    assert.equal(frames.at(-2)?.[0]?.text, '乙');
  });

  await check('清空命令同时清掉待发送', async () => {
    seed([{ id: 'q1', text: '第一行' }]);
    await host.command(hosted.id, { type: 'clear_queue' });
    assert.deepEqual(hosted.queue, []);
  });

  await check('get_state 的 pendingMessageCount 就是待发送的行数', async () => {
    seed([
      { id: 'q1', text: '第一行' },
      { id: 'q2', text: '第二行' },
    ]);
    const data = (await host.command(hosted.id, { type: 'get_state' })).data as {
      pendingMessageCount?: number;
    };
    assert.equal(data.pendingMessageCount, 2);
  });

  await check('新会话把队列留在上一段对话里', async () => {
    seed([{ id: 'q1', text: '第一行' }]);
    await host.command(hosted.id, { type: 'new_session' });
    assert.deepEqual(hosted.queue, []);
  });
} finally {
  await host.disposeAll();
  await rm(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${String(failures)} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
