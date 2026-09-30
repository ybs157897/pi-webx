/** Reusable offline Pi SDK seed for the requirement trace and browser acceptance. */
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { createModuleAgentSessionService } from '../server/module-agents/session-service';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots, profileRevision } from '../server/module-agents/snapshots';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createModuleAgentChatroomRuntime } from '../server/modules/chatroom/runtime';
import { getRequirementVersion, readRequirementTrace,
  submitRequirementDelivery } from '../server/modules/requirements/lifecycle';
import { memorySettings, sandbox, scripted, within } from './subagent-check-fixtures';

function call(name: string, args: Record<string, unknown>, id: string) {
  return { content: [{ type: 'toolCall' as const, id, name, arguments: args }], stopReason: 'toolUse' as const };
}
function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }], stopReason: 'stop' as const };
}

export async function createRequirementTraceFixture() {
  const env = await sandbox();
  env.runtime.hasConfiguredAuth = () => true;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousWorkspaceRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  process.env.PI_CODING_AGENT_DIR = env.agentDir;
  process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(env.root, 'workspaces');
  const sqlitePath = join(env.root, 'requirements.sqlite');
  const sessionDir = join(env.root, 'sessions');
  const codeDir = join(env.root, 'code');
  await mkdir(codeDir);
  const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
  const loadedCodes = profiles.get('codes');
  assert.ok(loadedCodes?.ok);
  const codesProfile = structuredClone(loadedCodes.profile);
  codesProfile.config.workspace = await realpath(codeDir);
  codesProfile.effectiveWorkspace = codesProfile.config.workspace;
  codesProfile.profileRevision = profileRevision(codesProfile);
  profiles.set('codes', { ok: true, profile: codesProfile });

  let phase: 'main' | 'error' | 'cancel' | 'branch' = 'main';
  let roomTaskId = '';
  let requirementsSessionId = '';
  let restoredRequirementsId = '';

  function boot() {
    const store = new WorkbenchStore(sqlitePath);
    const chatroom = getChatroomService(store, 'default');
    const host = new PiHost({
      definitions: { read: async () => ({ schemaVersion: 1, revision: 1,
        path: join(env.root, 'defs.json'), agents: [] }) },
      modelRuntimeFactory: async () => env.runtime,
      settingsManagerFactory: memorySettings,
      sessionDir,
    });
    const originalCreate = host.create.bind(host);
    host.create = async options => {
      const hosted = await originalCreate({ ...options, provider: env.model.provider, model: env.model.id });
      const agentId = options.moduleAgent?.scope.agentId;
      if (agentId === 'requirements' && phase === 'branch') {
        scripted(hosted.session, turn => {
          if (turn === 1) return call('requirements_dispatch', {
            entryKey: 'branch-dispatch', title: '旧任务中分叉出的独立需求',
            note: '独立根：生成 branch-result.txt 并保留自己的执行证据。',
            taskDrafts: [{ title: '创建独立需求结果文件', priority: 'normal' }],
          }, 'branch-dispatch');
          if (turn === 2) return call('chatroom_send', {
            to: 'codes', body: '@代码开发 为新需求生成独立文件 branch-result.txt。',
            entryKey: 'branch-to-code',
          }, 'branch-to-code');
          return text('独立新需求已分派。');
        });
      } else if (agentId === 'requirements' && !options.sessionPath && phase === 'main') {
        requirementsSessionId = hosted.id;
        scripted(hosted.session, turn => {
          if (turn === 1) return call('chatroom_work', {
            action: 'accept', title: '需求追溯 SDK 验收', entryKey: 'req-accept',
          }, 'req-accept');
          if (turn === 2 || turn === 3) return call('requirements_dispatch', {
            entryKey: 'req-dispatch', title: '实现可追溯文件交付',
            note: '目标：生成 result.txt；范围：代码目录；验收：文件内容精确匹配并保留运行证据。',
            taskDrafts: [{ title: '编写并验证 result.txt', priority: 'normal' }],
          }, turn === 2 ? 'req-dispatch' : 'req-dispatch-retry');
          if (turn === 4) return call('chatroom_work', {
            action: 'update', taskId: roomTaskId || chatroom.work.publicTasks()[0]!.id,
            status: 'waiting_for_agent', summary: '需求已保存并交给研发', entryKey: 'req-wait',
          }, 'req-wait');
          if (turn === 5) return call('chatroom_send', {
            to: 'codes', body: '@代码开发 按已导入待办写入 result.txt，并保留工具验证结果。',
            taskIds: store.listRecords('tasks').map(item => item.id), entryKey: 'req-to-code',
          }, 'req-to-code');
          return text('需求和待办已建立，研发接手。');
        });
      } else if (agentId === 'requirements' && options.sessionPath) {
        restoredRequirementsId = hosted.id;
        scripted(hosted.session, turn => turn === 1 ? call('chatroom_work', {
          action: 'update', taskId: roomTaskId, status: 'completed',
          summary: '研发与助理回报均已核对', entryKey: 'req-complete',
        }, 'req-complete') : text('需求分工已完成。'));
      } else if (agentId === 'codes' && phase === 'branch') {
        scripted(hosted.session, turn => {
          if (turn === 1) return call('chatroom_work', {
            action: 'accept', title: '独立需求研发分工', entryKey: 'branch-code-accept',
          }, 'branch-code-accept');
          if (turn === 2) return call('write', {
            path: 'branch-result.txt', content: 'independent root\n',
          }, 'branch-write');
          if (turn === 3) return call('chatroom_work', {
            action: 'update', taskId: chatroom.work.publicTasks().find(item =>
              item.title === '独立需求研发分工')!.id,
            status: 'completed', summary: '独立文件已写入', entryKey: 'branch-code-complete',
          }, 'branch-code-complete');
          return text('独立需求代码已完成。');
        });
      } else if (agentId === 'codes' && phase === 'cancel') {
        scripted(hosted.session, turn => turn === 1 ? call('chatroom_work', {
          action: 'accept', title: '验证取消事件留存', entryKey: 'cancel-accept',
        }, 'cancel-accept') : text('新工作已认领，等待进一步指令。'));
      } else if (agentId === 'codes') {
        scripted(hosted.session, turn => {
          if (turn === 1) return call('chatroom_work', {
            action: 'accept', title: '实现可追溯文件交付', entryKey: 'code-accept',
          }, 'code-accept');
          if (turn === 2) return call('write', {
            path: 'result.txt', content: 'trace fixture verified\n',
          }, 'write-result');
          if (turn === 3) return call('bash', { command: 'cat result.txt' }, 'bash-verify');
          if (turn === 4) return call('chatroom_work', {
            action: 'update', taskId: roomTaskId || chatroom.work.publicTasks()[0]!.id,
            status: 'completed', summary: '文件已写入并验证', entryKey: 'code-complete',
          }, 'code-complete');
          if (turn === 5) return call('chatroom_send', {
            to: 'assistant', body: '@我的助理 文件已写入，按交接版本完成关联待办。',
            taskIds: store.listRecords('tasks').map(item => item.id), entryKey: 'code-to-assistant',
          }, 'code-to-assistant');
          return text('代码文件已完成。');
        });
      } else if (agentId === 'assistant') {
        scripted(hosted.session, turn => {
          if (turn === 1) return call('chatroom_work', {
            action: 'accept', title: '核对研发交付', entryKey: 'assistant-accept',
          }, 'assistant-accept');
          if (turn === 2) return call('assistant_coordinate', {
            action: 'complete_tasks', taskIds: store.listRecords('tasks').map(item => item.id),
            evidence: '研发结果文件和工具执行均已记录',
          }, 'assistant-coordinate');
          if (turn === 3) return call('chatroom_work', {
            action: 'update', taskId: roomTaskId || chatroom.work.publicTasks()[0]!.id,
            status: 'completed', summary: '关联待办已完成', entryKey: 'assistant-complete',
          }, 'assistant-complete');
          return text('关联待办已完成。');
        });
      } else if (agentId === 'logs' && phase === 'error') {
        scripted(hosted.session, turn => turn === 1
          ? call('read', { path: 'missing-trace-fixture.txt' }, 'read-missing')
          : text('读取失败已记录，未修改任何文件。'));
      }
      return hosted;
    };
    const sessionService = createModuleAgentSessionService({ host, store, profiles,
      workspaceKey: 'default', snapshots: new ProfileSnapshots(join(env.root, 'snapshots')),
      storedSessions: async () => [] });
    const relay = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default',
      sessionService, chatroom, admissionTimeoutMs: 3000, turnTimeoutMs: 8000, pollMs: 5 });
    return { store, chatroom, host, sessionService, relay,
      async close() { await relay.stop(); await host.disposeAll(); store.close(); } };
  }

  let app = boot();
  let disposed = false;
  const userSessionKey = app.chatroom.ensureUserSession();
  try {
    const request = app.chatroom.sendUser(userSessionKey, {
      body: '@需求管理 请建立文件交付需求并交给代码 Agent。', entryKey: 'trace-request',
    });
    await within(app.chatroom.drain(), 10000);
    const requirements = app.store.listRecords('requirements');
    assert.equal(requirements.length, 1, '真实 SDK 同 entryKey 重试只保留一个正式需求根');
    const requirement = requirements[0]!;
    roomTaskId = app.chatroom.work.publicTasks()[0]?.id ?? '';
    assert.ok(roomTaskId);
    const requirementVersion = getRequirementVersion(app.store, requirement.id)!;
    assert.ok(requirementVersion > 0);
    const followUp = app.chatroom.sendUser(userSessionKey, {
      body: '@需求管理 请核对所有分工并结束该需求的内部任务。',
      entryKey: 'req-final', threadId: request.threadId, collaborationTaskId: roomTaskId,
    });
    await within(app.chatroom.drain(), 5000);
    assert.equal(app.chatroom.storage.byId(followUp.id)?.deliveryStatus, 'delivered');
    assert.equal(restoredRequirementsId, requirementsSessionId);
    assert.equal(app.chatroom.work.publicTask(roomTaskId)?.status, 'completed');
    const trace = readRequirementTrace(app.store, requirement.id);
    const codeRun = trace.links.runs.find(item => item.agentId === 'codes' && item.status === 'succeeded');
    assert.ok(codeRun);
    const submitted = submitRequirementDelivery(app.store, requirement.id, {
      entryKey: 'delivery-submit', expectedUpdatedAt: requirement.updatedAt,
      expectedRequirementVersion: requirementVersion,
      summary: '文件与关联待办已完成，见执行证据。',
      evidence: [{ kind: 'file', ref: 'result.txt', runId: codeRun.id, toolCallId: 'write-result' }],
    });
    assert.equal(submitted.delivery.status, 'submitted');
    assert.equal(submitted.trace.acceptanceReady, true, submitted.trace.blockers.join('; '));
    const fixture = {
      root: env.root, codeDir, profiles, userSessionKey,
      requirementId: requirement.id, requirementVersion, requirementUpdatedAt: requirement.updatedAt as string,
      roomTaskId, requestMessageId: request.id, requestThreadId: request.threadId,
      requirementsSessionId, restoredRequirementsId,
      codeRunId: codeRun.id as string, writeToolCallId: 'write-result',
      deliveryId: submitted.delivery.id, deliveryUpdatedAt: submitted.delivery.updatedAt,
      get store() { return app.store; }, get host() { return app.host; },
      get chatroom() { return app.chatroom; }, get sessionService() { return app.sessionService; },
      setPhase(value: 'main' | 'error' | 'cancel' | 'branch') { phase = value; },
      async restart() {
        if (disposed) throw new Error('需求追溯验收环境已关闭');
        await app.close(); app = boot(); return fixture;
      },
      async close() {
        if (disposed) return;
        disposed = true;
        await app.close();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
        else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = previousWorkspaceRoot;
        await env.close();
      },
    };
    return fixture;
  } catch (error) {
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
    else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = previousWorkspaceRoot;
    await env.close();
    throw error;
  }
}
