import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { createModuleAgentSettingsRouter } from '../server/module-agents/settings/router';
import { ModuleAgentSettingsService } from '../server/module-agents/settings/service';
import { replaceFiles } from '../server/module-agents/settings/persistence';
import type { AgentSettingsUpdate, AgentSettingsView } from '../src/shared/module-agent-settings';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-webx-workspace-settings-')));
const priorRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(temp, 'defaults');
const root = join(temp, 'agents');
let server: ReturnType<express.Application['listen']> | undefined;
function body(view: AgentSettingsView, workspace: string | null): AgentSettingsUpdate {
  return { revision: view.revision, prompt: view.prompt, model: view.model, workspace,
    skills: view.skills.map(({ key, selected }) => ({ key, selected })) };
}

try {
  await cp(defaultAgentsConfigRoot(), root, { recursive: true });
  await mkdir(process.env.PI_WEBX_AGENT_WORKSPACE_ROOT, { recursive: true });
  const profiles = await loadAgentProfiles(root);
  const service = new ModuleAgentSettingsService({ root, profiles, validateModel: async () => true });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/module-agents', createModuleAgentSettingsRouter(service));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/module-agents`;
  async function request(id: string, method = 'GET', input?: unknown) {
    const response = await fetch(`${base}/${id}/settings`, { method, ...(input === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }) });
    return { status: response.status, body: await response.json() as AgentSettingsView & { error?: string } };
  }

  /**
   * 配置文件记录设置页保存的本机目录绑定，克隆进来就先带着；这里验的是
   * 「未绑定 → 默认目录 → 绑定/重置」流程，所以先经 API 清成它要的前置状态。
   * 只改临时克隆，真实配置不受影响。
   */
  async function unbound(id: string) {
    const view = await request(id);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    if (view.body.workspace === null) return view;
    const reset = await request(id, 'PUT', body(view.body, null));
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    return await request(id);
  }

  const logs = await unbound('logs');
  const codes = await unbound('codes');
  const requirements = await unbound('requirements');
  const works = await unbound('works');
  assert.equal(logs.status, 200);
  assert.equal(logs.body.workspace, null);
  assert.equal(logs.body.workspacePath, join(temp, 'defaults/logs'));
  assert.equal(logs.body.workspaceDefaultPath, logs.body.workspacePath);
  assert.equal(codes.body.workspacePath, join(temp, 'defaults/codes'));
  assert.equal(requirements.body.workspacePath, join(temp, 'defaults/requirements'));
  assert.equal(works.body.workspacePath, join(temp, 'defaults/works'));
  assert.equal(new Set([logs.body.workspacePath, codes.body.workspacePath, requirements.body.workspacePath, works.body.workspacePath]).size, 4);

  const custom = join(temp, 'custom-logs');
  await mkdir(join(custom, 'nested'), { recursive: true });
  const bound = await request('logs', 'PUT', body(logs.body, custom));
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  assert.equal(bound.body.workspace, custom);
  assert.equal(bound.body.workspacePath, custom);
  assert.match(await readFile(join(root, 'logs.yaml'), 'utf8'), /workspace: .*custom-logs/);
  assert.equal((await request('logs')).body.workspace, custom);
  assert.equal((await request('codes')).body.revision, codes.body.revision);

  const missing = join(temp, 'missing');
  const file = join(temp, 'ordinary-file');
  await writeFile(file, 'not a directory');
  for (const invalid of [missing, file, 'relative/workspace', join(temp, 'defaults')]) {
    const response = await request('requirements', 'PUT', body(requirements.body, invalid));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal((await request('requirements')).body.revision, requirements.body.revision);
  }
  for (const invalid of [custom, join(custom, 'nested')]) {
    const response = await request('codes', 'PUT', body(codes.body, invalid));
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  const alias = join(temp, 'custom-logs-alias');
  await symlink(custom, alias);
  assert.equal((await request('codes', 'PUT', body(codes.body, alias))).status, 400);
  assert.equal((await request('logs', 'PUT', body(logs.body, null))).status, 409, 'stale revision cannot reset binding');

  await rm(custom, { recursive: true });
  const repair = await request('logs');
  assert.equal(repair.status, 200, 'missing custom directory remains repairable');
  assert.equal(repair.body.workspace, custom);
  const reset = await request('logs', 'PUT', body(repair.body, null));
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.workspace, null);
  assert.equal(reset.body.workspacePath, reset.body.workspaceDefaultPath);
  assert.doesNotMatch(await readFile(join(root, 'logs.yaml'), 'utf8'), /^workspace:/m);

  const common = join(temp, 'common');
  await mkdir(common);
  const [left, right] = await Promise.all([
    request('logs', 'PUT', body(reset.body, common)),
    request('codes', 'PUT', body(codes.body, common)),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 400], 'simultaneous module bindings cannot overlap');
  const winner = left.status === 200 ? 'logs' : 'codes';
  const loser = winner === 'logs' ? 'codes' : 'logs';
  assert.equal((await request(winner)).body.workspacePath, common);
  assert.equal((await request(loser)).body.workspace, null);
  const winnerView = (await request(winner)).body;
  assert.equal((await request(winner, 'PUT', body(winnerView, null))).status, 200);

  const rollbackPath = join(temp, 'rollback-custom');
  await mkdir(rollbackPath);
  const rollbackProfiles = await loadAgentProfiles(root);
  const previousProfile = rollbackProfiles.get('requirements');
  const yamlBefore = await readFile(join(root, 'requirements.yaml'));
  const promptBefore = await readFile(join(root, 'prompts/requirements.md'));
  const rollback = new ModuleAgentSettingsService({ root, profiles: rollbackProfiles, validateModel: async () => true,
    persist: (changes, validate) => replaceFiles(changes, async () => { await validate(); throw new Error('simulated rollback'); }),
  });
  const failed = body(await rollback.get('requirements'), rollbackPath);
  failed.prompt += '\nFAIL';
  await assert.rejects(() => rollback.update('requirements', failed), /simulated rollback/);
  assert.deepEqual(await readFile(join(root, 'requirements.yaml')), yamlBefore);
  assert.deepEqual(await readFile(join(root, 'prompts/requirements.md')), promptBefore);
  assert.equal(rollbackProfiles.get('requirements'), previousProfile);
  assert.equal((await rollback.get('requirements')).workspace, null);
  console.log('PASS 模块工作区设置：独立默认目录、HTTP 绑定与重置、缺失目录修复、重叠/符号链接拒绝、并发与回滚');
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  if (priorRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = priorRoot;
  await rm(temp, { recursive: true, force: true });
}
