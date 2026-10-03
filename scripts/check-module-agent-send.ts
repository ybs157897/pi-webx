/** Offline command regressions for all four workbench Module Agents. */
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { parse, stringify } from 'yaml';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { PiHost } from '../server/pi/host';
import { createApiRouter, JSON_BODY_LIMIT } from '../server/routes';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots } from '../server/module-agents/snapshots';
import { WorkbenchStore } from '../server/workbench/store';
import type { AgentId, ResolvedAgentProfile } from '../server/module-agents/contracts';
import type { PiImage, PiRpcResponse } from '../src/shared/protocol';
import { memorySettings, until, within } from './subagent-check-fixtures';

const root = await mkdtemp(join(tmpdir(), 'module-agent-send-check-'));
const configRoot = join(root, 'config', 'agents');
const workspaceRoot = join(root, 'workspaces');
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const snapshotsDir = join(root, 'profile-snapshots');
const apiHome = join(root, 'pi-webx-home');
const dbPath = join(root, 'workbench.sqlite');
const AGENT_IDS: AgentId[] = ['requirements', 'logs', 'assistant', 'codes'];

interface Gate {
  promise: Promise<void>;
  release(): void;
}

interface CapturedTurn {
  index: number;
  lastUserText: string;
  allUserTexts: string[];
  images: Array<{ mimeType: string; byteLength: number }>;
  status: 'streaming' | 'complete' | 'aborted';
}

interface SessionProbe {
  id: string;
  agentId: AgentId;
  cwd: string;
  holdNext: boolean;
  activeGate?: Gate;
  turns: CapturedTurn[];
  commands: Array<Record<string, unknown>>;
}

function deferred(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, release: resolve };
}

function imageAndText(message: any): { text: string; images: Array<{ mimeType: string; byteLength: number }> } {
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

function installScriptedModel(hosted: any, probe: SessionProbe, model: any): void {
  const agent = hosted.session.agent;
  agent.getApiKey = () => 'module-agent-send-no-provider';
  agent.streamFunction = (_requestedModel: unknown, context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
    const userMessages = context.messages.filter((message: any) => message?.role === 'user').map(imageAndText);
    const last = userMessages.at(-1) ?? { text: '', images: [] };
    const turn: CapturedTurn = {
      index: probe.turns.length + 1,
      lastUserText: last.text,
      allUserTexts: userMessages.map(item => item.text),
      images: last.images,
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
    else setTimeout(() => finish(options?.signal?.aborted === true), 10);
    return stream;
  };
}

function safeProbe(probe: SessionProbe, hosted: any): Record<string, unknown> {
  return {
    id: probe.id,
    agentId: probe.agentId,
    cwd: probe.cwd,
    running: hosted.session.isStreaming || hosted.streaming,
    queue: hosted.queue.map((item: any) => ({ id: item.id, text: item.text, imageCount: item.images?.length ?? 0 })),
    activeGate: probe.activeGate !== undefined,
    turns: probe.turns.map(turn => ({ ...turn, images: [...turn.images] })),
    commands: probe.commands.map(command => ({ ...command })),
  };
}

function rpcData(response: PiRpcResponse): Record<string, any> {
  return response.data !== null && typeof response.data === 'object' ? response.data as Record<string, any> : {};
}

function durableUserStarts(hosted: any): Array<{ text: string; requestId?: string }> {
  const entries = hosted.journal.replayFrom(0);
  assert.ok(entries, 'the session journal must retain this short regression run');
  return entries.flatMap((entry: any) => {
    const frame = entry.frame;
    const event = frame?.t === 'pi' ? frame.event : undefined;
    const message = event?.type === 'message_start' ? event.message : undefined;
    if (message?.role !== 'user') return [];
    const content = imageAndText(message);
    return [{ text: content.text, ...(typeof frame.source?.requestId === 'string' ? { requestId: frame.source.requestId } : {}) }];
  });
}

function assertSourceIdForText(hosted: any, text: string, requestId: string, reason?: string): void {
  const starts = durableUserStarts(hosted);
  const start = starts.find(item => item.text.includes(text));
  assert.ok(start, `durable user message must exist for ${JSON.stringify(text)}`);
  assert.equal(start.requestId, requestId,
    reason ?? `message ${JSON.stringify(text)} must retire the matching optimistic echo id`);
}

function stubPromptPreflight(session: any, disposition: unknown): { calls: string[]; restore(): void } {
  const originalPrompt = session.prompt;
  const calls: string[] = [];
  session.prompt = ((text: string, options: unknown) => {
    calls.push(text);
    const callback = (options as { preflightResult?: (value: unknown) => void } | undefined)?.preflightResult;
    callback?.(disposition);
    return Promise.resolve();
  }) as typeof session.prompt;
  return { calls, restore: () => { session.prompt = originalPrompt; } };
}

async function main(): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(apiHome, { recursive: true });
  await cp(defaultAgentsConfigRoot(), configRoot, { recursive: true, force: true });

  for (const file of ['requirements.yaml', 'logs.yaml', 'assistant.yaml', 'codes.yaml']) {
    const configPath = join(configRoot, file);
    const config = parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    const agentId = String(config.id) as AgentId;
    const workspace = join(workspaceRoot, agentId);
    await mkdir(workspace, { recursive: true });
    config.enabled = true;
    config.workspace = await realpath(workspace);
    await writeFile(configPath, stringify(config), 'utf8');
  }

  const oldEnv = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    workspaceRoot: process.env.PI_WEBX_AGENT_WORKSPACE_ROOT,
    webHome: process.env.PI_WEBX_HOME,
    configRoot: process.env.PI_WEBX_AGENT_CONFIG_DIR,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.PI_WEBX_HOME = apiHome;
  process.env.PI_WEBX_AGENT_CONFIG_DIR = configRoot;

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = runtime.getModels('deepseek').find(candidate => candidate.input.includes('image'));
  assert.ok(model, 'offline runtime catalog must provide a local-fixture model that accepts images');
  runtime.hasConfiguredAuth = () => true;
  runtime.streamSimple = () => { throw new Error('network is disabled in module Agent command regression'); };

  const store = new WorkbenchStore(dbPath);
  const profiles = await loadAgentProfiles(configRoot);
  for (const agentId of AGENT_IDS) {
    const profile = profiles.get(agentId);
    assert.ok(profile?.ok === true, `${agentId} fixture profile must load`);
  }
  const host = new PiHost({
    definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }) },
    modelRuntimeFactory: async () => runtime,
    settingsManagerFactory: memorySettings,
    sessionDir,
  });
  const originalCreate = host.create.bind(host);
  const probes = new Map<string, SessionProbe>();
  host.create = async options => {
    const hosted = await originalCreate({ ...options, provider: model.provider, model: model.id });
    if (options.moduleAgent) {
      const probe: SessionProbe = {
        id: hosted.id,
        agentId: options.moduleAgent.scope.agentId,
        cwd: hosted.cwd,
        holdNext: true,
        turns: [],
        commands: [],
      };
      probes.set(hosted.id, probe);
      installScriptedModel(hosted, probe, model);
    }
    return hosted;
  };

  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use('/api/module-agents', createModuleAgentsRouter({
    host,
    store,
    profiles,
    workspaceKey: 'module-agent-send-check',
    snapshots: new ProfileSnapshots(snapshotsDir),
    storedSessions: async () => [],
  }));
  app.use('/api', createApiRouter(host));
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = async (sessionId: string, command: Record<string, unknown>): Promise<PiRpcResponse> => {
      const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      assert.equal(response.status, 200, `command HTTP should succeed: ${await response.clone().text()}`);
      return (await response.json() as { response: PiRpcResponse }).response;
    };
    const imageBytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 110, b: 220, alpha: 1 } } }).png().toBuffer();
    const image: PiImage = { type: 'image', data: imageBytes.toString('base64'), mimeType: 'image/png' };

    for (const agentId of AGENT_IDS) {
      const loaded = profiles.get(agentId)!;
      assert.ok(loaded.ok);
      const profile: ResolvedAgentProfile = loaded.profile;
      const moduleAgent = await assembleModuleAgent({ store, workspaceKey: 'module-agent-send-check', agentId, profile });
      const opened = await fetch(`${base}/api/module-agents/${agentId}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: `open-${agentId}` }),
      });
      assert.equal(opened.status, 200, `${agentId} module session must open: ${await opened.clone().text()}`);
      const { session } = await opened.json() as { session: { id: string } };
      const hosted = host.get(session.id);
      const probe = probes.get(session.id);
      assert.ok(hosted && probe, `${agentId} session must be real and fixture-controlled`);
      assert.equal(hosted.moduleAgent?.agentId, agentId);
      assert.equal(hosted.cwd, await realpath(join(workspaceRoot, agentId)), 'all module sessions stay inside temporary workspaces');

      const started = await send(session.id, {
        type: 'prompt', id: `${agentId}-start`, message: `${agentId}: held turn with image`, images: [image],
      });
      assert.equal(started.success, true);
      await within(until(() => probe.activeGate !== undefined && hosted.session.isStreaming), 3000);
      assert.equal(probe.turns[0]?.images.length, 1, `${agentId} must deliver a normalized image through the SDK`);
      assert.ok(['image/jpeg', 'image/webp'].includes(probe.turns[0]!.images[0]!.mimeType));

      const firstQueueRequestId = `${agentId}-queued`;
      const queued = await send(session.id, { type: 'prompt', id: firstQueueRequestId, message: `${agentId}: default busy queue` });
      assert.equal(queued.success, true);
      assert.equal(rpcData(queued).deliveredAs, 'queue', `${agentId} busy default prompt must enter the editable wait list`);
      const firstRow = hosted.queue[0];
      assert.ok(firstRow);
      assert.equal(firstRow.text, `${agentId}: default busy queue`);

      const edited = await send(session.id, {
        type: 'update_queue', id: firstRow.id, action: { kind: 'edit', text: `${agentId}: edited queue text` },
      });
      assert.equal(edited.success, true);
      assert.equal(hosted.queue[0]?.text, `${agentId}: edited queue text`);

      const removedQueueRequestId = `${agentId}-queued-image`;
      const removable = await send(session.id, {
        type: 'prompt', id: removedQueueRequestId, message: `${agentId}: removable image queue`, images: [image],
      });
      assert.equal(rpcData(removable).deliveredAs, 'queue');
      const secondRow = hosted.queue[1];
      assert.ok(secondRow);
      assert.equal(secondRow.images?.length, 1, `${agentId} queued rows retain image attachments`);
      const removed = await send(session.id, {
        type: 'update_queue', id: secondRow.id, action: { kind: 'remove' },
      });
      assert.equal(removed.success, true);
      assert.deepEqual(hosted.queue.map(item => item.id), [firstRow.id], 'remove must affect only its addressed row');
      const duplicateRemoved = await send(session.id, {
        type: 'prompt', id: removedQueueRequestId, message: `${agentId}: removable image queue`, images: [image],
      });
      assert.equal(duplicateRemoved.success, true);
      assert.equal(rpcData(duplicateRemoved).deduplicated, true, 'retrying a removed row id must not recreate the message');
      assert.deepEqual(hosted.queue.map(item => item.id), [firstRow.id], 'a duplicate cancelled request must not resurrect its queue row');

      const queuedSteerRequestId = `${agentId}-queued-steer`;
      const queuedSteer = await send(session.id, { type: 'prompt', id: queuedSteerRequestId, message: `${agentId}: steer queued row` });
      assert.equal(rpcData(queuedSteer).deliveredAs, 'queue');
      const thirdRow = hosted.queue[1];
      assert.ok(thirdRow);

      const originalSteer = hosted.session.steer.bind(hosted.session);
      const restoreSteer = hosted.session.steer;
      let failFirstSteer = true;
      hosted.session.steer = (async (...args: any[]) => {
        if (failFirstSteer) {
          failFirstSteer = false;
          throw new Error('fixture steer rejection');
        }
        return originalSteer(...args);
      }) as typeof hosted.session.steer;
      const failedSteer = await send(session.id, {
        type: 'update_queue', id: thirdRow.id, action: { kind: 'steer' },
      });
      hosted.session.steer = restoreSteer;
      assert.equal(failedSteer.success, false, 'a rejected row steer must be reported to the caller');
      assert.deepEqual(hosted.queue.map(item => item.id), [firstRow.id, thirdRow.id], 'failed steering must restore the same queue row');
      assert.equal(hosted.queue[1]?.text, `${agentId}: steer queued row`);

      const steered = await send(session.id, {
        type: 'update_queue', id: thirdRow.id, action: { kind: 'steer' },
      });
      assert.equal(steered.success, true, `${agentId} queue row must steer into the active turn`);
      assert.deepEqual(hosted.queue.map(item => item.id), [firstRow.id]);

      const explicitSteerRequestId = `${agentId}-explicit-steer`;
      const explicitSteer = await send(session.id, {
        type: 'prompt', id: explicitSteerRequestId, message: `${agentId}: explicit prompt steer`, streamingBehavior: 'steer',
      });
      assert.equal(explicitSteer.success, true, `${agentId} explicit busy steer must be accepted`);
      assert.ok(hosted.session.getSteeringMessages().length > 0, `${agentId} explicit steer must reach Pi's active turn`);

      probe.activeGate!.release();
      await within(until(() => hosted.session.isIdle && hosted.queue.length === 0 && probe.activeGate === undefined), 5000);
      const allSeen = probe.turns.flatMap(turn => turn.allUserTexts).join('\n');
      assert.ok(allSeen.includes(`${agentId}: edited queue text`), `${agentId} edited item must eventually be delivered`);
      assert.ok(allSeen.includes(`${agentId}: steer queued row`), `${agentId} steered item must reach the active turn`);
      assert.ok(allSeen.includes(`${agentId}: explicit prompt steer`), `${agentId} prompt-level steer must reach the active turn`);
      assert.ok(!allSeen.includes(`${agentId}: removable image queue`), `${agentId} removed row must never reach Pi`);

      assertSourceIdForText(hosted, `${agentId}: held turn with image`, `${agentId}-start`);
      assertSourceIdForText(hosted, `${agentId}: steer queued row`, queuedSteerRequestId);
      assertSourceIdForText(hosted, `${agentId}: explicit prompt steer`, explicitSteerRequestId);
      assertSourceIdForText(hosted, `${agentId}: edited queue text`, firstQueueRequestId);
      const afterText = `${agentId}: ordinary prompt after queue processing`;
      const afterRequestId = `${agentId}-ordinary-after-queue`;
      const ordinaryAfterQueue = await send(session.id, { type: 'prompt', id: afterRequestId, message: afterText });
      assert.equal(ordinaryAfterQueue.success, true);
      await within(until(() => hosted.session.isIdle && probe.activeGate === undefined), 3000);
      assertSourceIdForText(hosted, afterText, afterRequestId);
      assert.ok(!durableUserStarts(hosted).some(item => item.text.includes(`${agentId}: removable image queue`)),
        'a cancelled queue row must never become a durable user message');
      assert.ok(!durableUserStarts(hosted).some(item => item.requestId === removedQueueRequestId),
        'a cancelled queue request id must not be claimed by a later message');

      // Pi 1.0's preflight callback may say `handled` (the older SDK passed a
      // boolean). A handled idle submit has no user message in this stub, so its
      // request id must be settled before the next actual prompt can claim it.
      const turnsBeforeHandled = probe.turns.length;
      const startsBeforeHandled = durableUserStarts(hosted).length;
      const handledText = `${agentId}: SDK preflight handled without a user event`;
      const handledId = `${agentId}-handled-preflight`;
      const handledStub = stubPromptPreflight(hosted.session, 'handled');
      let handled: PiRpcResponse;
      try {
        handled = await send(session.id, { type: 'prompt', id: handledId, message: handledText });
      } finally {
        handledStub.restore();
      }
      assert.deepEqual(handledStub.calls, [handledText]);
      assert.equal(handled.success, true);
      assert.equal(rpcData(handled).accepted, true, 'string disposition "handled" must normalize to accepted=true');
      assert.equal(probe.turns.length, turnsBeforeHandled, 'a handled preflight stub must not call the model');
      assert.equal(durableUserStarts(hosted).length, startsBeforeHandled, 'a handled preflight stub must not create a durable user message');

      const afterHandledText = `${agentId}: user message after handled preflight`;
      const afterHandledId = `${agentId}-after-handled-preflight`;
      const afterHandled = await send(session.id, { type: 'prompt', id: afterHandledId, message: afterHandledText });
      assert.equal(afterHandled.success, true);
      await within(until(() => hosted.session.isIdle && probe.activeGate === undefined), 3000);
      assertSourceIdForText(hosted, afterHandledText, afterHandledId,
        'a handled no-message request id must not retire the next durable user message');

      const turnsBeforeRejected = probe.turns.length;
      const startsBeforeRejected = durableUserStarts(hosted).length;
      const rejectedText = `${agentId}: SDK preflight rejected without a user event`;
      const rejectedId = `${agentId}-rejected-preflight`;
      const rejectedStub = stubPromptPreflight(hosted.session, false);
      let rejected: PiRpcResponse;
      try {
        rejected = await send(session.id, { type: 'prompt', id: rejectedId, message: rejectedText });
      } finally {
        rejectedStub.restore();
      }
      assert.deepEqual(rejectedStub.calls, [rejectedText]);
      assert.equal(rejected.success, true);
      assert.equal(rpcData(rejected).accepted, false, 'the legacy boolean false disposition must remain rejected');
      assert.equal(probe.turns.length, turnsBeforeRejected, 'a rejected preflight must not call the model');
      assert.equal(durableUserStarts(hosted).length, startsBeforeRejected, 'a rejected preflight must not create a durable user message');

      const afterRejectedText = `${agentId}: user message after rejected preflight`;
      const afterRejectedId = `${agentId}-after-rejected-preflight`;
      const afterRejected = await send(session.id, { type: 'prompt', id: afterRejectedId, message: afterRejectedText });
      assert.equal(afterRejected.success, true);
      await within(until(() => hosted.session.isIdle && probe.activeGate === undefined), 3000);
      assertSourceIdForText(hosted, afterRejectedText, afterRejectedId,
        'a rejected request id must be forgotten before the next durable user message');

      // Queue flushing has the same newer-SDK `handled` disposition as a direct
      // prompt. Stub just the flush call so it creates no user event, then make
      // sure its deferred row id cannot attach to the next ordinary prompt.
      probe.holdNext = true;
      const turnsBeforeFlushHold = probe.turns.length;
      const flushHoldText = `${agentId}: hold before handled queue flush`;
      const flushHoldId = `${agentId}-flush-hold`;
      const flushHold = await send(session.id, { type: 'prompt', id: flushHoldId, message: flushHoldText });
      assert.equal(flushHold.success, true);
      await within(until(() => probe.activeGate !== undefined && hosted.session.isStreaming), 3000);
      const flushQueueText = `${agentId}: queued row handled without user event`;
      const flushQueueId = `${agentId}-flush-handled-queue`;
      const flushQueued = await send(session.id, { type: 'prompt', id: flushQueueId, message: flushQueueText });
      assert.equal(rpcData(flushQueued).deliveredAs, 'queue');
      const flushStub = stubPromptPreflight(hosted.session, 'handled');
      const startsBeforeHandledFlush = durableUserStarts(hosted).length;
      assertSourceIdForText(hosted, flushHoldText, flushHoldId);
      probe.activeGate!.release();
      try {
        await within(until(() => flushStub.calls.length === 1 && hosted.queue.length === 0
          && hosted.session.isIdle && hosted.flushing !== true && probe.activeGate === undefined), 5000);
      } finally {
        flushStub.restore();
      }
      assert.deepEqual(flushStub.calls, [flushQueueText]);
      assert.equal(probe.turns.length, turnsBeforeFlushHold + 1,
        'handled queue flush must not start a second scripted model turn');
      assert.equal(durableUserStarts(hosted).length, startsBeforeHandledFlush,
        'a handled queue flush must not create another durable user message');
      assert.ok(!durableUserStarts(hosted).some(item => item.text.includes(flushQueueText)));

      const afterFlushText = `${agentId}: ordinary prompt after handled queue flush`;
      const afterFlushId = `${agentId}-ordinary-after-handled-flush`;
      const afterFlush = await send(session.id, { type: 'prompt', id: afterFlushId, message: afterFlushText });
      assert.equal(afterFlush.success, true);
      await within(until(() => hosted.session.isIdle && probe.activeGate === undefined), 3000);
      assertSourceIdForText(hosted, afterFlushText, afterFlushId,
        'a handled flushed row must not retire the next ordinary prompt echo');
      assert.ok(!durableUserStarts(hosted).some(item => item.requestId === flushQueueId));

      const savedFile = hosted.sessionFile;
      await host.kill(session.id);
      assert.ok(savedFile, `${agentId} first SDK turn should persist before stop test`);

      const stoppedOpen = await fetch(`${base}/api/module-agents/${agentId}/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: `open-stop-${agentId}` }),
      });
      assert.equal(stoppedOpen.status, 200);
      const stoppedId = ((await stoppedOpen.json()) as { session: { id: string } }).session.id;
      const stoppedSession = host.get(stoppedId)!;
      const stoppedProbe = probes.get(stoppedId)!;
      const stopPrompt = await send(stoppedId, { type: 'prompt', id: `${agentId}-stop-start`, message: `${agentId}: stop this held turn` });
      assert.equal(stopPrompt.success, true);
      await within(until(() => stoppedProbe.activeGate !== undefined && stoppedSession.session.isStreaming), 3000);
      const abort = await send(stoppedId, { type: 'abort', id: `${agentId}-stop` });
      assert.equal(abort.success, true);
      await within(until(() => stoppedProbe.turns[0]?.status === 'aborted' && stoppedSession.session.isIdle), 3000);
      assert.equal(stoppedProbe.turns[0]?.status, 'aborted', `${agentId} stop must abort the held SDK stream`);
      await host.kill(stoppedId);

      console.log(`PASS ${agentId}: busy queue, edit/remove/queue-steer, explicit prompt steer, image attachment, stop`);
    }

    assert.equal(store.listRecords('tasks').length, 0, 'command coverage must not create user tasks');
    assert.equal(store.listRecords('requirements').length, 0, 'command coverage must not create requirement drafts');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await host.disposeAll();
    store.close();
    for (const [key, value] of Object.entries({
      PI_CODING_AGENT_DIR: oldEnv.agentDir,
      PI_WEBX_AGENT_WORKSPACE_ROOT: oldEnv.workspaceRoot,
      PI_WEBX_HOME: oldEnv.webHome,
      PI_WEBX_AGENT_CONFIG_DIR: oldEnv.configRoot,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();
