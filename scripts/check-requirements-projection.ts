/**
 * Requirements projection regression: workspace read-only markdown rendering,
 * idempotent mutation-cursor reconciliation, revision/deletion snapshots,
 * file-tool write protection and the codes Agent's read-only context tool.
 *
 * Uses a temporary WorkbenchStore, a temporary workspace and a temporary clone
 * of `config/agents` (codes.yaml keeps its checked-in tool list; only the
 * workspace is repointed at a temp directory, so the check does not depend on
 * local paths). All assertions are scripted; no model runs.
 */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { parse, stringify } from 'yaml';

import { WorkbenchStore } from '../server/workbench/store';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { resolveToolNames } from '../server/module-agents/registry';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createRequirementsDispatchTool } from '../server/modules/requirements/dispatch';
import { createRequirementsFileTools } from '../server/modules/requirements/files';
import { saveRequirementDraft } from '../server/modules/requirements/import-tasks';
import { createRequirementProjection } from '../server/modules/requirements/projection';
import { createRequirementsTools } from '../server/modules/requirements/tools';

const root = await mkdtemp(join(tmpdir(), 'pi-webx-requirements-projection-'));
const workspace = join(root, 'workspace');
const codesWorkspace = join(root, 'codes-project');
const configRoot = join(root, 'config', 'agents');

/** 投影文档不得让阅读者感知宿主应用；这些词只允许留在宿主自己的界面文案里。 */
const HOST_TERMS = ['指挥台', '工作台', '宿主', 'pi-webx', '模块 Agent'];

function toolNamed(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(item => item.name === name);
  assert.ok(tool, `工具 ${name} 必须存在`);
  return tool;
}

function assertNoHostTerms(label: string, text: string): void {
  for (const term of HOST_TERMS) assert.ok(!text.includes(term), `${label} 不得出现宿主术语「${term}」`);
}

/** fire-and-forget 的投影刷新没有可等待的句柄，只能限时轮询文件落地。 */
async function waitForContent(file: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw lastError instanceof Error ? lastError : new Error(`文件未在 ${timeoutMs}ms 内生成：${file}`);
}

const savedConfigDir = process.env.PI_WEBX_AGENT_CONFIG_DIR;
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));

try {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(codesWorkspace, { recursive: true })]);
  await cp(defaultAgentsConfigRoot(), configRoot, { recursive: true, force: true });
  const codesConfigPath = join(configRoot, 'codes.yaml');
  const codesConfig = parse(await readFile(codesConfigPath, 'utf8')) as Record<string, unknown>;
  codesConfig.workspace = await realpath(codesWorkspace);
  await writeFile(codesConfigPath, stringify(codesConfig), 'utf8');
  process.env.PI_WEBX_AGENT_CONFIG_DIR = configRoot;

  const projectionDir = join(workspace, 'requirements');
  const projection = createRequirementProjection(store, workspace);
  const requirementFile = join(projectionDir, 'REQ-000001', 'requirement.md');
  const changesFile = join(projectionDir, 'REQ-000001', 'changes.md');
  const cursorValue = (): string | undefined => (store.sqlite.prepare(
    `SELECT value FROM requirement_projection_meta WHERE key='mutation_cursor'`).get() as { value: string } | undefined)?.value;

  /* ---- 渲染正确性：README、需求快照与变更时间线 ---- */
  const draft = saveRequirementDraft(store, 'projection-check-session', {
    title: '投影渲染回归需求',
    note: '验收：快照必须与需求库一致。',
    priority: 'high',
    taskDrafts: [{ title: '投影渲染待办', priority: 'high', due: '2026-12-31', tag: '投影回归' }],
  });
  await projection.sync();

  const readme = await readFile(join(projectionDir, 'README.md'), 'utf8');
  assert.ok(readme.includes('# 需求库只读投影'), 'README.md 必须声明只读投影');
  assert.ok(readme.includes('REQ-XXXXXX/requirement.md') && readme.includes('REQ-XXXXXX/changes.md'));
  assert.ok(readme.includes('请勿手工修改本目录内的任何文件'));
  assert.ok(readme.includes('需求记录被删除后目录仍然保留'));
  assertNoHostTerms('requirements/README.md', readme);

  const requirementMd = await readFile(requirementFile, 'utf8');
  for (const expected of [
    `- 需求 ID：${draft.id}`,
    '- 展示编号：REQ-000001',
    '# 投影渲染回归需求',
    '- 状态：todo',
    '- 优先级：high',
    '- 当前版本：v1',
    `- 更新时间：${String(draft.updatedAt)}`,
    '验收：快照必须与需求库一致。',
    '- 1. 投影渲染待办 · 优先级：high · 截止：2026-12-31 · 标签：投影回归',
  ]) assert.ok(requirementMd.includes(expected), `requirement.md 必须包含「${expected}」`);
  assert.ok(requirementMd.includes('> 只读投影：由需求库自动生成，请勿手改'));
  assertNoHostTerms('REQ-000001/requirement.md', requirementMd);

  const createdEvent = store.sqlite.prepare(`SELECT occurred_at FROM workbench_mutations
    WHERE module='requirements' AND record_id=? AND operation='insert' ORDER BY seq LIMIT 1`)
    .get(draft.id) as { occurred_at: string } | undefined;
  assert.ok(createdEvent?.occurred_at, '创建需求必须留下 mutation 时间');
  const changesMd = await readFile(changesFile, 'utf8');
  assert.ok(changesMd.includes(`- v1 · ${createdEvent.occurred_at} · requirement.created · 保存需求草稿：投影渲染回归需求`),
    'changes.md 必须包含创建事件与时间');
  assert.ok(changesMd.includes(`- 当前版本：v1 · 更新时间：${String(draft.updatedAt)}`));
  assertNoHostTerms('REQ-000001/changes.md', changesMd);

  /* ---- 幂等：重复 sync 文件内容与游标都不变 ---- */
  const firstSync = { readme, requirement: requirementMd, changes: changesMd, cursor: cursorValue() };
  assert.ok(firstSync.cursor !== undefined && Number(firstSync.cursor) > 0, '首次 sync 必须推进投影游标');
  await projection.sync();
  assert.deepEqual({
    readme: await readFile(join(projectionDir, 'README.md'), 'utf8'),
    requirement: await readFile(requirementFile, 'utf8'),
    changes: await readFile(changesFile, 'utf8'),
    cursor: cursorValue(),
  }, firstSync, '重复 sync 必须幂等：文件内容与游标都不变');

  /* ---- 修订：版本递增、内容刷新、时间线追加 ---- */
  store.updateRecord('requirements', draft.id, { title: '投影渲染回归需求（修订）', note: '修订后的验收备注。' });
  await projection.sync();
  const revisedMd = await readFile(requirementFile, 'utf8');
  assert.ok(revisedMd.includes('- 当前版本：v2'), '内容修订必须递增版本');
  assert.ok(revisedMd.includes('# 投影渲染回归需求（修订）'));
  assert.ok(revisedMd.includes('修订后的验收备注。'));
  assert.ok(!revisedMd.includes('验收：快照必须与需求库一致。'), '修订后必须刷新为最新内容');
  assert.ok(revisedMd.includes('- 1. 投影渲染待办 · 优先级：high · 截止：2026-12-31 · 标签：投影回归'),
    '未修订的待办草稿必须保留');
  const revisedChanges = await readFile(changesFile, 'utf8');
  assert.ok(revisedChanges.includes('· requirement.updated · 需求内容已修订：投影渲染回归需求（修订）'),
    'changes.md 必须追加修订事件');
  assert.ok(revisedChanges.includes(`- v1 · ${createdEvent.occurred_at} · requirement.created`), '时间线必须保留创建事件');
  assertNoHostTerms('修订后的 changes.md', revisedChanges);

  /* ---- 删除：目录保留并标记 deleted ---- */
  assert.equal(store.removeRecord('requirements', draft.id), true);
  await projection.sync();
  assert.equal((await stat(join(projectionDir, 'REQ-000001'))).isDirectory(), true, '删除后需求目录必须保留');
  const deletedMd = await readFile(requirementFile, 'utf8');
  assert.ok(deletedMd.includes('- 状态：deleted') && !deletedMd.includes('- 状态：todo'));
  assert.ok(deletedMd.includes('- 当前版本：v3'));
  assert.ok(deletedMd.includes('> 记录已删除，追踪审计保留。'));
  const deletedChanges = await readFile(changesFile, 'utf8');
  assert.ok(deletedChanges.includes('· requirement.deleted · 需求记录已删除，追踪保留：'));
  assertNoHostTerms('删除后的 changes.md', deletedChanges);

  /* ---- 游标对账：非 requirements 变更也要推进游标，但不渲染需求 ---- */
  const cursorBeforeTask = Number(cursorValue());
  store.addRecord('tasks', { title: '投影游标推进检查' });
  await projection.sync();
  assert.ok(Number(cursorValue()) > cursorBeforeTask, '非 requirements 变更也要推进投影游标');
  assert.equal(await readFile(requirementFile, 'utf8'), deletedMd, '非需求变更不得改写需求快照');

  /* ---- 工具触发：saveDraft 成功后 fire-and-forget 刷新投影 ---- */
  const triggerWorkspace = join(root, 'trigger-workspace');
  await mkdir(triggerWorkspace, { recursive: true });
  const triggerProjection = createRequirementProjection(store, triggerWorkspace);
  const requirementTools = createRequirementsTools({ store, limits: { maxToolOutputChars: 24000 }, projection: triggerProjection, workspaceDir: triggerWorkspace });
  const saveDraftTool = toolNamed(requirementTools, 'requirements_save_draft');
  const saveDraftResult = await saveDraftTool.execute('projection-trigger-call', {
    entryKey: 'projection-trigger-save', title: '工具触发投影刷新',
    note: '工具保存成功后刷新投影。', taskDrafts: [{ title: '触发待办' }],
  }, undefined, undefined, { sessionManager: { getSessionId: () => 'projection-trigger-session' } } as never);
  const savedDraftId = (saveDraftResult.details as { data?: { requirementId?: string } } | undefined)?.data?.requirementId;
  assert.ok(savedDraftId, 'saveDraft 必须返回需求 ID');
  // 展示编号取 roots.seq：修订/删除会消耗 AUTOINCREMENT，编号不一定连号。
  const savedSeq = (store.sqlite.prepare('SELECT seq FROM requirement_lifecycle_roots WHERE requirement_id=?')
    .get(savedDraftId) as { seq: number } | undefined)?.seq;
  assert.ok(Number.isSafeInteger(savedSeq), '触发保存的需求必须进入生命周期追踪');
  const triggeredMd = await waitForContent(join(triggerWorkspace, 'requirements',
    `REQ-${String(savedSeq).padStart(6, '0')}`, 'requirement.md'));
  assert.ok(triggeredMd.includes(`- 需求 ID：${savedDraftId}`) && triggeredMd.includes('工具触发投影刷新'),
    'saveDraft 成功后投影必须自动刷新');
  const triggerReadme = await readFile(join(triggerWorkspace, 'requirements', 'README.md'), 'utf8');
  assert.ok(triggerReadme.includes('# 需求库只读投影'), '触发刷新必须同时写出 README');
  assertNoHostTerms('触发刷新后的 requirement.md', triggeredMd);

  /* ---- 写保护：requirements/ 只读，工作区其他路径不受影响 ---- */
  const fileTools = createRequirementsFileTools(workspace);
  const readTool = toolNamed(fileTools, 'read');
  const writeTool = toolNamed(fileTools, 'write');
  const editTool = toolNamed(fileTools, 'edit');
  const lsTool = toolNamed(fileTools, 'ls');

  const readBack = await readTool.execute('projection-read', { path: 'requirements/README.md' }, undefined, undefined, {} as never);
  assert.ok(JSON.stringify(readBack).includes('# 需求库只读投影'), 'read 必须放行投影目录');

  const baselineReadme = await readFile(join(projectionDir, 'README.md'), 'utf8');
  for (const path of [
    'requirements/README.md',
    'requirements/REQ-000001/requirement.md',
    'requirements/REQ-000002/requirement.md',
  ]) {
    await assert.rejects(
      async () => writeTool.execute('projection-write', { path, content: '写入必须被拒绝' }, undefined, undefined, {} as never),
      /只读/, `${path} 的写入（含 mkdir 路径）必须被拒绝且错误含「只读」`);
  }
  await assert.rejects(
    async () => editTool.execute('projection-edit', {
      path: 'requirements/README.md', edits: [{ oldText: '# 需求库只读投影', newText: '# 被改写' }],
    }, undefined, undefined, {} as never),
    /只读/, 'edit 必须拒绝投影目录');
  assert.equal(await readFile(join(projectionDir, 'README.md'), 'utf8'), baselineReadme, '被拒绝的写入不得改动投影文件');

  await writeTool.execute('projection-write-notes', { path: 'notes.txt', content: 'NON_PROJECTION_OK' }, undefined, undefined, {} as never);
  assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'NON_PROJECTION_OK', '工作区普通文件写入不受影响');
  await writeTool.execute('projection-write-sibling', { path: 'requirements-notes/x.md', content: 'SIBLING_OK' }, undefined, undefined, {} as never);
  assert.equal(await readFile(join(workspace, 'requirements-notes', 'x.md'), 'utf8'), 'SIBLING_OK', '同名前缀的非投影目录写入不受影响');

  const lsText = JSON.stringify(await lsTool.execute('projection-ls', { path: 'requirements' }, undefined, undefined, {} as never));
  assert.ok(lsText.includes('README.md') && lsText.includes('REQ-000001'), 'ls 必须放行投影目录');

  /* ---- 文案红线：工具文案不得出现宿主术语 ---- */
  for (const tool of [saveDraftTool, toolNamed(requirementTools, 'requirements_context')]) {
    assertNoHostTerms(`${tool.name} 描述`, `${tool.description ?? ''}\n${tool.promptSnippet ?? ''}`);
  }
  const dispatchTool = createRequirementsDispatchTool(store, getChatroomService(store, 'projection-dispatch'), triggerProjection);
  assertNoHostTerms('requirements_dispatch 描述', `${dispatchTool.description ?? ''}\n${dispatchTool.promptSnippet ?? ''}`);

  /* ---- codes 装配：只读 requirements_context，无保存/派工 ---- */
  const profiles = await loadAgentProfiles(configRoot);
  const codesLoaded = profiles.get('codes');
  assert.ok(codesLoaded?.ok === true, '临时克隆的 codes.yaml 必须可加载');
  if (!codesLoaded.ok) throw new Error('unreachable');
  const codesProfile = codesLoaded.profile;
  assert.ok(codesProfile.config.tools.includes('requirements.context'), 'codes.yaml tools 必须声明 requirements.context');
  const codesToolNames = resolveToolNames('codes', codesProfile.config.tools);
  assert.ok(codesToolNames.includes('requirements_context'), 'codes 工具白名单必须解析出 requirements_context');
  assert.ok(!codesToolNames.includes('requirements_save_draft') && !codesToolNames.includes('requirements_dispatch'),
    'codes 工具白名单不得解析出保存/派工');

  const assembled = await assembleModuleAgent({ store, workspaceKey: 'projection-codes', agentId: 'codes', profile: codesProfile });
  try {
    const assembledNames = assembled.customTools.map(tool => tool.name);
    const codesContextTool = assembled.customTools.find(tool => tool.name === 'requirements_context');
    assert.ok(codesContextTool, 'codes 的真实装配必须注入 requirements_context');
    assert.ok(!assembledNames.includes('requirements_save_draft') && !assembledNames.includes('requirements_dispatch'),
      'codes 装配只得只读需求口');
    const codesContext = await codesContextTool.execute('codes-context', { query: '工具触发投影刷新' },
      undefined, undefined, {} as never);
    assert.ok(JSON.stringify(codesContext).includes('工具触发投影刷新'), 'codes 的只读口必须能读到需求记录');
  } finally {
    await assembled.dispose();
  }

  console.log('PASS requirements projection: README/需求快照/变更时间线渲染、幂等游标、修订与删除保留、投影写保护、saveDraft 触发刷新、codes 只读 requirements_context 装配');
} finally {
  try { store.close(); } catch { /* already closed */ }
  if (savedConfigDir === undefined) delete process.env.PI_WEBX_AGENT_CONFIG_DIR;
  else process.env.PI_WEBX_AGENT_CONFIG_DIR = savedConfigDir;
  // 投影 sync 是 fire-and-forget 的，最后一个写盘可能与清理并发；重试让 rm 赢过有限的写者。
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
