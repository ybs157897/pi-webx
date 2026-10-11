/** Real SDK room relay with scripted offline model turns and isolated SQLite. */
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { createModuleAgentSessionService } from '../server/module-agents/session-service';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots, profileRevision } from '../server/module-agents/snapshots';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createModuleAgentChatroomRuntime, formatChatroomPrompt, formatClaimPrompt, parseClaimVerdict } from '../server/modules/chatroom/runtime';

/* Windows runner 在并行门禁负载下脚本回合常压 2s 线；非「故意超时」的回合与准入
   预算在 win32 上放宽 4 倍（故意超时的极小值保持原样，测的就是超时）。 */
const budget = (ms: number): number => (process.platform === 'win32' ? ms * 4 : ms);
import { sandbox, memorySettings, scripted, until, within } from './subagent-check-fixtures';

const env = await sandbox();
env.runtime.hasConfiguredAuth = () => true;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldWorkspaceRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_CODING_AGENT_DIR = env.agentDir;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(env.root, 'workspaces');

const store = new WorkbenchStore(join(env.root, 'workbench.sqlite'));
const chatroom = getChatroomService(store, 'default');
const userSessionKey = chatroom.ensureUserSession();
const host = new PiHost({
  definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(env.root, 'defs.json'), agents: [] }) },
  modelRuntimeFactory: async () => env.runtime,
  settingsManagerFactory: memorySettings,
  sessionDir: join(env.root, 'sessions'),
});
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
const codesLoaded = profiles.get('codes');
assert.ok(codesLoaded?.ok);
const codesWorkspace = join(env.root, 'code-project');
await mkdir(codesWorkspace);
const canonicalCodesWorkspace = await realpath(codesWorkspace);
const codesProfile = structuredClone(codesLoaded.profile);
codesProfile.config.workspace = canonicalCodesWorkspace;
codesProfile.effectiveWorkspace = canonicalCodesWorkspace;
codesProfile.profileRevision = profileRevision(codesProfile);
profiles.set('codes', { ok: true, profile: codesProfile });
const sessionService = createModuleAgentSessionService({
  host, store, profiles, workspaceKey: 'default', snapshots: new ProfileSnapshots(join(env.root, 'snapshots')),
  storedSessions: async () => [],
});

let requirementsDeliveries = 0;
let lastLogsSessionId: string | null = null;
let codesClaimRuns = 0;
const originalCreate = host.create.bind(host);
host.create = async options => {
  const hosted = await originalCreate({ ...options, provider: env.model.provider, model: env.model.id });
  const agentId = options.moduleAgent?.scope.agentId;
  if (broadcastPhase) {
    if (agentId === 'codes') {
      scripted(hosted.session, turn => {
        if (hosted.session.getActiveToolNames().length === 0) {
          codesClaimRuns += 1;
          assert.deepEqual(hosted.session.getActiveToolNames(), [], '认领判定阶段不开放业务工具');
          return text(codesClaims ? '{"claim": true, "reason": "属于代码实施"}' : '{"claim": false, "reason": "与代码职责无关"}');
        }
        if (turn === 1) {
          assert.ok(hosted.session.getActiveToolNames().includes('write'), '认领后恢复配置允许的业务工具');
          assert.ok(!JSON.stringify(hosted.session.messages).includes('"claim": true'),
            '认领 JSON 不进入持久工作会话');
          return call('write', { path: 'chatroom-claim-result.txt', content: '认领后由代码 Agent 写入\n' }, 'write-claim');
        }
        return text('已写入 chatroom-claim-result.txt，验证为读取文件内容。');
      });
    } else {
      const reason = agentId === 'requirements' ? '属于研发实施' : agentId === 'logs' ? '与日志无关' : '待研发回报后再跟进';
      scripted(hosted.session, () => {
        assert.deepEqual(hosted.session.getActiveToolNames(), [], '非认领成员也不得调用工具');
        return text(agentId === 'logs' && logsUnreadable ? '无法判断' : `{"claim": false, "reason": "${reason}"}`);
      });
    }
    return hosted;
  }
  if (agentId === 'requirements') {
    const delivery = ++requirementsDeliveries;
    scripted(hosted.session, turn => {
      if (delivery > 1) return { content: [{ type: 'thinking', thinking: 'SECRET_CLARIFICATION_THINKING' },
        { type: 'text', text: '请 @需求管理 补充验收细节，我会继续整理。' }], stopReason: 'stop' };
      if (turn === 1) return call('requirements_dispatch', {
        entryKey: 'user-development-request', title: '实现内部交接',
        note: '目标：建立聊天室接力；验收：生成文件并回报。',
        taskDrafts: [{ title: '完成聊天室接力代码', priority: 'normal' }],
      }, 'dispatch-requirement');
      if (turn === 2) return call('chatroom_send', {
        to: 'codes', body: '@代码开发 请按已创建待办实施并回报实际验证。', entryKey: 'dispatch-codes',
      }, 'send-codes');
      return { content: [{ type: 'thinking', thinking: 'SECRET_REQUIREMENTS_THINKING' },
        { type: 'text', text: '需求已整理并交给研发。' }], stopReason: 'stop' };
    });
  } else if (agentId === 'assistant') {
    scripted(hosted.session, turn => {
      if (turn === 1) return call('assistant_coordinate', {
        action: 'complete_tasks', taskIds: store.listRecords('tasks').map(task => task.id),
        evidence: '研发已写入代码文件并报告检查结果',
      }, 'complete');
      return { content: [{ type: 'thinking', thinking: 'SECRET_ASSISTANT_THINKING' },
        { type: 'text', text: '研发已完成，关联待办已更新。@代码开发 请知悉。' }], stopReason: 'stop' };
    });
  } else if (agentId === 'codes') {
    scripted(hosted.session, turn => {
      if (turn === 1) return call('write', { path: 'chatroom-result.txt', content: '由代码 Agent 完成的实现\n' }, 'write');
      if (turn === 2) return call('chatroom_send', {
        to: 'assistant', body: '开发已完成：chatroom-result.txt 已写入；验证为读取文件内容。',
        entryKey: 'report-assistant', taskIds: store.listRecords('tasks').map(task => task.id),
      }, 'report');
      return { content: [{ type: 'thinking', thinking: 'SECRET_CODES_THINKING' },
        { type: 'text', text: '实现已提交给助理确认。' }], stopReason: 'stop' };
    });
  } else if (agentId === 'logs') {
    lastLogsSessionId = hosted.id;
    scripted(hosted.session, () => ({ content: [{ type: 'text', text: '这个回复应当因超时而丢弃' }], stopReason: 'stop' }), 200);
  }
  return hosted;
};

function call(name: string, args: Record<string, unknown>, id: string) {
  return { content: [{ type: 'toolCall' as const, id, name, arguments: args }], stopReason: 'toolUse' as const };
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }], stopReason: 'stop' as const };
}

let broadcastPhase = false;
let codesClaims = true;
let logsUnreadable = false;

let relay: ReturnType<typeof createModuleAgentChatroomRuntime> | undefined;
try {
  assert.equal(parseClaimVerdict('{"claim": true, "reason": "属于我"}'), 'claim');
  assert.equal(parseClaimVerdict(' {"claim":false, "reason": "x"} '), 'pass');
  assert.equal(parseClaimVerdict('说明文字 {"claim":false, "reason": "x"} 尾注'), 'unreadable');
  assert.equal(parseClaimVerdict('无需认领'), 'unreadable');
  assert.equal(parseClaimVerdict('{"claim":true} {"claim":false}'), 'unreadable');
  assert.equal(parseClaimVerdict('{"claim":"true"}'), 'unreadable');
  assert.equal(parseClaimVerdict('模型自说自话没有判定'), 'unreadable');
  const requirements = profiles.get('requirements');
  assert.ok(requirements?.ok);
  const busyRequirements = await originalCreate({ moduleAgent: await assembleModuleAgent({
    store, workspaceKey: 'default', agentId: 'requirements', profile: requirements.profile,
  }),
    provider: env.model.provider, model: env.model.id });
  busyRequirements.streaming = true;

  relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', sessionService, chatroom,
    admissionTimeoutMs: budget(2000), turnTimeoutMs: budget(2000), pollMs: 5 });
  const first = chatroom.sendUser(userSessionKey, {
    body: '@需求管理 请实现内部交接。现在直接整理需求、建立待办并交给代码开发；完成后让助理更新状态。',
    entryKey: 'user-request',
  });
  assert.equal(first.recipientId, 'requirements');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(store.listRecords('tasks').length, 0, '同模块现有会话忙时不抢跑需求导入');
  busyRequirements.streaming = false;
  await host.kill(busyRequirements.id);
  await within(chatroom.drain(), 5000);
  const messages = chatroom.read({ limit: 100 }).messages;
  assert.equal(messages.length, 4, JSON.stringify(messages));
  assert.equal(messages[0]?.id, first.id);
  assert.deepEqual(messages.map(message => message.senderId), ['user', 'requirements', 'codes', 'assistant']);
  assert.deepEqual(messages.slice(0, 3).map(message => message.consumptions[0]?.status),
    ['consumed', 'consumed', 'consumed'], '点名消息逐成员确认消费');
  assert.ok(messages[1]?.body.includes('@代码开发'));
  assert.ok(messages.slice(0, 3).every(message => message.deliveryStatus === 'delivered'));
  assert.equal(messages[3]?.deliveryStatus, 'none');
  assert.equal(messages[3]?.body, '研发已完成，关联待办已更新。@代码开发 请知悉。');
  assert.equal(messages[3]?.recipientId, null, '自动正文中的 @代码开发 不触发新派工');
  assert.ok(messages.every(message => !message.body.includes('SECRET_') && !message.body.includes('toolCall')),
    '公开群消息只有正文');
  assert.equal(store.listRecords('tasks').length, 1);
  assert.equal(store.listRecords('tasks')[0]?.done, true);
  assert.equal(await readFile(join(codesWorkspace, 'chatroom-result.txt'), 'utf8'), '由代码 Agent 完成的实现\n');
  assert.ok(store.listRecords('requirements')[0]?.importedAt, '需求 Agent 在群聊接力中直接创建待办');
  assert.ok(!host.list().some(item => item.moduleAgent?.agentId === 'codes'), '短命接收会话已回收');

  const clarification = chatroom.sendUser(userSessionKey, {
    body: '@需求管理 我还需要补充一些验收要求，请先向我澄清。', entryKey: 'clarification-request',
  });
  await within(chatroom.drain(), 3000);
  const clarificationRows = chatroom.read({ after: messages[3]!.seq, limit: 10 }).messages;
  assert.equal(clarificationRows.length, 2, '澄清正文中的 @自己 不产生额外投递');
  assert.equal(clarificationRows[0]?.id, clarification.id);
  assert.equal(clarificationRows[0]?.deliveryStatus, 'delivered');
  assert.equal(clarificationRows[1]?.body, '请 @需求管理 补充验收细节，我会继续整理。');
  assert.equal(clarificationRows[1]?.recipientId, null);
  assert.equal(clarificationRows[1]?.deliveryStatus, 'none');

  await relay.stop();
  relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', sessionService, chatroom,
    admissionTimeoutMs: 500, turnTimeoutMs: 25, pollMs: 5 });
  const timeoutMessage = chatroom.sendUser(userSessionKey, { body: '@日志查询 故意延迟的检查', entryKey: 'timeout-test' });
  await within(chatroom.drain(), 1500);
  const timeoutRow = chatroom.storage.byId(timeoutMessage.id);
  assert.equal(timeoutRow?.deliveryStatus, 'failed', '超时不能标为成功');
  assert.match(timeoutRow?.error ?? '', /超时/);
  assert.equal(chatroom.read({ watch: [timeoutMessage.seq] }).updates[0]?.consumptions[0]?.status, 'failed');
  assert.equal(chatroom.hasReply(timeoutMessage.id, 'logs'), false);
  assert.ok(!host.list().some(item => item.moduleAgent?.agentId === 'logs'));
  assert.ok(lastLogsSessionId);
  assert.throws(() => chatroom.send('logs', lastLogsSessionId!, {
    to: 'assistant', body: '迟到的工具调用不能变成新的群话题', entryKey: 'stale-tool',
  }), /接收会话已结束/, '超时后迟到的 chatroom_send 不得派生新群话题');

  const afterFailure = chatroom.sendUser(userSessionKey, {
    body: '@需求管理 失败后下一条消息仍需处理', entryKey: 'after-failure',
  });
  await within(chatroom.drain(), 3000);
  assert.equal(chatroom.read({ watch: [afterFailure.seq] }).updates[0]?.consumptions[0]?.status, 'consumed',
    '失败不阻塞下一条消息消费');

  await relay.stop();
  let enteredSlowOpen = false;
  let releaseSlowOpen!: (hosted: Awaited<ReturnType<typeof sessionService.openOrCreate>>) => void;
  const slowOpen = new Promise<Awaited<ReturnType<typeof sessionService.openOrCreate>>>(resolve => { releaseSlowOpen = resolve; });
  relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', chatroom,
    sessionService: { openOrCreate: async (agentId, profile) => {
      if (agentId === 'logs' && !enteredSlowOpen) { enteredSlowOpen = true; return slowOpen; }
      return sessionService.openOrCreate(agentId, profile);
    } },
    admissionTimeoutMs: 1000, turnTimeoutMs: 1000, pollMs: 5 });
  const slowMessage = chatroom.sendUser(userSessionKey, { body: '@日志查询 创建会话卡住', entryKey: 'slow-open' });
  const afterSlow = chatroom.sendUser(userSessionKey, { body: '@需求管理 下一条仍需消费', entryKey: 'after-slow-open' });
  await within(chatroom.drain(), 5000);
  const slowRow = chatroom.read({ watch: [slowMessage.seq] }).updates[0];
  assert.equal(slowRow?.consumptions[0]?.status, 'failed');
  assert.match(slowRow?.error ?? '', /创建会话等待超时/);
  assert.equal(chatroom.read({ watch: [afterSlow.seq] }).updates[0]?.consumptions[0]?.status, 'consumed',
    '会话装配挂起也不能堵住后续消息');
  const slowLogsProfile = profiles.get('logs');
  assert.ok(slowLogsProfile?.ok);
  const lateSlowSession = await sessionService.openOrCreate('logs', slowLogsProfile.profile);
  releaseSlowOpen(lateSlowSession);
  await until(() => host.get(lateSlowSession.id) === undefined);
  assert.equal(chatroom.hasReply(slowMessage.id, 'logs'), false);

  await relay.stop();
  let enteredOpen = false;
  let finishOpen!: (hosted: Awaited<ReturnType<typeof sessionService.openOrCreate>>) => void;
  const heldOpen = new Promise<Awaited<ReturnType<typeof sessionService.openOrCreate>>>(resolve => { finishOpen = resolve; });
  relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', chatroom,
    sessionService: { openOrCreate: async () => { enteredOpen = true; return heldOpen; } },
    admissionTimeoutMs: 500, turnTimeoutMs: 500, pollMs: 5 });
  const stoppedMessage = chatroom.sendUser(userSessionKey, { body: '@日志查询 关闭期间不得启动新回合', entryKey: 'stop-test' });
  await until(() => enteredOpen);
  const stopping = relay.stop();
  await within(stopping, 300);
  const logsProfile = profiles.get('logs');
  assert.ok(logsProfile?.ok);
  const lateSession = await sessionService.openOrCreate('logs', logsProfile.profile);
  finishOpen(lateSession);
  await until(() => host.get(lateSession.id) === undefined);
  assert.equal(chatroom.storage.byId(stoppedMessage.id)?.deliveryStatus, 'failed');
  assert.equal(chatroom.read({ watch: [stoppedMessage.seq] }).updates[0]?.consumptions[0]?.status, 'failed');
  assert.equal(chatroom.hasReply(stoppedMessage.id, 'logs'), false);
  assert.ok(!host.list().some(item => item.moduleAgent?.agentId === 'logs'), '停止期间新建会话被立即回收');

  const longFollowUp = `@需求管理 请继续核对 ${'范围与验收 '.repeat(180)} 当前提问尾部必须完整保留`;
  const followUp = chatroom.sendUser(userSessionKey, {
    body: longFollowUp, entryKey: 'follow-up', replyTo: messages[3]!.id,
  });
  assert.equal(followUp.threadId, first.threadId);
  assert.equal(followUp.replyTo, messages[3]!.id);
  const followUpPrompt = formatChatroomPrompt(followUp, chatroom.history(followUp.threadId));
  assert.ok(followUpPrompt.includes('来自 用户本人'));
  assert.ok(followUpPrompt.includes('当前提问尾部必须完整保留'), '用户最新提问不受历史截断限制');
  assert.ok(followUpPrompt.includes(first.body), '回复同一话题时包含前文');
  await relay.stop();
  relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', sessionService, chatroom,
    admissionTimeoutMs: budget(4000), turnTimeoutMs: budget(2000), claimTimeoutMs: budget(2000), pollMs: 5 });
  await within(chatroom.drain(), 5000);

  broadcastPhase = true;
  const tailSeq = chatroom.read({ after: 0, limit: 200 }).messages.at(-1)?.seq ?? 0;
  const broadcastMessage = chatroom.sendUser(userSessionKey, {
    body: '请在代码目录写入 chatroom-claim-result.txt 并回报验证方式。', entryKey: 'user-broadcast',
  });
  assert.equal(broadcastMessage.recipientId, null);
  assert.equal(broadcastMessage.deliveryStatus, 'pending', '未点名用户消息作为发布进入队列');
  const claimPrompt = formatClaimPrompt(broadcastMessage, chatroom.history(broadcastMessage.threadId));
  assert.ok(claimPrompt.includes('未点名任何成员'));
  assert.ok(claimPrompt.includes('{"claim": true'));
  assert.ok(claimPrompt.includes('chatroom-claim-result.txt'));
  assert.ok(claimPrompt.includes('用户本人'));
  await within(chatroom.drain(), 10000);
  const broadcastRow = chatroom.storage.byId(broadcastMessage.id);
  assert.equal(broadcastRow?.deliveryStatus, 'delivered');
  assert.deepEqual(broadcastRow?.claimants, ['codes'], '发布只被代码成员认领');
  const broadcastReceipts = chatroom.read({ watch: [broadcastMessage.seq] }).updates[0]?.consumptions ?? [];
  assert.deepEqual(broadcastReceipts.map(item => [item.agentId, item.status]),
    [['requirements', 'skipped'], ['codes', 'consumed'], ['logs', 'skipped'], ['assistant', 'skipped']],
    '群发布逐成员记录跳过或成功消费');
  assert.ok(broadcastReceipts.every(item => item.startedAt && item.finishedAt));
  const afterBroadcast = chatroom.read({ after: tailSeq, limit: 10 }).messages;
  assert.deepEqual(afterBroadcast.map(message => message.senderId), ['user', 'codes'], '只有认领成员公开回复');
  assert.ok(afterBroadcast[1]?.body.includes('chatroom-claim-result.txt'));
  assert.equal(afterBroadcast[1]?.recipientId, null);
  assert.equal(await readFile(join(codesWorkspace, 'chatroom-claim-result.txt'), 'utf8'), '认领后由代码 Agent 写入\n');

  const beforeDuplicate = codesClaimRuns;
  assert.equal(chatroom.sendUser(userSessionKey, {
    body: '请在代码目录写入 chatroom-claim-result.txt 并回报验证方式。', entryKey: 'user-broadcast',
  }).id, broadcastMessage.id);
  await within(chatroom.drain(), 1000);
  assert.equal(codesClaimRuns, beforeDuplicate, '重复发送不再次执行认领或业务工具');
  chatroom.storage.sqlite.prepare(`UPDATE chatroom_messages SET delivery_status = 'pending'
    WHERE workspace_key = ? AND id = ?`).run('default', broadcastMessage.id);
  const savedProfiles = [...profiles];
  profiles.clear();
  try { await within(chatroom.drain(), 1000); }
  finally { for (const [id, profile] of savedProfiles) profiles.set(id, profile); }
  assert.equal(codesClaimRuns, beforeDuplicate, '已确认消费的消息即使重新入队也不重复执行业务');
  assert.equal(chatroom.storage.byId(broadcastMessage.id)?.deliveryStatus, 'delivered');

  await relay.stop();
  relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', sessionService, chatroom,
    admissionTimeoutMs: budget(1000), turnTimeoutMs: budget(5000), claimTimeoutMs: budget(3000), pollMs: 5 });
  const originalCommand = host.command.bind(host);
  let slowBroadcastId: string | undefined;
  let delayedFullTurn = false;
  host.command = async (sessionId, command) => {
    const response = await originalCommand(sessionId, command);
    if (command.type === 'prompt' && command.id === `chatroom:${slowBroadcastId}:codes` && !delayedFullTurn) {
      delayedFullTurn = true;
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    return response;
  };
  try {
    const slowBroadcast = chatroom.sendUser(userSessionKey, {
      body: '请检查代码文件，群内其他成员随后判断是否接手。', entryKey: 'slow-full-turn',
    });
    slowBroadcastId = slowBroadcast.id;
    await within(chatroom.drain(), 8000);
    assert.equal(delayedFullTurn, true, '前一成员的完整回合确实超过入场时限');
    assert.deepEqual(chatroom.read({ watch: [slowBroadcast.seq] }).updates[0]?.consumptions.map(item => [item.agentId, item.status]),
      [['requirements', 'skipped'], ['codes', 'consumed'], ['logs', 'skipped'], ['assistant', 'skipped']],
      '前一成员处理耗时不消耗后续成员各自的入场预算');
  } finally { host.command = originalCommand; }
  await relay.stop();
  relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', sessionService, chatroom,
    admissionTimeoutMs: budget(4000), turnTimeoutMs: budget(2000), claimTimeoutMs: budget(2000), pollMs: 5 });

  logsUnreadable = true;
  const mixedBroadcast = chatroom.sendUser(userSessionKey, {
    body: '请再检查代码目录的文件并回报验证方式。', entryKey: 'mixed-broadcast',
  });
  await within(chatroom.drain(), 10000);
  const mixedRow = chatroom.read({ watch: [mixedBroadcast.seq] }).updates[0];
  assert.equal(mixedRow?.deliveryStatus, 'delivered', '至少一个成员成功消费时保留成功状态');
  assert.deepEqual(mixedRow?.consumptions.map(item => [item.agentId, item.status]),
    [['requirements', 'skipped'], ['codes', 'consumed'], ['logs', 'failed'], ['assistant', 'skipped']],
    '无法解析认领判断只令对应订阅者失败');
  assert.match(mixedRow?.consumptions.find(item => item.agentId === 'logs')?.error ?? '', /未给出可解析/);
  assert.match(mixedRow?.error ?? '', /部分成员/);
  logsUnreadable = false;

  codesClaims = false;
  const ignoredBroadcast = chatroom.sendUser(userSessionKey, {
    body: '今天先到这里，辛苦各位。', entryKey: 'user-ignored-broadcast',
  });
  await within(chatroom.drain(), 10000);
  const ignoredRow = chatroom.storage.byId(ignoredBroadcast.id);
  assert.equal(ignoredRow?.deliveryStatus, 'failed', '无人认领的广播如实失败');
  assert.match(ignoredRow?.error ?? '', /没有成员认领/);
  assert.ok(ignoredRow?.consumptions.every(item => item.status === 'skipped'));
  assert.equal(chatroom.hasReply(ignoredBroadcast.id, 'codes'), false);
  console.log('PASS chatroom runtime: relay + broadcast self-claim fan-out, real SDK tools, final text only, timeout and stop');
} finally {
  await relay?.stop();
  await host.disposeAll();
  store.close();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = oldWorkspaceRoot;
  await env.close();
}
