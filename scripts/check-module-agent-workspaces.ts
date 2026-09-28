import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { profileRevision, ProfileSnapshots } from '../server/module-agents/snapshots';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { WorkbenchStore } from '../server/workbench/store';
import { HostError } from '../server/pi/host';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentId, ProfileLoadResult } from '../server/module-agents/contracts';
import {
  assertWorkspaceAvailable, boundSessionWorkspace, captureEffectiveWorkspace, defaultAgentWorkspace,
  validateWorkspaceSelection,
} from '../server/module-agents/workspace';

const root = await mkdtemp(path.join(tmpdir(), 'module-agent-workspaces-'));
const previous = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = path.join(root, 'dedicated');
const config = path.join(root, 'config');
await cp(defaultAgentsConfigRoot(), config, { recursive: true });

try {
  const profiles = await loadAgentProfiles(config);
  const logs = profiles.get('logs');
  const requirements = profiles.get('requirements');
  assert.ok(logs?.ok && requirements?.ok);
  assert.notEqual(logs.profile.effectiveWorkspace, requirements.profile.effectiveWorkspace);
  assert.equal(logs.profile.effectiveWorkspace, defaultAgentWorkspace('logs'));
  assert.equal(await validateWorkspaceSelection('logs', null, profiles), null);
  const defaultDir = await boundSessionWorkspace(logs.profile);
  assert.equal(defaultDir, defaultAgentWorkspace('logs'));
  assert.equal(await realpath(defaultDir), defaultDir);
  process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = path.join(root, 'new-dedicated');
  assert.equal(await boundSessionWorkspace(logs.profile), defaultDir, 'saved snapshot survives default-root changes');
  assert.notEqual(defaultAgentWorkspace('logs'), defaultDir);
  process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = path.join(root, 'dedicated');

  const custom = path.join(root, 'custom');
  const nested = path.join(custom, 'nested');
  await mkdir(nested, { recursive: true });
  const canonical = await realpath(custom);
  assert.equal(await validateWorkspaceSelection('logs', custom, profiles), canonical);
  const rebound = structuredClone(logs.profile);
  rebound.config.workspace = canonical;
  rebound.effectiveWorkspace = canonical;
  rebound.profileRevision = profileRevision(rebound);
  assert.notEqual(rebound.profileRevision, logs.profile.profileRevision);
  assert.equal(await boundSessionWorkspace(rebound), canonical);
  const snapshots = new ProfileSnapshots(path.join(root, 'snapshots'));
  await snapshots.save(rebound);
  assert.equal((await snapshots.read(rebound.profileRevision)).effectiveWorkspace, canonical);
  assert.equal(await boundSessionWorkspace(logs.profile), defaultDir, 'old profile keeps its original binding');

  const other = structuredClone(requirements.profile);
  other.config.workspace = canonical;
  other.effectiveWorkspace = canonical;
  const occupied = new Map<AgentId, ProfileLoadResult>(profiles);
  occupied.set('requirements', { ok: true, profile: other });
  await assert.rejects(validateWorkspaceSelection('logs', custom, occupied), /重叠/);
  await assert.rejects(validateWorkspaceSelection('logs', nested, occupied), /重叠/);
  await assert.rejects(validateWorkspaceSelection('logs', root, occupied), /重叠/);
  await assert.rejects(validateWorkspaceSelection('logs', '/', occupied), /重叠/);
  const alias = path.join(root, 'alias');
  await symlink(custom, alias);
  await assert.rejects(validateWorkspaceSelection('logs', alias, occupied), /重叠/);
  await assert.rejects(assertWorkspaceAvailable('logs', custom, profiles, [{ agentId: 'codes', cwd: canonical }]), /运行中/);
  await assert.rejects(validateWorkspaceSelection('logs', path.join(root, 'missing'), profiles), /不存在/);
  await assert.rejects(validateWorkspaceSelection('logs', 'relative', profiles), /绝对路径/);

  const missing = path.join(root, 'missing-custom');
  const yaml = path.join(config, 'logs.yaml');
  await writeFile(yaml, `${await readFile(yaml, 'utf8')}\nworkspace: ${JSON.stringify(missing)}\n`);
  const vanished = await loadAgentProfiles(config);
  const vanishedLogs = vanished.get('logs');
  assert.ok(vanishedLogs?.ok, 'missing custom directory must remain readable for settings reset');
  assert.equal(vanishedLogs.profile.config.workspace, missing);
  await assert.rejects(boundSessionWorkspace(vanishedLogs.profile), /不存在/);

  const legacy = structuredClone(logs.profile);
  delete legacy.effectiveWorkspace;
  const legacyCwd = path.join(root, 'legacy-cwd');
  await mkdir(legacyCwd);
  assert.equal(await boundSessionWorkspace(legacy, legacyCwd), await realpath(legacyCwd));
  const legacyRevision = profileRevision(legacy);
  const crypto = await import('node:crypto');
  assert.equal(legacyRevision, crypto.createHash('sha256').update(JSON.stringify({
    config: legacy.config, promptText: legacy.promptText, skills: legacy.skills,
  })).digest('hex'), 'legacy snapshot digest remains readable');
  legacy.profileRevision = legacyRevision;
  await snapshots.save(legacy);
  assert.equal((await snapshots.read(legacyRevision)).effectiveWorkspace, undefined);
  assert.equal(await captureEffectiveWorkspace('logs', undefined), defaultAgentWorkspace('logs'));

  const oldCodesResult = profiles.get('codes');
  assert.ok(oldCodesResult?.ok);
  const shared = path.join(root, 'historical-shared');
  await mkdir(shared);
  const historical = await realpath(shared);
  const oldLogs = structuredClone(logs.profile);
  const oldCodes = structuredClone(oldCodesResult.profile);
  for (const old of [oldLogs, oldCodes]) {
    old.config.workspace = historical;
    old.effectiveWorkspace = historical;
    old.profileRevision = profileRevision(old);
    await snapshots.save(old);
  }
  const stored: Array<{ id: string; path: string; cwd: string }> = [];
  for (const old of [oldLogs, oldCodes]) {
    const session = SessionManager.create(historical, path.join(root, 'sessions'));
    session.appendCustomEntry('pi-webx:module-agent', {
      version: 1, agentId: old.config.id, workspaceKey: 'default', profileRevision: old.profileRevision,
    });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture' }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
    const file = session.getSessionFile();
    assert.ok(file);
    stored.push({ id: session.getSessionId(), path: file, cwd: historical });
  }
  const store = new WorkbenchStore(path.join(root, 'workbench.sqlite'));
  let enter!: () => void;
  const enteredRestore = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let failFirst = true;
  const host = {
    sessions: new Map(),
    get: () => undefined,
    async create() {
      if (failFirst) { enter(); await blocked; failFirst = false; throw new HostError(503, 'fixture failure'); }
      return { id: 'restored-fixture' };
    },
    summary: (hosted: { id: string }) => ({ id: hosted.id }),
  };
  const app = express(); app.use(express.json());
  app.use('/api/module-agents', createModuleAgentsRouter({
    host: host as never, store, profiles, workspaceKey: 'default', snapshots,
    storedSessions: (async () => stored) as never,
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/module-agents`;
  const restore = async (id: AgentId, sessionId: string, requestId: string) => {
    const response = await fetch(`${base}/${id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, sessionId }) });
    return response.status;
  };
  try {
    const first = restore('logs', stored[0]!.id, 'held-logs');
    await Promise.race([enteredRestore, first.then(status => { throw new Error(`first restore ended before claim: ${status}`); })]);
    assert.equal(await restore('codes', stored[1]!.id, 'blocked-codes'), 409, 'in-flight historical overlap is rejected');
    release();
    assert.equal(await first, 503);
    assert.equal(await restore('codes', stored[1]!.id, 'retry-codes'), 200, 'failed claim is released');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }

  console.log('module agent workspaces: pass');
} finally {
  if (previous === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = previous;
  await rm(root, { recursive: true, force: true });
}
