import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { createModuleAgentSettingsRouter } from '../server/module-agents/settings/router';
import { ModuleAgentSettingsService } from '../server/module-agents/settings/service';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots } from '../server/module-agents/snapshots';
import { profileRevision } from '../server/module-agents/snapshots';
import { replaceFiles } from '../server/module-agents/settings/persistence';
import type { AgentSettingsUpdate, AgentSettingsView } from '../src/shared/module-agent-settings';
import { deferred, sandbox, scripted, within } from './subagent-check-fixtures';

const env = await sandbox();
const savedWorkspaceRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(env.root, 'agent-workspaces');
const root = join(env.root, 'config');
await cp(defaultAgentsConfigRoot(), root, { recursive: true });
await mkdir(join(root, 'skills/logs/log-analysis/references'), { recursive: true });
await writeFile(join(root, 'skills/logs/log-analysis/references/example.md'), 'A-SUPPLEMENT');
for (const [slug, marker] of [['declared-b', 'B-SECRET'], ['undeclared-c', 'C-SECRET']]) {
  await mkdir(join(root, `skills/logs/${slug}/references`), { recursive: true });
  await writeFile(join(root, `skills/logs/${slug}/SKILL.md`), `---\nname: ${slug}\ndescription: ${slug} candidate\n---\n${marker}`);
  await writeFile(join(root, `skills/logs/${slug}/references/secret.md`), `${marker}-SUPPLEMENT`);
}
const bKey = './skills/logs/declared-b/SKILL.md';
const cKey = './skills/logs/undeclared-c/SKILL.md';
const dormantLink = join(root, 'skills/logs/declared-b/references/dormant-link.md');
await symlink(join(root, 'prompts/logs.md'), dormantLink);
await writeFile(join(root, 'logs.yaml'), (await readFile(join(root, 'logs.yaml'), 'utf8'))
  .replace('  - ./skills/logs/log-analysis/SKILL.md', `  - ./skills/logs/log-analysis/SKILL.md\n  - path: ${bKey}\n    enabled: false`));
await writeFile(join(env.agentDir, 'models.json'), JSON.stringify({ providers: {
  'settings-fixture': { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'fixture-only', models: [
    { id: 'model-a', name: 'Fixture A' }, { id: 'model-b', name: 'Fixture B' },
  ] },
} }));
env.runtime = await ModelRuntime.create({ authPath: join(env.agentDir, 'auth.json'), modelsPath: join(env.agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
const modelA = { provider: 'settings-fixture', id: 'model-a' };
const modelB = { provider: 'settings-fixture', id: 'model-b' };
assert.ok(env.runtime.getModel(modelA.provider, modelA.id));
assert.ok(env.runtime.getModel(modelB.provider, modelB.id));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = env.agentDir;
env.runtime.hasConfiguredAuth = () => true;
const store = new WorkbenchStore(join(env.root, 'workbench.sqlite'));
const host = new PiHost({
  definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(env.root, 'defs.json'), agents: [] }) },
  modelRuntimeFactory: async () => env.runtime,
  settingsManagerFactory: () => SettingsManager.inMemory({ defaultProvider: modelA.provider, defaultModel: modelA.id, retry: { enabled: false }, compaction: { enabled: false } }, { projectTrusted: false }),
  sessionDir: join(env.root, 'sessions'),
});
const originalCreate = host.create.bind(host);
host.create = async options => originalCreate({ ...options, cwd: env.cwd });
const profiles = await loadAgentProfiles(root);
const snapshots = new ProfileSnapshots(join(env.root, 'snapshots'));
let stored: Array<{ id: string; path: string; cwd: string }> = [];
const service = new ModuleAgentSettingsService({ root, profiles, validateModel: async model => !!env.runtime.getModel(model.provider, model.id) });
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/module-agents', createModuleAgentSettingsRouter(service));
app.use('/api/module-agents', createModuleAgentsRouter({ host, store, profiles, workspaceKey: 'default', snapshots, storedSessions: async () => stored }));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/module-agents`;
async function request(id: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/${id}/settings`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as AgentSettingsView & { error?: string } };
}
async function session(requestId: string, sessionId?: string) {
  const response = await fetch(`${base}/logs/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, ...(sessionId ? { sessionId } : {}) }) });
  return { status: response.status, body: await response.json() as { session: { id: string }; error?: string } };
}
function update(view: AgentSettingsView): AgentSettingsUpdate {
  return { revision: view.revision, prompt: view.prompt, model: view.model, skills: view.skills.map(({ key, selected }) => ({ key, selected })) };
}

try {
  const first = await request('logs'); assert.equal(first.status, 200);
  const initial = first.body;
  const originalProfileRevision = (profiles.get('logs') as { ok: true; profile: { profileRevision: string } }).profile.profileRevision;
  const currentProfile = profiles.get('logs');
  assert.ok(currentProfile?.ok);
  const { skillEntries: _unused, ...legacyConfig } = currentProfile.profile.config;
  const legacyProfile = { ...currentProfile.profile, config: legacyConfig };
  legacyProfile.profileRevision = profileRevision(legacyProfile);
  await snapshots.save(legacyProfile);
  assert.equal((await snapshots.read(legacyProfile.profileRevision)).config.skillEntries, undefined, 'old profile snapshots need no candidate field');
  const originalNonSkillTools = (profiles.get('logs') as { ok: true; profile: { config: { tools: string[] } } }).profile.config.tools.filter(tool => tool !== 'skills.read');
  assert.equal(initial.enabled, true);
  assert.equal(initial.implemented, true);
  assert.deepEqual(initial.skills.map(skill => [skill.key, skill.selected]), [['./skills/logs/log-analysis/SKILL.md', true], [bKey, false]]);
  assert.equal(initial.skills[0]?.editable, true);
  assert.match(initial.skills[0]?.content ?? '', /name: log-analysis/);
  assert.ok(!JSON.stringify(initial).includes(cKey));
  assert.ok(!JSON.stringify(initial).includes('LOGS_MCP_AUTHORIZATION'), 'API must not return key references');
  const codes = await request('codes'); assert.equal(codes.status, 200);
  const codesEdit = update(codes.body); codesEdit.prompt += '\nDISABLED-EDIT';
  assert.equal((await request('codes', 'PUT', codesEdit)).status, 200);
  assert.equal((await request('codes')).body.enabled, codes.body.enabled, 'settings save must preserve Agent enablement');
  assert.equal((await request('codes')).body.implemented, codes.body.implemented);
  assert.equal((await request('unknown')).status, 404);

  const beforeConfig = await readFile(join(root, 'logs.yaml'), 'utf8');
  const old = await session('old'); assert.equal(old.status, 200, JSON.stringify(old.body));
  const oldId = old.body.session.id;
  const oldHosted = host.get(oldId)!;
  assert.equal(oldHosted.moduleAgent?.profileRevision, originalProfileRevision);
  assert.equal(oldHosted.session.model?.id, modelA.id, 'empty model inherits fixture default');
  scripted(oldHosted.session, () => ({ content: [{ type: 'text', text: 'fixture' }], stopReason: 'stop' }));
  await oldHosted.session.prompt('persist');
  stored = [{ id: oldId, path: oldHosted.sessionFile, cwd: env.cwd }];

  const next = update(initial);
  next.prompt += '\nNEW-PROMPT-SENTINEL';
  next.model = modelB;
  const saved = await request('logs', 'PUT', next); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.notEqual(saved.body.revision, initial.revision);
  assert.equal(saved.body.skills.length, 2);
  assert.equal((await request('logs')).body.revision, saved.body.revision, 'GET must reread files');
  assert.equal((await request('logs', 'PUT', next)).status, 409, 'stale request must conflict');
  const yaml = await readFile(join(root, 'logs.yaml'), 'utf8');
  assert.ok(yaml.includes('LOGS_MCP_AUTHORIZATION') && yaml.includes('占位地址'), 'unrelated YAML and comment remain');
  assert.ok(yaml.includes('enabled: true'));
  assert.ok(beforeConfig.includes('logs.search'));
  assert.equal((await request('codes')).body.enabled, codes.body.enabled, 'other module enablement remains unchanged');

  const newSession = await session('new'); assert.equal(newSession.status, 200, JSON.stringify(newSession.body));
  const fresh = host.get(newSession.body.session.id)!;
  assert.equal(fresh.moduleAgent?.profileRevision, (profiles.get('logs') as { ok: true; profile: { profileRevision: string } }).profile.profileRevision);
  assert.ok(fresh.session.systemPrompt.includes('NEW-PROMPT-SENTINEL'));
  assert.equal(fresh.session.model?.provider, modelB.provider);
  assert.equal(fresh.session.model?.id, modelB.id);
  assert.ok(!fresh.session.systemPrompt.includes('declared-b') && !fresh.session.systemPrompt.includes('undeclared-c'));
  const skillRead = fresh.session.getToolDefinition('skills_read')!;
  const supplement = await skillRead.execute('supplement', { name: 'log-analysis', resource: 'references/example.md' }, undefined, undefined, {} as never);
  assert.ok(JSON.stringify(supplement).includes('A-SUPPLEMENT'));
  for (const name of ['declared-b', 'undeclared-c']) {
    const hidden = await skillRead.execute('hidden', { name, resource: 'references/secret.md' }, undefined, undefined, {} as never);
    assert.equal(hidden.details?.found, false);
  }
  const freshProfile = (profiles.get('logs') as { ok: true; profile: { skills: Array<{name:string;files:Record<string,string>}>; config: { skills:string[] } } }).profile;
  assert.deepEqual(freshProfile.skills.map(skill => skill.name), ['log-analysis']);
  assert.deepEqual(freshProfile.config.skills, ['./skills/logs/log-analysis/SKILL.md']);
  assert.ok(!JSON.stringify(freshProfile).includes('B-SECRET') && !JSON.stringify(freshProfile).includes('C-SECRET'));
  await rm(dormantLink);
  await host.kill(oldId);
  const restored = await session('restore-old', oldId); assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const pinned = host.get(oldId)!;
  assert.equal(pinned.moduleAgent?.profileRevision, originalProfileRevision);
  assert.notEqual(originalProfileRevision, fresh.moduleAgent?.profileRevision);
  assert.equal(pinned.session.model?.id, modelA.id);
  assert.ok(!pinned.session.systemPrompt.includes('NEW-PROMPT-SENTINEL'));
  const pinnedSkill = await pinned.session.getToolDefinition('skills_read')!.execute('old', { name: 'log-analysis' }, undefined, undefined, {} as never);
  assert.ok(JSON.stringify(pinnedSkill).includes('log-analysis'));

  const duplicate = update(saved.body);
  duplicate.skills[1] = { ...duplicate.skills[0]! };
  assert.equal((await request('logs', 'PUT', duplicate)).status, 400);
  const traversal = update(saved.body);
  traversal.skills.push({ key: './skills/logs/../codes/attack/SKILL.md', selected: true });
  assert.equal((await request('logs', 'PUT', traversal)).status, 400);
  assert.equal((await request('logs', 'PUT', { ...update(saved.body), skills: update(saved.body).skills.slice(0, 1) })).status, 400);
  assert.equal((await request('logs', 'PUT', { ...update(saved.body), skills: [...update(saved.body).skills, { key: cKey, selected: true }] })).status, 400);
  assert.equal((await request('logs', 'PUT', { ...update(saved.body), skills: [{ ...update(saved.body).skills[0], content: 'attack' }, update(saved.body).skills[1]] })).status, 400);
  assert.equal((await request('logs', 'PUT', { ...update(saved.body), skills: [{ ...update(saved.body).skills[0], path: cKey }, update(saved.body).skills[1]] })).status, 400);
  const wrongModel = update(saved.body); wrongModel.model = { provider: 'nonexistent', id: 'nonexistent' };
  assert.equal((await request('logs', 'PUT', wrongModel)).status, 400);
  assert.equal((await request('logs')).body.revision, saved.body.revision, 'invalid writes leave files unchanged');

  const ownSkillPath = join(root, 'skills/logs/log-analysis/SKILL.md');
  await writeFile(ownSkillPath, (await readFile(ownSkillPath, 'utf8')) + '\nEXTERNAL-EDIT');
  assert.equal((await request('logs', 'PUT', update(saved.body))).status, 409, 'external Skill edit conflicts');
  const revised = (await request('logs')).body;
  await writeFile(join(root, 'logs.yaml'), (await readFile(join(root, 'logs.yaml'), 'utf8')) + '\n# external change\n');
  assert.equal((await request('logs', 'PUT', update(revised))).status, 409, 'raw YAML comments participate in revision');

  const symlinkPath = join(root, 'skills/logs/undeclared-link');
  await symlink(join(root, 'skills/codes'), symlinkPath);
  assert.equal((await request('logs')).status, 200, 'undeclared directory is never scanned');
  await rm(symlinkPath);
  const supplementalLink = join(root, 'skills/logs/log-analysis/references/link.md');
  await symlink(join(root, 'prompts/codes.md'), supplementalLink);
  assert.equal((await request('logs')).status, 400, 'symlinked supplementary resource rejected');
  await rm(supplementalLink);

  async function selectSkills(keys: string[], label: string) {
    const current = (await request('logs')).body;
    const body = update(current);
    for (const skill of body.skills) skill.selected = keys.includes(skill.key);
    const savedSelection = await request('logs', 'PUT', body);
    assert.equal(savedSelection.status, 200, JSON.stringify(savedSelection.body));
    const active = await session(label);
    assert.equal(active.status, 200, JSON.stringify(active.body));
    const hosted = host.get(active.body.session.id)!;
    assert.equal(!!hosted.session.getToolDefinition('skills_read'), keys.length > 0);
    assert.equal(hosted.moduleAgent?.profileRevision, (profiles.get('logs') as { ok: true; profile: { profileRevision: string } }).profile.profileRevision);
    const tools = (profiles.get('logs') as { ok: true; profile: { config: { tools: string[] } } }).profile.config.tools;
    assert.deepEqual(tools.filter(tool => tool !== 'skills.read'), originalNonSkillTools);
    assert.equal(tools.includes('skills.read'), keys.length > 0);
    return savedSelection.body;
  }
  const firstKey = './skills/logs/log-analysis/SKILL.md';
  await selectSkills([firstKey], 'first-skill-only');
  const allOff = await selectSkills([], 'last-skill-removed');
  assert.deepEqual(allOff.skills.map(skill => skill.selected), [false, false]);
  const offYaml = await readFile(join(root, 'logs.yaml'), 'utf8');
  assert.ok(offYaml.includes(bKey) && offYaml.includes(firstKey), 'deselection retains declared candidates');
  const reselected = await selectSkills([bKey], 'skill-b-reselected');
  assert.deepEqual(reselected.skills.map(skill => skill.selected), [false, true]);
  const restarted = new ModuleAgentSettingsService({ root, profiles: await loadAgentProfiles(root), validateModel: async () => true });
  assert.deepEqual((await restarted.get('logs')).skills.map(skill => skill.selected), [false, true]);
  const bSession = host.get((await session('skill-b-after-reload')).body.session.id)!;
  assert.ok(bSession.session.systemPrompt.includes('declared-b'));
  assert.ok(!bSession.session.systemPrompt.includes('- "log-analysis":') && !bSession.session.systemPrompt.includes('undeclared-c'));
  const bResource = await bSession.session.getToolDefinition('skills_read')!.execute('b', { name: 'declared-b', resource: 'references/secret.md' }, undefined, undefined, {} as never);
  assert.equal(bResource.details?.found, true);
  const aHidden = await bSession.session.getToolDefinition('skills_read')!.execute('a', { name: 'log-analysis', resource: 'references/example.md' }, undefined, undefined, {} as never);
  assert.equal(aHidden.details?.found, false);
  // A hand-edited YAML can disable every Skill while retaining the old tool declaration.
  await writeFile(join(root, 'logs.yaml'), (await readFile(join(root, 'logs.yaml'), 'utf8')).replace(`  - ${bKey}`, `  - path: ${bKey}\n    enabled: false`));
  const manualProfiles = await loadAgentProfiles(root);
  const manual = manualProfiles.get('logs');
  assert.ok(manual?.ok);
  assert.deepEqual(manual.profile.config.skills, []);
  assert.ok(manual.profile.config.tools.includes('skills.read'));
  profiles.set('logs', manual);
  const manualSession = await session('manual-all-off');
  assert.equal(manualSession.status, 200, JSON.stringify(manualSession.body));
  assert.equal(host.get(manualSession.body.session.id)?.session.getToolDefinition('skills_read'), undefined);
  const manualView = (await request('logs')).body;
  assert.deepEqual(manualView.skills.map(skill => skill.selected), [false, false]);
  const restoredB = update(manualView); restoredB.skills[1]!.selected = true;
  assert.equal((await request('logs', 'PUT', restoredB)).status, 200);
  const inherit = update(reselected); inherit.model = null;
  inherit.revision = (await request('logs')).body.revision;
  const inherited = await request('logs', 'PUT', inherit);
  assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
  const inheritedSession = await session('default-after-clear');
  assert.equal(inheritedSession.status, 200, JSON.stringify(inheritedSession.body));
  assert.equal(host.get(inheritedSession.body.session.id)?.session.model?.id, modelA.id);

  const rollbackRoot = join(env.root, 'rollback-config');
  await cp(defaultAgentsConfigRoot(), rollbackRoot, { recursive: true });
  const existingDir = join(rollbackRoot, 'skills/logs/preexisting');
  await mkdir(existingDir);
  const existingFile = join(existingDir, 'SKILL.md');
  await writeFile(existingFile, '---\nname: preexisting\ndescription: preserve this directory\n---\nORIGINAL');
  const rollbackProfiles = await loadAgentProfiles(rollbackRoot);
  const rollbackMapBefore = rollbackProfiles.get('logs');
  const yamlBefore = await readFile(join(rollbackRoot, 'logs.yaml'));
  const promptBefore = await readFile(join(rollbackRoot, 'prompts/logs.md'));
  const skillBefore = await readFile(join(rollbackRoot, 'skills/logs/log-analysis/SKILL.md'));
  const existingBefore = await readFile(existingFile);
  const entered = deferred<void>();
  const release = deferred<void>();
  const rollbackService = new ModuleAgentSettingsService({
    root: rollbackRoot, profiles: rollbackProfiles, validateModel: async () => true,
    persist: (changes, validate) => replaceFiles(changes, async () => {
      await validate();
      entered.resolve();
      await release.promise;
      throw new Error('failure after publication and validation');
    }),
  });
  const rollbackInitial = await rollbackService.get('logs');
  const failedUpdate = update(rollbackInitial);
  failedUpdate.prompt += '\nSHOULD-ROLL-BACK';
  failedUpdate.skills[0]!.selected = false;
  const failingWrite = rollbackService.update('logs', failedUpdate);
  await within(entered.promise, 3000);
  assert.match(await readFile(join(rollbackRoot, 'logs.yaml'), 'utf8'), /enabled: false/);
  let readSettled = false;
  const pendingRead = rollbackService.get('logs').then(view => { readSettled = true; return view; });
  await delay(50);
  assert.equal(readSettled, false, 'GET must wait through published but uncommitted files');
  release.resolve();
  await assert.rejects(() => within(failingWrite, 3000), /failure after publication and validation/);
  const rolledBack = await within(pendingRead, 3000);
  assert.equal(rolledBack.revision, rollbackInitial.revision);
  assert.deepEqual(await readFile(join(rollbackRoot, 'logs.yaml')), yamlBefore);
  assert.deepEqual(await readFile(join(rollbackRoot, 'prompts/logs.md')), promptBefore);
  assert.deepEqual(await readFile(join(rollbackRoot, 'skills/logs/log-analysis/SKILL.md')), skillBefore);
  assert.deepEqual(await readFile(existingFile), existingBefore);
  assert.equal((await readdir(join(rollbackRoot, 'skills/logs'))).includes('preexisting'), true);
  for (const directory of [rollbackRoot, join(rollbackRoot, 'prompts'), join(rollbackRoot, 'skills/logs')]) {
    assert.ok((await readdir(directory)).every(name => !/\.(tmp|rollback)$/.test(name)), 'temporary files must be removed');
  }
  assert.equal(rollbackProfiles.get('logs'), rollbackMapBefore, 'failed write must retain live profile');
  const normalService = new ModuleAgentSettingsService({ root: rollbackRoot, profiles: rollbackProfiles, validateModel: async () => true });
  assert.equal((await normalService.get('logs')).revision, rollbackInitial.revision);
  const afterFailure = await normalService.update('logs', { ...update(rolledBack), prompt: `${rolledBack.prompt}\nRECOVERED` });
  assert.match(afterFailure.prompt, /RECOVERED/);
  assert.notEqual((rollbackProfiles.get('logs') as { ok: true; profile: { profileRevision: string } }).profile.profileRevision, (rollbackMapBefore as { ok: true; profile: { profileRevision: string } }).profile.profileRevision);
  const invalidRoot = join(env.root, 'invalid-config');
  await cp(defaultAgentsConfigRoot(), invalidRoot, { recursive: true });
  const originalYaml = await readFile(join(invalidRoot, 'logs.yaml'), 'utf8');
  for (const entry of [
    '  - path: ./skills/logs/log-analysis/SKILL.md\n    enabled: yes',
    '  - path: ./skills/logs/log-analysis/SKILL.md\n    enabled: true\n    extra: false',
    '  - ./skills/logs/log-analysis/SKILL.md\n  - ./skills/logs/log-analysis/SKILL.md',
    '  - ../outside/SKILL.md',
  ]) {
    await writeFile(join(invalidRoot, 'logs.yaml'), originalYaml.replace('  - ./skills/logs/log-analysis/SKILL.md', entry));
    const invalid = await loadAgentProfiles(invalidRoot);
    assert.equal(invalid.get('logs')?.ok, false, entry);
    assert.equal(invalid.get('codes')?.ok, true, 'invalid logs YAML stays isolated');
  }
  console.log('PASS 模块设置：HTTP/临时资源、模型 A→B 与默认继承、Skill 选中/取消/重选、旧会话快照、真实发布失败回滚与串行 GET');
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host.disposeAll(); store.close();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = savedWorkspaceRoot;
  await env.close();
}
