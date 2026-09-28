/** Real HTTP + PiHost lifecycle, fully isolated data and scripted model turns. */
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots, profileRevision } from '../server/module-agents/snapshots';
import { sandbox, memorySettings, scripted } from './subagent-check-fixtures';

const env = await sandbox();
env.runtime.hasConfiguredAuth = () => true;
const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = env.agentDir;
const store = new WorkbenchStore(join(env.root, 'workbench.sqlite'));
const host = new PiHost({ definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(env.root, 'defs.json'), agents: [] }) }, modelRuntimeFactory: async () => env.runtime, settingsManagerFactory: memorySettings, sessionDir: join(env.root, 'sessions') });
const originalCreate = host.create.bind(host);
host.create = async options => originalCreate({ ...options, cwd: env.cwd, provider: env.model.provider, model: env.model.id });
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
const loaded = profiles.get('logs'); assert.ok(loaded?.ok);
const original = structuredClone(loaded.profile);
const snapshots = new ProfileSnapshots(join(env.root, 'snapshots'));
let stored: any[] = [];
const app = express(); app.use(express.json());
app.use('/api/module-agents', createModuleAgentsRouter({ host, store, profiles, workspaceKey: 'default', snapshots, storedSessions: async () => stored }));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as any).port}/api/module-agents`;
const post = async (body: object, id = 'logs') => { const response = await fetch(`${base}/${id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
const unhandled: unknown[] = []; const capture = (error: unknown) => unhandled.push(error); process.on('unhandledRejection', capture);
try {
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => post({ requestId: 'same-create' })));
  assert.ok(concurrent.every(result => result.status === 200));
  const id = concurrent[0]!.body.session.id;
  assert.equal(new Set(concurrent.map(result => result.body.session.id)).size, 1);
  assert.equal(host.list().length, 1, 'same request creates exactly one session');
  assert.equal((await post({ requestId: 'same-create', sessionId: id })).status, 409, 'requestId cannot change target');
  const hosted = host.get(id)!;
  hosted.streaming = true;
  assert.equal((await post({ requestId: 'restore-running', sessionId: id })).status, 200);
  hosted.streaming = false;
  scripted(hosted.session, turn => turn === 1
    ? { content: [{ type: 'toolCall', id: 'logs-call', name: 'logs_search', arguments: { limit: 1 } }], stopReason: 'toolUse' }
    : { content: [{ type: 'text', text: 'fixture completed' }], stopReason: 'stop' });
  await hosted.session.prompt('query');
  assert.ok(hosted.session.messages.some(message => message.role === 'toolResult' && message.toolName === 'logs_search'));
  stored = [{ id, path: hosted.sessionFile, cwd: env.cwd }];
  await host.kill(id);
  const changed = structuredClone(original); changed.promptText = 'NEW-PROFILE-SENTINEL'; changed.skills[0]!.files['SKILL.md'] = 'NEW-SKILL-SENTINEL';
  changed.config.dataSources.logs!.id = 'new-source'; changed.profileRevision = profileRevision(changed);
  profiles.set('logs', { ok: true, profile: changed });
  const resumed = await Promise.all([post({ requestId: 'resume-a', sessionId: id }), post({ requestId: 'resume-b', sessionId: id })]);
  assert.ok(resumed.every(result => result.status === 200), JSON.stringify(resumed));
  assert.equal(host.list().length, 1, 'different requestIds restoring same session coalesce');
  const restored = host.get(id)!;
  assert.equal(restored.moduleAgent?.profileRevision, original.profileRevision);
  assert.ok(!restored.session.systemPrompt.includes('NEW-PROFILE-SENTINEL'));
  const oldSkill = await restored.session.getToolDefinition('skills_read')!.execute('skill', { name: 'log-analysis' }, undefined, undefined, {} as never);
  assert.ok(JSON.stringify(oldSkill).includes('先收窄范围'));
  const oldLogs = await restored.session.getToolDefinition('logs_search')!.execute('logs', { limit: 1 }, undefined, undefined, {} as never);
  assert.ok(JSON.stringify(oldLogs).includes('workbench-logs'));
  const fresh = await post({ requestId: 'new-profile' }); assert.equal(fresh.status, 200);
  assert.equal(host.get(fresh.body.session.id)?.moduleAgent?.profileRevision, changed.profileRevision);
  assert.ok(host.get(fresh.body.session.id)?.session.systemPrompt.includes('NEW-PROFILE-SENTINEL'));
  await host.kill(id);
  await rm(join(env.root, 'snapshots', `${original.profileRevision}.json`));
  assert.equal((await post({ requestId: 'missing-snapshot', sessionId: id })).status, 409);
  const broken = structuredClone(changed); broken.config.tools.push('unknown.tool'); broken.profileRevision = profileRevision(broken);
  profiles.set('logs', { ok: true, profile: broken });
  assert.equal((await post({ requestId: 'broken-config' })).status, 503);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, [], 'failed requests do not leak rejected finally promises');
  assert.equal((await post({ requestId: 'disabled' }, 'codes')).status, 503);
  console.log('PASS 模块 HTTP：创建幂等、运行中恢复、并发恢复合并、真实 SDK 工具回合、旧配置/Skill/源快照恢复、新会话新版本、缺快照拒绝、错误无未处理拒绝');
} finally {
  process.removeListener('unhandledRejection', capture); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host.disposeAll(); store.close(); if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; await env.close();
}
