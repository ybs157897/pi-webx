/** Life Agent SDK assembly and domain-tool integration without provider network access. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { todayISO } from '../server/workbench/schema.mjs';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { applyLifePlan } from '../server/modules/life/service';
import { memorySettings } from './subagent-check-fixtures';

const root = await mkdtemp(join(tmpdir(), 'pi-webx-life-agent-'));
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

try {
  const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
  const life = profiles.get('life');
  assert.ok(life?.ok, `life.yaml must load: ${life && !life.ok ? life.error : 'missing'}`);
  assert.equal(life.profile.config.model, undefined, 'life uses user-selected default model');
  assert.equal(life.profile.config.knowledge.homeBinding, 'life');
  const option = await assembleModuleAgent({ store, workspaceKey: 'default', agentId: 'life', profile: life.profile });
  const hosted = await host.create({ provider: model.provider, model: model.id, moduleAgent: option });
  const names = hosted.session.getAllTools().map(tool => tool.name).sort();
  assert.deepEqual(names, ['life_capture', 'life_context', 'life_propose_plan']);
  assert.deepEqual(hosted.session.getActiveToolNames().sort(), names);
  assert.equal(hosted.session.getToolDefinition('bash'), undefined);
  assert.equal(hosted.session.getToolDefinition('read'), undefined);
  assert.ok(hosted.session.systemPrompt.includes('生活秘书'));
  assert.equal(hosted.moduleAgent?.agentId, 'life');
  assert.equal(hosted.cwd, life.profile.effectiveWorkspace);

  const ctx = { sessionManager: hosted.session.sessionManager } as any;
  const tool = (name: string) => {
    const found = hosted.session.getToolDefinition(name);
    assert.ok(found, `${name} is in the SDK tool set`);
    return found;
  };
  const initial = (await tool('life_context').execute('context', {}, undefined, undefined, ctx)).details as any;
  assert.match(initial.data.now.localDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(initial.data.now.timeZone);
  const captured = (await tool('life_capture').execute('capture', { entries: [
    { entryKey: 'cat-food', originalText: '买猫粮', title: '买猫粮', tag: '购物' },
    { entryKey: 'property-fee', originalText: '周五前交物业费', title: '交物业费', due: nextFriday, tag: '缴费' },
    { entryKey: 'dental', originalText: '找时间预约洗牙', title: '预约洗牙', tag: '医疗' },
  ] }, undefined, undefined, ctx)).details as any;
  assert.equal(captured.data.entries.length, 3);
  assert.ok(captured.data.entries.every((item: any) => item.alreadyCaptured === false));
  assert.equal(captured.data.entries[0].record.due, null, 'undated item stays undated');
  assert.equal(captured.data.entries[2].record.due, null);
  assert.equal(captured.data.entries[1].record.due, nextFriday);
  const afterCapture = (await tool('life_context').execute('context-2', {}, undefined, undefined, ctx)).details as any;
  assert.equal(afterCapture.data.tasks.length, 3);
  const byTitle = new Map<string, any>(afterCapture.data.tasks.map((item: any) => [item.title, item]));
  const fee = byTitle.get('交物业费');
  const cat = byTitle.get('买猫粮');
  assert.ok(fee && cat);
  const proposed = (await tool('life_propose_plan').execute('proposal', {
    planKey: 'tomorrow', note: '缴费优先，中间预留休息与路程',
    entries: [
      { taskId: fee.id, expectedUpdatedAt: fee.updatedAt, plannedDate: tomorrow, startTime: '09:00', endTime: '09:30', kind: 'flexible' },
      { taskId: cat.id, expectedUpdatedAt: cat.updatedAt, plannedDate: tomorrow, startTime: '10:00', endTime: '10:30', kind: 'flexible' },
    ],
  }, undefined, undefined, ctx)).details as any;
  assert.equal(proposed.data.alreadyProposed, false);
  assert.equal(store.listRecords('tasks').find(item => item.id === fee.id)?.plannedDate, null,
    'proposal alone cannot schedule a task');
  const applied = applyLifePlan(store, proposed.data.plan.id, { expectedUpdatedAt: proposed.data.plan.updatedAt });
  assert.equal(applied.tasks.length, 2);
  assert.equal(applied.tasks[0]?.plannedDate, tomorrow);
  assert.equal(store.listRecords('tasks').find(item => item.title === '预约洗牙')?.plannedDate, null);

  const agent = hosted.session.agent;
  agent.getApiKey = () => 'offline-fixture';
  agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: '生活秘书验收回合' }],
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
  assert.ok(log.includes('pi-webx:module-agent'));
  await host.kill(hosted.id);
  const restored = await host.create({ sessionPath: sessionFile, moduleAgent: option });
  assert.equal(restored.moduleAgent?.agentId, 'life');
  assert.deepEqual(restored.session.getAllTools().map(tool => tool.name).sort(), names);
  assert.equal(store.listRecords('tasks').length, 3);
  await host.kill(restored.id);
  console.log('PASS life Agent: isolated SDK tools and workspace, capture, draft-only proposal, explicit apply, session restore');
} finally {
  await host.disposeAll();
  store.close();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = oldWorkspaceRoot;
  await rm(root, { recursive: true, force: true });
}
