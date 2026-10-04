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
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentId } from '../server/module-agents/contracts';
import {
  boundSessionWorkspace, captureEffectiveWorkspace, defaultAgentWorkspace,
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
  assert.equal(await validateWorkspaceSelection('logs', null), null);
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
  assert.equal(await validateWorkspaceSelection('logs', custom), canonical);
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
  other.profileRevision = profileRevision(other);
  await snapshots.save(other);
  assert.equal(await boundSessionWorkspace(other), canonical, 'requirements may share the logs workspace');
  assert.equal(await boundSessionWorkspace(rebound), canonical, 'both agents keep the same shared binding');
  assert.equal(await validateWorkspaceSelection('logs', nested), await realpath(nested), 'nested shared directory is accepted');
  assert.equal(await validateWorkspaceSelection('logs', root), await realpath(root), 'parent directory may contain other agent workspaces');
  const alias = path.join(root, 'alias');
  await symlink(custom, alias);
  assert.equal(await validateWorkspaceSelection('logs', alias), canonical, 'symlinked binding canonicalizes into the shared directory');
  await assert.rejects(validateWorkspaceSelection('logs', path.join(root, 'missing')), /不存在/);
  await assert.rejects(validateWorkspaceSelection('logs', 'relative'), /绝对路径/);

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
  const host = {
    sessions: new Map(),
    get: () => undefined,
    async create(options: { sessionPath: string }) {
      const manager = SessionManager.open(options.sessionPath);
      const hosted = { id: manager.getSessionId(), cwd: manager.getHeader()!.cwd, session: { sessionManager: manager } };
      this.sessions.set(hosted.id, hosted);
      return hosted;
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
    const [logsStatus, codesStatus] = await Promise.all([
      restore('logs', stored[0]!.id, 'restore-logs'),
      restore('codes', stored[1]!.id, 'restore-codes'),
    ]);
    assert.equal(logsStatus, 200, 'logs restores into the shared historical workspace');
    assert.equal(codesStatus, 200, 'codes restores into the same shared workspace concurrently');
    assert.equal(host.sessions.size, 2, 'both shared-workspace sessions stay hosted');
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
