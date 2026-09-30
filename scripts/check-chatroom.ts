import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { WorkbenchStore } from '../server/workbench/store';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createChatroomRouter } from '../server/modules/chatroom/router';
import { createChatroomTools } from '../server/modules/chatroom/tools';
import type { ChatroomMessage } from '../server/modules/chatroom/contracts';
import { parseChatroomMentions, findChatroomMentionDraft } from '../src/shared/chatroom-mentions.mjs';
import { registerChatroomFixtureRunner } from './chatroom-check-fixtures';

const dir = mkdtempSync(join(tmpdir(), 'pi-webx-chatroom-'));
const dbPath = join(dir, 'workbench.sqlite');
let store = new WorkbenchStore(dbPath);

try {
  let service = getChatroomService(store);
  assert.equal(getChatroomService(store), service, 'assemble/runtime share one in-process service');
  assert.equal(parseChatroomMentions('@研发 请处理').recipientId, 'codes');
  assert.equal(parseChatroomMentions('a@codes.example.com').recipientId, null, 'email is not a mention');
  assert.deepEqual(parseChatroomMentions('@需求 @需求管理').mentions.map(item => item.id), ['requirements', 'requirements']);
  assert.equal(parseChatroomMentions('@需求 @研发').multipleRecipients, true);
  assert.deepEqual(parseChatroomMentions('@不存在').unknownMentions, ['@不存在']);
  assert.deepEqual(findChatroomMentionDraft('请找 @'), { query: '', start: 3, end: 4 });
  assert.equal(findChatroomMentionDraft('mail@'), null);
  const selfHandoff = service.send('requirements', 'req-session', {
    body: '@需求管理 请用独立接收会话处理', entryKey: 'self',
  });
  assert.equal(selfHandoff.recipientId, 'requirements', 'ordinary module session may address its own receiving Agent');
  assert.throws(() => service.publishReply('requirements', 'req-session', {
    body: '普通会话不能伪造自动正文', entryKey: 'not-active',
  }), /只能在当前群投递/);
  assert.throws(() => service.send('requirements', 'req-session', {
    to: 'codes', body: '@需求管理 冲突', entryKey: 'conflicting-to',
  }), /不一致/);
  assert.throws(() => service.send('requirements', 'req-session', {
    body: '@需求管理 @代码开发 两人接手', entryKey: 'multi-to',
  }), /只能 @ 一位/);
  assert.throws(() => service.send('requirements', 'req-session', {
    body: '@不存在 请处理', entryKey: 'unknown-mention',
  }), /未知 @成员/);
  assert.throws(() => service.send('requirements', 'req-session', {
    to: 'unknown' as 'codes', body: 'bad', entryKey: 'unknown',
  }), /未知收件/);
  assert.throws(() => service.send('requirements', 'req-session', {
    body: { thinking: 'secret' } as unknown as string, entryKey: 'thought',
  }), /必须是文本/);
  assert.throws(() => service.send('requirements', 'req-session', {
    body: ' ', entryKey: 'empty',
  }), /正文/);
  assert.throws(() => service.send('requirements', 'req-session', {
    to: 'codes', body: '字'.repeat(12000), entryKey: 'decorated-too-long',
  }), /12000/, 'visible @ prefix still counts toward body limit');

  const requirement = store.addRecord('requirements', {
    title: '群聊接力需求', sourceSessionId: 'req-session', taskDrafts: [{ title: '实现内部聊天室' }],
  });
  assert.throws(() => service.send('requirements', 'other-session', {
    to: 'assistant', body: '越权需求', entryKey: 'forged',
    requirementId: requirement.id, expectedUpdatedAt: String(requirement.updatedAt),
  }), /不属于当前会话/);
  assert.throws(() => service.send('requirements', 'req-session', {
    to: 'assistant', body: '过期需求', entryKey: 'stale',
    requirementId: requirement.id, expectedUpdatedAt: 'old',
  }), /已更新/);

  const broadcast = service.send('requirements', 'req-session', { body: '群里留一条公告', entryKey: 'broadcast' });
  assert.equal(broadcast.deliveryStatus, 'pending', '未点名消息是待认领的群发布');
  assert.equal(broadcast.recipientId, null);
  assert.throws(() => service.recordClaimants(broadcast.id, ['nobody' as 'logs']), /认领成员不合法/);
  assert.throws(() => service.recordClaimants(broadcast.id, ['logs']), /不在可认领状态/);
  const first = service.send('requirements', 'req-session', {
    to: 'assistant', body: '请把这个需求拆成待办', entryKey: 'handoff',
    requirementId: requirement.id, expectedUpdatedAt: String(requirement.updatedAt),
  });
  assert.equal(first.seq, broadcast.seq + 1);
  assert.equal(first.body, '@我的助理 请把这个需求拆成待办');
  assert.equal(first.deliveryStatus, 'pending');
  assert.equal(service.send('requirements', 'req-session', {
    to: 'assistant', body: '请把这个需求拆成待办', entryKey: 'handoff',
    requirementId: requirement.id, expectedUpdatedAt: String(requirement.updatedAt),
  }).id, first.id);
  assert.throws(() => service.send('requirements', 'req-session', {
    to: 'assistant', body: '另一个内容', entryKey: 'handoff',
  }), /entryKey/, 'same key with changed content is a conflict');

  const task = store.addRecord('tasks', { title: '实现内部聊天室' });
  let active = 0;
  let peak = 0;
  let publications = 0;
  const received: ChatroomMessage[] = [];
  const unregister = registerChatroomFixtureRunner(service, async message => {
    active += 1;
    peak = Math.max(peak, active);
    received.push(message);
    try {
      if (message.body.endsWith('模拟失败')) throw new Error('runner failed');
      if (message.id === selfHandoff.id) {
        await service.withDelivery('requirements-self-receiver', message, 'requirements', async () => {
          const fallback = service.publishReply('requirements', 'requirements-self-receiver', {
            body: '请 @需求管理 回复验收条件，稍后 @代码开发', entryKey: 'runtime-answer',
          });
          assert.equal(fallback.recipientId, null);
          assert.equal(fallback.deliveryStatus, 'none');
          assert.equal(service.publishReply('requirements', 'requirements-self-receiver', {
            body: '请 @需求管理 回复验收条件，稍后 @代码开发', entryKey: 'runtime-answer',
          }).id, fallback.id);
          assert.throws(() => service.publishReply('requirements', 'requirements-self-receiver', {
            body: '改过的正文', entryKey: 'runtime-answer',
          }), /entryKey/);
        });
        assert.throws(() => service.publishReply('requirements', 'requirements-self-receiver', {
          body: '@代码开发 迟到', entryKey: 'late-runtime',
        }), /接收会话已结束/);
      } else if (message.id === first.id) {
        await service.withDelivery('assistant-from-requirement', message, 'assistant', async () => {
          assert.equal(service.getDelivery('assistant-from-requirement')?.id, first.id);
          service.attachTasks('assistant-from-requirement', [{ id: task.id, updatedAt: String(task.updatedAt) }]);
          assert.throws(() => service.send('assistant', 'assistant-from-requirement', {
            to: 'codes', body: '伪造待办', entryKey: 'bad-task', taskIds: ['not-a-task'],
          }), /只能转交/);
          assert.throws(() => service.send('assistant', 'assistant-from-requirement', {
            to: 'assistant', body: '不能自叫', entryKey: 'active-self',
          }), /不能再点名自己/);
          service.send('assistant', 'assistant-from-requirement', {
            to: 'codes', body: '请研发完成这个待办', entryKey: 'ask-codes', taskIds: [task.id],
          });
        });
        assert.equal(service.getDelivery('assistant-from-requirement'), undefined);
        assert.throws(() => service.send('assistant', 'assistant-from-requirement', {
          to: 'codes', body: '迟到的投递', entryKey: 'late-send',
        }), /接收会话已结束/);
      } else if (message.recipientId === 'codes') {
        assert.deepEqual(message.context.taskIds, [task.id]);
        assert.equal(message.context.taskVersions?.[task.id], task.updatedAt);
        await service.withDelivery('codes-from-assistant', message, 'codes', async () => {
          const completed = service.send('codes', 'codes-from-assistant', {
            to: 'assistant', body: '研发已处理，请更新状态', entryKey: 'return-assistant', taskIds: [task.id],
          });
          assert.deepEqual(completed.context.reportedTaskIds, [task.id]);
          const incomplete = service.send('codes', 'codes-from-assistant', {
            to: 'assistant', body: '还有事项未完成', entryKey: 'return-assistant-incomplete',
          });
          assert.deepEqual(incomplete.context.taskIds, [task.id], 'association survives');
          assert.deepEqual(incomplete.context.reportedTaskIds, [], 'omission never reports completion');
        });
      } else if (message.recipientId === 'assistant') {
        const sessionId = `assistant-from-codes-${message.seq}`;
        await service.withDelivery(sessionId, message, 'assistant', async () => {
          const notice = service.send('assistant', sessionId, {
            body: '收到，待办状态更新已记录', entryKey: `completion-notice-${message.seq}`,
          });
          assert.equal(notice.context.reportedTaskIds, undefined, 'old report is not inherited by other forwards');
        });
      } else if (message.senderId === 'user' && message.recipientId === 'requirements') {
        const sessionId = `requirements-from-user-${message.seq}`;
        await service.withDelivery(sessionId, message, 'requirements', async () => {
          let target = requirement;
          if (!message.context.requirementId) {
            assert.throws(() => service.attachRequirement(sessionId, requirement), /不属于当前交接上下文/);
            target = store.addRecord('requirements', {
              title: '用户新需求', sourceSessionId: sessionId, taskDrafts: [{ title: '新任务' }],
            });
          } else {
            assert.equal(message.context.requirementId, requirement.id, 'reply inherits trusted requirement context');
            target = store.updateRecord('requirements', requirement.id, { title: '已导入后的新版本' });
            assert.notEqual(target.updatedAt, message.context.expectedUpdatedAt);
          }
          service.attachRequirement(sessionId, target);
          service.attachTasks(sessionId, [{ id: task.id, updatedAt: String(task.updatedAt) }]);
          assert.equal(message.context.requirementId, target.id);
          assert.deepEqual(message.context.taskIds, [task.id]);
        });
      } else if (message.recipientId === null) {
        publications += 1;
        service.recordClaimants(message.id, ['logs']);
        assert.deepEqual(service.storage.byId(message.id)?.claimants, ['logs'], '认领记录是内部路由事实');
        if (publications === 1) {
          await assert.rejects(service.withDelivery(`intruder-${message.seq}`, message, 'assistant', async () => {
            throw new Error('非认领成员不能投递');
          }), /无权投递/);
          await service.withDelivery(`claim-logs-${message.seq}`, message, 'logs', async () => {
            service.publishReply('logs', `claim-logs-${message.seq}`, {
              body: '公告已由日志成员认领并记录', entryKey: `claim-answer-${message.seq}`,
            });
          });
          assert.equal(service.hasReply(message.id, 'logs'), true);
        }
      }
    } finally {
      active -= 1;
    }
  });
  await service.drain();
  assert.ok(peak > 1 && peak <= 4, 'independent messages overlap within the bounded delivery limit');
  assert.deepEqual(service.history(selfHandoff.threadId).map(message => message.body), [
    '@需求管理 请用独立接收会话处理', '请 @需求管理 回复验收条件，稍后 @代码开发',
  ], 'runtime answer keeps quoted @ visible without dispatch');
  assert.equal(new Set(received.map(message => message.id)).size, received.length, '每条投递只执行一次');
  assert.deepEqual(received.map(message => message.recipientId ?? 'broadcast').sort(),
    ['requirements', 'broadcast', 'assistant', 'codes', 'assistant', 'assistant', 'broadcast', 'broadcast'].sort(),
    '点名与群发布全部投递，独立成员可以交错执行');
  for (const agentId of ['requirements', 'codes', 'assistant', 'logs']) {
    const directedSeqs = received.filter(message => message.recipientId === agentId).map(message => message.seq);
    assert.deepEqual(directedSeqs, [...directedSeqs].sort((a, b) => a - b), '每个成员的点名消息保持 FIFO');
  }
  const chain = service.history(first.threadId);
  assert.deepEqual(chain.map(message => message.body), [
    '@我的助理 请把这个需求拆成待办', '@代码开发 请研发完成这个待办', '@我的助理 研发已处理，请更新状态',
    '@我的助理 还有事项未完成', '收到，待办状态更新已记录', '收到，待办状态更新已记录',
  ]);
  assert.deepEqual(chain.map(message => message.seq), [...chain.map(message => message.seq)].sort((a, b) => a - b));
  assert.equal(service.hasReply(first.id, 'assistant'), true);
  assert.equal(service.hasReply(first.id, 'codes'), false);
  assert.equal(service.read({ after: 0, limit: 2 }).hasMore, true);
  const publicData = JSON.stringify(service.read({ after: 0, watch: [first.seq] }));
  assert.ok(!publicData.includes('req-session') && !publicData.includes('expectedUpdatedAt'));
  assert.ok(!publicData.includes('taskVersions') && !publicData.includes('thinking') && !publicData.includes('claimants'));
  assert.equal(service.read({ watch: [first.seq] }).updates[0]?.deliveryStatus, 'delivered');

  const requirementsTool = createChatroomTools({ service, agentId: 'requirements', limits: { maxToolOutputChars: 10000 } });
  const sendTool = requirementsTool.find(tool => tool.name === 'chatroom_send')!;
  assert.throws(() => service.send('requirements', 'req-session', {
    body: '伪造发言人', entryKey: 'forged-sender', senderId: 'codes',
  } as any), /未知字段/);
  const toolResult = await sendTool.execute('call-1', {
    body: '工具闭包身份', entryKey: 'tool-bound',
  }, undefined, undefined, { sessionManager: { getSessionId: () => 'req-session' } } as any);
  const toolMessage = (toolResult.details as { data: { message: { senderId: string } } }).data.message;
  assert.equal(toolMessage.senderId, 'requirements', 'model cannot provide sender identity');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(sendTool.execute('call-aborted', {
    body: '中止后的消息', entryKey: 'aborted-tool',
  }, aborted.signal, undefined, { sessionManager: { getSessionId: () => 'req-session' } } as any), /已中止/);

  service.send('requirements', 'req-session', { to: 'logs', body: '模拟失败', entryKey: 'fail' });
  await service.drain();
  const failed = service.read({ after: 0 }).messages.find(message => message.body.endsWith('模拟失败'));
  assert.equal(failed?.deliveryStatus, 'failed');
  assert.match(failed?.error ?? '', /runner failed/);
  const callCount = received.length;
  await service.drain();
  assert.equal(received.length, callCount, 'failed deliveries do not retry automatically');

  const app = express();
  app.use(express.json());
  app.use('/api/chatroom', createChatroomRouter(service));
  const http = app.listen(0, '127.0.0.1');
  try {
    await once(http, 'listening');
    const address = http.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/chatroom/messages`;
    const response = await fetch(`${base}?after=0&limit=2&watch=${first.seq}`);
    assert.equal(response.status, 200);
    const data = await response.json() as { messages: Array<{ seq: number }>; nextCursor: number; updates: Array<{ deliveryStatus: string }> };
    assert.equal(data.messages.length, 2);
    assert.equal(data.nextCursor, data.messages[1]?.seq);
    assert.equal(data.updates[0]?.deliveryStatus, 'delivered');
    assert.equal((await fetch(`${base}?watch=bad`)).status, 400);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('pi_webx_chatroom_user='));
    const post = (body: unknown) => fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    });
    const human = await post({ body: '@需求管理 接着处理这个需求', entryKey: 'human-reply', replyTo: first.id });
    assert.equal(human.status, 201);
    const humanMessage = (await human.json() as { message: ChatroomMessage }).message;
    assert.equal(humanMessage.senderId, 'user');
    assert.equal(humanMessage.senderName, '我');
    assert.equal(humanMessage.recipientId, 'requirements');
    assert.equal(humanMessage.threadId, first.threadId);
    assert.equal(humanMessage.depth, undefined, 'private depth is not exposed');
    const duplicate = await post({ body: '@需求管理 接着处理这个需求', entryKey: 'human-reply', replyTo: first.id });
    assert.equal(duplicate.status, 201);
    assert.equal((await duplicate.json() as { message: { id: string } }).message.id, humanMessage.id);
    assert.equal((await post({ body: '@需求管理 改内容', entryKey: 'human-reply', replyTo: first.id })).status, 409);
    assert.equal((await post({ body: '@研发 伪造', entryKey: 'forged-human', senderId: 'codes' })).status, 400);
    assert.equal((await post({ body: '@不存在 处理', entryKey: 'unknown-human' })).status, 400);
    assert.equal((await post({ body: '@需求 @研发 一起', entryKey: 'multi-human' })).status, 400);
    const email = await post({ body: 'mail@codes.example.com 仅广播', entryKey: 'email-human' });
    assert.equal(email.status, 201);
    const emailMessage = (await email.json() as { message: { recipientId: string | null; deliveryStatus: string } }).message;
    assert.equal(emailMessage.recipientId, null);
    assert.equal(emailMessage.deliveryStatus, 'pending', '用户广播同样进入待认领队列');
    const newRequest = await post({ body: '@需求管理 用户新的需求', entryKey: 'human-new' });
    assert.equal(newRequest.status, 201);
    const newMessage = (await newRequest.json() as { message: { id: string } }).message;
    assert.equal((await post({ body: '@需求管理 无效回复', entryKey: 'bad-reply', replyTo: 'missing' })).status, 404);
    await service.drain();
    assert.equal(service.storage.byId(humanMessage.id)?.context.requirementId, requirement.id);
    assert.notEqual(service.storage.byId(newMessage.id)?.context.requirementId, requirement.id);
    assert.ok(service.storage.byId(newMessage.id)?.context.requirementId);
  } finally {
    http.close();
  }

  unregister();
  await service.stop();
  const pending = service.send('assistant', 'assistant-direct', {
    to: 'codes', body: '重启后继续投递', entryKey: 'restart-queue', taskIds: [task.id],
  });
  assert.equal(pending.deliveryStatus, 'pending');
  store.close();
  store = new WorkbenchStore(dbPath);
  service = getChatroomService(store);
  const replayed: string[] = [];
  registerChatroomFixtureRunner(service, async message => {
    replayed.push(message.id);
    await service.withDelivery('replayed-codes', message, 'codes', async () => {
      service.publishReply('codes', 'replayed-codes', { body: '重启后已处理', entryKey: 'replayed' });
    });
  });
  await service.drain();
  assert.deepEqual(replayed, [pending.id], 'pending queue resumes after restart');
  assert.equal(service.storage.byId(pending.id)?.deliveryStatus, 'delivered');

  await service.stop();
  const interrupted = service.send('assistant', 'assistant-direct', {
    to: 'codes', body: '运行中断', entryKey: 'interrupt', taskIds: [task.id],
  });
  assert.equal(service.storage.claim(interrupted.id)?.deliveryStatus, 'running');
  store.close();
  store = new WorkbenchStore(dbPath);
  service = getChatroomService(store);
  assert.equal(service.storage.byId(interrupted.id)?.deliveryStatus, 'failed');
  assert.match(service.storage.byId(interrupted.id)?.error ?? '', /重启中断/);
  assert.deepEqual(service.read({ watch: [interrupted.seq] }).updates.map(message => message.deliveryStatus), ['failed']);

  let depthRejected = false;
  let countRejected = false;
  service.registerRunner(async message => {
    if (message.body.includes('depth ')) {
      await service.withDelivery(`depth-session-${message.seq}`, message, message.recipientId!, async () => {
        const senderId = message.recipientId!;
        const to = senderId === 'assistant' ? 'codes' : 'assistant';
        try {
          service.send(senderId, `depth-session-${message.seq}`, {
            to, body: `depth ${message.depth + 1}`, entryKey: `next-${message.seq}`,
          });
        } catch (error) {
          assert.match(String(error), /接力次数已达上限/);
          depthRejected = true;
        }
      });
    }
    if (message.body.endsWith('count root')) {
      await service.withDelivery(`count-session-${message.seq}`, message, 'assistant', async () => {
        for (let index = 0; index < 40; index += 1) {
          try {
            service.send('assistant', `count-session-${message.seq}`, {
              body: `count ${index}`, entryKey: `count-${index}`,
            });
          } catch (error) {
            assert.equal(index, 39);
            assert.match(String(error), /消息数已达上限/);
            countRejected = true;
          }
        }
      });
    }
    if (message.body === '@我的助理 用户继续') {
      await service.withDelivery(`resume-session-${message.seq}`, message, 'assistant', async () => {
        service.send('assistant', `resume-session-${message.seq}`, {
          body: '继续后的自动回复', entryKey: `resume-reply-${message.seq}`,
        });
      });
    }
  });
  const depthRoot = service.send('requirements', 'depth-origin', {
    to: 'assistant', body: 'depth 0', entryKey: 'depth-root',
  });
  await service.drain();
  assert.equal(depthRejected, true);
  assert.equal(service.history(depthRoot.threadId).length, 13);
  const countRoot = service.send('requirements', 'count-origin', {
    to: 'assistant', body: 'count root', entryKey: 'count-root',
  });
  await service.drain();
  assert.equal(countRejected, true);
  assert.equal(service.history(countRoot.threadId).length, 40);
  const userKey = service.ensureUserSession();
  assert.throws(() => service.sendUser('forged-user-key', { body: '@我的助理 伪造', entryKey: 'forged' }), /会话无效/);
  const continuation = service.sendUser(userKey, {
    body: '@我的助理 用户继续', entryKey: 'user-continue', replyTo: countRoot.id,
  });
  await service.drain();
  assert.equal(continuation.threadId, countRoot.threadId);
  assert.equal(continuation.depth, 0, 'new human entry resets automatic chain depth');
  assert.equal(service.storage.countThread(countRoot.threadId), 42, 'human continuation works after 40-message segment');
  assert.equal(service.storage.countSinceUserAnchor(countRoot.threadId), 2);
  await service.stop();

  console.log('chatroom: durable order/queue, scoped refs, explicit completion reports, revoked sessions, public HTTP/tools OK');
} finally {
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
}
