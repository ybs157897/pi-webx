/**
 * Bound-project context regression for the four module Agents.
 *
 * The fixtures use temporary workspaces and a scripted Pi SDK stream. They
 * exercise real module assembly and the hosted-session prompt preparation path,
 * without calling a model provider or reading user project files.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createAssistantMessageEventStream, getSystemMessageText, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

import { assembleModuleAgent } from '../server/module-agents/assemble';
import { loadAgentProfiles, defaultAgentsConfigRoot } from '../server/module-agents/profiles';
import { profileRevision } from '../server/module-agents/snapshots';
import {
  loadWorkspaceProjectContext,
  MAX_PROJECT_INSTRUCTION_BYTES,
  workspaceProjectPrompt,
} from '../server/module-agents/project-context';
import type { ResolvedAgentProfile } from '../server/module-agents/contracts';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';

const root = await mkdtemp(join(tmpdir(), 'module-agent-project-context-'));
const AGENT_IDS = ['assistant', 'logs', 'requirements', 'codes'] as const;
const MARKER = {
  parent: 'PARENT_AGENTS_MUST_NOT_LEAK',
  home: 'USER_GLOBAL_AGENTS_MUST_NOT_LEAK',
  system: 'GLOBAL_SYSTEM_PROMPT_MUST_NOT_LEAK',
  append: 'GLOBAL_APPEND_PROMPT_MUST_NOT_LEAK',
  extension: 'GLOBAL_EXTENSION_MUST_NOT_LEAK',
  nested: 'NESTED_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK',
  readme: 'README_MUST_NOT_AUTO_LOAD',
  hidden: 'HIDDEN_WORKSPACE_OVERLAY_MUST_NOT_LOAD',
  outside: 'OUTSIDE_SYMLINK_INSTRUCTIONS_MUST_NOT_LEAK',
};

interface ProjectFixture {
  agentId: typeof AGENT_IDS[number];
  workspaceDir: string;
  expectedInstructions: string[];
}

interface ScriptedInput {
  systemPrompts: string[];
}

function readProjectIdentity(systemPrompt: string): { kind: string; name: string; path: string; source: string } {
  const block = systemPrompt.match(/<workspace_project>\s*([\s\S]*?)\s*<\/workspace_project>/);
  assert.ok(block, 'the assembled system prompt must identify its bound project');
  return JSON.parse(block[1]!) as { kind: string; name: string; path: string; source: string };
}

/** Capture system sections from the real hosted-session preparation path. */
async function captureSdkInput(session: { agent: any; prompt: (text: string) => Promise<unknown> }): Promise<ScriptedInput> {
  const agent = session.agent;
  const model = agent.state.model;
  assert.ok(model, 'the offline scripted session requires a model object');
  const savedStream = agent.streamFunction;
  const savedApiKey = agent.getApiKey;
  const captured: ScriptedInput = { systemPrompts: [] };

  agent.streamFunction = ((_requestedModel: unknown, context: { messages: unknown[] }) => {
    const systemMessages = (context.messages as Array<{ role?: string }>).filter(message => message.role === 'system');
    captured.systemPrompts.push(systemMessages
      .map(message => getSystemMessageText(message as Parameters<typeof getSystemMessageText>[0]))
      .filter(Boolean)
      .join('\n\n'));
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'project context fixture complete' }],
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
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  }) as typeof agent.streamFunction;
  agent.getApiKey = () => 'scripted-project-context-no-provider';
  try {
    await session.prompt('Inspect the already bound project context.');
  } finally {
    agent.streamFunction = savedStream;
    agent.getApiKey = savedApiKey;
  }
  assert.equal(captured.systemPrompts.length, 1, 'the hosted SDK session should make one scripted model request');
  return captured;
}

async function makeProjectFixture(
  agentId: typeof AGENT_IDS[number],
  index: number,
  outsideDir: string,
): Promise<ProjectFixture> {
  const workspaceDir = join(root, `project-${agentId}`);
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(workspaceDir, 'src', 'modules', 'one'), { recursive: true });

  const projectRule = `PROJECT_ROOT_RULE_${agentId}`;
  const localRule = `PROJECT_LOCAL_RULE_${agentId}`;
  const claudeRule = `PROJECT_CLAUDE_RULE_${agentId}`;
  const expectedInstructions = [projectRule, localRule];
  await writeFile(join(workspaceDir, 'AGENTS.md'), `${projectRule}\nThe project document cannot add tools to this Agent.`);

  if (index === 0 || index === 2) {
    await symlink('AGENTS.md', join(workspaceDir, 'CLAUDE.md'));
  } else {
    await writeFile(join(workspaceDir, 'CLAUDE.md'), claudeRule);
    expectedInstructions.push(claudeRule);
  }

  await writeFile(join(workspaceDir, 'AGENTS.local.md'), localRule);
  if (index === 1) {
    // Distinct path, identical content: it should not duplicate the instruction.
    await writeFile(join(workspaceDir, 'CLAUDE.local.md'), localRule);
  } else if (index === 3) {
    await symlink(join(outsideDir, 'outside-instruction.md'), join(workspaceDir, 'CLAUDE.local.md'));
  }

  await writeFile(join(workspaceDir, 'README.md'), MARKER.readme);
  await writeFile(join(workspaceDir, 'src', 'modules', 'one', 'AGENTS.md'), MARKER.nested);
  await mkdir(join(workspaceDir, '.zcode'), { recursive: true });
  await writeFile(join(workspaceDir, '.zcode', 'AGENTS.md'), MARKER.hidden);

  return { agentId, workspaceDir: await realpath(workspaceDir), expectedInstructions };
}

async function checkLoaderEdges(): Promise<void> {
  const emptyDir = join(root, 'empty-project');
  const largeDir = join(root, 'large-project');
  const nearLimitDir = join(root, 'near-limit-project');
  const externalDir = join(root, 'external-link-project');
  await Promise.all([
    mkdir(emptyDir, { recursive: true }),
    mkdir(largeDir, { recursive: true }),
    mkdir(nearLimitDir, { recursive: true }),
    mkdir(externalDir, { recursive: true }),
  ]);

  const emptyRoot = await realpath(emptyDir);
  const empty = await loadWorkspaceProjectContext(emptyDir);
  assert.equal(empty.workspaceDir, emptyRoot);
  assert.equal(empty.name, basename(emptyRoot));
  assert.deepEqual(empty.instructions, [], 'an empty workspace remains a project without instruction files');
  const emptyIdentity = readProjectIdentity(workspaceProjectPrompt(empty));
  assert.deepEqual(emptyIdentity, {
    kind: 'bound-project',
    name: basename(emptyRoot),
    path: emptyRoot,
    source: 'agent-workspace-binding',
  });

  await writeFile(join(largeDir, 'AGENTS.md'), `LARGE_PROJECT_RULE:${'x'.repeat(MAX_PROJECT_INSTRUCTION_BYTES + 5000)}`);
  await writeFile(join(largeDir, 'CLAUDE.md'), 'LARGE_PROJECT_SECOND_RULE_MUST_NOT_LOAD');
  const large = await loadWorkspaceProjectContext(largeDir);
  assert.equal(large.instructions.length, 1, 'the byte budget is shared across root instruction files');
  const largeContent = large.instructions[0]!.content;
  assert.ok(largeContent.startsWith('LARGE_PROJECT_RULE:'));
  assert.ok(largeContent.includes('项目指令达到自动加载大小上限'), 'truncation must be visible to the Agent');
  const loadedPrefix = largeContent.split('\n\n[项目指令达到自动加载大小上限')[0]!;
  assert.equal(Buffer.byteLength(loadedPrefix), MAX_PROJECT_INSTRUCTION_BYTES,
    'the source text must respect the total automatic instruction byte budget');

  const baselinePrefix = 'NEAR_BUDGET_BASELINE:';
  const baseline = `${baselinePrefix}${'b'.repeat(60 * 1024 - baselinePrefix.length)}`;
  const localRule = `NEAR_BUDGET_LOCAL_RULE:${'l'.repeat(3500)}`;
  await Promise.all([
    writeFile(join(nearLimitDir, 'AGENTS.md'), baseline),
    writeFile(join(nearLimitDir, 'CLAUDE.md'), baseline),
    writeFile(join(nearLimitDir, 'AGENTS.local.md'), localRule),
  ]);
  const nearLimit = await loadWorkspaceProjectContext(nearLimitDir);
  assert.equal(nearLimit.instructions.length, 2,
    'a duplicate full-size CLAUDE file must leave budget for a later local instruction');
  assert.equal(nearLimit.instructions[0]!.content, baseline, 'the baseline should be loaded once without truncation');
  assert.equal(nearLimit.instructions[1]!.content, localRule, 'the distinct local instruction should retain its full text');
  assert.ok(nearLimit.instructions.every(item => !item.content.includes('自动加载大小上限')),
    'de-duplicating a large file must not inject a truncated duplicate prefix');
  assert.ok(nearLimit.instructions.reduce((total, item) => total + Buffer.byteLength(item.content), 0)
    <= MAX_PROJECT_INSTRUCTION_BYTES, 'distinct source text must stay within the shared injection budget');

  const outsideDir = join(root, 'outside-for-symlink');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'outside-instruction.md'), MARKER.outside);
  await symlink(join(outsideDir, 'outside-instruction.md'), join(externalDir, 'CLAUDE.md'));
  const external = await loadWorkspaceProjectContext(externalDir);
  assert.equal(external.workspaceDir, await realpath(externalDir), 'a skipped external symlink cannot erase project binding');
  assert.deepEqual(external.instructions, [], 'instruction symlinks must resolve inside the bound project root');
}

async function main(): Promise<void> {
  const agentDir = join(root, 'agent-home');
  const homeDir = join(root, 'user-home');
  const sessionDir = join(root, 'sessions');
  const outsideDir = join(root, 'outside');
  await Promise.all([
    mkdir(join(agentDir, 'extensions'), { recursive: true }),
    mkdir(join(homeDir, '.zcode'), { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(outsideDir, { recursive: true }),
  ]);

  await writeFile(join(root, 'AGENTS.md'), MARKER.parent);
  await writeFile(join(homeDir, '.zcode', 'AGENTS.md'), MARKER.home);
  await writeFile(join(agentDir, 'SYSTEM.md'), MARKER.system);
  await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), MARKER.append);
  const extensionPath = join(agentDir, 'extensions', 'project-context-probe.ts');
  await writeFile(extensionPath, `export default function projectContextProbe(pi: any) {
  pi.registerTool({
    name: 'project_context_extension_probe',
    label: 'Project Context Probe',
    description: '${MARKER.extension}',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: 'text', text: 'extension should not be loaded' }] }; },
  });
}`);
  await writeFile(join(outsideDir, 'outside-instruction.md'), MARKER.outside);
  await checkLoaderEdges();

  const fixtures: ProjectFixture[] = [];
  for (let index = 0; index < AGENT_IDS.length; index += 1) {
    fixtures.push(await makeProjectFixture(AGENT_IDS[index]!, index, outsideDir));
  }
  const contexts = new Map<string, Awaited<ReturnType<typeof loadWorkspaceProjectContext>>>();
  for (const fixture of fixtures) {
    const context = await loadWorkspaceProjectContext(fixture.workspaceDir);
    contexts.set(fixture.agentId, context);
    assert.equal(context.workspaceDir, fixture.workspaceDir);
    assert.equal(context.name, basename(fixture.workspaceDir));
    const loadedInstructions = context.instructions.map(item => item.content).join('\n');
    for (const expected of fixture.expectedInstructions) {
      assert.ok(loadedInstructions.includes(expected), `${fixture.agentId} should load ${expected}`);
    }
    assert.equal(context.instructions.length, fixture.expectedInstructions.length,
      `${fixture.agentId} should de-duplicate aliases/content and load only its root files`);
    assert.ok(!JSON.stringify(context.instructions).includes(MARKER.hidden));
    assert.ok(!JSON.stringify(context.instructions).includes(MARKER.nested));
    assert.ok(!JSON.stringify(context.instructions).includes(MARKER.readme));
    assert.ok(!JSON.stringify(context.instructions).includes(MARKER.outside));

    const beforeChildren = structuredClone(context);
    await mkdir(join(fixture.workspaceDir, 'src', 'another-module'), { recursive: true });
    const afterChildren = await loadWorkspaceProjectContext(fixture.workspaceDir);
    assert.deepEqual(afterChildren, beforeChildren,
      'adding or switching among project subdirectories must not change the bound project identity');
  }

  const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
  const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const fixtureModel = runtime.getModels('deepseek')[0];
  assert.ok(fixtureModel, 'the offline model catalog must provide a fixture model');
  await runtime.setRuntimeApiKey(fixtureModel.provider, 'scripted-project-context-no-provider');

  const previousEnv = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  const host = new PiHost({
    definitions: {
      read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }),
    },
    modelRuntimeFactory: async () => runtime,
    sessionDir,
    settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
  });

  try {
    for (const fixture of fixtures) {
      const loaded = profiles.get(fixture.agentId);
      assert.ok(loaded?.ok === true, `the checked-in ${fixture.agentId}.yaml must load`);
      if (!loaded || !loaded.ok) throw new Error(`unreachable profile ${fixture.agentId}`);

      const profile: ResolvedAgentProfile = structuredClone(loaded.profile);
      profile.config.workspace = fixture.workspaceDir;
      profile.effectiveWorkspace = fixture.workspaceDir;
      profile.profileRevision = profileRevision(profile);
      const assembled = await assembleModuleAgent({
        store,
        workspaceKey: 'project-context-regression',
        agentId: fixture.agentId,
        profile,
        workspaceDir: fixture.workspaceDir,
      });

      const context = contexts.get(fixture.agentId)!;
      const prompt = assembled.systemPromptAppend[0] ?? '';
      const identity = readProjectIdentity(prompt);
      assert.deepEqual(identity, {
        kind: 'bound-project',
        name: basename(fixture.workspaceDir),
        path: fixture.workspaceDir,
        source: 'agent-workspace-binding',
      }, `${fixture.agentId} assembly must name its own bound project`);
      assert.deepEqual(assembled.projectContextFiles, context.instructions,
        `${fixture.agentId} assembly must carry only its bound root instructions`);
      for (const expected of fixture.expectedInstructions) {
        assert.ok(JSON.stringify(assembled.projectContextFiles).includes(expected),
          `${fixture.agentId} assembly should include ${expected}`);
      }

      const hosted = await host.create({
        provider: fixtureModel.provider,
        model: fixtureModel.id,
        moduleAgent: assembled,
      });
      assert.equal(hosted.cwd, fixture.workspaceDir, `${fixture.agentId} SDK session must keep the bound root as cwd`);
      assert.deepEqual(
        hosted.session.getAllTools().map((tool: { name: string }) => tool.name).sort(),
        [...new Set([...assembled.allowedToolNames, ...assembled.customTools.map(tool => tool.name)])].sort(),
        `${fixture.agentId} project instructions must not expand its configured tool surface`,
      );
      assert.ok(!hosted.extensionsResult.extensions.some(extension => extension.path === extensionPath),
        `${fixture.agentId} must not load user-level extensions`);
      assert.equal(hosted.session.getToolDefinition('project_context_extension_probe'), undefined,
        `${fixture.agentId} must not receive tools from user-level extensions`);
      const sdkInput = await captureSdkInput(hosted.session as never);
      const sdkPrompt = sdkInput.systemPrompts[0]!;
      assert.ok(sdkPrompt.includes(fixture.workspaceDir), `${fixture.agentId} SDK session prompt must contain the bound path`);
      assert.ok(sdkPrompt.includes('<project_context>'), `${fixture.agentId} SDK session prompt must include project instructions`);
      for (const expected of fixture.expectedInstructions) {
        assert.ok(sdkPrompt.includes(expected), `${fixture.agentId} SDK session prompt must contain its own root instruction`);
      }
      for (const other of fixtures.filter(candidate => candidate.agentId !== fixture.agentId)) {
        for (const otherRule of other.expectedInstructions) {
          assert.ok(!sdkPrompt.includes(otherRule), `${fixture.agentId} SDK session prompt must not contain ${other.agentId} instructions`);
        }
      }
      for (const forbidden of Object.values(MARKER)) {
        assert.ok(!sdkPrompt.includes(forbidden), `${fixture.agentId} SDK session prompt must omit ${forbidden}`);
      }
      await host.kill(hosted.id);
    }

    console.log('PASS module Agent project context: all four bound identities and root instructions reach the Pi SDK prompt; parent/global/nested/README/external-link context stays out; project documents do not change tools');
  } finally {
    await host.disposeAll();
    store.close();
    if (previousEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousEnv.agentDir;
    if (previousEnv.home === undefined) delete process.env.HOME;
    else process.env.HOME = previousEnv.home;
    if (previousEnv.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousEnv.userProfile;
  }
}

try {
  await main();
} finally {
  await rm(root, { recursive: true, force: true });
}
