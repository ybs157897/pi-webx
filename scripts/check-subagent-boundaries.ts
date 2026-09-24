/** Real SDK boundary regressions. All model streams are local, no credential/network access. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SettingsManager, type ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createWorkerSession, createWorkerSettings, disposeWorkerSession, resolveWorkerModel, type SubagentParentContext } from '../server/pi/subagent-session';
import { createSubagentWorkerDispatch, type SubagentWorkerRunner } from '../server/pi/subagent-worker';
import { createSubagentTool, freezeDefinition } from '../server/pi/subagent-tool';
import { SubagentRunError } from '../server/pi/subagent-error';
import { createExtensionUiScope, type PendingExtensionDialog } from '../server/pi/extension-ui';
import { PiHost, HostError } from '../server/pi/host';
import type { SubagentCapacity } from '../server/pi/subagent-capacity';
import type { SessionCapacity } from '../server/pi/session-capacity';
import type { PiExtensionUiRequest, SubagentUiOrigin } from '../src/shared/protocol';
import { sandbox, definition, memorySettings, scripted, until, within, deferred } from './subagent-check-fixtures';

const env = await sandbox();
const { cwd, agentDir, model, runtime, root } = env;
const parent: SubagentParentContext = { cwd, agentDir, sessionId: 'parent', session: {
  model, thinkingLevel: 'off', settingsManager: memorySettings(), getAllTools: () => [],
} };
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const hosts: PiHost[] = [];
try {
  // Exact fixed selection cannot become a fuzzy model, a fabricated id, or another provider.
  const models = [{ ...model, provider: 'alpha', id: 'flash-pro' }, { ...model, provider: 'beta', id: 'alpha/flash' }];
  const lookup = { getModel: (p: string, id: string) => models.find(m => m.provider === p && m.id === id),
    hasConfiguredAuth: (p: string) => p === 'beta' } satisfies Pick<ModelRuntime, 'getModel' | 'hasConfiguredAuth'>;
  for (const modelId of ['flash', 'does-not-exist', 'flash-pro']) {
    const def = freezeDefinition(definition({ model: { mode: 'fixed', providerId: 'alpha', modelId } }));
    assert.throws(() => resolveWorkerModel(def, parent.session, lookup), (e: SubagentRunError) => e.code === 'invalid-model');
  }
  models.push({ ...model, provider: 'alpha', id: 'flash' });
  assert.throws(() => resolveWorkerModel(freezeDefinition(definition({ model: { mode: 'fixed', providerId: 'alpha', modelId: 'flash' } })), parent.session, lookup), (e: SubagentRunError) => e.code === 'invalid-model');
  const exact = resolveWorkerModel(freezeDefinition(definition({ model: { mode: 'fixed', providerId: 'beta', modelId: 'alpha/flash' } })), parent.session, lookup);
  assert.equal(exact, models[1]);
  assert.equal(resolveWorkerModel(freezeDefinition(definition()), parent.session, lookup), model);

  // Two in-memory settings layers retain the SDK's recursive merge on read and subsequent writes.
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false, maxRetries: 5, baseDelayMs: 1500 } }));
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ retry: { maxRetries: 1 } }));
  const parentSettings = SettingsManager.create(cwd, agentDir);
  const before = await readFile(join(agentDir, 'settings.json'), 'utf8');
  const copied = createWorkerSettings(parentSettings);
  assert.deepEqual(copied.getRetrySettings(), { enabled: false, maxRetries: 1, baseDelayMs: 1500 });
  copied.setRetryEnabled(true); await copied.flush();
  assert.equal(copied.getRetrySettings().maxRetries, 1, 'project overrides survive a child setting write');
  assert.equal(parentSettings.getRetrySettings().enabled, false);
  assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), before);

  // Each extension instance gets session_start; the child has a real scoped browser UI.
  await writeFile(join(agentDir, 'extensions', 'boundary.js'), `export default function(pi) {
    let started=false;
    pi.on('session_start',()=>{started=true});
    pi.on('session_shutdown',(_event,ctx)=>{ctx.ui.notify('extension closed','info')});
    pi.registerTool({name:'probe_ask',label:'Ask',description:'test interaction',parameters:{type:'object',properties:{}},
      async execute(_id,_p,_s,_u,ctx){
        if(!started || !ctx.hasUI) throw new Error('child extension not bound');
        const answer=await ctx.ui.confirm('Confirm test','Question');
        return {content:[{type:'text',text:JSON.stringify({answer,started,hasUI:ctx.hasUI})}],details:{}};
      }});
  }`);
  const dialogs = new Map<string, PendingExtensionDialog>(), events: PiExtensionUiRequest[] = [];
  const owner = { pendingDialogs: dialogs, isAlive: () => true, publish: (e: PiExtensionUiRequest) => events.push(e) };
  const origin = (runId: string): SubagentUiOrigin => ({ kind: 'subagent', runId, agentId: 'test-agent', agentName: 'test-agent', toolCallId: 'call-'+runId });
  const abortA = new AbortController(), abortB = new AbortController();
  const a = createExtensionUiScope(owner, { origin: origin('a'), signal: abortA.signal });
  const b = createExtensionUiScope(owner, { origin: origin('b'), signal: abortB.signal });
  const child = await createWorkerSession({ definition: freezeDefinition(definition()), parent, model, runtime,
    toolNames: ['probe_ask'], denied: ['subagent'], uiContext: a.context, signal: abortA.signal });
  try {
    const askTool = child.agent.state.tools.find(t => t.name === 'probe_ask')!;
    const answer = askTool.execute('q', {}, undefined, undefined).catch(e => e);
    const sibling = b.context.editor('Sibling', '');
    await until(() => dialogs.size === 2);
    a.context.setStatus('shared', 'A'); b.context.setStatus('shared', 'B');
    assert.equal(new Set(events.filter(e => e.method === 'setStatus').map(e => e.statusKey)).size, 2);
    assert.throws(() => a.context.setEditorText('overwrite parent'), /不能修改/);
    const first = [...dialogs.values()].find(d => d.request.origin?.runId === 'a')!;
    assert.match(first.request.title!, /^\[test-agent\]/);
    assert.equal(first.request.origin?.toolCallId, 'call-a');
    abortA.abort(new Error('cancel only A'));
    assert.match((await within(answer)).message, /cancel only A/);
    assert.equal(dialogs.size, 1, 'a child cancellation leaves its sibling dialog open');
    const remaining = [...dialogs.values()][0]!;
    assert.equal(remaining.request.origin?.runId, 'b');
    remaining.respond({ type: 'extension_ui_response', id: remaining.request.id, value: 'answered' });
    assert.equal(await sibling, 'answered');
    const bound = await createWorkerSession({ definition: freezeDefinition(definition()), parent: { ...parent, session: { ...parent.session, settingsManager: parentSettings } }, model, runtime,
      toolNames: [], denied: [], uiContext: b.context });
    assert.deepEqual(bound.settingsManager.getRetrySettings(), parentSettings.getRetrySettings()); bound.dispose();
  } finally { await disposeWorkerSession(child); a.dispose(); b.dispose(); }
  assert.equal(dialogs.size, 0);

  // Host -> dispatcher -> real SDK children -> parent browser dialog bridge -> tool results.
  runtime.hasConfiguredAuth = () => true;
  const def = definition({ tools: { mode: 'selected', names: ['probe_ask'] } });
  const newHost = (read = async () => ({ schemaVersion: 1 as const, revision: 0, path: join(root, 'defs.json'), agents: [def] })) => {
    const host = new PiHost({ definitions: { read }, modelRuntimeFactory: async () => runtime,
      settingsManagerFactory: memorySettings, sessionDir: join(root, 'sessions') });
    hosts.push(host); return host;
  };
  type TestHost = { capacity: SubagentCapacity; sessionCapacity: SessionCapacity; workerRunner: SubagentWorkerRunner };
  const host = newHost(), wiring = host as unknown as TestHost;
  const hosted = await host.create({ cwd, provider: model.provider, model: model.id, noSession: true, toolNames: ['read'] });
  const published: PiExtensionUiRequest[] = [];
  host.subscribe(hosted, { frame: ({ frame }) => {
    if (frame.t === 'pi' && frame.event.type === 'extension_ui_request') published.push(frame.event);
  }, close: () => undefined });
  let live = 0, peak = 0, disposed = 0;
  const errors: boolean[] = [];
  wiring.workerRunner = createSubagentWorkerDispatch({ capacity: wiring.capacity, modelRuntime: async () => runtime,
    createSession: async opts => {
      const child = await createWorkerSession(opts); live++; peak = Math.max(peak, live);
      child.subscribe(e => { if (e.type === 'tool_execution_end') errors.push(e.isError); });
      scripted(child, n => n === 1
        ? { content: [{ type: 'toolCall', id: 'ask-'+live, name: 'probe_ask', arguments: {} }], stopReason: 'toolUse' }
        : { content: [{ type: 'text', text: 'child finished' }], stopReason: 'stop' });
      return { getActiveToolNames: () => child.getActiveToolNames(), subscribe: f => child.subscribe(f), prompt: t => child.prompt(t), abort: () => child.abort(),
        get extensionRunner() { return child.extensionRunner; },
        get messages() { return child.messages; }, dispose: () => { child.dispose(); live--; disposed++; } };
    } });
  scripted(hosted.session, n => n === 1
    ? { content: [1, 2].map(i => ({ type: 'toolCall', id: 'spawn-'+i, name: 'subagent', arguments: { agentId: def.id, task: 'independent '+i } })), stopReason: 'toolUse' }
    : { content: [{ type: 'text', text: 'parent finished' }], stopReason: 'stop' });
  const prompt = hosted.session.prompt('two children');
  await until(() => hosted.pendingDialogs.size === 2);
  const snapshot = await host.command(hosted.id, { type: 'get_messages' });
  assert.equal((snapshot.data as { pendingDialogs: unknown[] }).pendingDialogs.length, 2);
  const requests = [...hosted.pendingDialogs.values()].map(v => v.request);
  assert.equal(new Set(requests.map(r => r.origin?.runId)).size, 2);
  assert.deepEqual(requests.map(r => r.origin?.toolCallId).sort(), ['spawn-1', 'spawn-2']);
  for (const req of requests) {
    const response = await host.command(hosted.id, { type: 'extension_ui_response', id: req.id, confirmed: true });
    assert.equal(response.success, true);
  }
  await within(prompt);
  assert.equal(peak, 2); assert.equal(disposed, 2); assert.equal(live, 0);
  assert.deepEqual(errors, [false, false]); assert.equal(hosted.pendingDialogs.size, 0);
  assert.equal(wiring.capacity.size, 0); assert.equal(wiring.sessionCapacity.size, 1);
  const toolResults = hosted.session.messages.filter(m => m.role === 'toolResult');
  assert.equal(toolResults.length, 2); assert.ok(toolResults.every(m => !m.isError));
  assert.equal(published.filter(e => e.method === 'notify' && e.origin && e.message?.includes('extension closed')).length, 2,
    'both child shutdown handlers execute before their UI/context is disposed');
  scripted(hosted.session, n => n === 1
    ? { content: [{ type: 'toolCall', id: 'cancelled-spawn', name: 'subagent', arguments: { agentId: def.id, task: 'cancel this child' } }], stopReason: 'toolUse' }
    : { content: [{ type: 'text', text: 'after cancellation' }], stopReason: 'stop' });
  const cancelledPrompt = hosted.session.prompt('cancel pending child interaction');
  await until(() => hosted.pendingDialogs.size === 1);
  assert.equal((await within(host.command(hosted.id, { type: 'abort' }))).success, true);
  await within(cancelledPrompt);
  assert.equal(hosted.pendingDialogs.size, 0);
  assert.equal(wiring.capacity.size, 0);
  assert.equal(disposed, 3); assert.equal(live, 0);
  await host.kill(hosted.id); assert.equal(wiring.sessionCapacity.size, 0);

  // A selected tool must fail before dispatch; all-policy reductions must reach model-visible content.
  const run = (tool: ToolDefinition) => tool.execute('p', { agentId: def.id, task: 'test' }, undefined, undefined, {} as never);
  let dispatched = false;
  const tool = createSubagentTool({ definitions: async () => ({ schemaVersion: 1, revision: 0, path: '', agents: [definition({ tools: { mode: 'selected', names: ['write'] } })] }),
    parentActiveTools: () => ['read'], dispatch: async () => { dispatched = true; throw new Error('unexpected'); } }, []);
  await assert.rejects(() => run(tool), (e: SubagentRunError) => e.code === 'unavailable-tools'); assert.equal(dispatched, false);
  const all = createSubagentTool({ definitions: async () => ({ schemaVersion: 1, revision: 0, path: '', agents: [definition()] }), parentActiveTools: () => ['read', 'probe_ask'],
    dispatch: async () => ({ runId: 'r', text: 'done', model: { provider: 'x', id: 'y' }, effectiveTools: ['read'], turns: 1, durationMs: 1, truncated: false }) }, []);
  assert.match((await run(all)).content.map(b => b.type === 'text' ? b.text : '').join(''), /Unavailable tools: probe_ask/);

  // Parent creation holds its reservation while definitions/extension initialization awaits.
  const gate = deferred<void>(); let block = false, entered = false;
  const capHost = newHost(async () => {
    if (block) { entered = true; await gate.promise; }
    return { schemaVersion: 1, revision: 0, path: '', agents: [def] };
  });
  const capWiring = capHost as unknown as TestHost;
  for (let i = 0; i < 11; i++) await capHost.create({ cwd, noSession: true, provider: model.provider, model: model.id });
  block = true;
  const creating = capHost.create({ cwd, noSession: true, provider: model.provider, model: model.id });
  await until(() => entered);
  assert.equal(capWiring.sessionCapacity.size, 12);
  await assert.rejects(() => capWiring.capacity.acquire({ parentId: 'existing', definitionId: 'd', definitionLimit: 1 }, { timeoutMs: 1000 }));
  await assert.rejects(() => capHost.create({ cwd }), (e: HostError) => e.status === 429);
  await assert.rejects(() => capHost.fork({ cwd, source: 'unused-at-full-capacity' }), (e: HostError) => e.status === 429);
  gate.resolve(); await creating;
  await capHost.disposeAll(); assert.equal(capWiring.sessionCapacity.size, 0);
  await assert.rejects(() => capHost.create({ cwd }), (e: HostError) => e.status === 503);

  // A failed assembly/fork returns its reservation for reuse.
  const failureHost = newHost(), failureWiring = failureHost as unknown as TestHost;
  await assert.rejects(() => failureHost.fork({ cwd, source: join(root, 'not-a-session') }));
  assert.equal(failureWiring.sessionCapacity.size, 0);
  await assert.rejects(() => failureHost.create({ cwd, provider: 'unknown-review-provider', model: 'unlisted-review-model-8f2' }));
  assert.equal(failureWiring.sessionCapacity.size, 0);
  const resumable = await failureHost.create({ cwd, provider: model.provider, model: model.id });
  scripted(resumable.session, () => ({ content: [{ type: 'text', text: 'persist test' }], stopReason: 'stop' }));
  await within(resumable.session.prompt('persist test'));
  await assert.rejects(() => failureHost.create({ cwd, sessionPath: resumable.session.sessionFile }), (e: HostError) => e.status === 409);
  assert.equal(failureWiring.sessionCapacity.size, 1, 'a failed duplicate resume releases only its own reservation');
  assert.equal(resumable.alive, true);
  console.log('check-subagent-boundaries: exact models, settings, child UI, parallel SDK flow, tool failures and host reservations passed');
} finally {
  for (const host of hosts) await host.disposeAll();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await env.close();
}
