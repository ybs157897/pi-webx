/**
 * Real-SDK gate for the explore codemode pilot (`PI_EXPLORE_CODEMODE=1`).
 *
 * Three layers, matching what each can actually prove:
 *
 *   1. **Policy (pure).** The grant exists only for `builtin:explore` with a
 *      `selected` tool policy and the flag on; a granted name cannot bypass the
 *      restricted-tool exclusion; flag-off behaviour is byte-identical to before
 *      the pilot existed.
 *   2. **Metrics (pure).** Usage is summed per assistant turn and survives both
 *      the success return and every failure throw; the pilot's counters ride the
 *      failure message as key=value fields, so a failed run keeps its sample.
 *   3. **Real SDK + QuickJS, no model, no network.** With the pilot grant
 *      mounted: five active tools, the four read-only direct tools still
 *      declared, `codemode` itself not callable from scripts (exposure
 *      `model-only` — no recursion), the `models` namespace absent
 *      (`models:false`), a nested `read` running through the real pipeline, and
 *      the host nested-call ceiling blocking + counting past its limit.
 *
 * Everything runs against the installed `@earendil-works/pi-coding-agent` with
 * no provider call: a temporary agent dir, an empty credentials store, no
 * catalogue file, `allowModelNetwork`/`refreshOnCreate` off. The user's real
 * `~/.pi` is never read, written or redefined.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

import { BUILTIN_AGENT_DEFINITIONS, BUILTIN_EXPLORE_ID, BUILTIN_GENERAL_PURPOSE_ID } from '../server/builtin-agents';
import {
  CODEMODE_NESTED_CALL_LIMIT, EXPLORE_CODEMODE_ENV, exploreCodemodeEnabled, exploreCodemodeGrant,
  HOST_EXCLUSIVE_CHILD_TOOLS,
} from '../server/pi/subagent-codemode-pilot';
import { executeWorkerSession, type WorkerSessionLike } from '../server/pi/subagent-execution';
import { SubagentRunError } from '../server/pi/subagent-error';
import { createWorkerSession, type WorkerSessionOptions } from '../server/pi/subagent-session';
import { createSubagentWorkerDispatch } from '../server/pi/subagent-worker';
import { SubagentCapacity } from '../server/pi/subagent-capacity';
import { SessionCapacity } from '../server/pi/session-capacity';
import {
  createSubagentTool, freezeDefinition, planToolSurface,
  type SubagentDispatchOutcome, type SubagentDispatchRequest, type SubagentToolDeps, type ToolSurface,
} from '../server/pi/subagent-tool';
import type { AgentDefinition, AgentDefinitionsResponse } from '../src/shared/agent-definitions';

function builtin(id: string): AgentDefinition {
  const found = BUILTIN_AGENT_DEFINITIONS.find((entry) => entry.id === id);
  assert.ok(found !== undefined, `builtin ${id} exists`);
  return found;
}

const EXPLORE = builtin(BUILTIN_EXPLORE_ID);
const EXPLORE_FROZEN = freezeDefinition(EXPLORE);

/* ------------------------------------------------------- 1. policy (pure) */

{
  assert.equal(exploreCodemodeEnabled({}), false, 'flag off by default');
  assert.equal(exploreCodemodeEnabled({ [EXPLORE_CODEMODE_ENV]: '0' }), false);
  assert.equal(exploreCodemodeEnabled({ [EXPLORE_CODEMODE_ENV]: '1' }), true, 'exactly "1" enables');

  // Grant eligibility: flag + builtin:explore + selected. Everything else misses.
  assert.equal(exploreCodemodeGrant(EXPLORE_FROZEN, false), undefined, 'flag off → no grant');
  assert.equal(
    exploreCodemodeGrant(freezeDefinition(builtin(BUILTIN_GENERAL_PURPOSE_ID)), true),
    undefined,
    'general-purpose never gets the grant',
  );
  const allToolsExplore = freezeDefinition({ ...EXPLORE, tools: { mode: 'all' } });
  assert.equal(exploreCodemodeGrant(allToolsExplore, true), undefined, '`all` policy never gets the grant');

  const grant = exploreCodemodeGrant(EXPLORE_FROZEN, true);
  assert.ok(grant !== undefined);
  assert.deepEqual(grant.hostGrantedTools, ['codemode']);
  assert.equal(grant.extensionFactories.length, 2, 'guard factory first, codemode second');
  assert.deepEqual(grant.stats, { outerCodemodeCalls: 0, nestedToolCalls: 0, blockedCalls: 0, directToolCalls: 0 });

  // The grant permits the name; without it the same policy is refused.
  const policy = { mode: 'selected' as const, names: ['read', 'grep', 'find', 'ls', 'codemode'] };
  const parentActive = ['read'];
  assert.deepEqual(
    planToolSurface(policy, parentActive).toolNames.sort(),
    ['find', 'grep', 'ls', 'read'],
    'without a grant codemode is unavailable to a selected definition',
  );
  assert.deepEqual(
    planToolSurface(policy, parentActive, grant.hostGrantedTools).toolNames.sort(),
    ['codemode', 'find', 'grep', 'ls', 'read'],
    'the host grant is the only thing that admits codemode',
  );

  // A grant cannot smuggle a restricted name past the exclusion.
  const smuggle = planToolSurface(
    { mode: 'selected' as const, names: ['read', 'codemode', 'subagent'] },
    [],
    ['codemode', 'subagent'],
  );
  assert.deepEqual(smuggle.excluded, ['subagent'], 'restricted names stay excluded even when granted');
  assert.ok(smuggle.toolNames.includes('codemode'));

  // `all` stays a pure ceiling: a grant widens nothing there.
  assert.deepEqual(
    planToolSurface({ mode: 'all' as const }, ['read'], grant.hostGrantedTools).toolNames,
    ['read'],
    '`all` ignores host grants',
  );

  // Host-exclusivity: parent activation alone never admits codemode, in either
  // policy mode — the grant is its only authorization source.
  assert.deepEqual(
    HOST_EXCLUSIVE_CHILD_TOOLS,
    new Set(['codemode']),
    'codemode is the one host-exclusive child tool',
  );
  const parentHasIt = planToolSurface(
    { mode: 'selected' as const, names: ['read', 'codemode'] },
    ['read', 'codemode'],
  );
  assert.deepEqual(parentHasIt.toolNames, ['read'], 'a parent that has codemode active grants nothing');
  assert.deepEqual(parentHasIt.unavailable, ['codemode'], 'a selected definition without a grant is refused loudly');
  assert.deepEqual(
    planToolSurface({ mode: 'all' as const }, ['read', 'codemode']).toolNames,
    ['read'],
    '`all` does not inherit host-exclusive names from the parent',
  );
  console.log('policy ok');
}

/* ------------------------------------------------------ 2. metrics (pure) */

const dispatchSurface: ToolSurface = { toolNames: ['read'], excluded: [], unavailable: [] };

{
  // Usage sums turn by turn and lands on the success outcome.
  const events: unknown[] = [
    { type: 'message_end', message: { role: 'assistant', usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 2 } } },
    { type: 'turn_end', toolResults: [] },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 200, output: 20, cacheRead: 1, cacheWrite: 0 } } },
    { type: 'turn_end', toolResults: [] },
  ];
  const session: WorkerSessionLike = {
    subscribe: (listener) => { for (const event of events) listener(event as never); return () => undefined; },
    prompt: async () => undefined,
    abort: async () => undefined,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer' }], stopReason: 'stop' }],
  };
  const outcome = await executeWorkerSession(session, {
    definition: EXPLORE_FROZEN, task: 'x', surface: dispatchSurface, signal: undefined, onUpdate: undefined,
  });
  assert.deepEqual(outcome.usage, { input: 300, output: 30, cacheRead: 6, cacheWrite: 2 });
  assert.equal(outcome.turns, 2);
  console.log('usage on success ok');
}

{
  // A failed run keeps its accounting on the error itself.
  {
    const session: WorkerSessionLike = {
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: 'boom' }],
    };
    await assert.rejects(
      executeWorkerSession(session, {
        definition: EXPLORE_FROZEN, task: 'x', surface: dispatchSurface, signal: undefined, onUpdate: undefined,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SubagentRunError);
        assert.equal(error.code, 'model-error');
        assert.equal(error.usage, undefined, 'a session that never reported usage has none');
        return true;
      },
    );
  }

  // Role filter: `message_end` also fires for tool-result messages carrying their
  // own usage — only assistant turns count against the documented contract.
  {
    const events: unknown[] = [
      { type: 'message_end', message: { role: 'toolResult', usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 } } },
      { type: 'turn_end', toolResults: [{}] },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 40, output: 4, cacheRead: 1, cacheWrite: 0 } } },
      { type: 'turn_end', toolResults: [] },
    ];
    const session: WorkerSessionLike = {
      subscribe: (listener) => { for (const event of events) listener(event as never); return () => undefined; },
      prompt: async () => undefined,
      abort: async () => undefined,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' }],
    };
    const outcome = await executeWorkerSession(session, {
      definition: EXPLORE_FROZEN, task: 'x', surface: dispatchSurface, signal: undefined, onUpdate: undefined,
    });
    assert.deepEqual(outcome.usage, { input: 40, output: 4, cacheRead: 1, cacheWrite: 0 }, 'tool-result usage is not double-counted');
  }
  console.log('usage on failure ok');
}

function dispatchOutcome(): SubagentDispatchOutcome {
  return {
    runId: 'run-1', text: 'done', model: { provider: 'deepseek', id: 'deepseek-v4-flash' },
    effectiveTools: ['read'], turns: 1, durationMs: 5, truncated: false,
  };
}

function definitionsResponse(agents: AgentDefinition[]): AgentDefinitionsResponse {
  return { schemaVersion: 1, revision: 1, path: '/probe/agents.json', agents };
}

{
  // With the flag on, the dispatch request carries the pilot payload and an
  // effective definition that adds codemode to the frozen four; the result
  // details expose the counters. With the flag off, neither appears.
  const savedFlag = process.env[EXPLORE_CODEMODE_ENV];
  try {
    process.env[EXPLORE_CODEMODE_ENV] = '1';
    const requests: SubagentDispatchRequest[] = [];
    const deps: SubagentToolDeps = {
      definitions: () => Promise.resolve(definitionsResponse([EXPLORE])),
      parentActiveTools: () => ['read'],
      dispatch: async (request) => {
        requests.push(request);
        return dispatchOutcome();
      },
    };
    const tool = createSubagentTool(deps, [EXPLORE_FROZEN]);
    const result = await tool.execute('call-1', { agentId: BUILTIN_EXPLORE_ID, task: 'x' }, undefined, undefined, {} as never);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].exploreCodemode !== undefined, 'the pilot payload reaches the dispatcher');
    assert.deepEqual(
      requests[0].definition.tools,
      { mode: 'selected', names: ['read', 'grep', 'find', 'ls', 'codemode'] },
      'the effective definition adds codemode to the frozen four',
    );
    const details = (result.details ?? {}) as Record<string, unknown>;
    assert.deepEqual(details.codemode, { outerCodemodeCalls: 0, nestedToolCalls: 0, blockedCalls: 0, directToolCalls: 0 });

    // Flag off: same dispatch, no payload, no extra details key.
    delete process.env[EXPLORE_CODEMODE_ENV];
    requests.length = 0;
    const off = createSubagentTool(deps, [EXPLORE_FROZEN]);
    const offResult = await off.execute('call-2', { agentId: BUILTIN_EXPLORE_ID, task: 'x' }, undefined, undefined, {} as never);
    assert.equal(requests[0].exploreCodemode, undefined, 'flag off sends no pilot payload');
    assert.deepEqual(requests[0].definition.tools, { mode: 'selected', names: ['read', 'grep', 'find', 'ls'] });
    assert.equal((offResult.details as Record<string, unknown>).codemode, undefined);
    console.log('dispatch payload on/off ok');
  } finally {
    if (savedFlag === undefined) delete process.env[EXPLORE_CODEMODE_ENV];
    else process.env[EXPLORE_CODEMODE_ENV] = savedFlag;
  }
}

{
  // A failed pilot dispatch keeps usage and the counters in the error message.
  const savedFlag = process.env[EXPLORE_CODEMODE_ENV];
  try {
    process.env[EXPLORE_CODEMODE_ENV] = '1';
    const deps: SubagentToolDeps = {
      definitions: () => Promise.resolve(definitionsResponse([EXPLORE])),
      parentActiveTools: () => ['read'],
      dispatch: () => Promise.reject(new SubagentRunError(
        'model-error', 'boom', undefined, 'run-9',
        { input: 11, output: 3, cacheRead: 1, cacheWrite: 0 },
      )),
    };
    const tool = createSubagentTool(deps, [EXPLORE_FROZEN]);
    await assert.rejects(
      tool.execute('call-3', { agentId: BUILTIN_EXPLORE_ID, task: 'x' }, undefined, undefined, {} as never),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /usage=in=11\/out=3\/cacheRead=1/);
        assert.match(message, /codemode=outer=0,nested=0,blocked=0,direct=0/);
        assert.match(message, /runId=run-9/);
        return true;
      },
    );
    console.log('failure fields ok');
  } finally {
    if (savedFlag === undefined) delete process.env[EXPLORE_CODEMODE_ENV];
    else process.env[EXPLORE_CODEMODE_ENV] = savedFlag;
  }
}

/* ------------------------------- 3. real SDK + QuickJS (no model/network) */

interface ScriptedEnd {
  readonly isError: boolean;
  readonly toolName: string;
  readonly text: string;
}

let scriptedCallSeq = 0;

/**
 * Drive one scripted tool call through the worker's real agent loop. The
 * "provider" is a scripted stream (no network, no credentials); the tool
 * execution — including codemode's QuickJS sandbox and its nested calls — is
 * the real thing. The tool registry is left untouched so nested calls can
 * resolve the read tool.
 */
async function driveWorkerToolCall(
  worker: AgentSession,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ScriptedEnd> {
  const agent = worker.agent;
  const model = agent.state.model;
  assert.ok(model !== undefined, 'the scripted loop needs a model object');

  const savedStream = agent.streamFunction;
  const savedApiKey = agent.getApiKey;
  const savedFinishTurn = agent.finishTurn;

  const ends: ScriptedEnd[] = [];
  const unsubscribe = agent.subscribe((event) => {
    if (event.type !== 'tool_execution_end') return;
    const result = event.result as { content?: { text?: string }[] } | undefined;
    ends.push({
      isError: event.isError,
      toolName: event.toolName,
      text: (result?.content ?? []).map((block) => block.text ?? '').join(''),
    });
  });

  scriptedCallSeq += 1;
  const callId = `scripted-codemode-${scriptedCallSeq}`;
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: toolName, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
  agent.streamFunction = (() => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'toolUse', message });
    stream.end(message);
    return stream;
  }) as unknown as typeof agent.streamFunction;
  agent.getApiKey = () => 'scripted-stream-no-provider';
  agent.finishTurn = (turn) =>
    turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted'
      ? undefined
      : { action: 'end' };

  try {
    await agent.prompt(`run the ${toolName} tool exactly once`);
  } finally {
    agent.streamFunction = savedStream;
    agent.getApiKey = savedApiKey;
    agent.finishTurn = savedFinishTurn;
    unsubscribe();
  }

  const end = ends.find((entry) => entry.toolName === toolName);
  assert.notEqual(end, undefined, `the loop executed the scripted ${toolName} call`);
  return end as ScriptedEnd;
}

const root = await mkdtemp(join(tmpdir(), 'pi-webx-codemode-probe-'));
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const cwd = join(root, 'work');

try {
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const PROBE_FILE = join(cwd, 'probe.txt');
  await writeFile(PROBE_FILE, 'codemode-probe-payload\n', 'utf8');

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const probeModel = runtime.getModels('deepseek')[0];
  assert.ok(probeModel !== undefined, 'the built-in catalogue supplies a model object');

  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const { session: parent } = await createAgentSession({
    cwd, agentDir,
    model: probeModel,
    modelRuntime: runtime,
    sessionManager: SessionManager.create(cwd, sessionDir),
    settingsManager: settings,
    resourceLoader: loader,
    customTools: [],
  });

  const grant = exploreCodemodeGrant(EXPLORE_FROZEN, true);
  assert.ok(grant !== undefined);
  const worker = await createWorkerSession({
    definition: EXPLORE_FROZEN,
    parent: { sessionId: parent.sessionId, cwd, agentDir, session: parent },
    model: probeModel,
    runtime,
    toolNames: [...grant.hostGrantedTools.slice(), 'read', 'grep', 'find', 'ls'],
    denied: ['subagent'],
    extensionFactories: grant.extensionFactories,
  });
  try {
    // Registry: five active tools, four of them the unchanged read-only set.
    assert.deepEqual(
      worker.getActiveToolNames().sort(),
      ['codemode', 'find', 'grep', 'ls', 'read'],
      'the pilot child activates the read-only four plus codemode',
    );
    for (const forbidden of ['bash', 'write', 'edit', 'powershell']) {
      assert.equal(worker.getToolDefinition(forbidden), undefined, `explore must not have ${forbidden}`);
    }

    // `codemode` is declared to the model but not callable from scripts: its
    // exposure is `model-only`, so a script cannot recurse into codemode.
    assert.ok(worker.getToolDefinition('codemode') !== undefined, 'codemode is declared to the model');
    const callable = worker.getCallableToolNames().sort();
    assert.deepEqual(
      callable,
      ['find', 'grep', 'ls', 'read'],
      'scripts reach exactly the read-only four — codemode itself is not callable',
    );

    // Real QuickJS: `models` is absent (models:false) — the registry bypass is closed.
    const modelsProbe = await driveWorkerToolCall(worker, 'codemode', {
      code: 'return ["typeof-models", typeof models].join("=");',
    });
    assert.ok(modelsProbe.text.includes('typeof-models=undefined'), `models namespace absent, got: ${modelsProbe.text}`);
    assert.ok(modelsProbe.text.includes('Script completed'), 'the sandbox really executed the script');

    // Real nested call through the pipeline: read resolves to its text content.
    const readProbe = await driveWorkerToolCall(worker, 'codemode', {
      code: `const text = await tools.read({ path: ${JSON.stringify(PROBE_FILE)} });\n`
        + 'return ["read-len", text.length, "has-payload", text.includes("codemode-probe-payload")].join("=");',
    });
    assert.ok(readProbe.text.includes('Script completed'), `nested read executed, got: ${readProbe.text}`);
    assert.ok(readProbe.text.includes('has-payload=true'), `the nested read returned real file content: ${readProbe.text}`);
    assert.equal(grant.stats.nestedToolCalls, 1, 'the guard counted the nested call');
    assert.equal(grant.stats.outerCodemodeCalls, 2, 'the guard counted both scripted codemode calls');

    // Direct tool declarations survived mode:'on' — the four tools are still
    // active alongside codemode, not hidden behind it.
    assert.deepEqual(
      worker.getActiveToolNames().filter((name) => name !== 'codemode').sort(),
      ['find', 'grep', 'ls', 'read'],
      "mode 'on' keeps the direct tools",
    );

    // The host ceiling: the counter is cumulative per dispatch, so with
    // `before.nestedToolCalls` already spent, the script may run
    // LIMIT − before calls and the next one is blocked.
    const before = { ...grant.stats };
    const flood = await driveWorkerToolCall(worker, 'codemode', {
      code: `let done = 0;\n`
        + `for (let i = 0; i < ${CODEMODE_NESTED_CALL_LIMIT + 30}; i += 1) {\n`
        + `  try { await tools.read({ path: ${JSON.stringify(PROBE_FILE)} }); done += 1; }\n`
        + `  catch (error) { return ["blocked-after", done, "reason-in-output", String(error).includes("宿主上限")].join("="); }\n`
        + `}\n`
        + 'return "no-block";',
    });
    const expectedAllowed = CODEMODE_NESTED_CALL_LIMIT - before.nestedToolCalls;
    assert.ok(
      flood.text.includes(`blocked-after=${expectedAllowed}`),
      `the ceiling blocks exactly past the cumulative limit, got: ${flood.text}`,
    );
    assert.ok(flood.text.includes('reason-in-output=true'), `the blocked call carries the guard's reason: ${flood.text}`);
    assert.equal(grant.stats.blockedCalls, before.blockedCalls + 1, 'the guard counted its refusal');
    assert.equal(
      grant.stats.nestedToolCalls,
      CODEMODE_NESTED_CALL_LIMIT + 1,
      'the refused call was counted too, cumulative',
    );

    // The ceiling persists for the rest of the dispatch: the counter never
    // resets, so a *new* script in a later turn is refused on its first call.
    // (Blocking is the whole effect — the run itself is not terminated; pi's
    // terminate hint does not propagate through codemode's nested results.)
    const stillBlocked = await driveWorkerToolCall(worker, 'codemode', {
      code: `try { await tools.read({ path: ${JSON.stringify(PROBE_FILE)} }); return "unexpected-success"; }\n`
        + `catch (error) { return ["still-blocked", String(error).includes("宿主上限")].join("="); }`,
    });
    assert.ok(stillBlocked.text.includes('still-blocked=true'), `a later script is still refused: ${stillBlocked.text}`);
    assert.equal(grant.stats.blockedCalls, before.blockedCalls + 2, 'the second refusal was counted');

    // No session transcript appeared for the worker anywhere on disk.
    assert.equal(worker.sessionFile, undefined, 'the worker writes no transcript');
  } finally {
    worker.dispose();
  }

  /* ------------------- dispatcher-level: passthrough + failure usage */

  /**
   * A worker handle that replays canned events into the loop and lets each test
   * script the prompt behaviour. Structural on purpose: the dispatcher must not
   * care that this is not a real AgentSession.
   */
  function fakeHandle(events: readonly unknown[], prompt: () => Promise<void>) {
    const handle = {
      subscribe: (listener: (event: unknown) => void) => {
        queueMicrotask(() => { for (const event of events) listener(event); });
        return () => undefined;
      },
      prompt,
      abort: async () => undefined,
      messages: [] as unknown[],
      getActiveToolNames: () => ['read'],
      dispose: () => undefined,
    };
    return handle as unknown as Awaited<ReturnType<typeof createWorkerSession>>;
  }

  const dispatchParent = { sessionId: parent.sessionId, cwd, agentDir, session: parent };
  const dispatchRequestBase = {
    definition: EXPLORE_FROZEN,
    task: 'x',
    surface: { toolNames: ['read'], excluded: [], unavailable: [] } as ToolSurface,
    signal: undefined,
    onUpdate: undefined,
  };

  {
    // The full chain: the request payload's factories are what the worker
    // session actually receives — removing the passthrough in subagent-worker
    // must turn this red, not just the mock-level tests above.
    const captured: WorkerSessionOptions[] = [];
    const runner = createSubagentWorkerDispatch({
      modelRuntime: () => Promise.resolve(runtime),
      capacity: new SubagentCapacity({ maxWorkers: 2, budget: new SessionCapacity(2) }),
      createSession: async (options) => {
        captured.push(options);
        return fakeHandle([], async () => undefined);
      },
    });
    await assert.rejects(runner.dispatch(dispatchParent, {
      ...dispatchRequestBase,
      ...(grant === undefined ? {} : {
        exploreCodemode: { extensionFactories: grant.extensionFactories, stats: grant.stats },
      }),
    }), () => true, 'the fake session produces no final answer; only the wiring matters here');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].extensionFactories, grant?.extensionFactories, 'factories arrive by reference');
    await assert.rejects(runner.dispatch(dispatchParent, { ...dispatchRequestBase }), () => true);
    assert.equal(captured[1].extensionFactories, undefined, 'no payload, no factories');
    await runner.cancelAll();
    console.log('passthrough chain ok');
  }

  {
    // A raw prompt rejection used to drop usage on the floor: the dispatcher's
    // failure exit now attaches whatever the loop had observed.
    const events = [
      { type: 'message_end', message: { role: 'assistant', usage: { input: 11, output: 3, cacheRead: 1, cacheWrite: 0 } } },
    ];
    const runner = createSubagentWorkerDispatch({
      modelRuntime: () => Promise.resolve(runtime),
      capacity: new SubagentCapacity({ maxWorkers: 1, budget: new SessionCapacity(1) }),
      createSession: async () => fakeHandle(events, async () => { throw new Error('provider exploded'); }),
    });
    await assert.rejects(runner.dispatch(dispatchParent, { ...dispatchRequestBase }), (error: unknown) => {
      assert.ok(error instanceof SubagentRunError, `wrapped as SubagentRunError, got ${String(error)}`);
      assert.equal(error.code, 'model-error');
      assert.deepEqual(error.usage, { input: 11, output: 3, cacheRead: 1, cacheWrite: 0 }, 'usage survived the raw prompt rejection');
      return true;
    });
    await runner.cancelAll();
    console.log('prompt-throw usage ok');
  }

  {
    // A lifecycle timeout wins with its own reason and bypasses the loop's
    // throws; the same snapshot must still ride that exit. The fake session
    // ignores abort and exits late, past the cleanup grace.
    const events = [
      { type: 'message_end', message: { role: 'assistant', usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 } } },
    ];
    const runner = createSubagentWorkerDispatch({
      modelRuntime: () => Promise.resolve(runtime),
      capacity: new SubagentCapacity({ maxWorkers: 1, budget: new SessionCapacity(1) }),
      timeoutMs: 120,
      createSession: async () => fakeHandle(events, () => new Promise((resolve) => { setTimeout(resolve, 400); })),
    });
    await assert.rejects(runner.dispatch(dispatchParent, { ...dispatchRequestBase }), (error: unknown) => {
      assert.ok(error instanceof SubagentRunError);
      assert.equal(error.code, 'timeout', `the lifecycle's own reason wins, got ${error.code}`);
      assert.deepEqual(error.usage, { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 }, 'usage rides the timeout exit too');
      return true;
    });
    await runner.cancelAll();
    console.log('timeout usage ok');
  }

  /* ---------------- inherited `codemode.mode:'only'` must not hide the four */

  {
    // The worker copies the parent's settings, so a `codemode.mode:'only'` in
    // them would hide the direct tool declarations — except the pilot pins
    // `mode:'on'` in the extension options. Declaration-level hiding has no
    // public observer (`_hiddenDeclarations` is private), so this asserts the
    // pin behaviourally: under an inherited 'only' the child still activates
    // the five tools, scripts still reach exactly the read-only four, and a
    // script still executes end to end.
    const onlySettings = SettingsManager.inMemory({ codemode: { mode: 'only' } }, { projectTrusted: false });
    const onlyLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: onlySettings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await onlyLoader.reload();
    const { session: onlyParent } = await createAgentSession({
      cwd, agentDir, model: probeModel, modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: onlySettings, resourceLoader: onlyLoader, customTools: [],
    });
    const onlyGrant = exploreCodemodeGrant(EXPLORE_FROZEN, true);
    assert.ok(onlyGrant !== undefined);
    const onlyWorker = await createWorkerSession({
      definition: EXPLORE_FROZEN,
      parent: { sessionId: onlyParent.sessionId, cwd, agentDir, session: onlyParent },
      model: probeModel,
      runtime,
      toolNames: ['codemode', 'read', 'grep', 'find', 'ls'],
      denied: ['subagent'],
      extensionFactories: onlyGrant.extensionFactories,
    });
    try {
      assert.deepEqual(onlyWorker.getActiveToolNames().sort(), ['codemode', 'find', 'grep', 'ls', 'read']);
      assert.deepEqual(onlyWorker.getCallableToolNames().sort(), ['find', 'grep', 'ls', 'read']);
      const alive = await driveWorkerToolCall(onlyWorker, 'codemode', { code: 'return "alive-under-only";' });
      assert.ok(alive.text.includes('Script completed') && alive.text.includes('alive-under-only'),
        `the pinned mode keeps codemode working under an inherited 'only', got: ${alive.text}`);
    } finally {
      onlyWorker.dispose();
    }
    console.log("inherited codemode.mode:'only' ok");
  }

  console.log('real SDK + QuickJS ok');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('check-explore-codemode: all assertions passed');
