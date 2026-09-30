/**
 * 模块 Agent 装配路径门禁（A01/A02/A09 的服务端部分）：真实 pi SDK、无模型调用。
 *
 * 与 check-subagent-sdk 同款环境：临时 agent dir、无凭据的 ModelRuntime、
 * inMemory settings、临时 sessionDir。真实会话才能证明的事：收口加载器只给
 * 模块提示词与显式 Skill、工具白名单不含内置工具、身份条目落进会话日志、
 * set_tools/fork/reset/普通恢复路径全部收口、普通会话回归不受影响。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

import { PiHost, HostError } from '../server/pi/host';
import { MAIN_IDENTITY_PROMPT } from '../server/prompts/loader';
import { WorkbenchStore } from '../server/workbench/store';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { LOGS_TOOL_NAMES } from '../server/module-agents/logs/tools';
import { loadAgentProfiles, defaultAgentsConfigRoot } from '../server/module-agents/profiles';
import { profileRevision } from '../server/module-agents/snapshots';
import type { ResolvedAgentProfile } from '../server/module-agents/contracts';
import type { PiCommandEnvelope } from '../src/shared/protocol';

const root = await mkdtemp(join(tmpdir(), 'module-agent-sessions-'));
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const cwd = join(root, 'work');

const SENTINEL = 'LOGS-AGENT-SENTINEL-7e2d';
const GENERAL_TOOL_NAMES = ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'];
const MODULE_TOOL_NAMES = [
  'chatroom_read', 'chatroom_send',...Object.values(LOGS_TOOL_NAMES), 'skills_read', ...GENERAL_TOOL_NAMES].sort();

const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
const realLogs = profiles.get('logs');
assert.ok(realLogs?.ok === true, '仓库内 logs.yaml 必须可加载');
if (!realLogs.ok) throw new Error('unreachable');
const profile: ResolvedAgentProfile = {
  ...realLogs.profile,
  promptText: `${realLogs.profile.promptText}\n${SENTINEL}`,
};

/**
 * 无凭据环境下的伪模型回合：脚本轮发一条纯文本 assistant 消息。
 *
 * SessionManager 的落盘门是「首个 assistant 消息」——没有回合的会话不产生
 * 文件，身份条目跟会话日志一起等这一刻。恢复/fork 断言需要文件，所以先跑
 * 一个脚本轮把它刷出来（与 check-subagent-sdk 同一手法，不触网）。
 */
async function driveScriptedTurn(session: { agent: any }): Promise<void> {
  const agent = session.agent;
  const model = agent.state.model;
  const savedStream = agent.streamFunction;
  const savedApiKey = agent.getApiKey;
  agent.streamFunction = (() => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'scripted' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  }) as typeof agent.streamFunction;
  agent.getApiKey = () => 'scripted-stream-no-provider';
  try {
    await agent.prompt('ping');
  } finally {
    agent.streamFunction = savedStream;
    agent.getApiKey = savedApiKey;
  }
}

async function main(): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'SYSTEM.md'), 'GLOBAL-PROMPT-MUST-NOT-LEAK');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const boundCwd = await realpath(cwd);
  profile.config.workspace = boundCwd;
  profile.effectiveWorkspace = boundCwd;
  profile.profileRevision = profileRevision(profile);

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const probeModel = runtime.getModels('deepseek')[0];
  assert.ok(probeModel !== undefined, '内置目录应提供模型对象');

  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
  const host = new PiHost({
    definitions: {
      read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }),
    },
    modelRuntimeFactory: async () => runtime,
    sessionDir,
    settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
  });

  try {
    const moduleOption = await assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'logs', profile });

    /* (a) 工具面恰为 配置允许的模块工具，无内置工具、无 subagent/render_ui */
    const hosted = await host.create({ cwd: join(root, 'ignored-cwd'), provider: probeModel.provider, model: probeModel.id, moduleAgent: moduleOption });
    assert.equal(hosted.cwd, boundCwd);
    assert.equal(hosted.session.sessionManager.getCwd(), boundCwd);
    const reboundDir = join(root, 'rebound');
    await mkdir(reboundDir);
    const canonicalRebound = await realpath(reboundDir);
    const reboundProfile = structuredClone(profile);
    reboundProfile.config.workspace = canonicalRebound;
    reboundProfile.effectiveWorkspace = canonicalRebound;
    reboundProfile.profileRevision = profileRevision(reboundProfile);
    const reboundOption = await assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'logs', profile: reboundProfile });
    const reboundHosted = await host.create({ provider: probeModel.provider, model: probeModel.id, moduleAgent: reboundOption });
    assert.equal(reboundHosted.cwd, canonicalRebound, 'new session uses latest binding');
    assert.equal(hosted.cwd, boundCwd, 'existing session retains original binding');
    await host.kill(reboundHosted.id);

    const codesResult = profiles.get('codes');
    assert.ok(codesResult?.ok);
    const codesDir = join(root, 'codes-work');
    await mkdir(codesDir);
    const canonicalCodes = await realpath(codesDir);
    const codesProfile = structuredClone(codesResult.profile);
    codesProfile.config.workspace = canonicalCodes;
    codesProfile.effectiveWorkspace = canonicalCodes;
    codesProfile.profileRevision = profileRevision(codesProfile);
    const codesOption = await assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'codes', profile: codesProfile });
    await assert.rejects(host.create({ cwd: boundCwd, provider: probeModel.provider, model: probeModel.id, moduleAgent: codesOption }),
      (error) => error instanceof HostError && error.status === 409, 'codes cannot override bound cwd');
    const codesHosted = await host.create({ provider: probeModel.provider, model: probeModel.id, moduleAgent: codesOption });
    assert.equal(codesHosted.cwd, canonicalCodes);
    assert.equal(codesHosted.session.sessionManager.getCwd(), canonicalCodes);
    await host.kill(codesHosted.id);
    const allNames = hosted.session.getAllTools().map((tool) => tool.name).sort();
    assert.deepEqual(allNames, MODULE_TOOL_NAMES, '模块会话的工具目录必须恰为 配置允许的领域工具');
    assert.deepEqual(hosted.session.getActiveToolNames().sort(), MODULE_TOOL_NAMES, '全部模块工具应处于激活态');
    assert.equal(hosted.moduleAgent?.agentId, 'logs');
    assert.equal(hosted.moduleAgent?.sessionId, hosted.id);

    /* (a2) 配置 tools 是真实白名单：删掉 knowledge.create/update 就真没有 */
    const trimmedProfile: ResolvedAgentProfile = {
      ...profile,
      config: {
        ...profile.config,
        tools: profile.config.tools.filter((name) => !['knowledge.create', 'knowledge.update', 'chatroom.send', 'chatroom.read'].includes(name)),
      },
    };
    const trimmed = await host.create({
      cwd, provider: probeModel.provider, model: probeModel.id,
      moduleAgent: await assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'logs', profile: trimmedProfile }),
    });
    assert.deepEqual(
      trimmed.session.getAllTools().map((tool) => tool.name).sort(),
      [...['issues_read', 'issues_search', 'knowledge_read', 'knowledge_search', 'logs_read', 'logs_search', 'skills_read'], ...GENERAL_TOOL_NAMES].sort(),
      '配置删掉的名字不得出现在会话工具里',
    );
    assert.equal(trimmed.session.getToolDefinition('knowledge_create'), undefined);
    assert.equal(trimmed.session.getToolDefinition('chatroom_send'), undefined, '关闭群聊写能力后不得继续发群消息');
    assert.equal(trimmed.session.getToolDefinition('chatroom_read'), undefined);
    await host.kill(trimmed.id);
    // 未知工具名报装配错误，不默默放行。
    await assert.rejects(
      assembleModuleAgent({
        store, workspaceKey: 'ws', agentId: 'logs',
        profile: { ...profile, config: { ...profile.config, tools: ['logs.bogus'] } },
      }),
      (error) => error instanceof HostError && error.status === 503,
      '未知工具名必须装配失败',
    );

    /* (b) Skills 只含 log-analysis */
    assert.ok(hosted.session.systemPrompt.includes('log-analysis'), '模型必须能发现 Skill');
    const skill = hosted.session.getToolDefinition('skills_read')!;
    const content = await skill.execute('probe', { name: 'log-analysis' }, undefined, undefined, {} as never);
    assert.ok(JSON.stringify(content).includes('先收窄范围'), '模型可通过受限工具读取 Skill 正文');
    const refusedSkill = await skill.execute('probe', { name: 'log-analysis', resource: '../../SYSTEM.md' }, undefined, undefined, {} as never);
    assert.equal((refusedSkill.details as any).found, false);
    assert.ok(!hosted.session.systemPrompt.includes('GLOBAL-PROMPT-MUST-NOT-LEAK'));

    /* (c) 系统提示词是 profile 正文，不含主会话身份段 */
    assert.ok(hosted.session.systemPrompt.includes(SENTINEL), '系统提示词应含模块提示词');
    assert.ok(
      !hosted.session.systemPrompt.includes(MAIN_IDENTITY_PROMPT.trim().split('\n')[0]!),
      '模块会话不得含 MAIN_IDENTITY 段',
    );

    /* (d) 身份条目在会话日志里；首个 assistant 回合后落盘到文件 */
    const inLog = hosted.session.sessionManager.getEntries()
      .some((entry) => (entry as { customType?: string }).customType === 'pi-webx:module-agent');
    assert.ok(inLog, '会话日志应含模块身份条目');
    await driveScriptedTurn(hosted.session as never);
    assert.ok(hosted.sessionFile !== null);
    const logText = await readFile(hosted.sessionFile!, 'utf8');
    assert.ok(logText.includes('"pi-webx:module-agent"'), '会话日志应含模块身份条目');
    assert.ok(logText.includes(profile.profileRevision), '条目应带 profileRevision');

    /* (e) set_tools 被拒且工具面不变 */
    const refused = await host.command(hosted.id, {
      type: 'set_tools', toolNames: ['read'], id: 'req-set-tools',
    } as unknown as PiCommandEnvelope);
    assert.equal(refused.success, false, 'set_tools 必须拒绝模块会话');
    assert.match(refused.error ?? '', /配置决定/);
    assert.deepEqual(hosted.session.getActiveToolNames().sort(), MODULE_TOOL_NAMES, '被拒后工具面不变');

    /* (f) 恢复路径身份核对 */
    const sessionFile = hosted.sessionFile!;
    await host.kill(hosted.id);
    await assert.rejects(
      host.create({ cwd, sessionPath: sessionFile }),
      (error) => error instanceof HostError && error.status === 409,
      '普通入口恢复模块会话必须 409',
    );
    await assert.rejects(
      host.create({
        cwd, sessionPath: sessionFile,
        moduleAgent: { ...moduleOption, scope: { ...moduleOption.scope, agentId: 'codes' } },
      }),
      (error) => error instanceof HostError && error.status === 409,
      'agentId 不符必须 409',
    );
    const restored = await host.create({ cwd, sessionPath: sessionFile, moduleAgent: moduleOption });
    assert.equal(restored.moduleAgent?.agentId, 'logs', '正确恢复应还原 moduleAgent');
    assert.equal(restored.moduleAgent?.profileRevision, profile.profileRevision);
    assert.deepEqual(restored.session.getAllTools().map((tool) => tool.name).sort(), MODULE_TOOL_NAMES, '恢复后工具面不变');
    await host.kill(restored.id);

    /* (g) fork 模块会话被拒 */
    await assert.rejects(
      host.fork({ source: sessionFile, cwd }),
      (error) => error instanceof HostError && error.status === 400,
      '模块会话 fork 必须 400',
    );

    /* (h) 普通会话回归：默认工具集仍在，且无模块工具 */
    const normal = await host.create({ cwd, provider: probeModel.provider, model: probeModel.id });
    const normalNames = normal.session.getAllTools().map((tool) => tool.name);
    assert.ok(normalNames.includes('read') && normalNames.includes('bash'), '普通会话应有内置工具');
    assert.ok(!normalNames.some((name) => name === 'logs_search'), '普通会话不得有模块工具');
    assert.equal(normal.moduleAgent, undefined);
    await host.kill(normal.id);

    console.log('PASS 模块 Agent 装配：工具面恰为领域工具、Skill/提示词收口、身份条目落日志、set_tools/fork/越界恢复全拒、普通会话回归');
  } finally {
    store.close();
    await host.disposeAll();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
}

try {
  await main();
} finally {
  await rm(root, { recursive: true, force: true });
}
