/**
 * 模块 Agent MCP 适配门禁（A03/A04 服务端）：真实 PiHost + 真实 MCP SDK +
 * stdio fixture 子进程。断言：同名工具不串连接、envRefs 注入不透传父进程环境、
 * 调用超时可恢复、required/degraded 语义、会话销毁回收子进程。
 *
 * fixture 是 `scripts/mcp-fixture-server.ts`，哨兵经 envRefs 注入。
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

import { PiHost, HostError } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { loadAgentProfiles } from '../server/module-agents/profiles';
import type { McpConnectionConfig, ResolvedAgentProfile } from '../server/module-agents/contracts';

const root = await mkdtemp(join(tmpdir(), 'module-agent-mcp-'));
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const cwd = join(root, 'work');
const configRoot = join(root, 'config');
const fixtureScript = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'));
const savedWorkspaceRoot = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(root, 'dedicated');

// 父进程环境哨兵：fixture 子进程不应看得到（env 不透传验证）。
process.env.FIX_A_SENTINEL = 'sentinel-A';
process.env.FIX_B_SENTINEL = 'sentinel-B';
process.env.FIX_B_TOKEN = 'token-B';
process.env.LEAK_ME = 'leak-should-not-arrive';

function fixtureConn(id: string, over: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  const sentinel = id === 'fixture-a' ? 'FIX_A_SENTINEL' : 'FIX_B_SENTINEL';
  return {
    id,
    enabled: true,
    required: true,
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', tsxLoader, fixtureScript],
      envRefs: {
        FIXTURE_SENTINEL: sentinel,
        // fixture-b 顺带验证 token 注入：REQUIRE 与 TOKEN 指向同一父变量。
        ...(id === 'fixture-b' ? { FIXTURE_REQUIRE_TOKEN: 'FIX_B_TOKEN', FIXTURE_TOKEN: 'FIX_B_TOKEN' } : {}),
      },
    },
    tools: id === 'fixture-a' ? ['search_logs', 'slow', 'env_probe'] : ['search_logs', 'get_log'],
    resources: false,
    timeoutMs: 4_000,
    ...over,
  };
}

function liveFixturePids(): number[] {
  try {
    return execSync('pgrep -f mcp-fixture-server', { encoding: 'utf8' })
      .split('\n').map((line) => Number(line.trim())).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await delay(150);
  }
  return false;
}

async function writeProfile(mcp: McpConnectionConfig[], useDefaultWorkspace = false): Promise<ResolvedAgentProfile> {
  await mkdir(join(configRoot, 'prompts'), { recursive: true });
  await writeFile(join(configRoot, 'prompts', 'logs.md'), '你是日志 Agent。\n');
  await writeFile(join(configRoot, 'logs.yaml'), [
    'schemaVersion: 1',
    'id: logs',
    'enabled: true',
    'promptFile: ./prompts/logs.md',
    ...(useDefaultWorkspace ? [] : [`workspace: ${JSON.stringify(await realpath(cwd))}`]),
    'skills: []',
    'tools:',
    '  - logs.search',
    '  - logs.read',
    `mcp: ${JSON.stringify(mcp, null, 0)}`,
    'knowledge: { homeBinding: logs, sharedReadBindings: [] }',
    'limits: { maxRunningSessions: 1, maxToolOutputChars: 24000 }',
    '',
  ].join('\n'));
  const profiles = await loadAgentProfiles(configRoot);
  const result = profiles.get('logs');
  assert.ok(result?.ok === true, 'fixture 配置必须可加载');
  if (!result.ok) throw new Error('unreachable');
  return result.profile;
}

const toolCtx = {} as never;

await mkdir(agentDir, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await mkdir(cwd, { recursive: true });
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));

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
const host = new PiHost({
  definitions: {
    read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }),
  },
  modelRuntimeFactory: async () => runtime,
  sessionDir,
  settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
});

try {
  const firstUse = await writeProfile([fixtureConn('fixture-a')], true);
  const firstAssembled = await assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'logs', profile: firstUse });
  assert.equal(firstAssembled.mcp.connected.length, 1, 'first default workspace is created before MCP launch');
  await firstAssembled.dispose();
  /* (5a) required 失败：已连子进程被 dispose，装配整体抛 503 */
  const baselinePids = liveFixturePids();
  const badProfile = await writeProfile([
    fixtureConn('fixture-a'),
    fixtureConn('fixture-b', {
      connection: { transport: 'stdio', command: '/nonexistent/pi-webx-mcp-bin' },
    }),
  ]);
  await assert.rejects(
    assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'logs', profile: badProfile }),
    (error) => error instanceof HostError && error.status === 503,
    'required 连接失败必须装配 503',
  );
  let cleaned = false;
  for (let i = 0; i < 20 && !cleaned; i++) {
    cleaned = liveFixturePids().length === baselinePids.length;
    if (!cleaned) await delay(150);
  }
  assert.ok(cleaned, 'required 失败后已连 fixture 子进程必须被 dispose');

  /* (5b) required:false 失败 → degraded 记录，其余工具照常 */
  const degradedProfile = await writeProfile([
    fixtureConn('fixture-a'),
    fixtureConn('fixture-b', {
      required: false,
      connection: { transport: 'stdio', command: '/nonexistent/pi-webx-mcp-bin' },
    }),
  ]);
  const degradedAssembled = await assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'logs', profile: degradedProfile });
  assert.equal(degradedAssembled.mcp.degraded.length, 1, '非必需失败应记 degraded');
  assert.equal(degradedAssembled.mcp.degraded[0]?.id, 'fixture-b');
  assert.ok(degradedAssembled.customTools.some((tool) => tool.name === 'mcp__logs__fixture-a__search_logs'));
  await degradedAssembled.dispose();

  /* (1)(2) 双连接装配：工具命名隔离、哨兵不串线、配置未列的工具不注册 */
  const profile = await writeProfile([
    fixtureConn('fixture-a'),
    fixtureConn('fixture-b'),
  ]);
  const assembled = await assembleModuleAgent({ store, workspaceKey: 'ws', agentId: 'logs', profile });
  const hosted = await host.create({
    cwd, provider: probeModel.provider, model: probeModel.id, moduleAgent: assembled,
  });
  const names = hosted.session.getAllTools().map((tool) => tool.name);
  assert.ok(names.includes('mcp__logs__fixture-a__search_logs'), 'fixture-a 的 search_logs 未装配');
  assert.ok(names.includes('mcp__logs__fixture-b__search_logs'), 'fixture-b 的 search_logs 未装配');
  assert.ok(!names.some((name) => name.includes('extra_tool')), '配置未列的服务端工具不得注册');

  const callResult = async (name: string, params: Record<string, unknown>) => {
    const tool = hosted.session.getToolDefinition(name);
    assert.ok(tool !== undefined, `工具 ${name} 未注册`);
    return tool.execute('call-1', params, undefined, undefined, toolCtx);
  };
  const callVia = async (name: string, params: Record<string, unknown>) => {
    const result = await callResult(name, params);
    return result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
  };

  const textA = await callVia('mcp__logs__fixture-a__search_logs', { q: 'alpha' });
  const textB = await callVia('mcp__logs__fixture-b__search_logs', { q: 'beta' });
  assert.ok(textA.includes('sentinel:sentinel-A:alpha'), `fixture-a 应回自己的哨兵，实际：${textA}`);
  assert.ok(textB.includes('sentinel:sentinel-B:beta'), `fixture-b 应回自己的哨兵，实际：${textB}`);

  /* (3) env 不透传：子进程看不到父进程故意设的 LEAK_ME */
  const probe = await callVia('mcp__logs__fixture-a__env_probe', { name: 'LEAK_ME' });
  assert.ok(probe.includes('env:LEAK_ME=absent'), `子进程不应继承父环境，实际：${probe}`);
  const probeSentinel = await callVia('mcp__logs__fixture-a__env_probe', { name: 'FIXTURE_SENTINEL' });
  assert.ok(probeSentinel.includes('env:FIXTURE_SENTINEL=present'), 'envRefs 注入的变量子进程应可见');

  /* (4) 调用超时：slow 超 timeoutMs 报错误文本，会话仍可调用其他工具 */
  const slowResult = await callResult('mcp__logs__fixture-a__slow', { ms: 30_000 });
  const slowText = slowResult.content.map(item => 'text' in item ? item.text : '').join('\n');
  assert.equal((slowResult.details as { isError: boolean }).isError, true, '超时必须携带失败标记供正文识别');
  const toolError = await callResult('mcp__logs__fixture-a__search_logs', { q: 'fixture-error' });
  assert.equal((toolError.details as { isError: boolean }).isError, true, 'MCP isError 不得丢失');
  const toolSuccess = await callResult('mcp__logs__fixture-a__search_logs', { q: 'ok' });
  assert.equal((toolSuccess.details as { isError: boolean }).isError, false);
  assert.ok(slowText.includes('失败') || slowText.includes('报错'), `超时应回错误文本，实际：${slowText}`);
  const after = await callVia('mcp__logs__fixture-a__search_logs', { q: 'after-timeout' });
  assert.ok(after.includes('sentinel:sentinel-A:after-timeout'), '超时后连接应仍可用');

  /* (6) 会话销毁：两个 fixture 子进程退出 */
  const pids = assembled.mcp.connected.map((conn) => conn.pid).filter((pid): pid is number => typeof pid === 'number');
  assert.equal(pids.length, 2, '应有两个 fixture 子进程');
  await host.kill(hosted.id);
  for (const pid of pids) {
    assert.ok(await waitForExit(pid, 3_000), `pid ${pid} 在会话销毁后应退出`);
  }

  console.log('PASS 模块 Agent MCP：双连接哨兵隔离、未列工具不注册、env 不透传、超时可恢复、required/degraded 语义、销毁回收子进程');
} finally {
  store.close();
  await host.disposeAll();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedWorkspaceRoot === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = savedWorkspaceRoot;
  await rm(root, { recursive: true, force: true });
}
