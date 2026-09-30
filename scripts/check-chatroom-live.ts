/** Opt-in acceptance against configured models; all business data and files stay in a temporary workspace. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { createModuleAgentSessionService } from '../server/module-agents/session-service';
import { profileRevision } from '../server/module-agents/snapshots';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createChatroomRouter } from '../server/modules/chatroom/router';
import { createModuleAgentChatroomRuntime } from '../server/modules/chatroom/runtime';
import type { ChatroomPublicMessage, ChatroomReadResult } from '../server/modules/chatroom/contracts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-webx-chatroom-live-')));
const logFile = join(root, 'consumption.log');
const resultFile = join(root, 'result.json');
const oldWorkspaceRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(root, 'workspaces');
const originalInfo = console.info.bind(console);
console.info = (...args: unknown[]) => {
  appendFileSync(logFile, `${args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
  originalInfo(...args);
};
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
for (const [id, loaded] of profiles) {
  if (!loaded.ok) continue;
  const profile = structuredClone(loaded.profile);
  const workspace = join(root, 'workspaces', id);
  mkdirSync(workspace, { recursive: true });
  profile.config.workspace = workspace;
  profile.effectiveWorkspace = workspace;
  profile.profileRevision = profileRevision(profile);
  profiles.set(id, { ok: true, profile });
}
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
const host = new PiHost({ sessionDir: join(root, 'sessions'), teamJournalDir: join(root, 'teams') });
const chatroom = getChatroomService(store);
const sessionService = createModuleAgentSessionService({ host, store, profiles, workspaceKey: 'default', storedSessions: async () => [] });
const liveTurnTimeoutMs = Number(process.env.PI_WEBX_CHATROOM_LIVE_TIMEOUT_MS ?? 120_000);
assert.ok(Number.isSafeInteger(liveTurnTimeoutMs) && liveTurnTimeoutMs >= 1000 && liveTurnTimeoutMs <= 600_000);
const runtime = createModuleAgentChatroomRuntime({ host, profiles, chatroom, sessionService, workspaceKey: 'default',
  admissionTimeoutMs: 30_000, turnTimeoutMs: liveTurnTimeoutMs, claimTimeoutMs: 60_000 });
const app = express();
app.use(express.json());
app.use('/api/chatroom', createChatroomRouter(chatroom));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/api/chatroom/messages`;
const results: ChatroomPublicMessage[] = [];
let cookie = '';

async function send(body: string, entryKey: string): Promise<ChatroomPublicMessage> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ body, entryKey }) });
  cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  assert.equal(response.status, 201);
  const { message } = await response.json() as { message: ChatroomPublicMessage };
  appendFileSync(logFile, `${JSON.stringify({ event: 'send', id: message.id, seq: message.seq, body })}\n`);
  const deadline = Date.now() + liveTurnTimeoutMs + 120_000;
  while (Date.now() < deadline) {
    const watch = await fetch(`${url}?after=${message.seq}&watch=${message.seq}`, { headers: { cookie } });
    assert.equal(watch.status, 200);
    const feed = await watch.json() as ChatroomReadResult;
    const current = feed.updates[0];
    if (current && (current.deliveryStatus === 'delivered' || current.deliveryStatus === 'failed')) {
      results.push(current);
      writeFileSync(resultFile, JSON.stringify({ root, logFile, messages: results, replies: feed.messages }, null, 2));
      console.log('LIVE_MESSAGE', JSON.stringify(current));
      return current;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`消息 ${message.id} 超过验收等待时限`);
}

console.log('LIVE_ARTIFACTS', JSON.stringify({ root, logFile, resultFile, url }));
try {
  const directed = await send('@代码开发 这是消费链路验收。请用 write 工具在当前临时工作目录创建 mq-directed.txt，内容严格为 DIRECTED_OK，完成后公开回复文件名和读取核对的结果。', 'live-directed');
  assert.equal(directed.deliveryStatus, 'delivered', directed.error ?? JSON.stringify(directed));
  assert.deepEqual(directed.consumptions.map(item => [item.agentId, item.status]), [['codes', 'consumed']]);
  assert.equal(readFileSync(join(root, 'workspaces', 'codes', 'mq-directed.txt'), 'utf8').trim(), 'DIRECTED_OK');
  const broadcast = await send('这是一项仅属于代码开发职责的消费链路验收，请代码开发在自己的当前临时工作目录创建 mq-broadcast.txt，内容严格为 BROADCAST_OK，读取核对后公开回复。没有需求整理、待办或日志任务，其他成员无需处理。', 'live-broadcast');
  assert.equal(broadcast.deliveryStatus, 'delivered', broadcast.error ?? JSON.stringify(broadcast));
  assert.ok(broadcast.consumptions.some(item => item.agentId === 'codes' && item.status === 'consumed'));
  assert.ok(broadcast.consumptions.every(item => ['consumed', 'skipped', 'failed'].includes(item.status)));
  assert.equal(readFileSync(join(root, 'workspaces', 'codes', 'mq-broadcast.txt'), 'utf8').trim(), 'BROADCAST_OK');
  assert.match(readFileSync(logFile, 'utf8'), /"status":"consumed"/);
  for (const message of [directed, broadcast]) {
    const task = chatroom.work.publicTask(message.collaborationTaskId!);
    assert.ok(task, 'configured model accepts explicit work');
    assert.equal(task.status, 'completed', 'configured model explicitly records completion after verification');
  }
  await chatroom.drain();
  const final = await fetch(url, { headers: { cookie } });
  assert.equal(final.status, 200);
  const feed = await final.json() as ChatroomReadResult;
  writeFileSync(resultFile, JSON.stringify({ root, logFile, messages: results,
    tasks: feed.tasks, turnTimeoutMs: liveTurnTimeoutMs, replies: feed.messages.filter(message => message.senderId !== 'user') }, null, 2));
  console.log('PASS live chatroom: HTTP sends, configured models, member consumption logs, public replies and real file writes');
} finally {
  await runtime.stop();
  await host.disposeAll();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
  console.info = originalInfo;
  if (oldWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = oldWorkspaceRoot;
}
