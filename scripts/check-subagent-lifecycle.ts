/** Lifecycle regression: finite cancellation, late cleanup and a single shared budget. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SessionCapacity } from '../server/pi/session-capacity';
import { SubagentCapacity } from '../server/pi/subagent-capacity';
import { createSubagentWorkerDispatch, type WorkerSessionHandle } from '../server/pi/subagent-worker';
import type { SubagentParentContext } from '../server/pi/subagent-session';
import { SubagentRunError } from '../server/pi/subagent-error';
import { deferred, request, until, within } from './subagent-check-fixtures';

const runtime = {} as ModelRuntime;
const parent: SubagentParentContext = { sessionId: 'parent', cwd: '/tmp', agentDir: '/tmp', session: {
  model: { provider: 'test', id: 'test' } as NonNullable<SubagentParentContext['session']['model']>,
  thinkingLevel: 'off', settingsManager: SettingsManager.inMemory(), getAllTools: () => [],
} };
function child() {
  const counts = { prompt: 0, abort: 0, dispose: 0 };
  const session: WorkerSessionHandle = {
    subscribe: () => () => undefined, getActiveToolNames: () => [],
    prompt: async () => { counts.prompt++; }, abort: async () => { counts.abort++; }, dispose: () => { counts.dispose++; },
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }],
  };
  return { session, counts };
}

for (const stage of ['runtime', 'session'] as const) {
  for (const stop of ['timeout', 'parent'] as const) {
    const budget = new SessionCapacity(2), capacity = new SubagentCapacity({ maxWorkers: 1, budget });
    const gate = deferred<void>(); let entered = false, created = 0;
    const late = child();
    const runner = createSubagentWorkerDispatch({ capacity, timeoutMs: stop === 'timeout' ? 20 : 5000,
      modelRuntime: async () => { if (stage === 'runtime') { entered = true; await gate.promise; } return runtime; },
      createSession: async () => { created++; if (stage === 'session') { entered = true; await gate.promise; } return late.session; },
    });
    const result = runner.dispatch(parent, request()).catch((error: SubagentRunError) => error);
    try {
      await until(() => entered);
      if (stop === 'parent') await within(runner.cancelParent(parent.sessionId), 750);
      const error = await within(result, 750);
      assert.ok(error instanceof SubagentRunError);
      assert.equal(error.code, stop === 'timeout' ? 'timeout' : 'parent-aborted');
      assert.ok(error.runId);
      assert.equal(capacity.size, 1, 'unsettled initialization keeps its reservation');
      assert.equal(late.counts.prompt, 0, 'cancelled initialization cannot start a prompt');
      const queued = runner.dispatch(parent, request()).catch((error: SubagentRunError) => error);
      await until(() => capacity.queued === 1);
      await within(runner.cancelParent(parent.sessionId), 750);
      assert.equal((await queued as SubagentRunError).code, 'parent-aborted');
      assert.equal(capacity.queued, 0);
      gate.resolve();
      await until(() => capacity.size === 0);
      assert.equal(budget.size, 0);
      assert.equal(created, stage === 'runtime' ? 0 : 1);
      assert.equal(late.counts.dispose, stage === 'runtime' ? 0 : 1);
      assert.equal(late.counts.prompt, 0);
    } finally { gate.resolve(); await runner.cancelAll(); }
  }
}

// A late rejection is observed, releases its lease, and never becomes unhandled.
{
  const budget = new SessionCapacity(1), capacity = new SubagentCapacity({ maxWorkers: 1, budget });
  const gate = deferred<WorkerSessionHandle>(); let entered = false;
  const runner = createSubagentWorkerDispatch({ capacity, timeoutMs: 20, modelRuntime: async () => runtime,
    createSession: () => { entered = true; return gate.promise; } });
  const result = runner.dispatch(parent, request()).catch(error => error);
  await until(() => entered);
  assert.equal((await within(result)).code, 'timeout');
  gate.reject(new Error('late failure'));
  await until(() => capacity.size === 0);
  assert.equal(budget.size, 0);
  await runner.cancelAll();
  await assert.rejects(() => runner.dispatch(parent, request()), (error: SubagentRunError) => error.code === 'parent-aborted');
}

// An executing tool that ignores abort also stays owned until quiescent.
{
  const budget = new SessionCapacity(1), capacity = new SubagentCapacity({ maxWorkers: 1, budget });
  const pending = deferred<void>(); const late = child();
  late.session.prompt = async () => { late.counts.prompt++; await pending.promise; };
  const runner = createSubagentWorkerDispatch({ capacity, timeoutMs: 20, modelRuntime: async () => runtime, createSession: async () => late.session });
  const result = await within(runner.dispatch(parent, request()).catch(error => error));
  assert.equal(result.code, 'timeout'); assert.equal(late.counts.abort, 1);
  assert.equal(capacity.size, 1); assert.equal(late.counts.dispose, 0);
  pending.resolve(); await until(() => capacity.size === 0);
  assert.equal(late.counts.dispose, 1); assert.equal(budget.size, 0);
}

// Hosted initialization and workers consume the same budget; releases pump FIFO waiters.
{
  const budget = new SessionCapacity(3), capacity = new SubagentCapacity({ maxWorkers: 2, budget });
  const hosted = budget.reserve()!;
  const first = await capacity.acquire({ parentId: 'p', definitionId: 'd', definitionLimit: 1 }, { timeoutMs: 1000 });
  assert.equal(first.kind, 'acquired');
  const waiting = capacity.acquire({ parentId: 'p', definitionId: 'd', definitionLimit: 1 }, { timeoutMs: 1000 });
  const initializing = budget.reserve()!;
  assert.equal(budget.size, 3); assert.equal(budget.reserve(), undefined);
  await assert.rejects(() => capacity.acquire({ parentId: 'p', definitionId: 'other', definitionLimit: 1 }, { timeoutMs: 1000 }));
  if (first.kind === 'acquired') first.slot.release();
  const second = await waiting; assert.equal(second.kind, 'acquired'); assert.equal(budget.size, 3);
  if (second.kind === 'acquired') { second.slot.release(); second.slot.release(); }
  initializing.release(); hosted.release(); assert.equal(budget.size, 0);
}
await delay(0);
console.log('check-subagent-lifecycle: timeout, cancellation, late cleanup, shutdown and shared budget passed');
