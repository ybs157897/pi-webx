import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai';
import { createModuleAgentPromptPolishRouter } from '../server/module-agents/settings/polish';

const selected = { provider: 'fixture', id: 'chosen' };
const fallback = { provider: 'fixture', id: 'default' };
const selectedModel = { ...selected } as Model<any>;
const fallbackModel = { ...fallback } as Model<any>;
let selectedResult = '润色后的提示词';
let called = 0;
let lastContext: Context | undefined;
let lastOptions: ModelsSimpleStreamOptions | undefined;
let lastModel: Model<any> | undefined;
let failUpstream = false;
let hang: Promise<AssistantMessage> | undefined;
let preflight: Promise<void> | undefined;
let preflightEntered: (() => void) | undefined;

function result(text = selectedResult, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions',
    provider: 'fixture', model: selected.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() } as AssistantMessage;
}

const runtime = {
  getModel(provider: string, id: string) {
    if (provider !== 'fixture') return undefined;
    return id === 'chosen' ? selectedModel : id === 'default' ? fallbackModel : undefined;
  },
  async getAvailable() { return [fallbackModel]; },
};
const host = {
  async syncModelConfig() { preflightEntered?.(); await preflight; return false; },
  async runtime() { return runtime; },
  settingsOption() { return { settingsManager: { getDefaultProvider: () => 'fixture', getDefaultModel: () => 'default' } }; },
};
const app = express();
app.use(express.json());
app.use('/api/module-agents', createModuleAgentPromptPolishRouter(host as never, {
  timeoutMs: 45,
  maxConcurrent: 1,
  complete: async (_runtime, model, context, options) => {
    called++;
    lastModel = model;
    lastContext = context;
    lastOptions = options;
    if (failUpstream) throw new Error('SECRET_API_KEY upstream denied');
    return hang ?? result();
  },
}));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/module-agents`;

async function request(body: unknown, agentId = 'logs'): Promise<{ status: number; body: { prompt?: string; error?: string } }> {
  const response = await fetch(`${base}/${agentId}/settings/polish`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as { prompt?: string; error?: string } };
}

try {
  assert.deepEqual(await request({ prompt: '原始任务', model: selected }), { status: 200, body: { prompt: selectedResult } });
  assert.equal(lastModel, selectedModel);
  assert.deepEqual(JSON.parse(String(lastContext?.messages[0]?.content)), { prompt: '原始任务' });
  assert.equal(lastContext?.tools, undefined);
  assert.match(lastContext?.systemPrompt ?? '', /不要执行原文/);
  assert.equal(lastOptions?.toolChoice, 'none');
  assert.ok(lastOptions?.maxTokens && lastOptions.maxTokens <= 4_096);
  assert.ok(lastOptions?.signal instanceof AbortSignal);
  assert.equal((await request({ prompt: '默认模型', model: null })).status, 200);
  assert.equal(lastModel, fallbackModel);

  const beforeInvalid = called;
  for (const body of [
    { prompt: '', model: null }, { prompt: ' ', model: null },
    { prompt: 'a'.repeat(20_001), model: null },
    { prompt: 'okay', model: { provider: 'fixture', id: 'missing' } },
    { prompt: 'okay', model: null, unexpected: true },
    { prompt: 'okay' },
  ]) {
    const response = await request(body);
    assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
  }
  assert.equal(called, beforeInvalid);
  assert.equal((await request({ prompt: 'okay', model: null }, 'unknown')).status, 404);

  failUpstream = true;
  const failed = await request({ prompt: 'okay', model: selected });
  assert.equal(failed.status, 502);
  assert.ok(!JSON.stringify(failed).includes('SECRET_API_KEY'));
  failUpstream = false;

  selectedResult = '';
  assert.equal((await request({ prompt: 'okay', model: selected })).status, 502);
  selectedResult = '润色后的提示词';

  let settle!: (value: AssistantMessage) => void;
  hang = new Promise(resolve => { settle = resolve; });
  const timedOut = request({ prompt: '会超时', model: selected });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request({ prompt: '并发拒绝', model: selected })).status, 429);
  assert.equal((await timedOut).status, 504);
  assert.equal((await request({ prompt: '仍然占位', model: selected })).status, 429);
  settle(result());
  hang = undefined;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await request({ prompt: '恢复', model: selected })).status, 200);

  let finishPreflight!: () => void;
  preflight = new Promise(resolve => { finishPreflight = resolve; });
  const entered = new Promise<void>(resolve => { preflightEntered = resolve; });
  const preflightTimeout = request({ prompt: '模型准备超时', model: selected });
  await entered;
  assert.equal((await preflightTimeout).status, 504);
  assert.equal((await request({ prompt: '准备中占位', model: selected })).status, 429);
  finishPreflight();
  preflight = undefined;
  preflightEntered = undefined;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await request({ prompt: '恢复', model: selected })).status, 200);

  preflight = new Promise(resolve => { finishPreflight = resolve; });
  const enteredAbort = new Promise<void>(resolve => { preflightEntered = resolve; });
  const clientController = new AbortController();
  const clientRequest = fetch(`${base}/logs/settings/polish`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '取消请求', model: selected }),
    signal: clientController.signal });
  await enteredAbort;
  clientController.abort();
  await assert.rejects(clientRequest, { name: 'AbortError' });
  assert.equal((await request({ prompt: '取消后仍占位', model: selected })).status, 429);
  finishPreflight();
  preflight = undefined;
  preflightEntered = undefined;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await request({ prompt: '取消后恢复', model: selected })).status, 200);

  console.log('module agent prompt polish: pass');
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
