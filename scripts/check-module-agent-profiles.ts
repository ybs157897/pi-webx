/**
 * 模块 Agent 配置加载器门禁（A15）：统一 YAML 目录、逐文件隔离、版本稳定。
 *
 * 钉死的行为：文件名必须等于注册 id；重复键、未知字段、id 不一致、未知文件名
 * 各自落到该文件的报错上；一个文件语法错误不影响其他 Agent；profileRevision 对
 * 相同内容稳定、对一字节改动敏感；进程 chdir 不改变结果（根目录与相对路径都
 * 由 rootDir 固定）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgentProfiles, defaultAgentsConfigRoot } from '../server/module-agents/profiles';
import { AGENT_IDS } from '../server/module-agents/contracts';

const root = await mkdtemp(join(tmpdir(), 'module-agent-profiles-'));

function yaml(id: string, extra = ''): string {
  return [
    'schemaVersion: 1',
    `id: ${id}`,
    'enabled: true',
    `promptFile: ./prompts/${id}.md`,
    'skills: []',
    'tools: []',
    'mcp: []',
    'knowledge:',
    `  homeBinding: ${id}`,
    '  sharedReadBindings: []',
    'limits:',
    '  maxRunningSessions: 1',
    '  maxToolOutputChars: 24000',
    extra,
  ].join('\n');
}

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(root, 'cfg-'));
  await mkdir(join(dir, 'prompts'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  for (const id of AGENT_IDS) {
    await writeFile(join(dir, 'prompts', `${id}.md`), `PROMPT-${id}`, 'utf8');
  }
  return dir;
}

function errors(results: Map<string, { ok: boolean }>): string[] {
  return [...results.entries()].filter(([, r]) => !r.ok).map(([key]) => key);
}

try {
  /* 每个已注册 Agent 的合法配置全部加载成功，逐文件隔离 */
  const good = await fixture({
    'requirements.yaml': yaml('requirements'),
    'codes.yaml': yaml('codes'),
    'logs.yaml': yaml('logs'),
    'assistant.yaml': yaml('assistant'),
  });
  const first = await loadAgentProfiles(good);
  assert.deepEqual(errors(first), [], '所有合法 YAML 都应加载成功');
  for (const id of AGENT_IDS) {
    const result = first.get(id);
    assert.ok(result?.ok === true, `${id} 应加载成功`);
    if (result.ok) {
      assert.equal(result.profile.config.id, id);
      assert.equal(result.profile.promptText, `PROMPT-${id}`);
      assert.match(result.profile.profileRevision, /^[0-9a-f]{64}$/);
    }
  }

  /* profileRevision 稳定：同内容两次一致，改一字节变化 */
  const second = await loadAgentProfiles(good);
  for (const id of AGENT_IDS) {
    const a = first.get(id);
    const b = second.get(id);
    assert.ok(a?.ok === true && b?.ok === true);
    if (a.ok && b.ok) assert.equal(a.profile.profileRevision, b.profile.profileRevision, `${id} 同内容两次加载版本应一致`);
  }
  await writeFile(join(good, 'logs.yaml'), yaml('logs').replace('24000', '24001'), 'utf8');
  const third = await loadAgentProfiles(good);
  const before = first.get('logs');
  const after = third.get('logs');
  assert.ok(before?.ok === true && after?.ok === true);
  if (before.ok && after.ok) assert.notEqual(before.profile.profileRevision, after.profile.profileRevision, '内容变化必须改变版本');

  /* 重复键报错且带文件名 */
  const dup = await fixture({
    'requirements.yaml': yaml('requirements'),
    'codes.yaml': yaml('codes'),
    'logs.yaml': `${yaml('logs')}\nid: logs\n`,
  });
  const dupResults = await loadAgentProfiles(dup);
  const dupLogs = dupResults.get('logs');
  assert.ok(dupLogs && !dupLogs.ok, '重复键应报错');
  if (!dupLogs!.ok) {
    assert.ok(dupLogs!.file.endsWith('logs.yaml'), '报错应带文件名');
    assert.match(dupLogs!.error, /unique|唯一|重复/i);
  }
  assert.ok(dupResults.get('codes')?.ok === true, '其他文件不受影响');

  /* 未知字段报错并指出字段名 */
  const unknownField = await fixture({
    'requirements.yaml': yaml('requirements'),
    'codes.yaml': yaml('codes'),
    'logs.yaml': yaml('logs', 'surpriseField: 1'),
  });
  const uf = (await loadAgentProfiles(unknownField)).get('logs');
  assert.ok(uf && !uf.ok, '未知字段应报错');
  if (!uf!.ok) assert.ok(uf!.error.includes('surpriseField'), '报错应指出字段名');

  /* 未知文件名报错，不影响合法文件 */
  const unknownName = await fixture({
    'requirements.yaml': yaml('requirements'),
    'foo.yaml': yaml('logs'),
  });
  const un = await loadAgentProfiles(unknownName);
  const foo = un.get('foo' as never);
  assert.ok(foo !== undefined && !foo.ok, 'foo.yaml 应报错');
  if (!foo.ok) assert.equal(foo.agentId, null);
  assert.ok(un.get('requirements')?.ok === true, '合法文件不受未知文件影响');

  /* 文件名与内容 id 不一致报错 */
  const mismatched = await fixture({
    'logs.yaml': yaml('codes'),
  });
  const mm = (await loadAgentProfiles(mismatched)).get('logs');
  assert.ok(mm && !mm.ok, 'id 与文件名不一致应报错');
  if (!mm!.ok) assert.match(mm!.error, /不一致/);

  /* 单文件语法错误：其他两个仍 ok，错误带定位 */
  const broken = await fixture({
    'requirements.yaml': yaml('requirements'),
    'codes.yaml': 'id: [codes\n  broken: {',
    'logs.yaml': yaml('logs'),
  });
  const brokenResults = await loadAgentProfiles(broken);
  assert.ok(brokenResults.get('requirements')?.ok === true, '语法错误不能拖垮 requirements');
  assert.ok(brokenResults.get('logs')?.ok === true, '语法错误不能拖垮 logs');
  const codes = brokenResults.get('codes');
  assert.ok(codes && !codes.ok, '语法错误文件应报错');
  if (!codes!.ok) assert.match(codes!.error, /第 \d+ 行/, 'YAML 语法错误应带行列定位');

  /* 缺失 promptFile 报错 */
  const missingPrompt = await fixture({ 'logs.yaml': yaml('logs') });
  await rm(join(missingPrompt, 'prompts', 'logs.md'));
  const mp = (await loadAgentProfiles(missingPrompt)).get('logs');
  assert.ok(mp && !mp.ok, '缺失 promptFile 应报错');

  /* 进程 cwd 漂移不改变结果：根目录与相对资源由 rootDir 固定 */
  const isolated = await fixture({
    'requirements.yaml': yaml('requirements'),
    'logs.yaml': yaml('logs'),
  });
  const beforeChdir = await loadAgentProfiles(isolated);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const afterChdir = await loadAgentProfiles(isolated);
    const r0 = beforeChdir.get('logs');
    const r1 = afterChdir.get('logs');
    assert.ok(r0?.ok === true && r1?.ok === true);
    if (r0.ok && r1.ok) assert.equal(r0.profile.profileRevision, r1.profile.profileRevision, 'chdir 后版本不变');
  } finally {
    process.chdir(previous);
  }

  /* 仓库内真实配置：config/agents 四份文件可加载 */
  const real = await loadAgentProfiles(defaultAgentsConfigRoot());
  for (const id of AGENT_IDS) assert.equal(real.get(id)?.ok, true, `config/agents/${id}.yaml 应可加载`);
  const realAssistant = real.get('assistant');
  assert.ok(realAssistant?.ok === true, 'config/agents/assistant.yaml 应可加载');
  if (realAssistant!.ok) {
    assert.equal(realAssistant!.profile.config.knowledge.homeBinding, 'assistant');
    assert.equal(realAssistant!.profile.config.model, undefined, '我的助理沿用用户默认模型');
    assert.ok(realAssistant!.profile.promptText.includes('我的助理'));
  }
  const realLogs = real.get('logs');
  assert.ok(realLogs?.ok === true, 'config/agents/logs.yaml 应可加载');
  if (realLogs!.ok) {
    assert.equal(realLogs!.profile.skillPaths.length, 1);
    assert.ok(realLogs!.profile.promptText.includes('日志查询 Agent'));
  }

  console.log('PASS 模块 Agent 配置：统一 YAML 目录、逐文件隔离、版本稳定、错误带文件与定位，cwd 漂移不改变结果');
} finally {
  await rm(root, { recursive: true, force: true });
}
