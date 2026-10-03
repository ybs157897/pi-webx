/**
 * Requirements Agent context and execution-order regression.
 *
 * This uses a temporary WorkbenchStore, a temporary Pi agent directory and a
 * scripted stream over the real Pi SDK loop. The scripted responses verify
 * assembly, tool execution and transcript ordering; they do not claim to prove
 * that a live model will follow the prompt. A live-model probe is separate.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

import { assembleModuleAgent } from '../server/module-agents/assemble';
import { loadAgentProfiles, defaultAgentsConfigRoot } from '../server/module-agents/profiles';
import { profileRevision } from '../server/module-agents/snapshots';
import { PiHost, HostError } from '../server/pi/host';
import { buildRequirementsWorkbenchContext } from '../server/modules/requirements/context';
import { getChatroomService } from '../server/modules/chatroom/service';
import { WorkbenchStore } from '../server/workbench/store';
import type { ResolvedAgentProfile } from '../server/module-agents/contracts';

const root = await mkdtemp(join(tmpdir(), 'requirements-agent-context-'));
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const workspaceDir = join(root, 'requirements-work');
const outsideDir = join(root, 'outside');

const ORIGINAL_REQUEST = '我想给这个加一个工作台';
const GLOBAL_PROMPT_SENTINEL = 'GLOBAL-PROMPT-MUST-NOT-LEAK';
const PRIVATE_SOURCE_SENTINEL = 'PRIVATE-REQUIREMENT-SOURCE-SESSION-9d1c';
const PRIVATE_NOTE_SENTINEL = 'HUGE_NOTE_PRIVATE_MARKER-4a2e';
const NEEDLE = 'UNIQUE_CONTEXT_NEEDLE-81ac';
const UNSCOPED_TOOLS = ['bash', 'powershell', 'grep', 'find'];

type ScriptStep =
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'text'; id: string; text: string };

interface ToolEnd {
  id: string;
  toolName: string;
  isError: boolean;
  text: string;
  details: unknown;
}

interface ScriptRun {
  toolEnds: ToolEnd[];
  assistantTexts: string[];
  modelInputs: string[];
}

function tool(id: string, name: string, args: Record<string, unknown> = {}): ScriptStep {
  return { kind: 'tool', id, name, args };
}

function say(id: string, text: string): ScriptStep {
  return { kind: 'text', id, text };
}

function messageFor(model: any, step: ScriptStep): AssistantMessage {
  const toolCall = step.kind === 'tool'
    ? [{ type: 'toolCall' as const, id: step.id, name: step.name, arguments: step.args }]
    : null;
  return {
    role: 'assistant',
    content: toolCall ?? [{ type: 'text', text: step.text }],
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
    stopReason: step.kind === 'tool' ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

/** Drive several tool calls and a final answer through the real SDK loop. */
async function driveScriptedPrompt(session: { agent: any }, prompt: string, steps: ScriptStep[]): Promise<ScriptRun> {
  const agent = session.agent;
  const model = agent.state.model;
  assert.ok(model, 'the offline scripted SDK loop requires a model object');

  const savedStream = agent.streamFunction;
  const savedApiKey = agent.getApiKey;
  const savedFinishTurn = agent.finishTurn;
  const run: ScriptRun = { toolEnds: [], assistantTexts: [], modelInputs: [] };
  let cursor = 0;

  const unsubscribe = agent.subscribe((event: any) => {
    if (event.type === 'tool_execution_end') {
      const result = event.result as { content?: Array<{ text?: string }>; details?: unknown } | undefined;
      run.toolEnds.push({
        id: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        text: (result?.content ?? []).map(block => block.text ?? '').join(''),
        details: result?.details,
      });
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      run.assistantTexts.push((event.message.content ?? [])
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join(''));
    }
  });

  agent.streamFunction = ((_requestedModel: unknown, context: { messages: unknown[] }) => {
    const step = steps[cursor++];
    assert.ok(step, `scripted model requested an unexpected turn ${cursor}`);
    run.modelInputs.push(JSON.stringify(context.messages));
    const stream = createAssistantMessageEventStream();
    const message = messageFor(model, step);
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end(message);
    return stream;
  }) as typeof agent.streamFunction;
  agent.getApiKey = () => 'scripted-stream-no-provider';
  agent.finishTurn = (turn: { message: { stopReason: string } }) => {
    if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return undefined;
    if (cursor >= steps.length && turn.message.stopReason !== 'toolUse') return { action: 'end' };
    return undefined;
  };

  try {
    await agent.prompt(prompt);
  } finally {
    agent.streamFunction = savedStream;
    agent.getApiKey = savedApiKey;
    agent.finishTurn = savedFinishTurn;
    unsubscribe();
  }
  assert.equal(cursor, steps.length, 'the SDK must consume each scripted step');
  return run;
}

function contextData(end: ToolEnd): Record<string, any> {
  const details = end.details as { data?: unknown } | undefined;
  if (details?.data !== undefined) return details.data as Record<string, any>;
  return JSON.parse(end.text) as Record<string, any>;
}

function endById(run: ScriptRun, id: string): ToolEnd {
  const end = run.toolEnds.find(item => item.id === id);
  assert.ok(end, `SDK transcript must contain tool result ${id}`);
  return end;
}

function resultText(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map(block => block.text ?? '').join('');
}

async function main(): Promise<void> {
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(outsideDir, { recursive: true }),
  ]);
  await writeFile(join(agentDir, 'SYSTEM.md'), GLOBAL_PROMPT_SENTINEL, 'utf8');

  const workspace = await realpath(workspaceDir);
  const outside = await realpath(outsideDir);
  await writeFile(join(workspace, 'relative.txt'), 'WORKSPACE_RELATIVE_BEFORE', 'utf8');
  await writeFile(join(workspace, 'hostile-shadow.txt'), 'WORKSPACE_BOUND_CWD', 'utf8');
  await writeFile(join(outside, 'relative.txt'), 'HOSTILE_CWD_SHADOW', 'utf8');
  await writeFile(join(outside, 'outside-secret.txt'), 'OUTSIDE_SECRET_MUST_NOT_READ', 'utf8');
  await mkdir(join(outside, 'nested'), { recursive: true });
  await writeFile(join(outside, 'nested', 'nested-secret.txt'), 'NESTED_OUTSIDE_SECRET', 'utf8');
  await mkdir(join(workspace, 'crowded'), { recursive: true });
  await Promise.all(Array.from({ length: 205 }, (_, index) =>
    writeFile(join(workspace, 'crowded', `entry-${String(index).padStart(3, '0')}.txt`), 'entry', 'utf8')));
  await symlink(join(outside, 'outside-secret.txt'), join(workspace, 'outside-link.txt'));
  await symlink(join(outside, 'nested'), join(workspace, 'outside-dir-link'));

  const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
  const loaded = profiles.get('requirements');
  assert.ok(loaded?.ok === true, 'the checked-in requirements.yaml must load');
  if (!loaded.ok) throw new Error('unreachable');

  const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
  const hugeRequirement = store.addRecord('requirements', {
    title: '上下文输出长度回归',
    status: 'todo',
    note: `${PRIVATE_NOTE_SENTINEL} ${'x'.repeat(4900)}`,
    sourceSessionId: PRIVATE_SOURCE_SENTINEL,
    taskDrafts: [{ title: '不得读取私有来源字段', priority: 'normal', due: null, tag: '回归' }],
  });
  const matchingRequirement = store.addRecord('requirements', {
    title: '关联记录搜索回归',
    status: 'doing',
    note: `只应按工作台需求搜索：${NEEDLE}`,
    sourceSessionId: `${PRIVATE_SOURCE_SENTINEL}-MATCH`,
    taskDrafts: [],
  });
  for (let index = 0; index < 5; index += 1) {
    store.addRecord('requirements', { title: `公开摘要 ${index + 1}`, status: index % 2 ? 'done' : 'todo', note: '', taskDrafts: [] });
  }

  const safeContextSize = JSON.stringify(buildRequirementsWorkbenchContext(store)).length;
  const profile: ResolvedAgentProfile = structuredClone(loaded.profile);
  profile.config.workspace = workspace;
  profile.effectiveWorkspace = workspace;
  // Leave the checked-in model choice intact. The offline runtime is deliberately
  // supplied an explicit fixture model through host.create, as the UI can do.
  profile.config.limits = {
    ...profile.config.limits,
    maxToolOutputChars: safeContextSize + 1600,
  };
  // Simulate an older saved profile snapshot and prompt. Runtime policy must still
  // remove unscoped shell/search tools and append the current clarification rules.
  profile.config.tools = [...new Set([...profile.config.tools, ...UNSCOPED_TOOLS])];
  profile.promptText = 'LEGACY_REQUIREMENTS_PROMPT: 先扫描上级目录并搜索可能相关的项目。';
  profile.profileRevision = profileRevision(profile);

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const fixtureModel = runtime.getModels('deepseek')[0];
  assert.ok(fixtureModel, 'the offline model catalog must provide a fixture model');

  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const host = new PiHost({
    definitions: {
      read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }),
    },
    modelRuntimeFactory: async () => runtime,
    sessionDir,
    settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
  });

  try {
    const moduleOption = await assembleModuleAgent({ store, workspaceKey: 'requirements-regression', agentId: 'requirements', profile });
    const hosted = await host.create({
      cwd: outside,
      provider: fixtureModel.provider,
      model: fixtureModel.id,
      moduleAgent: moduleOption,
    });
    assert.equal(hosted.cwd, workspace, 'the session must keep its bound workspace despite a hostile requested cwd');
    assert.equal(hosted.session.sessionManager.getCwd(), workspace);
    assert.equal(hosted.session.agent.state.model?.provider, fixtureModel.provider, 'the explicit offline fixture model must override the checked-in model');
    assert.equal(hosted.session.agent.state.model?.id, fixtureModel.id);

    const toolNames = hosted.session.getAllTools().map(item => item.name).sort();
    for (const expected of [
      'requirements_context', 'requirements_save_draft', 'requirements_dispatch', 'skills_read',
      'read', 'write', 'edit', 'ls', 'chatroom_send', 'chatroom_read', 'chatroom_work',
    ]) assert.ok(toolNames.includes(expected), `requirements Agent must expose ${expected}`);
    for (const name of UNSCOPED_TOOLS) assert.ok(!toolNames.includes(name), `legacy snapshot must not restore ${name}`);
    assert.deepEqual(hosted.session.getActiveToolNames().sort(), toolNames, 'all assembled tools are active');

    const systemPrompt = hosted.session.systemPrompt;
    assert.ok(systemPrompt.includes('<requirements_workbench_context>'), 'the curated application context must be injected into the module prompt');
    assert.ok(systemPrompt.includes('AI 指挥台'));
    assert.ok(systemPrompt.includes('宿主应用本身不能作为用户目标的默认值'));
    assert.ok(systemPrompt.includes('指代不明确') && systemPrompt.includes('不先列目录'));
    assert.ok(systemPrompt.includes('LEGACY_REQUIREMENTS_PROMPT'), 'the regression includes an old profile prompt');
    assert.ok(!systemPrompt.includes(GLOBAL_PROMPT_SENTINEL), 'module session must not load the global agent prompt');
    const contextStart = systemPrompt.indexOf('<requirements_workbench_context>') + '<requirements_workbench_context>'.length;
    const contextEnd = systemPrompt.indexOf('</requirements_workbench_context>', contextStart);
    assert.ok(contextEnd > contextStart, 'the injected app context must have a bounded section');
    const injectedContext = systemPrompt.slice(contextStart, contextEnd);
    assert.ok(!injectedContext.includes(PRIVATE_SOURCE_SENTINEL), 'injected app context must omit private session provenance');
    assert.ok(!injectedContext.includes(PRIVATE_NOTE_SENTINEL), 'injected app context must omit requirement note contents');
    assert.ok(!injectedContext.includes(workspace), 'injected app context must not reveal the bound cwd');
    assert.ok(!injectedContext.includes(hosted.id), 'injected app context must not include the private session id');

    const skillName = profile.skills[0]?.name;
    assert.ok(skillName, 'the current profile must include the product requirements Skill');
    const opening = await driveScriptedPrompt(hosted.session as never, ORIGINAL_REQUEST, [
      tool('opening-skill', 'skills_read', { name: skillName }),
      tool('opening-context', 'requirements_context', {}),
      say('opening-clarification', '你说的“这个”具体指哪个项目或功能？我知道你在需求助手里，但这不能确定需求目标。'),
    ]);
    assert.deepEqual(opening.toolEnds.map(item => item.toolName), ['skills_read', 'requirements_context'],
      'the scripted flow reads the method Skill and scoped workbench context before asking');
    assert.ok(opening.toolEnds.every(item => !item.isError));
    assert.ok(opening.modelInputs[0]?.includes(ORIGINAL_REQUEST), 'the original ambiguous request reaches the SDK model input');
    assert.ok(opening.modelInputs[1]?.includes('这个/这里/它'), 'the Skill result reaches the next SDK model input');
    assert.ok(opening.modelInputs[2]?.includes('AI 指挥台'), 'the workbench context result reaches the clarification turn');
    assert.ok(opening.assistantTexts.some(text => text.includes('“这个”') && text.includes('哪个项目或功能')),
      'the scripted transcript ends with a concise target clarification');
    assert.deepEqual(opening.toolEnds.map(item => item.toolName).filter(name => ['read', 'ls', ...UNSCOPED_TOOLS, 'chatroom_read'].includes(name)), [],
      'the ambiguous request must not trigger file, shell, search or whole-chatroom scans');

    const openingContext = contextData(endById(opening, 'opening-context'));
    assert.equal(openingContext.hostApplication?.id, 'pi-webx');
    assert.equal(openingContext.target?.kind, 'unspecified');
    assert.equal(openingContext.target?.source, 'server-binding');
    assert.equal(openingContext.requirements?.total, 7);
    assert.equal(openingContext.requirements?.items?.length, 5, 'the initial context is capped at five requirement summaries');
    assert.ok(!JSON.stringify(openingContext).includes(PRIVATE_SOURCE_SENTINEL));
    assert.ok(!JSON.stringify(openingContext).includes(PRIVATE_NOTE_SENTINEL));
    assert.ok(!JSON.stringify(openingContext).includes(workspace));

    const contextQueries = await driveScriptedPrompt(hosted.session as never, '读取指定的上下文回归样例。', [
      tool('query-match', 'requirements_context', { query: NEEDLE, limit: 2 }),
      tool('detail-huge-note', 'requirements_context', { requirementId: hugeRequirement.id }),
      tool('query-missing-id', 'requirements_context', { requirementId: 'nonexistent-requirement-00000000' }),
      say('query-done', '上下文查询回归完成。'),
    ]);
    assert.deepEqual(contextQueries.toolEnds.map(item => item.toolName), [
      'requirements_context', 'requirements_context', 'requirements_context',
    ]);
    const matchEnd = endById(contextQueries, 'query-match');
    assert.equal(matchEnd.isError, false);
    const matchData = contextData(matchEnd);
    assert.equal(matchData.requirements?.returned, 1);
    assert.equal(matchData.requirements?.items?.[0]?.id, matchingRequirement.id);
    assert.ok(JSON.stringify(matchData).includes(NEEDLE), 'topic search may return a bounded matching note excerpt');
    assert.ok(!JSON.stringify(matchData).includes(PRIVATE_SOURCE_SENTINEL));

    const hugeEnd = endById(contextQueries, 'detail-huge-note');
    assert.equal(hugeEnd.isError, false);
    assert.ok(hugeEnd.text.length <= profile.config.limits.maxToolOutputChars, 'JSON tool output must respect maxToolOutputChars');
    const hugeData = contextData(hugeEnd);
    assert.equal(hugeData.record?.id, hugeRequirement.id);
    assert.equal(hugeData.record?.noteLength, hugeRequirement.note.length);
    assert.equal(hugeData.record?.noteTruncated, true, 'large requirement notes must carry explicit truncation metadata');
    assert.ok((hugeData.record?.note?.length ?? 0) < hugeData.record?.noteLength);
    assert.ok(hugeEnd.text.includes(PRIVATE_NOTE_SENTINEL), 'the detail tool may expose requested note content only within its output bound');
    assert.ok(!hugeEnd.text.includes(PRIVATE_SOURCE_SENTINEL), 'detail projection must omit private source-session fields');

    const missingEnd = endById(contextQueries, 'query-missing-id');
    assert.equal(missingEnd.isError, true, 'a nonexistent requirement id must fail closed');
    assert.ok(missingEnd.text.includes('需求不存在'));
    assert.ok(!missingEnd.text.includes(PRIVATE_SOURCE_SENTINEL));

    // A direct page session cannot read arbitrary group history.
    const directChatRead = await driveScriptedPrompt(hosted.session as never, '试图读取未关联的群聊。', [
      tool('direct-chatroom-read', 'chatroom_read', {}),
      say('direct-chatroom-done', '已收到工具边界结果。'),
    ]);
    const deniedDirectChat = endById(directChatRead, 'direct-chatroom-read');
    assert.equal(deniedDirectChat.isError, true);
    assert.ok(deniedDirectChat.text.includes('没有关联群话题'));

    // A delivered group session sees only its own thread, even when another
    // pending requirements delivery exists in the same workspace.
    const chatroom = getChatroomService(store, 'requirements-regression');
    const firstDelivery = chatroom.send('assistant', 'fixture-sender-a', {
      to: 'requirements', body: 'CURRENT_THREAD_ONLY_SENTINEL', entryKey: 'requirements-context-thread-a',
    });
    const secondDelivery = chatroom.send('assistant', 'fixture-sender-b', {
      to: 'requirements', body: 'OTHER_THREAD_MUST_NOT_LEAK', entryKey: 'requirements-context-thread-b',
    });
    const claimedFirst = chatroom.storage.claim(firstDelivery.id);
    assert.ok(claimedFirst, 'the fixture must claim the first delivery');
    const scopedChatRead = await chatroom.withDelivery(hosted.id, claimedFirst, 'requirements', async () =>
      driveScriptedPrompt(hosted.session as never, '读取当前投递话题。', [
        tool('scoped-chatroom-read', 'chatroom_read', {}),
        say('scoped-chatroom-done', '已读取当前投递话题。'),
      ]));
    const scopedEnd = endById(scopedChatRead, 'scoped-chatroom-read');
    assert.equal(scopedEnd.isError, false);
    assert.ok(scopedEnd.text.includes('CURRENT_THREAD_ONLY_SENTINEL'));
    assert.ok(!scopedEnd.text.includes('OTHER_THREAD_MUST_NOT_LEAK'));
    assert.notEqual(firstDelivery.threadId, secondDelivery.threadId);

    // File SDK calls are bound to the profile workspace even if their SDK
    // context carries a different cwd.
    const readTool = hosted.session.getToolDefinition('read');
    assert.ok(readTool, 'the guarded Pi SDK read tool must be installed');
    const hostileResult = await readTool.execute(
      'hostile-cwd-read', { path: 'hostile-shadow.txt' }, undefined, undefined, { cwd: outside } as never,
    );
    assert.ok(resultText(hostileResult).includes('WORKSPACE_BOUND_CWD'));
    assert.ok(!resultText(hostileResult).includes('HOSTILE_CWD_SHADOW'));

    const fileRun = await driveScriptedPrompt(hosted.session as never, '在绑定工作区内执行文件访问回归。', [
      tool('file-read-relative', 'read', { path: 'relative.txt' }),
      tool('file-read-absolute', 'read', { path: join(workspace, 'relative.txt') }),
      tool('file-write-inside', 'write', { path: 'written.txt', content: 'WORKSPACE_WRITE_OK' }),
      tool('file-edit-inside', 'edit', { path: 'relative.txt', edits: [{ oldText: 'BEFORE', newText: 'AFTER' }] }),
      tool('file-ls-capped', 'ls', { path: 'crowded', limit: 200 }),
      tool('file-read-parent-escape', 'read', { path: '../outside/outside-secret.txt' }),
      tool('file-read-absolute-escape', 'read', { path: join(outside, 'outside-secret.txt') }),
      tool('file-read-leaf-symlink', 'read', { path: 'outside-link.txt' }),
      tool('file-read-nested-symlink', 'read', { path: 'outside-dir-link/nested-secret.txt' }),
      tool('file-write-absolute-escape', 'write', { path: join(outside, 'new-absolute.txt'), content: 'must-not-write' }),
      tool('file-write-symlink-ancestor', 'write', { path: 'outside-dir-link/new-via-symlink.txt', content: 'must-not-write' }),
      say('file-run-done', '文件工具回归完成。'),
    ]);
    for (const id of [
      'file-read-relative', 'file-read-absolute', 'file-write-inside', 'file-edit-inside', 'file-ls-capped',
    ]) assert.equal(endById(fileRun, id).isError, false, `${id} should stay inside the bound workspace`);
    assert.ok(endById(fileRun, 'file-read-relative').text.includes('WORKSPACE_RELATIVE_BEFORE'));
    assert.ok(endById(fileRun, 'file-read-absolute').text.includes('WORKSPACE_RELATIVE_BEFORE'));
    assert.equal(await readFile(join(workspace, 'written.txt'), 'utf8'), 'WORKSPACE_WRITE_OK');
    assert.equal(await readFile(join(workspace, 'relative.txt'), 'utf8'), 'WORKSPACE_RELATIVE_AFTER');
    const lsText = endById(fileRun, 'file-ls-capped').text;
    const listedEntries = lsText.split('\n').filter(line => /^entry-\d+\.txt$/.test(line));
    assert.equal(listedEntries.length, 200, 'ls must stop at the 200-entry cap independent of filesystem iteration order');
    assert.equal(new Set(listedEntries).size, 200);

    for (const id of [
      'file-read-parent-escape', 'file-read-absolute-escape', 'file-read-leaf-symlink',
      'file-read-nested-symlink', 'file-write-absolute-escape', 'file-write-symlink-ancestor',
    ]) {
      const denied = endById(fileRun, id);
      assert.equal(denied.isError, true, `${id} must be denied`);
      assert.ok(!denied.text.includes('OUTSIDE_SECRET_MUST_NOT_READ'));
    }
    await assert.rejects(readFile(join(outside, 'new-absolute.txt'), 'utf8'));
    await assert.rejects(readFile(join(outside, 'new-via-symlink.txt'), 'utf8'));

    const sessionFile = hosted.sessionFile;
    assert.ok(sessionFile, 'the real SDK prompt must persist the module session');
    const persisted = await readFile(sessionFile, 'utf8');
    assert.ok(persisted.includes('pi-webx:module-agent'));
    assert.ok(persisted.includes(profile.profileRevision));

    const reset = await host.command(hosted.id, { type: 'new_session', id: 'requirements-reset-regression' } as never);
    assert.equal(reset.success, false, 'module sessions must not reset through the ordinary-session path');
    assert.match(reset.error ?? '', /模块 Agent 会话请从模块入口新建/);
    assert.deepEqual(hosted.session.getAllTools().map(item => item.name).sort(), toolNames,
      'a rejected ordinary reset must leave the requirement tool surface unchanged');
    await host.kill(hosted.id);

    const restored = await host.create({
      sessionPath: sessionFile,
      provider: fixtureModel.provider,
      model: fixtureModel.id,
      moduleAgent: moduleOption,
    });
    assert.equal(restored.cwd, workspace);
    assert.equal(restored.moduleAgent?.agentId, 'requirements');
    assert.equal(restored.moduleAgent?.profileRevision, profile.profileRevision);
    const restoredNames = restored.session.getAllTools().map(item => item.name).sort();
    for (const name of UNSCOPED_TOOLS) assert.ok(!restoredNames.includes(name), `restore must not re-enable ${name}`);
    assert.ok(restoredNames.includes('requirements_context') && restoredNames.includes('read'));
    assert.ok(restored.session.systemPrompt.includes('<requirements_workbench_context>'));
    await host.kill(restored.id);

    console.log('PASS requirements Agent: safe host context, early clarification sequence, bounded requirements_context, legacy tool removal, scoped chat history, guarded workspace tools, restore/reset boundaries');
  } finally {
    await host.disposeAll();
    store.close();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
}

try {
  await main();
} finally {
  await rm(root, { recursive: true, force: true });
}
