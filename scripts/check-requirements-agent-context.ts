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
import { basename, join } from 'node:path';

import { createAssistantMessageEventStream, getSystemMessageText, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

import { assembleModuleAgent } from '../server/module-agents/assemble';
import { ASK_USER_TOOL_NAME, createAskUserTool } from '../server/module-agents/ask-user';
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

const ORIGINAL_REQUEST = '请结合当前绑定项目说明梳理需求。';
const GLOBAL_PROMPT_SENTINEL = 'GLOBAL-PROMPT-MUST-NOT-LEAK';
const PROJECT_AGENTS_SENTINEL = 'BOUND_PROJECT_AGENTS_FACT-71c9';
const PROJECT_CLAUDE_SENTINEL = 'BOUND_PROJECT_CLAUDE_FACT-4b86';
const PROJECT_README_SENTINEL = 'BOUND_PROJECT_README_FACT-15af';
const PRIVATE_SOURCE_SENTINEL = 'PRIVATE-REQUIREMENT-SOURCE-SESSION-9d1c';
const PRIVATE_NOTE_SENTINEL = 'HUGE_NOTE_PRIVATE_MARKER-4a2e';
const NEEDLE = 'UNIQUE_CONTEXT_NEEDLE-81ac';
/** Requirements sessions keep shell tools out; read-only search tools are allowed for impact analysis. */
const SHELL_TOOLS = ['bash', 'powershell'];
const SEARCH_TOOLS = ['grep', 'find'];

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
async function driveScriptedPrompt(
  session: { agent: any; prompt: (prompt: string) => Promise<unknown> },
  prompt: string,
  steps: ScriptStep[],
): Promise<ScriptRun> {
  const agent = session.agent;
  const model = agent.state.model;
  assert.ok(model, 'the offline scripted SDK loop requires a model object');

  const savedStream = agent.streamFunction;
  const savedFinishTurn = agent.finishTurn;
  const sessionRuntime = (session as any).modelRuntime as {
    hasConfiguredAuth: (...args: any[]) => boolean;
    checkAuth: (...args: any[]) => Promise<unknown>;
    getAuth: (...args: any[]) => Promise<unknown>;
  };
  const savedHasConfiguredAuth = sessionRuntime.hasConfiguredAuth;
  const savedCheckAuth = sessionRuntime.checkAuth;
  const savedGetAuth = sessionRuntime.getAuth;
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
  sessionRuntime.hasConfiguredAuth = () => true;
  sessionRuntime.checkAuth = async () => ({ type: 'api_key' });
  sessionRuntime.getAuth = async () => ({ auth: { apiKey: 'scripted-stream-no-provider' } });
  agent.finishTurn = (turn: { message: { stopReason: string } }) => {
    if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return undefined;
    if (cursor >= steps.length && turn.message.stopReason !== 'toolUse') return { action: 'end' };
    return undefined;
  };

  try {
    await session.prompt(prompt);
  } finally {
    agent.streamFunction = savedStream;
    agent.finishTurn = savedFinishTurn;
    sessionRuntime.hasConfiguredAuth = savedHasConfiguredAuth;
    sessionRuntime.checkAuth = savedCheckAuth;
    sessionRuntime.getAuth = savedGetAuth;
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

/**
 * 契约钉：没有提问通道时必须同步降级 —— ask_user 要返回 needsFallback 文本，
 * 不许调用对话框、更不许挂起等待一个永远不会来的答案（离线门禁会因此卡死）。
 * 这是不依赖 SDK 会话的直接单元断言，桩 ctx 只提供 execute 所需的最小形状。
 */
async function assertAskUserNoUiContract(): Promise<void> {
  const tool = createAskUserTool();
  assert.equal(tool.name, ASK_USER_TOOL_NAME);
  assert.equal(ASK_USER_TOOL_NAME, 'ask_user', 'the YAML whitelist entry and the produced tool name must agree');
  const uiTouches: string[] = [];
  const noUiCtx = {
    hasUI: false,
    ui: {
      select: () => { uiTouches.push('select'); throw new Error('没有通道时不得发起选择'); },
      input: () => { uiTouches.push('input'); throw new Error('没有通道时不得发起输入'); },
    },
  };
  const raced = await Promise.race([
    tool.execute('ask-user-no-ui', {
      questions: [{ id: 'Q1', question: '范围是否包含旧数据迁移？', choices: [{ label: '包含', description: '影响工作量' }, { label: '不包含' }] }],
    }, undefined, undefined, noUiCtx as never),
    new Promise<'timeout'>(resolve => { setTimeout(() => { resolve('timeout'); }, 2_000).unref(); }),
  ]);
  assert.notEqual(raced, 'timeout', 'ask_user must degrade instead of hanging without a question channel');
  const text = resultText(raced as { content?: Array<{ text?: string }> });
  assert.ok(text.includes('needsFallback'), `the degraded result must carry needsFallback, got ${text}`);
  assert.equal((raced as { details?: { needsFallback?: boolean } }).details?.needsFallback, true);
  assert.deepEqual(uiTouches, [], 'the no-channel path must not touch the dialog UI');
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
  await Promise.all([
    writeFile(join(workspace, 'AGENTS.md'), `# Project identity\n${PROJECT_AGENTS_SENTINEL}\n`, 'utf8'),
    writeFile(join(workspace, 'CLAUDE.md'), `# Project notes\n${PROJECT_CLAUDE_SENTINEL}\n`, 'utf8'),
    writeFile(join(workspace, 'README.md'), `# ${basename(workspace)}\n${PROJECT_README_SENTINEL}\n`, 'utf8'),
  ]);
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

  const safeContextSize = JSON.stringify(buildRequirementsWorkbenchContext(store, workspace)).length;
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
  // remove shell tools and append the current bound-project context, while
  // read-only grep/find stay available for code impact analysis.
  profile.config.tools = [...new Set([...profile.config.tools, ...SHELL_TOOLS, ...SEARCH_TOOLS])];
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
      'requirements_context', 'requirements_save_draft', 'requirements_dispatch', 'ask_user', 'skills_read',
      'read', 'write', 'edit', 'ls', 'chatroom_send', 'chatroom_read', 'chatroom_work',
    ]) assert.ok(toolNames.includes(expected), `requirements Agent must expose ${expected}`);
    for (const name of SEARCH_TOOLS) assert.ok(toolNames.includes(name), `requirements Agent must expose read-only search tool ${name}`);
    for (const name of SHELL_TOOLS) assert.ok(!toolNames.includes(name), `legacy snapshot must not restore ${name}`);
    assert.deepEqual(hosted.session.getActiveToolNames().sort(), toolNames, 'all assembled tools are active');

    // 提问卡的通道契约：无 UI 时降级不悬挂，不依赖这里已装配的会话。
    await assertAskUserNoUiContract();

    // 工具文案红线：所有模型可见的工具描述不得出现宿主术语（含 grep/find 的
    // 工作区守卫注入文案与 chatroom_read 的话题限定文案）。
    for (const item of hosted.session.getAllTools()) {
      const copy = `${item.label ?? ''}\n${item.description ?? ''}\n${item.promptSnippet ?? ''}\n${(item.promptGuidelines ?? []).join('\n')}`;
      for (const term of ['指挥台', '工作台', '宿主', 'pi-webx', '模块 Agent']) {
        assert.ok(!copy.includes(term), `tool ${item.name} copy must not mention the host term「${term}」`);
      }
    }

    const systemPrompt = hosted.session.systemPrompt;
    assert.ok(systemPrompt.includes('<requirements_session_context>'), 'the curated session context must be injected into the module prompt');
    assert.ok(systemPrompt.includes('bound-project') && systemPrompt.includes(basename(workspace)));
    assert.ok(systemPrompt.includes(`<cwd>\n${workspace}\n</cwd>`), 'the SDK cwd section must use the bound project root');
    assert.ok(!systemPrompt.includes(outside), 'an external requested cwd must not enter the SDK system prompt');
    assert.ok(systemPrompt.includes('<workspace_project>'));
    assert.ok(!systemPrompt.includes('服务端没有预选目标'), 'the bound project is the default target');
    assert.ok(systemPrompt.includes('不要再问用户当前项目是什么'));
    assert.ok(systemPrompt.includes('LEGACY_REQUIREMENTS_PROMPT'), 'the regression includes an old profile prompt');
    assert.ok(!systemPrompt.includes(GLOBAL_PROMPT_SENTINEL), 'module session must not load the global agent prompt');
    assert.ok(systemPrompt.includes(PROJECT_AGENTS_SENTINEL), 'bound project instructions must enter the actual SDK prompt');
    assert.ok(systemPrompt.includes(PROJECT_CLAUDE_SENTINEL), 'bound project instructions may come from CLAUDE.md');
    const contextStart = systemPrompt.indexOf('<requirements_session_context>') + '<requirements_session_context>'.length;
    const contextEnd = systemPrompt.indexOf('</requirements_session_context>', contextStart);
    assert.ok(contextEnd > contextStart, 'the injected session context must have a bounded section');
    const injectedContext = systemPrompt.slice(contextStart, contextEnd);
    assert.ok(!injectedContext.includes(PRIVATE_SOURCE_SENTINEL), 'injected context must omit private session provenance');
    assert.ok(!injectedContext.includes(PRIVATE_NOTE_SENTINEL), 'injected context must omit requirement note contents');
    assert.ok(injectedContext.includes(workspace), 'the bound project path must be explicit in the injected context');
    assert.ok(!injectedContext.includes(hosted.id), 'injected context must not include the private session id');

    const skillName = profile.skills[0]?.name;
    assert.ok(skillName, 'the current profile must include the product requirements Skill');
    const opening = await driveScriptedPrompt(hosted.session as never, ORIGINAL_REQUEST, [
      tool('opening-skill', 'skills_read', { name: skillName }),
      tool('opening-context', 'requirements_context', {}),
      tool('opening-ls', 'ls', { path: '.' }),
      tool('opening-read-agents', 'read', { path: 'AGENTS.md' }),
      tool('opening-read-claude', 'read', { path: 'CLAUDE.md' }),
      tool('opening-read-readme', 'read', { path: 'README.md' }),
      say('opening-done', '固定脚本工具调用完成；此响应不代表真实模型行为。'),
    ]);
    assert.deepEqual(opening.toolEnds.map(item => item.toolName), [
      'skills_read', 'requirements_context', 'ls', 'read', 'read', 'read',
    ], 'the scripted SDK loop can call context and bound-project file tools');
    assert.ok(opening.toolEnds.every(item => !item.isError));
    const firstSdkInput = opening.modelInputs[0] ?? '';
    assert.ok(firstSdkInput.includes(ORIGINAL_REQUEST), 'the user request reaches the SDK input');
    const firstRequest = JSON.parse(firstSdkInput) as Array<{ role?: string; content?: unknown; sections?: Record<string, string | null> }>;
    const firstSystemMessage = firstRequest.find(message => message.role === 'system');
    assert.ok(firstSystemMessage, 'the actual stream input must contain a system message');
    const firstSystemPrompt = getSystemMessageText(firstSystemMessage as never);
    assert.ok(firstSystemPrompt.includes(`<cwd>\n${workspace}\n</cwd>`), 'the SDK provider input carries the bound cwd');
    assert.ok(firstSystemPrompt.includes('bound-project') && firstSystemPrompt.includes(basename(workspace)));
    assert.ok(firstSystemPrompt.includes('<workspace_project>'));
    assert.ok(firstSystemPrompt.includes(PROJECT_AGENTS_SENTINEL), 'bound project instructions reach the SDK provider input');
    assert.ok(firstSystemPrompt.includes(PROJECT_CLAUDE_SENTINEL));
    assert.ok(!firstSdkInput.includes(outside), 'a caller-supplied external cwd does not override project context');
    assert.ok(opening.modelInputs[2]?.includes(workspace), 'the context-tool result reaches the next SDK input');
    assert.ok(endById(opening, 'opening-ls').text.includes('README.md'));
    assert.ok(endById(opening, 'opening-read-agents').text.includes(PROJECT_AGENTS_SENTINEL));
    assert.ok(endById(opening, 'opening-read-claude').text.includes(PROJECT_CLAUDE_SENTINEL));
    assert.ok(endById(opening, 'opening-read-readme').text.includes(PROJECT_README_SENTINEL));
    assert.deepEqual(opening.toolEnds.map(item => item.toolName).filter(name => [...SHELL_TOOLS, 'chatroom_read'].includes(name)), [],
      'the module session keeps shell tools and unscoped chat reads out of the tool surface');

    const openingContext = contextData(endById(opening, 'opening-context'));
    assert.equal(openingContext.hostApplication, undefined, 'the context must not describe any host application');
    assert.equal(openingContext.workspace?.kind, 'bound-directory');
    assert.equal(openingContext.target?.kind, 'bound-project');
    assert.equal(openingContext.target?.name, basename(workspace));
    assert.equal(openingContext.target?.path, workspace);
    assert.equal(openingContext.target?.source, 'server-binding');
    assert.equal(openingContext.requirements?.total, 7);
    assert.equal(openingContext.requirements?.items?.length, 5, 'the initial context is capped at five requirement summaries');
    assert.equal(openingContext.requirements?.items?.[0]?.category, 'new', 'the context summary must expose the record category');
    assert.ok(!JSON.stringify(openingContext).includes(PRIVATE_SOURCE_SENTINEL));
    assert.ok(!JSON.stringify(openingContext).includes(PRIVATE_NOTE_SENTINEL));
    assert.ok(JSON.stringify(openingContext).includes(workspace));

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
    assert.equal(hugeData.record?.category, 'new', 'the single-record context must expose the category for change triage');
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
    const projectionReadmePath = join(workspace, 'requirements', 'README.md');
    const projectionReadmeBefore = await readFile(projectionReadmePath, 'utf8');

    const fileRun = await driveScriptedPrompt(hosted.session as never, '在绑定工作区内执行文件访问回归。', [
      tool('file-read-relative', 'read', { path: 'relative.txt' }),
      tool('file-read-absolute', 'read', { path: join(workspace, 'relative.txt') }),
      tool('file-write-inside', 'write', { path: 'written.txt', content: 'WORKSPACE_WRITE_OK' }),
      tool('file-edit-inside', 'edit', { path: 'relative.txt', edits: [{ oldText: 'BEFORE', newText: 'AFTER' }] }),
      tool('file-ls-capped', 'ls', { path: 'crowded', limit: 200 }),
      tool('file-read-projection', 'read', { path: 'requirements/README.md' }),
      tool('file-ls-projection', 'ls', { path: 'requirements' }),
      tool('file-write-projection', 'write', { path: 'requirements/README.md', content: 'MUST_NOT_REPLACE_PROJECTION' }),
      tool('file-edit-projection', 'edit', {
        path: 'requirements/README.md',
        edits: [{ oldText: projectionReadmeBefore, newText: `${projectionReadmeBefore}\nMUST_NOT_EDIT_PROJECTION` }],
      }),
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
      'file-read-projection', 'file-ls-projection',
    ]) assert.equal(endById(fileRun, id).isError, false, `${id} should stay inside the bound workspace`);
    assert.ok(endById(fileRun, 'file-read-relative').text.includes('WORKSPACE_RELATIVE_BEFORE'));
    assert.ok(endById(fileRun, 'file-read-absolute').text.includes('WORKSPACE_RELATIVE_BEFORE'));
    assert.equal(await readFile(join(workspace, 'written.txt'), 'utf8'), 'WORKSPACE_WRITE_OK');
    assert.equal(await readFile(join(workspace, 'relative.txt'), 'utf8'), 'WORKSPACE_RELATIVE_AFTER');
    const lsText = endById(fileRun, 'file-ls-capped').text;
    const listedEntries = lsText.split('\n').filter(line => /^entry-\d+\.txt$/.test(line));
    assert.equal(listedEntries.length, 200, 'ls must stop at the 200-entry cap independent of filesystem iteration order');
    assert.equal(new Set(listedEntries).size, 200);
    for (const id of ['file-write-projection', 'file-edit-projection']) {
      const denied = endById(fileRun, id);
      assert.equal(denied.isError, true, `${id} must not mutate the read-only requirements projection`);
      assert.ok(denied.text.includes('只读'));
    }
    assert.equal(await readFile(projectionReadmePath, 'utf8'), projectionReadmeBefore,
      'failed projection writes must leave the generated project file unchanged');

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
    for (const name of SHELL_TOOLS) assert.ok(!restoredNames.includes(name), `restore must not re-enable ${name}`);
    for (const name of SEARCH_TOOLS) assert.ok(restoredNames.includes(name), `restore must keep read-only search tool ${name}`);
    assert.ok(restoredNames.includes('requirements_context') && restoredNames.includes('read'));
    assert.ok(restored.session.systemPrompt.includes('<requirements_session_context>'));
    assert.ok(restored.session.systemPrompt.includes('bound-project'));
    assert.ok(restored.session.systemPrompt.includes(workspace));
    assert.ok(!restored.session.systemPrompt.includes('服务端没有预选目标'));
    await host.kill(restored.id);

    console.log('PASS requirements Agent: scripted SDK context input, bound-project files and cwd, bounded requirements_context, ask_user no-channel degrade contract, scoped chat history, read-only grep/find kept with shell tools removed, guarded writes, read-only projection, restore/reset boundaries (no model-behavior claim)');
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
