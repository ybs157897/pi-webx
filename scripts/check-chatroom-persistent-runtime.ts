/** Offline Pi SDK acceptance for durable room sessions, work state and member mailboxes. */
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { createModuleAgentSessionService } from '../server/module-agents/session-service';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots, profileRevision } from '../server/module-agents/snapshots';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createModuleAgentChatroomRuntime } from '../server/modules/chatroom/runtime';
import { sandbox, memorySettings, scripted, until, within } from './subagent-check-fixtures';

const env = await sandbox();
env.runtime.hasConfiguredAuth = () => true;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldWorkspaceRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_CODING_AGENT_DIR = env.agentDir;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(env.root, 'workspaces');
const sqlitePath = join(env.root, 'room.sqlite');
const sessionDir = join(env.root, 'sessions');
const snapshotDir = join(env.root, 'profiles');
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
const loadedCodes = profiles.get('codes');
assert.ok(loadedCodes?.ok);
const codeDir = join(env.root, 'code');
await mkdir(codeDir);
const codesProfile = structuredClone(loadedCodes.profile);
codesProfile.config.workspace = await realpath(codeDir);
codesProfile.effectiveWorkspace = codesProfile.config.workspace;
codesProfile.profileRevision = profileRevision(codesProfile);
profiles.set('codes', { ok: true, profile: codesProfile });

function call(name: string, args: Record<string, unknown>, id: string) {
  return { content: [{ type: 'toolCall' as const, id, name, arguments: args }], stopReason: 'toolUse' as const };
}
function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }], stopReason: 'stop' as const };
}

type Mode = 'accept' | 'complete' | 'parallel' | 'fifo' | 'cancel-accept' | 'cancel-tool'
  | 'uncertain-accept' | 'uncertain-write' | 'personal';
let mode: Mode = 'accept';
let taskId = '';
let restoredContextSeen = false;
let codeActive = 0;
let codeMaxActive = 0;
let reqSessionId = '';
let reqRestoredId = '';
const modelPrompts: string[] = [];

function boot() {
  const store = new WorkbenchStore(sqlitePath);
  const chatroom = getChatroomService(store, 'default');
  const host = new PiHost({
    definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(env.root, 'defs.json'), agents: [] }) },
    modelRuntimeFactory: async () => env.runtime,
    settingsManagerFactory: memorySettings,
    sessionDir,
  });
  const originalCreate = host.create.bind(host);
  const originalCommand = host.command.bind(host);
  host.command = async (sessionId, command) => {
    if (command.type === 'prompt' && command.id?.startsWith('chatroom:')) modelPrompts.push(command.message);
    return originalCommand(sessionId, command);
  };
  host.create = async options => {
    const hosted = await originalCreate({ ...options, provider: env.model.provider, model: env.model.id });
    const agentId = options.moduleAgent?.scope.agentId;
    const localMode = mode;
    if (agentId === 'requirements' && localMode === 'accept') {
      reqSessionId = hosted.id;
      scripted(hosted.session, turn => turn === 1
        ? call('chatroom_work', { action: 'accept', title: '持久会话验收任务', entryKey: 'accept-req' }, 'accept-req')
        : text('任务已认领，我会等待补充后继续。'));
    } else if (agentId === 'requirements' && localMode === 'complete') {
      reqRestoredId = hosted.id;
      restoredContextSeen = hosted.session.messages.some(item => item.role === 'toolResult'
        && item.toolName === 'chatroom_work');
      scripted(hosted.session, turn => turn === 1
        ? call('chatroom_work', { action: 'update', taskId, status: 'completed',
          summary: '已接收补充并完成验证', entryKey: 'complete-req' }, 'complete-req')
        : text('补充已处理，任务完成。'));
    } else if (agentId === 'codes' && localMode === 'cancel-accept') {
      scripted(hosted.session, turn => turn === 1
        ? call('chatroom_work', { action: 'accept', title: '取消运行验收任务', entryKey: 'accept-cancel' }, 'accept-cancel')
        : text('已接手，请发执行指令。'));
    } else if (agentId === 'codes' && localMode === 'cancel-tool') {
      scripted(hosted.session, turn => turn === 1
        ? call('bash', { command: 'sleep 5' }, 'slow-bash') : text('被取消后不能公开这条回复。'));
    } else if (agentId === 'codes' && localMode === 'uncertain-accept') {
      scripted(hosted.session, turn => turn === 1
        ? call('chatroom_work', { action: 'accept', title: '中断恢复验收任务', entryKey: 'accept-uncertain' }, 'accept-uncertain')
        : text('准备执行文件写入。'));
    } else if (agentId === 'codes' && localMode === 'uncertain-write') {
      scripted(hosted.session, turn => turn === 1
        ? call('write', { path: 'unknown-effect.txt', content: 'SDK 已执行\n' }, 'uncertain-write')
        : text('文件已写入。'));
    } else if (agentId === 'codes') {
      scripted(hosted.session, () => text(localMode === 'parallel' ? '代码检查结束。' : '顺序处理完毕。'),
        localMode === 'parallel' ? 650 : 180);
    } else if (agentId === 'logs') {
      scripted(hosted.session, () => text('日志已检查。'), 10);
    }
    if (agentId === 'codes') {
      host.subscribe(hosted, { frame(entry) {
        if (entry.frame.t !== 'pi') return;
        if (entry.frame.event.type === 'agent_start') {
          codeActive += 1; codeMaxActive = Math.max(codeMaxActive, codeActive);
        }
        if (entry.frame.event.type === 'agent_settled') codeActive -= 1;
      }, close() {} });
    }
    return hosted;
  };
  const sessionService = createModuleAgentSessionService({ host, store, profiles, workspaceKey: 'default',
    snapshots: new ProfileSnapshots(snapshotDir), storedSessions: async () => [] });
  const relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', sessionService, chatroom,
    admissionTimeoutMs: 3000, turnTimeoutMs: 8000, claimTimeoutMs: 2000, pollMs: 5 });
  return { store, chatroom, host, sessionService, relay,
    async close() { await relay.stop(); await host.disposeAll(); store.close(); } };
}

let app = boot();
let userKey = app.chatroom.ensureUserSession();
try {
  const first = app.chatroom.sendUser(userKey, { body: '@需求管理 请接手并持续处理这个问题。', entryKey: 'first' });
  await within(app.chatroom.drain(), 5000);
  const accepted = app.chatroom.storage.byId(first.id)!;
  taskId = accepted.context.collaborationTaskId ?? '';
  assert.ok(taskId, '真实 SDK chatroom_work accept 创建任务');
  const firstBinding = app.chatroom.work.getBinding(accepted, 'requirements');
  assert.equal(firstBinding.scope, 'assignment');
  assert.equal(firstBinding.sessionId, reqSessionId);
  assert.equal(app.chatroom.work.publicTask(taskId)?.status, 'running',
    '回合成功与任务完成分别记录');
  const firstReply = app.chatroom.history(first.threadId).find(item => item.senderId === 'requirements');
  assert.ok(firstReply);
  const firstRun = app.chatroom.work.publicTask(taskId)?.assignments[0]?.lastRun;
  assert.equal(firstRun?.status, 'succeeded');
  await app.close();

  mode = 'complete';
  app = boot();
  userKey = app.chatroom.ensureUserSession(userKey);
  const followUp = app.chatroom.sendUser(userKey, {
    body: '@需求管理 补充完成条件，请继续原工作。', entryKey: 'follow-up', replyTo: firstReply.id,
  });
  await within(app.chatroom.drain(), 5000);
  assert.equal(followUp.context.collaborationTaskId, taskId);
  assert.equal(reqRestoredId, reqSessionId, '冷启动按绑定 ID 恢复同一 SDK Session');
  assert.ok(restoredContextSeen, '恢复的模型上下文包含上一回合的工具结果');
  const followUpPrompt = modelPrompts.find(item => item.includes(`当前消息 #${followUp.seq}`));
  assert.ok(followUpPrompt);
  assert.ok(!followUpPrompt.includes(first.body), '已在 SDK Session 内的旧群消息不重复注入');
  assert.equal(app.chatroom.work.publicTask(taskId)?.status, 'completed',
    '仅明确 update completed 才完成任务');
  const completed = app.chatroom.storage.byId(followUp.id)!;
  assert.equal(app.chatroom.work.getBinding(completed, 'requirements').lastProcessedSeq, followUp.seq);

  mode = 'personal';
  const personalProfile = profiles.get('requirements');
  assert.ok(personalProfile?.ok);
  const personal = await app.sessionService.openOrCreate('requirements', personalProfile.profile);
  assert.notEqual(personal.id, reqSessionId, '个人会话与群执行会话独立');
  await app.host.kill(personal.id);

  mode = 'parallel';
  const codeSlow = app.chatroom.sendUser(userKey, { body: '@代码开发 执行较慢的检查。', entryKey: 'parallel-codes' });
  const logsFast = app.chatroom.sendUser(userKey, { body: '@日志查询 立刻检查日志。', entryKey: 'parallel-logs' });
  await until(() => app.chatroom.storage.byId(logsFast.id)?.deliveryStatus === 'delivered');
  assert.equal(app.chatroom.storage.byId(codeSlow.id)?.deliveryStatus, 'running',
    '其他 Agent 不等待代码 Agent 的长回合');
  await within(app.chatroom.drain(), 5000);

  const codeBacklog = Array.from({ length: 6 }, (_, index) => app.chatroom.sendUser(userKey, {
    body: `@代码开发 依次处理积压检查 ${index + 1}。`, entryKey: `backlog-codes-${index}`,
  }));
  const backlogLogs = app.chatroom.sendUser(userKey, {
    body: '@日志查询 在代码 Agent 积压期间检查日志。', entryKey: 'backlog-logs',
  });
  await within((async () => {
    while (app.chatroom.storage.byId(backlogLogs.id)?.deliveryStatus !== 'delivered') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })(), 6000);
  assert.equal(app.chatroom.storage.byId(codeBacklog[0]!.id)?.deliveryStatus, 'running',
    '同一 Agent 的积压不能占满全部跨 Agent 投递名额');
  await within(app.chatroom.drain(), 8000);
  assert.equal(codeMaxActive, 1, '积压消息仍按成员顺序串行运行');

  mode = 'fifo';
  const sameAgentA = app.chatroom.sendUser(userKey, { body: '@代码开发 第一项检查。', entryKey: 'fifo-a' });
  const sameAgentB = app.chatroom.sendUser(userKey, { body: '@代码开发 第二项检查。', entryKey: 'fifo-b' });
  await within(app.chatroom.drain(), 5000);
  assert.equal(app.chatroom.storage.byId(sameAgentA.id)?.deliveryStatus, 'delivered');
  assert.equal(app.chatroom.storage.byId(sameAgentB.id)?.deliveryStatus, 'delivered');
  assert.equal(codeMaxActive, 1, '同一 Agent 跨话题也只运行一个 SDK 回合');

  mode = 'cancel-accept';
  const cancelSeed = app.chatroom.sendUser(userKey, { body: '@代码开发 接手可取消的长任务。', entryKey: 'cancel-seed' });
  await within(app.chatroom.drain(), 5000);
  const cancelTaskId = app.chatroom.storage.byId(cancelSeed.id)?.context.collaborationTaskId;
  assert.ok(cancelTaskId);
  const cancelReply = app.chatroom.history(cancelSeed.threadId).find(item => item.senderId === 'codes');
  assert.ok(cancelReply);
  mode = 'cancel-tool';
  const cancelMessage = app.chatroom.sendUser(userKey, {
    body: '@代码开发 现在执行较长的工具命令。', entryKey: 'cancel-tool', replyTo: cancelReply.id,
  });
  await until(() => app.store.sqlite.prepare(`SELECT 1 FROM chatroom_work_run_tools
    WHERE workspace_key = 'default' AND tool_call_id = 'slow-bash' AND finished_at IS NULL`)
    .get() !== undefined);
  const version = app.chatroom.work.publicTask(cancelTaskId)!.version;
  const cancelStarted = Date.now();
  const cancellation = await within(app.chatroom.taskAction(userKey, cancelTaskId,
    { action: 'cancel', entryKey: 'cancel-direct', expectedVersion: version }), 2500);
  assert.ok(Date.now() - cancelStarted < 2500, '取消指令直接作用于运行中的 SDK 工具');
  assert.equal(cancellation.task.status, 'cancelled');
  await within(app.chatroom.drain(), 3000);
  assert.equal(app.chatroom.hasReply(cancelMessage.id, 'codes'), false,
    '被取消的长工具回合不生成迟到回复');

  mode = 'uncertain-accept';
  const uncertainSeed = app.chatroom.sendUser(userKey, {
    body: '@代码开发 接手一个需要写文件的任务。', entryKey: 'uncertain-seed',
  });
  await within(app.chatroom.drain(), 5000);
  const uncertainTaskId = app.chatroom.storage.byId(uncertainSeed.id)?.context.collaborationTaskId;
  assert.ok(uncertainTaskId);
  const uncertainReply = app.chatroom.history(uncertainSeed.threadId).find(item => item.senderId === 'codes');
  assert.ok(uncertainReply);
  mode = 'uncertain-write';
  const realToolEnd = app.chatroom.work.markToolEnd.bind(app.chatroom.work);
  const realFinish = app.chatroom.work.finishRun.bind(app.chatroom.work);
  // Fault injection at the persistence boundary: SDK executes the tool, then the process loses its final writes.
  app.chatroom.work.markToolEnd = (runId, callId, isError) => {
    if (callId !== 'uncertain-write') realToolEnd(runId, callId, isError);
  };
  app.chatroom.work.finishRun = (runId, status, options) => status === 'succeeded'
    ? app.chatroom.work.getRun(runId)! : realFinish(runId, status, options);
  app.chatroom.sendUser(userKey, { body: '@代码开发 写入验收文件。',
    entryKey: 'uncertain-write', replyTo: uncertainReply.id });
  await within(app.chatroom.drain(), 5000);
  assert.equal(await readFile(join(codeDir, 'unknown-effect.txt'), 'utf8'), 'SDK 已执行\n');
  assert.equal(app.chatroom.work.publicTask(uncertainTaskId)?.assignments[0]?.lastRun?.status, 'running');
  await app.close();

  mode = 'personal';
  app = boot();
  userKey = app.chatroom.ensureUserSession(userKey);
  assert.equal(app.chatroom.work.publicTask(uncertainTaskId)?.status, 'needs_review',
    '重启后未落完成记录的工具操作保留待核对状态');
  assert.equal(app.chatroom.work.publicTask(uncertainTaskId)?.assignments[0]?.lastRun?.status, 'needs_review');
  await assert.rejects(app.chatroom.taskAction(userKey, uncertainTaskId, {
    action: 'resume', entryKey: 'resume-without-review',
    expectedVersion: app.chatroom.work.publicTask(uncertainTaskId)!.version,
  }), /核对/, '副作用未知不能自动重跑');

  console.log('PASS persistent chatroom runtime: cold restore, tool context, explicit completion, isolation, FIFO, direct cancellation and unknown-effect recovery');
} finally {
  await app.close();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = oldWorkspaceRoot;
  await env.close();
}
