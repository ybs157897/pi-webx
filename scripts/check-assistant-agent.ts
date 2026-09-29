/**
 * 我的助理 Agent 门禁：真实配置加载 + 真实 Pi SDK 装配，全程不联网、不调用模型。
 *
 * 钉死的行为：config/agents 只有四份注册 Agent（life/works 已退役）；assistant
 * 配置不指定模型（继承用户默认）、绑定 assistant 知识库、沿用旧生活助理的资源
 * 上限；装配后的工具集恰为 assistant_* 三个，没有 bash/read/edit，cwd 落在
 * assistant 专属工作区；会话日志带 pi-webx:module-agent 身份条目，重开身份与
 * 工具面不变；HTTP 入口对 works/life 一律 404。
 */
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { todayISO } from '../server/workbench/schema.mjs';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { AGENT_IDS } from '../server/module-agents/contracts';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { ProfileSnapshots } from '../server/module-agents/snapshots';
import { ASSISTANT_TOOL_NAMES } from '../server/modules/assistant/tools';
import { memorySettings } from './subagent-check-fixtures';

const root = await mkdtemp(join(tmpdir(), 'pi-webx-assistant-agent-'));
const tomorrow = todayISO(new Date(Date.now() + 86_400_000));
const nextFriday = (() => {
  const day = new Date();
  day.setDate(day.getDate() + ((5 - day.getDay() + 7) % 7 || 7));
  return todayISO(day);
})();
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldWorkspaceRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(root, 'workspaces');
await mkdir(agentDir, { recursive: true });
await mkdir(sessionDir, { recursive: true });
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: null,
  allowModelNetwork: false, refreshOnCreate: false,
});
const model = runtime.getModels('deepseek')[0];
assert.ok(model, 'offline SDK catalogue needs a model');
const host = new PiHost({
  definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }) },
  modelRuntimeFactory: async () => runtime,
  settingsManagerFactory: memorySettings,
  sessionDir,
});
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
const app = express();
app.use(express.json());
app.use('/api/module-agents', createModuleAgentsRouter({
  host, store, profiles, workspaceKey: 'default',
  snapshots: new ProfileSnapshots(join(root, 'snapshots')),
  storedSessions: async () => [],
}));
const server = app.listen(0, '127.0.0.1');

try {
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/module-agents`;

  /* 配置目录：只有四份注册 Agent，life/works 不再是身份 */
  assert.deepEqual([...AGENT_IDS], ['requirements', 'codes', 'logs', 'assistant']);
  assert.equal(profiles.size, 4, 'config/agents 只应有四份注册配置');
  for (const id of AGENT_IDS) {
    const result = profiles.get(id);
    assert.ok(result?.ok === true, `config/agents/${id}.yaml 必须可加载：${result && !result.ok ? result.error : 'missing'}`);
  }
  assert.equal(profiles.has('life' as never), false, 'life.yaml 必须删除');
  assert.equal(profiles.has('works' as never), false, 'works.yaml 必须删除');

  const loaded = profiles.get('assistant');
  assert.ok(loaded?.ok);
  const assistant = loaded.profile;
  assert.equal(assistant.config.enabled, true);
  assert.equal(assistant.config.model, undefined, 'assistant 沿用用户选择的默认模型');
  assert.equal(assistant.config.knowledge.homeBinding, 'assistant');
  assert.deepEqual(assistant.config.knowledge.sharedReadBindings, []);
  assert.deepEqual(assistant.config.tools, ['assistant.context', 'assistant.capture', 'assistant.proposePlan']);
  assert.deepEqual(assistant.config.limits, { maxRunningSessions: 1, maxToolOutputChars: 24000 },
    '资源上限沿用生活秘书的历史值');
  assert.ok(assistant.promptText.includes('我的助理'));
  assert.ok(!assistant.promptText.includes('生活秘书'));

  /* 装配：工具面、工作区、身份 */
  const option = await assembleModuleAgent({ store, workspaceKey: 'default', agentId: 'assistant', profile: assistant });
  const hosted = await host.create({ provider: model.provider, model: model.id, moduleAgent: option });
  const names = hosted.session.getAllTools().map(tool => tool.name).sort();
  const expected = ['assistant_capture', 'assistant_context', 'assistant_propose_plan'];
  assert.deepEqual(names, expected);
  assert.deepEqual([...Object.values(ASSISTANT_TOOL_NAMES)].sort(), expected, '配置名映射必须与 SDK 工具名一一对应');
  assert.deepEqual(hosted.session.getActiveToolNames().sort(), expected);
  for (const forbidden of ['bash', 'read', 'edit', 'write', 'requirements_save_draft']) {
    assert.equal(hosted.session.getToolDefinition(forbidden), undefined, `assistant 不得拥有 ${forbidden}`);
  }
  assert.ok(hosted.session.systemPrompt.includes('我的助理'));
  assert.equal(hosted.moduleAgent?.agentId, 'assistant');
  assert.equal(hosted.moduleAgent?.workspaceKey, 'default');
  assert.equal(hosted.cwd, assistant.effectiveWorkspace, 'cwd 必须绑定配置的默认工作区');
  assert.equal(path.basename(hosted.cwd), 'assistant');

  /* 真实 SDK 工具回合：读取上下文 → 收集（无默认截止日）→ 草稿不落排期 */
  const ctx = { sessionManager: hosted.session.sessionManager } as never;
  const tool = (name: string) => {
    const found = hosted.session.getToolDefinition(name);
    assert.ok(found, `${name} is in the SDK tool set`);
    return found;
  };
  const initial = (await tool('assistant_context').execute('context', {}, undefined, undefined, ctx)).details as any;
  assert.match(initial.data.now.localDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(initial.data.now.localTime, /^\d{2}:\d{2}$/);
  assert.ok(initial.data.now.timeZone);
  assert.equal(initial.data.tasks.length, 0);
  const captured = (await tool('assistant_capture').execute('capture', { entries: [
    { entryKey: 'cat-food', originalText: '买猫粮', title: '买猫粮', tag: '购物' },
    { entryKey: 'property-fee', originalText: '周五前交物业费', title: '交物业费', due: nextFriday, tag: '缴费' },
    { entryKey: 'dental', originalText: '找时间预约洗牙', title: '预约洗牙', tag: '医疗' },
  ] }, undefined, undefined, ctx)).details as any;
  assert.equal(captured.data.entries.length, 3);
  assert.ok(captured.data.entries.every((item: any) => item.alreadyCaptured === false));
  assert.equal(captured.data.entries[0].record.due, null, '未说明日期的事项不能自动设为今天截止');
  assert.equal(captured.data.entries[2].record.due, null);
  assert.equal(captured.data.entries[1].record.due, nextFriday);
  const afterCapture = (await tool('assistant_context').execute('context-2', {}, undefined, undefined, ctx)).details as any;
  assert.equal(afterCapture.data.tasks.length, 3);
  const byTitle = new Map<string, any>(afterCapture.data.tasks.map((item: any) => [item.title, item]));
  const fee = byTitle.get('交物业费');
  const cat = byTitle.get('买猫粮');
  assert.ok(fee && cat);
  const proposed = (await tool('assistant_propose_plan').execute('proposal', {
    planKey: 'tomorrow', note: '缴费优先，中间预留休息与路程',
    entries: [
      { taskId: fee.id, expectedUpdatedAt: fee.updatedAt, plannedDate: tomorrow, startTime: '09:00', endTime: '09:30', kind: 'flexible' },
      { taskId: cat.id, expectedUpdatedAt: cat.updatedAt, plannedDate: tomorrow, startTime: '10:00', endTime: '10:30', kind: 'flexible' },
    ],
  }, undefined, undefined, ctx)).details as any;
  assert.equal(proposed.data.alreadyProposed, false);
  assert.equal(proposed.data.plan.appliedAt, null);
  assert.equal(store.listRecords('plans').length, 1);
  assert.equal(store.listRecords('tasks').find(item => item.id === fee.id)?.plannedDate, null,
    '只保存草稿不能排期，必须等界面确认');
  assert.equal(store.listRecords('tasks').find(item => item.title === '预约洗牙')?.plannedDate, null);

  /* 会话日志身份 + 重开：agentId 与工具面都不变 */
  const agent = hosted.session.agent;
  agent.getApiKey = () => 'offline-fixture';
  agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: '我的助理验收回合' }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  };
  await agent.prompt('请帮我记住这几件事');
  const sessionFile = hosted.sessionFile;
  assert.ok(sessionFile);
  const log = await readFile(sessionFile, 'utf8');
  assert.ok(log.includes('pi-webx:module-agent'), '会话日志必须带模块身份条目');
  assert.ok(log.includes('"assistant"'));
  assert.ok(!log.includes('"life"') && !log.includes('"works"'));
  await host.kill(hosted.id);
  const restored = await host.create({ sessionPath: sessionFile, moduleAgent: option });
  assert.equal(restored.moduleAgent?.agentId, 'assistant');
  assert.equal(restored.moduleAgent?.workspaceKey, 'default');
  assert.deepEqual(restored.session.getAllTools().map(tool => tool.name).sort(), expected);
  assert.ok(restored.session.systemPrompt.includes('我的助理'));
  await host.kill(restored.id);

  /* 交叉断言：退役身份在 HTTP 入口不存在 */
  const post = (id: string) => fetch(`${base}/${id}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: `retired-${id}` }),
  });
  for (const retired of ['life', 'works']) {
    const response = await post(retired);
    assert.equal(response.status, 404, `${retired} 不再是可创建的模块 Agent`);
    assert.match(((await response.json()) as { error: string }).error, /unknown module agent/);
  }
  const capabilities = await (await fetch(base)).json() as { agents: Array<{ id: string; tools?: string[] }> };
  assert.deepEqual(capabilities.agents.map(agent => agent.id), ['requirements', 'codes', 'logs', 'assistant']);
  assert.deepEqual(capabilities.agents.find(agent => agent.id === 'assistant')?.tools,
    ['assistant.context', 'assistant.capture', 'assistant.proposePlan']);

  assert.equal(store.listRecords('tasks').length, 3);
  console.log('PASS assistant Agent: four profiles only, offline SDK tools and workspace, draft-only plan, session identity and retired ids');
} finally {
  server.close();
  await host.disposeAll();
  store.close();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = oldWorkspaceRoot;
  await rm(root, { recursive: true, force: true });
}
