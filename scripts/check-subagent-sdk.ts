/**
 * Real-SDK probe for the subagent seam: the parts a fake cannot prove.
 *
 * Everything here runs against the installed `@earendil-works/pi-coding-agent`
 * with **no model call and no network**: a temporary agent dir is the only place
 * any file may appear, the model runtime is built from an empty credentials
 * store with no catalogue file, and `allowModelNetwork`/`refreshOnCreate` are
 * off. The user's real `~/.pi` is never read, written or redefined — this script
 * never touches `PI_CODING_AGENT_DIR`.
 *
 * What only a real session can show, and why each assertion matters:
 *
 *   1. `customTools` is held by reference, so splicing its contents plus
 *      `runtime.refreshTools()` changes the description the *provider* will send
 *      — without recreating the session.
 *   2. Removing the tool from that array really removes it from the registry.
 *   3. The SDK activates a newly registered tool by default. That is the trap:
 *      a session the user ran with no tools must stay tool-less even after a
 *      definition is enabled, which is what `nextActiveTools` is for.
 *   4. A worker session gets its definition's system prompt, none of the
 *      parent's, exactly the allowlisted tools, no dispatch tool, and no
 *      transcript on disk.
 *   5. A broken `fixed` model fails instead of falling back to the parent's.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

import { SUBAGENT_TOOL_NAME, type AgentDefinition } from '../src/shared/agent-definitions';
import {
  createSubagentTool,
  freezeDefinition,
  nextActiveTools,
  type SubagentDispatchOutcome,
  type SubagentToolDeps,
  type ToolSurface,
} from '../server/pi/subagent-tool';
import { createWorkerSession, resolveWorkerModel } from '../server/pi/subagent-session';
import { SubagentRunError } from '../server/pi/subagent-error';
import { PiHost } from '../server/pi/host';
import {
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_EXPLORE_ID,
  BUILTIN_GENERAL_PURPOSE_ID,
} from '../server/builtin-agents';

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'probe-definition',
    revision: 1,
    name: 'probe-specialist',
    description: 'First specialist',
    systemPrompt: 'WORKER-PROMPT-MARKER: you are a probe specialist.',
    model: { mode: 'inherit' },
    tools: { mode: 'all' },
    maxTurns: 4,
    maxConcurrentInstances: 1,
    enabled: true,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** A dispatch that can never run: this probe never starts a worker turn. */
const unusedDispatch: SubagentToolDeps = {
  definitions: () => Promise.reject(new Error('the probe never dispatches')),
  parentActiveTools: () => [],
  dispatch: (): Promise<SubagentDispatchOutcome> => Promise.reject(new Error('the probe never dispatches')),
};

/** One real session, as the host hands it out. */
type HostedSession = Awaited<ReturnType<PiHost['create']>>['session'];

/** What the loop reported for one scripted tool call. */
interface ScriptedToolEnd {
  readonly isError: boolean;
  readonly toolName: string;
  readonly text: string;
  readonly details: unknown;
}

/**
 * Drive one scripted tool call through the **real** agent loop.
 *
 * The probe has no model, so the "provider" is a scripted stream: it emits a
 * single assistant message that asks for `subagent`, and the run is told to stop
 * after that one turn. Everything between the message and the result is the real
 * thing — the loop's tool preparation, the tool's `execute()`, and the `isError`
 * flag the SDK computes for the transcript the UI renders.
 *
 * This mutates a live session on purpose and puts every field back: the stream
 * function, the API-key lookup (the scripted stream never contacts a provider)
 * and the tool list are restored in `finally`, and the listener is removed. It
 * is the smallest seam that can observe `isError` without a model call.
 */
async function driveScriptedToolCall(
  session: HostedSession,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<ScriptedToolEnd> {
  const agent = session.agent;
  const model = agent.state.model;
  assert.ok(model !== undefined, 'the scripted loop needs a model object');

  const savedStream = agent.streamFunction;
  const savedApiKey = agent.getApiKey;
  const savedStop = agent.shouldStopAfterTurn;
  const savedTools = [...agent.state.tools];

  const ends: ScriptedToolEnd[] = [];
  const unsubscribe = agent.subscribe((event) => {
    if (event.type !== 'tool_execution_end') return;
    const result = event.result as { content?: { text?: string }[]; details?: unknown } | undefined;
    ends.push({
      isError: event.isError,
      toolName: event.toolName,
      text: (result?.content ?? []).map((block) => block.text ?? '').join(''),
      details: result?.details,
    });
  });

  // Called once per turn by the loop; the scripted stream ignores model/context
  // and answers with exactly one `subagent` call.
  agent.streamFunction = (() => {
    const stream = createAssistantMessageEventStream();
    const message = scriptedToolCallMessage(model, args);
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'toolUse', message });
    stream.end(message);
    return stream;
  }) as unknown as typeof agent.streamFunction;
  agent.getApiKey = () => 'scripted-stream-no-provider';
  agent.shouldStopAfterTurn = () => true;
  agent.state.tools = [tool as unknown as (typeof agent.state.tools)[number]];

  try {
    await agent.prompt('run the subagent tool exactly once');
  } finally {
    agent.streamFunction = savedStream;
    agent.getApiKey = savedApiKey;
    agent.shouldStopAfterTurn = savedStop;
    agent.state.tools = savedTools;
    unsubscribe();
  }

  const end = ends.find((entry) => entry.toolName === SUBAGENT_TOOL_NAME);
  assert.notEqual(end, undefined, 'the loop executed the scripted tool call');
  return end as ScriptedToolEnd;
}

/** The scripted assistant turn: exactly one `subagent` call, nothing else. */
function scriptedToolCallMessage(
  model: { api: AssistantMessage['api']; provider: AssistantMessage['provider']; id: string },
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'scripted-call-1', name: SUBAGENT_TOOL_NAME, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

/** Every file under one directory, relative and sorted. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const next = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), next);
      else found.push(next);
    }
  };
  await walk(root, '');
  return found.sort();
}

const root = await mkdtemp(join(tmpdir(), 'pi-webx-subagent-probe-'));
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const cwd = join(root, 'work');

try {
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  // A project context file for the `injectAgentsMd` probe: the parent's own
  // loader reads it, and a child only when its definition asks for it.
  const AGENTS_SENTINEL = 'PROBE-AGENTS-SENTINEL-9f3c';
  await writeFile(join(cwd, 'AGENTS.md'), `# Probe context\n\n${AGENTS_SENTINEL}\n`, 'utf8');

  // No credentials and no catalogue file: nothing in this script can reach a
  // provider, and the user's auth.json is not on any path used here.
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const probeModel = runtime.getModels('deepseek')[0];
  assert.ok(probeModel !== undefined, 'the built-in catalogue supplies a model object to run against');
  assert.equal(runtime.hasConfiguredAuth(probeModel.provider), false, 'the probe holds no credentials');

  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const customTools: ToolDefinition[] = [];
  const { session: parent, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    model: probeModel,
    modelRuntime: runtime,
    sessionManager: SessionManager.create(cwd, sessionDir),
    settingsManager: settings,
    resourceLoader: loader,
    customTools,
  });
  assert.ok(parent.systemPrompt.includes('expert coding assistant'), 'the parent keeps the default prompt');
  // This probe's own parent loader sets `noContextFiles`, so the fixture
  // AGENTS.md is deliberately absent here; the host-created session in §6 is the
  // control that proves the file is loadable from this cwd at all.

  /* 1. description refresh through the real registry ------------------------- */

  const parentTools = ['read', 'grep'];
  parent.setActiveToolsByName(parentTools);
  const first = createSubagentTool(unusedDispatch, [freezeDefinition(definition())]);
  customTools.splice(0, customTools.length, first);
  extensionsResult.runtime.refreshTools();

  assert.equal(parent.getToolDefinition('subagent')?.description, first.description);
  assert.deepEqual(
    nextActiveTools(parentTools, { definitionCount: 1, registered: true }),
    [...parentTools, 'subagent'],
    'the host rule adds dispatch when the session has tools',
  );
  parent.setActiveToolsByName(nextActiveTools(parentTools, { definitionCount: 1, registered: true }));

  // Same session, new description: the provider-visible tool object is rebuilt.
  const second = createSubagentTool(unusedDispatch, [freezeDefinition(definition({
    name: 'second-specialist',
    description: 'Second specialist',
  }))]);
  customTools.splice(0, customTools.length, second);
  extensionsResult.runtime.refreshTools();
  const visible = parent.agent.state.tools.find((tool) => tool.name === 'subagent');
  assert.equal(visible?.description, second.description, 'the provider tools array carries the new description');
  assert.ok(second.description.includes('second-specialist'));
  assert.ok(!second.description.includes('probe-specialist'));
  assert.deepEqual(parent.getActiveToolNames().sort(), ['grep', 'read', 'subagent']);

  /* 2. empty definitions remove the tool ------------------------------------ */

  customTools.splice(0, customTools.length);
  extensionsResult.runtime.refreshTools();
  assert.equal(parent.getToolDefinition('subagent'), undefined, 'no definitions means no tool');
  const carried = parent.getActiveToolNames().filter((name) => name !== 'subagent');
  parent.setActiveToolsByName(nextActiveTools(carried, { definitionCount: 0, registered: false }));
  assert.deepEqual(parent.getActiveToolNames().sort(), ['grep', 'read']);

  /* 3. dynamic enable × parent on `none` (the trap, and the rule) ----------- */

  parent.setActiveToolsByName([]);
  assert.deepEqual(parent.getActiveToolNames(), [], 'a none-preset parent starts tool-less');
  customTools.splice(0, customTools.length, createSubagentTool(unusedDispatch, [freezeDefinition(definition())]));
  extensionsResult.runtime.refreshTools();
  assert.equal(
    parent.getActiveToolNames().includes('subagent'),
    true,
    'SDK default: a newly registered tool becomes active — this is the trap the host must undo',
  );
  assert.notEqual(parent.getToolDefinition('subagent'), undefined, 'the tool exists in the registry');
  const carriedNone = parent.getActiveToolNames().filter((name) => name !== 'subagent');
  parent.setActiveToolsByName(nextActiveTools(carriedNone, { definitionCount: 1, registered: true }));
  assert.deepEqual(parent.getActiveToolNames(), [], 'a none-preset parent stays tool-less after a definition is enabled');

  /* 4. worker assembly: prompt, tools, recursion, no transcript ------------- */

  // The injected sessionDir is what the parent's log is bound to; pi only
  // creates the file once an assistant message exists, so the directory itself
  // is the fact to assert here rather than a file count.
  assert.equal(parent.sessionManager.getSessionDir(), sessionDir, 'the parent log is bound to the injected directory');
  assert.equal(parent.sessionManager.isPersisted(), true, 'and it is a persisted session');
  const parentFiles = await filesUnder(sessionDir);

  const workerDefinition = freezeDefinition(definition({
    id: 'worker-definition',
    tools: { mode: 'selected', names: ['read', 'bash', 'subagent'] },
  }));
  const worker = await createWorkerSession({
    definition: workerDefinition,
    parent: { sessionId: parent.sessionId, cwd, agentDir, session: parent },
    model: probeModel,
    runtime,
    toolNames: ['read'],
    denied: ['subagent', 'spawn_agent'],
  });
  try {
    assert.ok(worker.systemPrompt.includes('WORKER-PROMPT-MARKER'), 'the worker runs its definition prompt');
    assert.ok(!worker.systemPrompt.includes('expert coding assistant'), 'the parent prompt does not leak in');
    assert.deepEqual(worker.getActiveToolNames(), ['read'], 'the allowlist is exact');
    assert.equal(worker.getToolDefinition('subagent'), undefined);
    assert.equal(worker.getToolDefinition('spawn_agent'), undefined);
    assert.ok(!worker.getAllTools().some((tool) => tool.name === 'subagent'));
    assert.equal(worker.sessionFile, undefined, 'the worker writes no transcript');
    assert.equal(worker.sessionManager.isPersisted(), false, 'the worker session is in-memory only');
    assert.deepEqual(await filesUnder(sessionDir), parentFiles, 'no file appeared for the worker');
    assert.equal(worker.sessionManager.getSessionId(), worker.sessionId);
  } finally {
    worker.dispose();
  }

  // The deny list beats the allowlist: a name in both never becomes usable.
  const denied = await createWorkerSession({
    definition: workerDefinition,
    parent: { sessionId: parent.sessionId, cwd, agentDir, session: parent },
    model: probeModel,
    runtime,
    toolNames: ['subagent'],
    denied: ['subagent'],
  });
  try {
    assert.deepEqual(denied.getActiveToolNames(), [], 'a denied tool is not registered, whatever the allowlist says');
    assert.equal(denied.getToolDefinition('subagent'), undefined);
    assert.ok(!denied.getAllTools().some((tool) => tool.name === 'subagent'));
  } finally {
    denied.dispose();
  }

  // `selected: []` — a pure-reasoning worker is legal and has no tools at all.
  const reasoning = await createWorkerSession({
    definition: workerDefinition,
    parent: { sessionId: parent.sessionId, cwd, agentDir, session: parent },
    model: probeModel,
    runtime,
    toolNames: [],
    denied: [],
  });
  try {
    assert.deepEqual(reasoning.getActiveToolNames(), [], 'an empty allowlist means pure reasoning');
    assert.ok(reasoning.systemPrompt.includes('WORKER-PROMPT-MARKER'));
  } finally {
    reasoning.dispose();
  }

  // A requested tool the child's registry does not have is dropped silently by
  // the SDK, so the dispatcher's own comparison is what turns it into a report
  // (or, for `selected`, a refusal). This is that real behaviour, not a grep.
  const missing = await createWorkerSession({
    definition: workerDefinition,
    parent: { sessionId: parent.sessionId, cwd, agentDir, session: parent },
    model: probeModel,
    runtime,
    toolNames: ['read', 'probe_unknown_tool'],
    denied: [],
  });
  try {
    assert.deepEqual(missing.getActiveToolNames(), ['read'], 'the unknown name simply is not active');
    assert.equal(missing.getToolDefinition('probe_unknown_tool'), undefined);
    assert.ok(!missing.getAllTools().some((tool) => tool.name === 'probe_unknown_tool'));
  } finally {
    missing.dispose();
  }

  /* 4b. AGENTS.md injection is opt-in, and it is context, not authority ------ */

  const injectProbe = async (injectAgentsMd: boolean | undefined) => {
    const child = await createWorkerSession({
      definition: freezeDefinition(injectAgentsMd === undefined ? definition() : definition({ injectAgentsMd })),
      parent: { sessionId: parent.sessionId, cwd, agentDir, session: parent },
      model: probeModel,
      runtime,
      toolNames: ['read'],
      denied: ['subagent'],
    });
    try {
      return { prompt: child.systemPrompt, tools: child.getActiveToolNames() };
    } finally {
      child.dispose();
    }
  };

  {
    const on = await injectProbe(true);
    assert.ok(
      on.prompt.includes(AGENTS_SENTINEL),
      'injectAgentsMd: true carries the parent-visible AGENTS.md into the child prompt',
    );
    assert.ok(on.prompt.includes('WORKER-PROMPT-MARKER'), 'the definition prompt is still the base');
    assert.ok(!on.tools.includes('subagent'), 'and the child still cannot dispatch');

    const off = await injectProbe(false);
    assert.ok(
      !off.prompt.includes(AGENTS_SENTINEL),
      'injectAgentsMd: false keeps the project context out of the child prompt',
    );
    assert.ok(off.prompt.includes('WORKER-PROMPT-MARKER'));

    const omitted = await injectProbe(undefined);
    assert.ok(
      !omitted.prompt.includes(AGENTS_SENTINEL),
      'an omitted field means the same as false',
    );
    assert.ok(omitted.prompt.includes('WORKER-PROMPT-MARKER'));
  }

  /* 5. a broken fixed model fails, without falling back --------------------- */

  const unknownProvider = freezeDefinition(definition({ model: { mode: 'fixed', providerId: 'probe-unknown', modelId: 'nope' } }));
  assert.throws(
    () => resolveWorkerModel(unknownProvider, parent, runtime),
    (error: SubagentRunError) => error.code === 'invalid-model' && /不.*回退/.test(error.message),
  );
  // A model the catalogue knows but this runtime cannot authenticate is the
  // same failure: the parent's model is never substituted.
  const unauthenticated = freezeDefinition(definition({ model: { mode: 'fixed', providerId: probeModel.provider, modelId: probeModel.id } }));
  assert.throws(
    () => resolveWorkerModel(unauthenticated, parent, runtime),
    (error: SubagentRunError) => error.code === 'invalid-model' && error.message.includes('凭据'),
  );
  assert.equal(resolveWorkerModel(freezeDefinition(definition()), parent, runtime), parent.model ?? undefined);

  /* 6. host assembly: preset handling and refresh before a turn ------------- */

  // `PiHost.create` composes its own resource loader from `getAgentDir()`, so the
  // process agent dir is pointed at the temporary one for this section and
  // restored afterwards. That keeps user extensions out of a deterministic
  // probe; it is safe here because this probe's runtime holds no credentials.
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    let enabled = true;
    const host = new PiHost({
      definitions: {
        read: async () => ({
          schemaVersion: 1,
          revision: 1,
          path: join(root, 'definitions.json'),
          agents: enabled ? [definition()] : [],
        }),
      },
      modelRuntimeFactory: async () => runtime,
      sessionDir,
      settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
    });

    const withTools = await host.create({
      cwd,
      provider: probeModel.provider,
      model: probeModel.id,
      toolNames: ['read', 'grep'],
    });
    // Control for the §4b sentinel: a host-created session uses pi's default
    // loader, which does read the project's context files.
    assert.ok(
      withTools.session.systemPrompt.includes(AGENTS_SENTINEL),
      'the fixture AGENTS.md is loadable from this cwd by a normal session',
    );
    assert.deepEqual(
      withTools.session.getActiveToolNames().sort(),
      ['grep', 'read', 'subagent'],
      'a session with tools gains dispatch when a definition is enabled',
    );

    const noTools = await host.create({
      cwd,
      provider: probeModel.provider,
      model: probeModel.id,
      toolNames: [],
    });
    assert.deepEqual(noTools.session.getActiveToolNames(), [], 'a none-preset session stays tool-less');

    // Refresh runs before a turn. `follow_up` only queues a message, so this
    // exercises the real refresh path without a model call.
    // Since the built-ins joined the list, emptying the store no longer removes
    // the tool — a built-in is enabled by construction. What the refresh still
    // does is drop the user's definition from the description it renders.
    enabled = false;
    await host.command(noTools.id, { type: 'follow_up', message: 'probe' });
    const afterDisable = noTools.session.getToolDefinition('subagent');
    assert.notEqual(afterDisable, undefined, 'built-ins keep the tool registered when the store empties');
    assert.ok(
      !afterDisable?.description.includes('probe-definition'),
      'the disabled user definition is gone from the description',
    );
    assert.ok(afterDisable?.description.includes(BUILTIN_EXPLORE_ID), 'the built-ins remain listed');
    assert.deepEqual(noTools.session.getActiveToolNames(), [], 'and the none-preset session is still tool-less');

    enabled = true;
    await host.command(noTools.id, { type: 'follow_up', message: 'probe again' });
    assert.notEqual(noTools.session.getToolDefinition('subagent'), undefined, 're-enabling brings the tool back');
    assert.deepEqual(
      noTools.session.getActiveToolNames(),
      [],
      'a none-preset session still gets no dispatch: the tool exists but is never activated',
    );

    await host.command(withTools.id, { type: 'follow_up', message: 'probe' });
    assert.deepEqual(withTools.session.getActiveToolNames().sort(), ['grep', 'read', 'subagent']);

    /* fork and reset are separate assembly paths: the tool must be there too. */

    const source = SessionManager.create(cwd, sessionDir);
    source.appendMessage({ role: 'user', content: [{ type: 'text', text: 'source turn' }] } as never);
    source.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'source answer' }],
      api: 'openai-completions',
      provider: probeModel.provider,
      model: probeModel.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'stop',
      timestamp: Date.now(),
    } as never);
    const sourceFile = source.getSessionFile();
    assert.ok(sourceFile !== undefined && sourceFile.startsWith(sessionDir), 'the source log is in the temp dir');

    const forked = await host.fork({ source: sourceFile, cwd });
    assert.notEqual(forked.session.getToolDefinition('subagent'), undefined, 'a fork registers the tool');
    assert.ok(forked.session.getActiveToolNames().includes('subagent'), 'a fork with tools activates dispatch');
    assert.ok(forked.sessionFile?.startsWith(sessionDir), 'the fork log lands in the injected session dir');

    await host.command(withTools.id, { type: 'new_session' });
    assert.notEqual(withTools.session.getToolDefinition('subagent'), undefined, 'a reset session registers the tool');
    assert.ok(withTools.session.getActiveToolNames().includes('subagent'), 'a reset session activates dispatch');
    assert.ok(withTools.sessionFile?.startsWith(sessionDir), 'the reset log lands in the injected session dir');

    await host.disposeAll();

    /* 6b. the child's ceiling is the parent's ACTIVE set, through real wiring -- */

    // The live round found a `read`/`grep` session handing `bash`, `write` and
    // `edit` to its child. Those three stay *registered* in every session — the
    // catalogue is what pi can run, not what the user allowed — so the only way
    // to catch that bug is to drive the tool the host itself builds and read the
    // surface it really hands to a worker.
    {
      let response: AgentDefinitionsResponse = {
        schemaVersion: 1,
        revision: 1,
        path: join(root, 'definitions.json'),
        agents: [definition({ tools: { mode: 'all' } })],
      };
      const host = new PiHost({
        definitions: { read: async () => response },
        modelRuntimeFactory: async () => runtime,
        sessionDir,
        settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
      });

      const surfaces: ToolSurface[] = [];
      const frozenRequests: { injectAgentsMd: boolean }[] = [];
      const captured = (names: readonly string[]): SubagentDispatchOutcome => ({
        runId: 'wired-run',
        text: 'ok',
        model: { provider: probeModel.provider, id: probeModel.id },
        effectiveTools: [...names],
        turns: 1,
        durationMs: 1,
        truncated: false,
      });
      /**
       * Test-only escape: the host builds its worker runner internally and has no
       * injection point for it (the production seam is `createSession`, one layer
       * lower). Replacing the runner on this fixture host keeps the run offline
       * while leaving the tool — and therefore the surface it computes from the
       * real session — entirely the host's own.
       */
      (host as unknown as {
        workerRunner: {
          dispatch: (
            parent: unknown,
            request: { surface: ToolSurface; definition: { injectAgentsMd: boolean } },
          ) => Promise<SubagentDispatchOutcome>;
          cancelParent: (parentId: string) => Promise<void>;
          cancelAll: () => Promise<void>;
        };
      }).workerRunner = {
        dispatch: async (_parent, request) => {
          surfaces.push(request.surface);
          frozenRequests.push({ injectAgentsMd: request.definition.injectAgentsMd });
          return captured(request.surface.toolNames);
        },
        // Shutdown still goes through the host; nothing is running in this probe.
        cancelParent: async () => undefined,
        cancelAll: async () => undefined,
      };

      const invoke = async (tool: ToolDefinition): Promise<Record<string, unknown>> => {
        const result = await tool.execute(
          'call-wired',
          { agentId: 'probe-definition', task: 'review this' },
          undefined,
          undefined,
          {} as ExtensionContext,
        );
        assert.ok(typeof result.details === 'object' && result.details !== null);
        return result.details as Record<string, unknown>;
      };

      const wired = await host.create({
        cwd,
        provider: probeModel.provider,
        model: probeModel.id,
        toolNames: ['read', 'grep'],
      });
      const catalogue = wired.session.getAllTools().map((tool) => tool.name);
      assert.ok(
        ['bash', 'write', 'edit'].every((name) => catalogue.includes(name)),
        'the switched-off builtins really are still registered (that is the trap)',
      );
      assert.deepEqual(wired.session.getActiveToolNames().sort(), ['grep', 'read', 'subagent']);

      const tool = wired.customTools[0];
      assert.notEqual(tool, undefined, 'the host put the dispatch tool in the session');

      const all = await invoke(tool as ToolDefinition);
      assert.deepEqual(surfaces[0]?.toolNames.slice().sort(), ['grep', 'read'], 'all = the parent ACTIVE set');
      for (const name of ['bash', 'write', 'edit', 'powershell', 'find', 'ls']) {
        assert.ok(!surfaces[0]?.toolNames.includes(name), `${name} is registered but must not reach the child`);
      }
      assert.ok(surfaces[0]?.excluded.includes('subagent'), 'the dispatch tool itself is excluded');
      assert.deepEqual([...(all.effectiveTools as string[])].sort(), ['grep', 'read']);

      // `selected` naming a switched-off tool: refused and reported, not granted.
      response = {
        ...response,
        agents: [definition({ tools: { mode: 'selected', names: ['bash', 'read'] } })],
      };
      await assert.rejects(() => invoke(tool as ToolDefinition),
        (error: { code?: string; message?: string }) => error.code === 'unavailable-tools' && error.message?.includes('bash') === true);
      assert.equal(surfaces.length, 1, 'missing selected tools are refused before dispatch');

      // Same host, later turn: the active set changed, and the very same tool
      // object must see it — a cached snapshot here is the live bug again.
      // The flag rides in the frozen definition, through the tool the host
      // wired: `true` when asked for, and normalised to `false` when omitted.
      response = { ...response, agents: [definition({ injectAgentsMd: true })] };
      await invoke(tool as ToolDefinition);
      assert.equal(frozenRequests[1]?.injectAgentsMd, true, 'the switch reaches the dispatcher as true');
      response = { ...response, agents: [definition()] };
      await invoke(tool as ToolDefinition);
      assert.equal(frozenRequests[2]?.injectAgentsMd, false, 'an omitted field reaches it as false');

      await host.command(wired.id, { type: 'set_tools', toolNames: ['read'] });
      const narrowed = await invoke(tool as ToolDefinition);
      assert.deepEqual(surfaces[3]?.toolNames, ['read'], 'the surface follows the session, not a stale snapshot');
      assert.deepEqual(narrowed.effectiveTools, ['read']);

      // A `none`-preset session: the tool exists but is inactive, and even a
      // direct call to it grants nothing.
      const none = await host.create({
        cwd,
        provider: probeModel.provider,
        model: probeModel.id,
        toolNames: [],
      });
      assert.deepEqual(none.session.getActiveToolNames(), []);
      assert.notEqual(none.customTools[0], undefined, 'a none session still registers the tool (inactive)');
      const noneDetails = await invoke(none.customTools[0] as ToolDefinition);
      assert.deepEqual(surfaces[4]?.toolNames, [], 'a none-preset parent hands over nothing');
      assert.deepEqual(noneDetails.effectiveTools, []);

      await host.disposeAll();

      // Finally, the real child: the allowlist is exactly the surface.
      const child = await createWorkerSession({
        definition: freezeDefinition(definition({ tools: { mode: 'selected', names: ['read', 'grep'] } })),
        parent: { sessionId: wired.id, cwd, agentDir, session: wired.session },
        model: probeModel,
        runtime,
        toolNames: ['read', 'grep'],
        denied: [],
      });
      try {
        assert.deepEqual(child.getActiveToolNames().sort(), ['grep', 'read'], 'the real child gets exactly that set');
        assert.equal(child.getToolDefinition('bash'), undefined);
        assert.equal(child.getToolDefinition('write'), undefined);
      } finally {
        child.dispose();
      }
    }
    /* 6c. built-in agents: registration, surface, freezing, injection ---------- */

    {
      // An EMPTY store: the user has configured nothing, and the built-ins are
      // enabled by construction — so the dispatch tool must still exist.
      let storedAgents: AgentDefinition[] = [];
      const host = new PiHost({
        definitions: {
          read: async () => ({
            schemaVersion: 1,
            revision: 1,
            path: join(root, 'definitions.json'),
            agents: storedAgents,
          }),
        },
        modelRuntimeFactory: async () => runtime,
        sessionDir,
        settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
      });

      const surfaces: ToolSurface[] = [];
      const definitionsSeen: { id: string; tools: unknown; maxTurns: number; maxConcurrentInstances: number; injectAgentsMd: boolean }[] = [];
      (host as unknown as {
        workerRunner: {
          dispatch: (
            parent: unknown,
            request: {
              surface: ToolSurface;
              definition: { id: string; tools: unknown; maxTurns: number; maxConcurrentInstances: number; injectAgentsMd: boolean };
            },
          ) => Promise<SubagentDispatchOutcome>;
          cancelParent: (parentId: string) => Promise<void>;
          cancelAll: () => Promise<void>;
        };
      }).workerRunner = {
        dispatch: async (_parent, request) => {
          surfaces.push(request.surface);
          definitionsSeen.push({
            id: request.definition.id,
            tools: request.definition.tools,
            maxTurns: request.definition.maxTurns,
            maxConcurrentInstances: request.definition.maxConcurrentInstances,
            injectAgentsMd: request.definition.injectAgentsMd,
          });
          return {
            runId: 'builtin-run',
            text: 'ok',
            model: { provider: probeModel.provider, id: probeModel.id },
            effectiveTools: [...request.surface.toolNames],
            turns: 1,
            durationMs: 1,
            truncated: false,
          };
        },
        cancelParent: async () => undefined,
        cancelAll: async () => undefined,
      };

      const hosted = await host.create({
        cwd,
        provider: probeModel.provider,
        model: probeModel.id,
        toolNames: ['read', 'grep'],
      });

      // 1. registered, active, and listing both built-ins with their descriptions
      const tool = hosted.customTools[0] as ToolDefinition | undefined;
      assert.notEqual(tool, undefined, 'an empty store still registers the dispatch tool');
      assert.ok(hosted.session.getActiveToolNames().includes('subagent'), 'and activates it');
      assert.ok(tool?.description.includes(BUILTIN_GENERAL_PURPOSE_ID), 'the description lists general-purpose');
      assert.ok(tool?.description.includes(BUILTIN_EXPLORE_ID), 'the description lists explore');
      for (const builtin of BUILTIN_AGENT_DEFINITIONS) {
        assert.ok(tool?.description.includes(builtin.description), `the description carries ${builtin.id}'s text`);
      }
      // The schema the provider receives offers exactly `agentId` + `task`, so a
      // description that tells the model to "specify search breadth" is asking for
      // an argument that cannot exist. The rewritten sentence must reach the real
      // tool description, and the old one must not.
      assert.ok(
        !(tool?.description ?? '').includes('Specify search breadth'),
        'the model-facing description never asks for a non-existent breadth parameter',
      );
      assert.ok(
        (tool?.description ?? '').includes('State the intended breadth in the task text'),
        'and says where breadth belongs instead',
      );
      assert.deepEqual(
        Object.keys((tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}),
        ['agentId', 'task'],
        'the schema really has no third parameter to name',
      );
      assert.ok(
        !(tool?.description ?? '').includes('user-configured'),
        'and the preamble never calls the built-ins user-configured',
      );
      assert.ok(
        (tool?.description ?? '').includes('explicitly asks for a subagent'),
        'while it does say an explicit request is reason enough to dispatch',
      );

      const call = async (agentId: string): Promise<Record<string, unknown>> => {
        const result = await (tool as ToolDefinition).execute(
          'call-builtin',
          { agentId, task: 'do the thing' },
          undefined,
          undefined,
          {} as ExtensionContext,
        );
        assert.ok(typeof result.details === 'object' && result.details !== null);
        return result.details as Record<string, unknown>;
      };

      // 2. explore: the read-only four survive a parent that only has two of
      // them — that is the exemption — while nothing writable appears.
      await call(BUILTIN_EXPLORE_ID);
      assert.deepEqual(
        surfaces[0]?.toolNames.slice().sort(),
        ['find', 'grep', 'ls', 'read'],
        'explore keeps all four read-only tools',
      );
      for (const forbidden of ['bash', 'write', 'edit', 'powershell']) {
        assert.ok(!surfaces[0]?.toolNames.includes(forbidden), `explore must never get ${forbidden}`);
      }
      assert.deepEqual(
        definitionsSeen[0]?.tools,
        { mode: 'selected', names: ['read', 'grep', 'find', 'ls'] },
        'and it keeps its own policy frozen',
      );
      assert.equal(definitionsSeen[0]?.maxTurns, 4);
      assert.equal(definitionsSeen[0]?.maxConcurrentInstances, 1);
      assert.equal(definitionsSeen[0]?.injectAgentsMd, false);

      // 3. general-purpose: `all`, still bounded by the parent
      await call(BUILTIN_GENERAL_PURPOSE_ID);
      assert.deepEqual(surfaces[1]?.toolNames.slice().sort(), ['grep', 'read'], 'general-purpose takes the parent active set');
      assert.deepEqual(definitionsSeen[1]?.tools, { mode: 'all' });
      assert.equal(definitionsSeen[1]?.injectAgentsMd, true);

      // A parent with only `read` active: explore follows it down, never up.
      const narrow = await host.create({
        cwd,
        provider: probeModel.provider,
        model: probeModel.id,
        toolNames: ['read'],
      });
      await (narrow.customTools[0] as ToolDefinition).execute(
        'call-builtin-narrow',
        { agentId: BUILTIN_EXPLORE_ID, task: 'look around' },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.deepEqual(
        surfaces[2]?.toolNames.slice().sort(),
        ['find', 'grep', 'ls', 'read'],
        'a parent with only read still hands explore its read-only four',
      );
      assert.deepEqual(surfaces[2]?.unavailable, [], 'and reports nothing missing');

      // 4b. a failure is a *thrown* error that still names itself: the SDK marks
      // a call `isError` only when the tool throws, and on that path `details`
      // is forced to `{}`, so the attribution has to travel in the message.
      {
        const failing = (host as unknown as {
          workerRunner: { dispatch: unknown };
        }).workerRunner;
        const original = failing.dispatch;
        failing.dispatch = async (_parent: unknown, request: { definition: { id: string }; surface: ToolSurface }) => {
          surfaces.push(request.surface);
          throw new SubagentRunError('max-turns', '子智能体达到轮数上限。', '部分输出', 'run-failed-1');
        };
        try {
          await assert.rejects(
            () => call(BUILTIN_EXPLORE_ID),
            (error: unknown) => {
              assert.ok(error instanceof Error, 'the host-wired tool throws a real Error');
              assert.equal((error as { code?: unknown }).code, 'max-turns', 'the failure carries a stable reason');
              const text = error.message;
              assert.ok(text.includes(`agentId=${BUILTIN_EXPLORE_ID}`), 'the message names the definition');
              assert.ok(text.includes('definitionRevision=1'), 'and its revision');
              assert.ok(text.includes('runId=run-failed-1'), 'and the run it belonged to');
              assert.ok(text.includes('reason=max-turns'), 'and the reason, readably');
              assert.ok(text.includes('轮数上限'), 'the human sentence survives');
              assert.equal((error as { runId?: unknown }).runId, 'run-failed-1', 'in-process callers read it structurally');
              return true;
            },
          );
        } finally {
          failing.dispatch = original;
        }
      }

      // 4c. and the *loop* really reports it as an error. This is the fact the
      // whole shape decision rests on, so it is observed, not assumed: a
      // scripted stream asks for the tool once, and the real loop executes it,
      // computes `isError`, and writes both into the transcript the UI renders.
      {
        const failing = (host as unknown as {
          workerRunner: { dispatch: unknown };
        }).workerRunner;
        const original = failing.dispatch;
        failing.dispatch = async (_parent: unknown, request: { definition: { id: string }; surface: ToolSurface }) => {
          surfaces.push(request.surface);
          throw new SubagentRunError('max-turns', '子智能体达到轮数上限。', '部分输出', 'run-loop-1');
        };
        try {
          const end = await driveScriptedToolCall(hosted.session, tool as ToolDefinition, {
            agentId: BUILTIN_EXPLORE_ID,
            task: 'do the thing',
          });
          assert.equal(end.isError, true, 'a thrown failure is an error at the loop level, not a success');
          assert.deepEqual(end.details, {}, 'and the SDK forces `details` to {} on that path — the SDK limit');
          assert.ok(end.text.includes(`agentId=${BUILTIN_EXPLORE_ID}`), 'so the attribution must be in the text');
          assert.ok(end.text.includes('reason=max-turns'), 'including the stable reason');
          assert.ok(end.text.includes('runId=run-loop-1'), 'and the run');
          const last = hosted.session.messages.at(-1) as { role?: string; isError?: boolean } | undefined;
          assert.equal(last?.role, 'toolResult', 'the transcript ends with the tool result');
          assert.equal(last?.isError, true, 'and the rendered transcript carries the error flag too');
        } finally {
          failing.dispatch = original;
        }
      }

      // 5. shadowing: a user definition with a built-in's name replaces it
      storedAgents = [definition({ id: 'user-general', name: 'general-purpose', description: 'Mine, not the shipped one.' })];
      await host.command(hosted.id, { type: 'follow_up', message: 'refresh please' });
      const refreshed = hosted.customTools[0] as ToolDefinition;
      assert.ok(!refreshed.description.includes(BUILTIN_GENERAL_PURPOSE_ID), 'the shadowed builtin leaves the description');
      assert.ok(refreshed.description.includes('user-general'), 'the user definition takes its place');
      assert.ok(refreshed.description.includes(BUILTIN_EXPLORE_ID), 'the other builtin is untouched');

      await host.disposeAll();

      // 2/3/4. the real child for each built-in, with its own policy and injection
      const frozen = (id: string) => freezeDefinition(
        BUILTIN_AGENT_DEFINITIONS.find((entry) => entry.id === id) as AgentDefinition,
      );
      const exploreChild = await createWorkerSession({
        definition: frozen(BUILTIN_EXPLORE_ID),
        parent: { sessionId: hosted.id, cwd, agentDir, session: hosted.session },
        model: probeModel,
        runtime,
        toolNames: ['read', 'grep', 'find', 'ls'],
        denied: ['subagent'],
      });
      try {
        assert.deepEqual(
          exploreChild.getActiveToolNames().sort(),
          ['find', 'grep', 'ls', 'read'],
          'the real child gets the read-only four',
        );
        for (const forbidden of ['bash', 'write', 'edit', 'powershell']) {
          assert.equal(exploreChild.getToolDefinition(forbidden), undefined, `explore must not have ${forbidden}`);
        }
        assert.ok(!exploreChild.systemPrompt.includes(AGENTS_SENTINEL), 'explore injects no AGENTS.md');
      } finally {
        exploreChild.dispose();
      }

      const generalChild = await createWorkerSession({
        definition: frozen(BUILTIN_GENERAL_PURPOSE_ID),
        parent: { sessionId: hosted.id, cwd, agentDir, session: hosted.session },
        model: probeModel,
        runtime,
        toolNames: ['read', 'grep'],
        denied: ['subagent'],
      });
      try {
        assert.deepEqual(generalChild.getActiveToolNames().sort(), ['grep', 'read'], 'the child stays inside the parent set');
        assert.ok(generalChild.systemPrompt.includes(AGENTS_SENTINEL), 'general-purpose injects the AGENTS.md context');
      } finally {
        generalChild.dispose();
      }
    }

  } finally {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }

  /* 7. isolation of this script itself ------------------------------------- */

  assert.ok(agentDir.startsWith(root) && sessionDir.startsWith(root), 'every path used is under the temp root');
  assert.notEqual(getAgentDir(), agentDir, 'the real agent dir was left alone (PI_CODING_AGENT_DIR untouched)');

  parent.dispose();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('check-subagent-sdk: real-SDK probe passed (no model call, no network)');
