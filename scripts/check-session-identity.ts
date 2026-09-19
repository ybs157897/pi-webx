/**
 * 会话身份：桥接层的 id 必须就是**转写文件里的那个 id**。
 *
 * 这条曾经不成立（`crypto.randomUUID()`），后果是：服务端重启后 `?session=<id>`
 * 再也对不上任何东西——磁盘上的对话明明还在，界面只能说「这堂课已结束」，而刷新
 * 毫无用处。稳定的 id 是「按 id 从磁盘恢复」的前提（`findStoredSessionById`）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PiHost } from '../server/pi/host';

const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-session-identity-'));
const host = new PiHost();
try {
  const hosted = await host.create({ cwd: temp });
  const file = hosted.session.sessionFile;
  assert.ok(file, '会话应当写进了文件');

  // 转写文件在第一条 assistant 消息落盘前还不存在，所以 id 先跟会话本体核对。
  assert.equal(
    hosted.id,
    hosted.session.sessionManager.getSessionId(),
    '桥接 id 与 pi 的会话 id 不一致：刷新后按 id 就找不回这堂课了',
  );
  assert.equal(
    host.summary(hosted).id,
    hosted.session.sessionManager.getSessionId(),
    '对外暴露的 SessionSummary.id 也必须是同一个 id',
  );

  // 文件名里嵌的也是同一个 id（`<时间戳>_<id>.jsonl`）。`listStoredSessions`
  // 读的是文件头里的 id，而文件头与这里必须一致。
  assert.ok(
    path.basename(file).endsWith(`_${hosted.id}.jsonl`),
    `转写文件名没有带上会话 id：${path.basename(file)}`,
  );

  // 已经在跑的会话，按文件再要一次应当拿到同一个（路由层就是这样先查再建）。
  const hostedAgain = host.list().find((entry) => entry.sessionFile === file);
  assert.equal(hostedAgain?.id, hosted.id, '宿主里同一个文件应当只有一个会话');

  await host.kill(hosted.id);
  assert.equal(host.list().length, 0, '杀掉之后宿主里没有会话了');

  /**
   * 关键一步：从**磁盘上已有的转写**恢复时，id 必须来自文件头。
   *
   * 这是服务端重启后 `?session=<id>` 还能接回来的唯一依据。真实的转写文件形如
   * `<时间戳>_<id>.jsonl`，第一行是 `type: "session"` 的头；这里按同样的形状
   * 造一个（不调模型），验证恢复路径认的是文件里的 id，不是新铸一个。
   */
  const storedId = '01a0b900-dead-beef-0000-000000000001';
  const sessionDir = path.join(temp, 'stored-sessions');
  await mkdir(sessionDir, { recursive: true });
  const storedFile = path.join(sessionDir, `2026-09-19T00-00-00-000Z_${storedId}.jsonl`);
  await writeFile(
    storedFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: storedId,
        timestamp: '2026-09-19T00:00:00.000Z',
        cwd: temp,
      }),
      JSON.stringify({
        type: 'message',
        id: 'e0000001',
        parentId: null,
        timestamp: '2026-09-19T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '上一堂课讲过成本控制。' }],
          timestamp: 1,
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  );
  const resumed = await host.create({ sessionPath: storedFile, cwd: temp });
  assert.equal(
    resumed.id,
    storedId,
    '从磁盘恢复时没有采用文件头里的 id：刷新后按 id 就找不回这堂课',
  );
  await host.kill(resumed.id);
  console.log('PASS 会话身份稳定：桥接 id == 转写文件 id，按文件恢复仍是同一个 id');
} finally {
  await host.disposeAll();
  await rm(temp, { recursive: true, force: true });
}
