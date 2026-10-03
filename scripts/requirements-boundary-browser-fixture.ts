/** Temporary browser fixture for requirement import conflicts and idempotent drafts. */
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { parse, stringify } from 'yaml';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

import { PiHost } from '../server/pi/host';
import { createApiRouter, JSON_BODY_LIMIT } from '../server/routes';
import { createWorkbenchRouter } from '../server/workbench/router';
import { WorkbenchStore } from '../server/workbench/store';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { createModuleAgentSettingsRouter } from '../server/module-agents/settings/router';
import { ModuleAgentSettingsService } from '../server/module-agents/settings/service';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots } from '../server/module-agents/snapshots';
import { importRequirementTasks } from '../server/modules/requirements/import-tasks';
import { attachWebSocketGateway } from '../server/ws';

interface DraftView {
  id: string;
  title: string;
  note: string;
  updatedAt: string;
  taskDrafts: Array<Record<string, unknown>>;
  importedAt?: string;
  importedTaskIds?: string[];
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'requirements-boundary-browser-'));
  const configRoot = join(root, 'config', 'agents');
  const workspaceRoot = join(root, 'workspaces');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const snapshotsDir = join(root, 'profile-snapshots');
  const webHome = join(root, 'pi-webx-home');
  const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
  const savedEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_WEBX_AGENT_WORKSPACE_ROOT: process.env.PI_WEBX_AGENT_WORKSPACE_ROOT,
    PI_WEBX_AGENT_CONFIG_DIR: process.env.PI_WEBX_AGENT_CONFIG_DIR,
    PI_WEBX_HOME: process.env.PI_WEBX_HOME,
    PI_WEBX_PORT: process.env.PI_WEBX_PORT,
  };
  let httpServer: ReturnType<express.Express['listen']> | undefined;
  let detachWebSocket: (() => void | Promise<void>) | undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let host: PiHost | undefined;
  let closing: Promise<void> | undefined;
  const forcedStateFailureStatuses: number[] = [];
  let stateGets = 0;
  let importPosts = 0;
  let seedId = '';

  const restoreEnv = (): void => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const cleanup = async (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      if (detachWebSocket) await detachWebSocket();
      if (host) await host.disposeAll();
      if (httpServer?.listening) {
        httpServer.closeAllConnections();
        await new Promise<void>(resolve => httpServer!.close(() => resolve()));
      }
      if (vite) await vite.close();
      store.close();
      restoreEnv();
      await rm(root, { recursive: true, force: true });
    })();
    return closing;
  };

  try {
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(webHome, { recursive: true }),
    ]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = workspaceRoot;
    process.env.PI_WEBX_AGENT_CONFIG_DIR = configRoot;
    process.env.PI_WEBX_HOME = webHome;

    await cp(defaultAgentsConfigRoot(), configRoot, { recursive: true, force: true });
    for (const file of ['requirements.yaml', 'logs.yaml', 'assistant.yaml', 'codes.yaml']) {
      const configPath = join(configRoot, file);
      const config = parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      const workspace = join(workspaceRoot, String(config.id));
      await mkdir(workspace, { recursive: true });
      config.enabled = true;
      config.workspace = await realpath(workspace);
      await writeFile(configPath, stringify(config), 'utf8');
    }

    const seeded = store.addRecord('requirements', {
      title: '导入冲突浏览器验收',
      note: '初始需求正文，用于检查冲突后是否载入最新版本。',
      status: 'todo',
      priority: 'normal',
      sourceSessionId: 'requirements-boundary-browser-fixture',
      taskDrafts: [{ title: '初始待办 A', priority: 'normal', due: null, tag: '初始' }],
    });
    seedId = seeded.id;

    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const model = runtime.getModels('deepseek')[0];
    assert.ok(model, 'offline catalog must provide a fixture model');
    runtime.hasConfiguredAuth = () => true;
    runtime.streamSimple = () => { throw new Error('network is disabled in requirement boundary fixture'); };

    const profiles = await loadAgentProfiles(configRoot);
    for (const id of ['requirements', 'logs', 'assistant', 'codes'] as const) {
      const profile = profiles.get(id);
      assert.ok(profile?.ok, `${id} fixture profile must load`);
      assert.equal(profile.profile.config.enabled, true);
    }
    const fixtureHost = new PiHost({
      definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }) },
      modelRuntimeFactory: async () => runtime,
      settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
      sessionDir,
    });
    host = fixtureHost;
    const originalCreate = fixtureHost.create.bind(fixtureHost);
    fixtureHost.create = async options => {
      const hosted = await originalCreate({ ...options, provider: model.provider, model: model.id });
      hosted.session.agent.getApiKey = () => 'requirements-boundary-no-provider';
      hosted.session.agent.streamFunction = () => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: 'assistant', content: [{ type: 'text', text: '浏览器边界夹具就绪。' }],
          api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
        return stream;
      };
      return hosted;
    };

    const app = express();
    app.use(express.json({ limit: JSON_BODY_LIMIT }));
    app.get('/__fixture/state', (_request, response) => {
      const requirement = store.listRecords('requirements').find(row => row.id === seedId) as DraftView | undefined;
      response.json({
        seedId,
        draft: requirement ?? null,
        tasks: store.listRecords('tasks'),
        importPosts,
        stateGets,
        forcedStateFailures: [...forcedStateFailureStatuses],
      });
    });
    app.post('/__fixture/revise', (request, response) => {
      const requirement = store.listRecords('requirements').find(row => row.id === seedId);
      if (!requirement) { response.status(404).json({ error: 'seed requirement is missing' }); return; }
      const revised = store.updateRecord('requirements', seedId, {
        note: typeof request.body?.note === 'string' ? request.body.note : '服务端更新后的需求正文。',
        taskDrafts: Array.isArray(request.body?.taskDrafts) ? request.body.taskDrafts : [
          { title: '服务器最新待办 B', priority: 'high', due: null, tag: '最新版本' },
        ],
      });
      response.json({ draft: revised });
    });
    app.post('/__fixture/delete', (_request, response) => {
      response.json({ deleted: store.removeRecord('requirements', seedId) });
    });
    app.post('/__fixture/import-externally', (_request, response, next) => {
      const requirement = store.listRecords('requirements').find(row => row.id === seedId);
      if (!requirement) { response.status(404).json({ error: 'seed requirement is missing' }); return; }
      try {
        response.json(importRequirementTasks(store, seedId, {
          expectedUpdatedAt: requirement.updatedAt,
          tasks: requirement.taskDrafts,
        }));
      } catch (error) { next(error); }
    });
    app.post('/__fixture/fail-next-state-get', (request, response) => {
      const requestedStatus = Number(request.body?.status);
      const status = requestedStatus === 404 || requestedStatus === 500 ? requestedStatus : 500;
      forcedStateFailureStatuses.push(status);
      response.json({ forcedStateFailures: [...forcedStateFailureStatuses] });
    });

    app.use((request, response, next) => {
      if (request.method === 'GET' && request.path === '/api/workbench/state') {
        stateGets += 1;
        const failureStatus = forcedStateFailureStatuses.shift();
        if (failureStatus !== undefined) {
          response.status(failureStatus).json({ error: 'fixture forced state reload failure' });
          return;
        }
      }
      if (request.method === 'POST' && /^\/api\/workbench\/requirements\/[^/]+\/import-tasks$/.test(request.path)) {
        importPosts += 1;
      }
      next();
    });

    const settings = new ModuleAgentSettingsService({ root: configRoot, profiles, validateModel: async () => true });
    app.use('/api/workbench', createWorkbenchRouter(store));
    app.use('/api/module-agents', createModuleAgentSettingsRouter(settings));
    app.use('/api/module-agents', createModuleAgentsRouter({
      host: fixtureHost,
      store,
      profiles,
      workspaceKey: 'requirements-boundary-browser-fixture',
      snapshots: new ProfileSnapshots(join(root, 'snapshots')),
      storedSessions: async () => [],
    }));
    app.use('/api', createApiRouter(fixtureHost));
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      const candidate = error as { status?: unknown };
      const status = Number.isInteger(candidate?.status) && Number(candidate.status) >= 400
        ? Number(candidate.status) : 500;
      response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    });

    httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const apiPort = (httpServer.address() as AddressInfo).port;
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    process.env.PI_WEBX_PORT = String(apiPort);
    detachWebSocket = attachWebSocketGateway(httpServer, fixtureHost);

    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    vite = await createViteServer({
      configFile: join(projectRoot, 'vite.config.ts'),
      root: projectRoot,
      server: {
        host: '127.0.0.1', port: 0, strictPort: false,
        proxy: { '/__fixture': { target: apiOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    const vitePort = (vite.httpServer!.address() as AddressInfo).port;
    console.log(`Requirements boundary fixture: http://127.0.0.1:${vitePort}`);
    console.log(`API: ${apiOrigin}`);
    console.log(`Fixture state: http://127.0.0.1:${vitePort}/__fixture/state`);
    console.log('Controls: POST /__fixture/revise, /__fixture/delete, /__fixture/import-externally, /__fixture/fail-next-state-get');
    console.log(`Seed requirement: ${seedId}`);
    console.log('Temporary SQLite, API home, Agent profiles and workspaces only; no provider/network calls. Stop with Ctrl+C.');

    await new Promise<void>((resolve, reject) => {
      const stop = (): void => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        void cleanup().then(resolve, reject);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      if (closing) stop();
    });
    await cleanup();
  } catch (error) {
    await cleanup();
    throw error;
  }
}

await main();
