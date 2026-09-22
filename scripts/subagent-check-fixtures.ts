import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentDefinition } from '../src/shared/agent-definitions';
import { freezeDefinition, type SubagentDispatchRequest } from '../server/pi/subagent-tool';

export function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'test-agent', name: 'test-agent', description: 'isolated test', revision: 1,
    systemPrompt: 'Return the test result.', model: { mode: 'inherit' },
    tools: { mode: 'all' }, maxTurns: 4, maxConcurrentInstances: 2,
    enabled: true, source: 'user', readOnly: false, createdAt: '', updatedAt: '', ...overrides,
  };
}

export function request(overrides: Partial<SubagentDispatchRequest> = {}): SubagentDispatchRequest {
  return { definition: freezeDefinition(definition()), task: 'test', toolCallId: 'parent-call',
    surface: { toolNames: [], excluded: [], unavailable: [] }, signal: undefined, onUpdate: undefined, ...overrides };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function within<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`test exceeded ${ms}ms`)), ms);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function until(predicate: () => boolean): Promise<void> {
  await within((async () => { while (!predicate()) await delay(1); })());
}

export const memorySettings = () => SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }, { projectTrusted: false });

export async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagent-boundaries-'));
  const cwd = join(root, 'work'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(join(agentDir, 'extensions'), { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModels('deepseek')[0]; assert.ok(model);
  runtime.streamSimple = () => { throw new Error('network forbidden by test fixture'); };
  return { root, cwd, agentDir, runtime, model, close: () => rm(root, { recursive: true, force: true }) };
}

export function scripted(session: AgentSession, build: (turn: number) => Pick<AssistantMessage, 'content' | 'stopReason'>, waitMs = 0) {
  let turns = 0;
  const model = session.model!;
  session.agent.getApiKey = () => 'local-script-no-network';
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', ...build(++turns), api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
    };
    void delay(waitMs).then(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
      stream.end(message);
    });
    return stream;
  };
}
