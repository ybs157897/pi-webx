/** Isolated browser fixture for Module Agent send, queue, attachment and stop paths. */
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
import { attachWebSocketGateway } from '../server/ws';
import type { AgentId } from '../server/module-agents/contracts';

interface Gate {
  promise: Promise<void>;
  release(): void;
}

interface TurnProbe {
  index: number;
  lastUserText: string;
  allUserTexts: string[];
  images: Array<{ mimeType: string; byteLength: number }>;
  status: 'streaming' | 'complete' | 'aborted';
}

interface PendingPromptAck {
  gate: Gate;
}

interface SessionProbe {
  id: string;
  agentId: AgentId;
  cwd: string;
  holdNext: boolean;
  activeGate?: Gate;
  pauseNextPromptAck: boolean;
  pendingPromptAck?: PendingPromptAck;
  turns: TurnProbe[];
  commands: Array<Record<string, unknown>>;
}

function deferred(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, release: resolve };
}

function userContent(message: any): { text: string; images: Array<{ mimeType: string; byteLength: number }> } {
  if (typeof message?.content === 'string') return { text: message.content, images: [] };
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks.filter((block: any) => block?.type === 'text')
    .map((block: any) => typeof block.text === 'string' ? block.text : '').join('\n');
  const images = blocks.filter((block: any) => block?.type === 'image').map((block: any) => ({
    mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'unknown',
    byteLength: typeof block.data === 'string' ? block.data.length : Buffer.isBuffer(block.data) ? block.data.length : 0,
  }));
  return { text, images };
}

function installFixtureStream(hosted: any, probe: SessionProbe, model: any): void {
  const agent = hosted.session.agent;
  agent.getApiKey = () => 'module-agent-browser-fixture-no-provider';
  agent.streamFunction = (_requestedModel: unknown, context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
    const users = context.messages.filter((message: any) => message?.role === 'user').map(userContent);
    const last = users.at(-1) ?? { text: '', images: [] };
    const turn: TurnProbe = {
      index: probe.turns.length + 1,
      lastUserText: last.text,
      allUserTexts: users.map(item => item.text),
      images: [...last.images],
      status: 'streaming',
    };
    probe.turns.push(turn);
    const gate = probe.holdNext ? deferred() : undefined;
    probe.holdNext = false;
    if (gate) probe.activeGate = gate;

    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: `Fixture ${probe.agentId} received: ${turn.lastUserText || '[image attachment]'}` }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    let ended = false;
    const finish = (aborted: boolean): void => {
      if (ended) return;
      ended = true;
      options?.signal?.removeEventListener('abort', abort);
      if (probe.activeGate === gate) probe.activeGate = undefined;
      turn.status = aborted ? 'aborted' : 'complete';
      if (aborted) {
        message.stopReason = 'aborted';
        message.content = [];
        stream.push({ type: 'error', reason: 'aborted', error: message });
        stream.end(message);
        return;
      }
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
    };
    const abort = (): void => {
      gate?.release();
      finish(true);
    };
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener('abort', abort, { once: true });
    if (gate) void gate.promise.then(() => finish(false));
    else setTimeout(() => finish(options?.signal?.aborted === true), 25);
    return stream;
  };
}

function safeCommand(command: any): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  if (typeof command?.type === 'string') copy.type = command.type;
  if (typeof command?.id === 'string') copy.id = command.id;
  if (typeof command?.message === 'string') copy.message = command.message;
  if (typeof command?.streamingBehavior === 'string') copy.streamingBehavior = command.streamingBehavior;
  if (command?.action && typeof command.action === 'object') copy.action = command.action;
  if (Array.isArray(command?.images)) {
    copy.images = command.images.map((image: any) => ({
      mimeType: typeof image?.mimeType === 'string' ? image.mimeType : 'unknown',
      base64Chars: typeof image?.data === 'string' ? image.data.length : 0,
    }));
  }
  return copy;
}

function publicProbe(probe: SessionProbe, hosted: any): Record<string, unknown> {
  return {
    id: probe.id,
    agentId: probe.agentId,
    cwd: probe.cwd,
    alive: hosted?.alive === true,
    running: hosted ? hosted.session.isStreaming || hosted.streaming : false,
    queue: (hosted?.queue ?? []).map((item: any) => ({ id: item.id, text: item.text, imageCount: item.images?.length ?? 0 })),
    activeGate: probe.activeGate !== undefined,
    pauseNextPromptAck: probe.pauseNextPromptAck,
    pendingPromptAck: probe.pendingPromptAck !== undefined,
    turns: probe.turns.map(turn => ({ ...turn, images: [...turn.images] })),
    commands: probe.commands.map(command => ({ ...command })),
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'module-agent-send-browser-'));
  const configRoot = join(root, 'config', 'agents');
  const workspaceRoot = join(root, 'workspaces');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const attachmentHome = join(root, 'pi-webx-home');
  const snapshotsDir = join(root, 'profile-snapshots');
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
  const probes = new Map<string, SessionProbe>();

  const restoreEnv = (): void => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const cleanup = async (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      for (const probe of probes.values()) {
        probe.activeGate?.release();
        probe.pendingPromptAck?.gate.release();
      }
      if (detachWebSocket) await detachWebSocket();
      if (host) await host.disposeAll();
      if (httpServer) {
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
      mkdir(attachmentHome, { recursive: true }),
    ]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = workspaceRoot;
    process.env.PI_WEBX_AGENT_CONFIG_DIR = configRoot;
    process.env.PI_WEBX_HOME = attachmentHome;

    await cp(defaultAgentsConfigRoot(), configRoot, { recursive: true, force: true });
    for (const file of ['requirements.yaml', 'logs.yaml', 'assistant.yaml', 'codes.yaml']) {
      const configPath = join(configRoot, file);
      const config = parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      const id = String(config.id) as AgentId;
      const workspace = join(workspaceRoot, id);
      await mkdir(workspace, { recursive: true });
      config.enabled = true;
      config.workspace = await realpath(workspace);
      await writeFile(configPath, stringify(config), 'utf8');
    }

    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const model = runtime.getModels('deepseek').find(candidate => candidate.input.includes('image'));
    assert.ok(model, 'fixture catalog must provide an offline image-capable model');
    runtime.hasConfiguredAuth = () => true;
    runtime.streamSimple = () => { throw new Error('network is disabled in Module Agent browser fixture'); };

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
      if (options.moduleAgent) {
        const probe: SessionProbe = {
          id: hosted.id,
          agentId: options.moduleAgent.scope.agentId,
          cwd: hosted.cwd,
          holdNext: true,
          pauseNextPromptAck: false,
          turns: [],
          commands: [],
        };
        probes.set(hosted.id, probe);
        installFixtureStream(hosted, probe, model);
      }
      return hosted;
    };

    const app = express();
    app.use(express.json({ limit: JSON_BODY_LIMIT }));
    app.get('/__fixture/health', (_request, response) => response.json({ ok: true }));
    app.get('/__fixture/state', (_request, response) => response.json({
      agents: [...probes.values()].map(probe => publicProbe(probe, host!.get(probe.id))),
    }));
    app.post('/__fixture/release', (request, response) => {
      const targetId = typeof request.body?.sessionId === 'string' ? request.body.sessionId : undefined;
      const selected = [...probes.values()].filter(probe => targetId === undefined || probe.id === targetId);
      const released = selected.filter(probe => probe.activeGate !== undefined).map(probe => probe.id);
      for (const probe of selected) {
        probe.activeGate?.release();
        probe.activeGate = undefined;
      }
      response.json({ released });
    });
    app.post('/__fixture/hold-next', (request, response) => {
      const id = typeof request.body?.sessionId === 'string' ? request.body.sessionId : '';
      const probe = probes.get(id);
      if (!probe) { response.status(404).json({ error: 'unknown fixture session' }); return; }
      probe.holdNext = true;
      response.json({ sessionId: id, holdNext: true });
    });
    app.post('/__fixture/pause-next-prompt', (request, response) => {
      const id = typeof request.body?.sessionId === 'string' ? request.body.sessionId : '';
      const probe = probes.get(id);
      if (!probe) { response.status(404).json({ error: 'unknown fixture session' }); return; }
      probe.pauseNextPromptAck = true;
      response.json({ sessionId: id, paused: true });
    });
    app.post('/__fixture/release-prompt', (request, response) => {
      const id = typeof request.body?.sessionId === 'string' ? request.body.sessionId : '';
      const probe = probes.get(id);
      if (!probe?.pendingPromptAck) { response.status(404).json({ error: 'no prompt acknowledgement is paused' }); return; }
      probe.pendingPromptAck.gate.release();
      response.json({ sessionId: id, released: true });
    });

    // Keep command evidence small; image payloads are represented by MIME and size only.
    app.use((request, response, next) => {
      const match = /^\/api\/sessions\/([^/]+)\/command$/.exec(request.path);
      const command = request.body?.command;
      if (request.method !== 'POST' || !match || command === null || typeof command !== 'object') { next(); return; }
      const id = decodeURIComponent(match[1]!);
      const probe = probes.get(id);
      if (!probe) { next(); return; }
      probe.commands.push(safeCommand(command));
      if (command.type !== 'prompt' || !probe.pauseNextPromptAck) { next(); return; }
      probe.pauseNextPromptAck = false;
      const originalJson = response.json.bind(response);
      response.json = ((payload: any) => {
        const rpc = payload?.response;
        if (rpc?.success !== true || rpc?.data?.accepted !== true) return originalJson(payload);
        const gate = deferred();
        probe.pendingPromptAck = { gate };
        response.once('close', () => gate.release());
        void gate.promise.then(() => {
          if (probe.pendingPromptAck?.gate === gate) probe.pendingPromptAck = undefined;
          originalJson(payload);
        });
        return response;
      }) as typeof response.json;
      next();
    });

    // Codes chat uses the configured root from a same-origin web-idea frame.
    // This tiny frame handshakes the temp workspace without starting an IDE or gateway.
    app.post('/api/codes/ide/start', (_request, response) => response.json({ ready: true }));
    app.get('/api/codes/ide/', (_request, response) => {
      const document = `<!doctype html><html><body>Temporary editor transport fixture<script>
        const requestId = 'module-agent-send-editor-root';
        window.parent.postMessage({ type: 'web-idea:open-request', requestId }, location.origin);
        window.addEventListener('message', event => {
          if (event.origin !== location.origin || event.data?.type !== 'web-idea:open-result' || event.data?.requestId !== requestId || !event.data.root) return;
          window.parent.postMessage({ type: 'web-idea:state', payload: { root: event.data.root, path: null, workspaceId: 'module-agent-send-fixture', dirty: false, saving: false } }, event.origin);
        });
      </script></body></html>`;
      response.type('html').send(document);
    });

    const settings = new ModuleAgentSettingsService({ root: configRoot, profiles, validateModel: async () => true });
    app.use('/api/workbench', createWorkbenchRouter(store));
    app.use('/api/module-agents', createModuleAgentSettingsRouter(settings));
    app.use('/api/module-agents', createModuleAgentsRouter({
      host: fixtureHost,
      store,
      profiles,
      workspaceKey: 'module-agent-send-browser-fixture',
      snapshots: new ProfileSnapshots(join(root, 'snapshots')),
      storedSessions: async () => [],
    }));
    app.use('/api', createApiRouter(fixtureHost));
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        proxy: { '/__fixture': { target: apiOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    const vitePort = (vite.httpServer!.address() as AddressInfo).port;
    console.log(`Module Agent send fixture: http://127.0.0.1:${vitePort}`);
    console.log(`API: ${apiOrigin}`);
    console.log(`Fixture state: http://127.0.0.1:${vitePort}/__fixture/state`);
    console.log(`Hold/release: POST /__fixture/hold-next, /__fixture/release, /__fixture/pause-next-prompt, /__fixture/release-prompt`);
    console.log('Enabled Agents: requirements, logs, assistant, codes. Each new module session holds its first model stream.');
    console.log('Codes uses a temporary workspace handshake page; no IDE process or gateway is started.');
    console.log('Model output is scripted and network calls are disabled. Stop this fixture with Ctrl+C.');

    process.once('SIGINT', () => { void cleanup(); });
    process.once('SIGTERM', () => { void cleanup(); });
    await new Promise<void>(resolve => {
      if (closing) resolve();
      else {
        const check = setInterval(() => { if (closing) { clearInterval(check); resolve(); } }, 50);
        check.unref();
      }
    });
    await cleanup();
  } catch (error) {
    await cleanup();
    throw error;
  }
}

await main();
