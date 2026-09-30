/** Exact lookup and real SDK cold restoration do not depend on recent-session pagination. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findModuleSession } from '../server/module-agents/session-index';
import { createModuleAgentSessionService } from '../server/module-agents/session-service';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { profileRevision, ProfileSnapshots } from '../server/module-agents/snapshots';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { sandbox, memorySettings, scripted } from './subagent-check-fixtures';

const env = await sandbox();
env.runtime.hasConfiguredAuth = () => true;
const previous = process.env.PI_CODING_AGENT_DIR;
const previousWorkspaces = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_CODING_AGENT_DIR = env.agentDir;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(env.root, 'workspaces');
const sessionDir = join(env.root, 'sessions');
await mkdir(sessionDir, { recursive: true });
const store = new WorkbenchStore(join(env.root, 'workbench.sqlite'));
const host = new PiHost({ modelRuntimeFactory: async () => env.runtime, settingsManagerFactory: memorySettings,
  sessionDir, teamJournalDir: join(env.root, 'teams'), definitions: {
    read: async () => ({ schemaVersion: 1, revision: 1, path: join(env.root, 'defs.json'), agents: [] }),
  } });
const create = host.create.bind(host);
host.create = async options => create({ ...options, provider: env.model.provider, model: env.model.id });
try {
  const target = randomUUID();
  await writeFile(join(sessionDir, 'old-custom-name.jsonl'), JSON.stringify({ type: 'session', id: target,
    cwd: env.cwd, timestamp: '2020-01-01T00:00:00Z' }) + '\n');
  await Promise.all(Array.from({ length: 650 }, async (_, index) => writeFile(join(sessionDir, `new-${index}.jsonl`),
    JSON.stringify({ type: 'session', id: randomUUID(), cwd: env.cwd, timestamp: new Date().toISOString() }) + '\n')));
  await writeFile(join(sessionDir, 'broken.jsonl'), '{broken\n');
  assert.equal((await findModuleSession(target, sessionDir))?.id, target, 'old log survives more than 500 newer sessions');
  assert.equal(await findModuleSession('absent', sessionDir), undefined);
  const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
  const loaded = profiles.get('logs'); assert.ok(loaded?.ok);
  const profile = structuredClone(loaded.profile);
  profile.config.workspace = await realpath(env.cwd); profile.effectiveWorkspace = profile.config.workspace;
  profile.profileRevision = profileRevision(profile);
  const onlyLogs = new Map([['logs' as const, { ok: true as const, profile }]]);
  let recentListCalls = 0;
  const deps = { host, store, profiles: onlyLogs, workspaceKey: 'exact',
    snapshots: new ProfileSnapshots(join(env.root, 'profiles')),
    storedSessions: async () => { recentListCalls += 1; return []; } };
  const service = createModuleAgentSessionService(deps);
  const opened = await service.openOrCreate('logs', profile);
  scripted(opened.session, () => ({ content: [{ type: 'text', text: 'persistent context sentinel' }], stopReason: 'stop' }));
  await opened.session.prompt('first turn');
  await host.kill(opened.id);
  const restored = await createModuleAgentSessionService(deps).openOrCreate('logs', profile, opened.id);
  assert.equal(restored.id, opened.id);
  assert.ok(JSON.stringify(restored.session.messages).includes('persistent context sentinel'));
  assert.equal(recentListCalls, 0, 'registered session restores from exact durable index');
  await assert.rejects(service.openOrCreate('assistant', profile, opened.id), /该模块 Agent/);
  await host.kill(restored.id);
  store.sqlite.prepare('UPDATE module_agent_session_index SET session_path=? WHERE session_id=?')
    .run(join(sessionDir, 'old-custom-name.jsonl'), opened.id);
  await assert.rejects(service.openOrCreate('logs', profile, opened.id), /身份不匹配/);
  console.log('module-session-index: old-log lookup, SDK cold restore, and identity checks passed');
} finally {
  await host.disposeAll(); store.close();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  if (previousWorkspaces === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = previousWorkspaces;
  await env.close();
}
