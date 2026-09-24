import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { createWorkbenchRouter } from '../server/workbench/router';
import { WorkbenchStore } from '../server/workbench/store';
import { api as uiApi } from '../src/workbench-app/api.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pi-webx-workbench-'));
const path = join(dir, 'workbench.sqlite');
let store = new WorkbenchStore(path);
let http: ReturnType<express.Express['listen']> | undefined;

try {
  assert.equal(store.read().tasks.length, 0);
  const task = store.addRecord('tasks', { title: '验证 SQLite 保存', due: '2026-09-23' });
  assert.equal(task.title, '验证 SQLite 保存');
  assert.equal(store.updateRecord('tasks', task.id, { done: true }).done, true);
  const exercise = store.addRecord('exercises', { type: '跑步', minutes: 30 });
  assert.equal(exercise.minutes, 30);
  const profile = store.putAtomProfile('pets', { name: '小猫' });
  assert.equal(profile.name, '小猫');
  const diary = store.addAtomRecord('pets', { title: '学会握手' });
  assert.equal(diary.title, '学会握手');
  assert.throws(() => store.addRecord('exercises', { type: '跑步', minutes: 2000 }), /上限/);
  store.close();

  store = new WorkbenchStore(path);
  assert.equal(store.read().tasks[0]?.done, true);
  assert.equal(store.read().pets.records[0]?.title, '学会握手');

  // 真实旧库启动迁移：旧 SQLite 只有 knowledge 记录，重开后生成默认库并补归属。
  const oldPath = join(dir, 'legacy-knowledge.sqlite');
  const oldDb = new Database(oldPath);
  oldDb.exec('CREATE TABLE workbench_records (seq INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(module, id))');
  oldDb.prepare('INSERT INTO workbench_records (module, id, payload) VALUES (?, ?, ?)').run('knowledge', 'legacy-doc-0001', JSON.stringify({ id: 'legacy-doc-0001', title: '原有笔记', body: '保留正文' }));
  oldDb.close();
  const migratedStore = new WorkbenchStore(oldPath);
  assert.equal(migratedStore.read().knowledge[0]?.knowledgeBaseId, 'kb-legacy-default');
  assert.equal(migratedStore.read().knowledge[0]?.body, '保留正文');
  assert.equal(migratedStore.read().knowledgeBases[0]?.title, '我的知识库');
  migratedStore.close();

  const imported = store.read();
  imported.tasks = [{ ...task, title: '从旧 JSON 导入' }];
  store.import(imported);
  assert.equal(store.read().tasks[0]?.title, '从旧 JSON 导入');
  assert.throws(() => store.import({ ...imported, tasks: [{ ...task, due: '2026-02-31' }] }), /日期/);
  assert.equal(store.read().tasks[0]?.title, '从旧 JSON 导入', 'failed import must roll back');

  // 向后兼容：新增模块（knowledge）在旧导出里没有这个键，必须按空数组导入而不是 400。
  const legacyExport = store.read() as Record<string, unknown>;
  delete legacyExport.knowledge;
  store.import(legacyExport);
  assert.equal(store.read().tasks[0]?.title, '从旧 JSON 导入');
  assert.deepEqual(store.read().knowledge, [], '旧 JSON 缺 knowledge 键应导入为空数组');
  assert.throws(() => store.import({ ...legacyExport, tasks: 'not-an-array' }), /记录数组/);

  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter(store));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/workbench`;
  const state = await fetch(`${base}/state`).then((response) => response.json()) as { data: { tasks: Array<{ title: string }> } };
  assert.equal(state.data.tasks[0]?.title, '从旧 JSON 导入');
  const createdResponse = await fetch(`${base}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '走 HTTP 新增' }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { record: { id: string } };
  const patchedResponse = await fetch(`${base}/tasks/${created.record.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }),
  });
  assert.equal((await patchedResponse.json() as { record: { done: boolean } }).record.done, true);
  const deleteResponse = await fetch(`${base}/tasks/${created.record.id}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.equal(store.read().tasks.length, 1);

  // 通用字段：tags / refs / starred 有默认值，写入时校验，关联可存可取。
  const linked = store.addRecord('fixes', {
    title: '关联一条任务', tags: ['bug', '界面'], refs: [{ type: 'tasks', id: task.id }], starred: true,
  });
  assert.deepEqual(linked.tags, ['bug', '界面']);
  assert.deepEqual(linked.refs, [{ type: 'tasks', id: task.id }]);
  assert.equal(linked.starred, true);
  assert.throws(() => store.addRecord('fixes', { title: '坏标签', tags: 'bug' }), /标签/);
  assert.throws(() => store.addRecord('fixes', { title: '坏关联', refs: [{ type: 'tasks' }] }), /关联/);
  assert.equal(store.read().logs[0], undefined, 'logs 默认空');
  const logged = store.addRecord('logs', { text: '带时间戳的日志' });
  assert.equal(typeof logged.createdAt, 'string', 'logs 现在也维护时间戳');
  assert.equal(typeof logged.updatedAt, 'string');

  // 旧 JSON 导入：缺时间戳的旧记录导入后自动补齐。
  const legacy = store.read();
  legacy.codes = [{ id: 'legacy000-0000-4000-8000-00000000c0de', title: '旧数据无时间戳', project: 'p', status: 'todo', note: '' }];
  store.import(legacy);
  const importedCode = store.read().codes[0];
  assert.equal(typeof importedCode?.createdAt, 'string', '导入旧数据要补齐 createdAt');

  // 搜索：标题命中优先，LIKE 通配符不越界。
  const hits = store.search('任务');
  assert.ok(hits.length >= 1);
  assert.equal(store.search('').length, 0);
  assert.equal(store.search('%').length, 0, '裸 % 不能匹配全部');
  const searchResponse = await fetch(`${base}/search?q=${encodeURIComponent('任务')}`).then((response) => response.json()) as { results: Array<{ title: string }> };
  assert.ok(searchResponse.results.length >= 1);

  // 偏好：白名单合并写入，读回落库。
  const prefsResponse = await fetch(`${base}/prefs`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'dark', unknownKey: 1 }),
  }).then((response) => response.json()) as { prefs: Record<string, unknown> };
  assert.equal(prefsResponse.prefs.theme, 'dark');
  assert.equal(prefsResponse.prefs.unknownKey, undefined, '白名单外的键要丢弃');
  const stateWithPrefs = await fetch(`${base}/state`).then((response) => response.json()) as { prefs: { theme?: string }; empty: boolean };
  assert.equal(stateWithPrefs.prefs.theme, 'dark');
  assert.equal(typeof stateWithPrefs.empty, 'boolean');

  // 知识库偏好：kbSelectedId / kbView 必须过白名单（漏在白名单外会被静默丢弃，
  // 编辑/预览视图与选中条目刷新后必然丢失），白名单外的键依旧丢弃。
  const KB_PREF_ID = '9000000a-0000-4000-8000-00000000000a';
  const kbPrefsResponse = await fetch(`${base}/prefs`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kbSelectedId: KB_PREF_ID, kbView: 'preview', kbBaseId: 'kb-legacy-default', kbStage: 'documents', unknownKey: 2 }),
  }).then((response) => response.json()) as { prefs: Record<string, unknown> };
  assert.equal(kbPrefsResponse.prefs.kbSelectedId, KB_PREF_ID, 'kbSelectedId 应在白名单内');
  assert.equal(kbPrefsResponse.prefs.kbView, 'preview', 'kbView 应在白名单内');
  assert.equal(kbPrefsResponse.prefs.kbBaseId, 'kb-legacy-default', 'kbBaseId 应在白名单内');
  assert.equal(kbPrefsResponse.prefs.kbStage, 'documents', 'kbStage 应在白名单内');
  assert.equal(kbPrefsResponse.prefs.unknownKey, undefined, '白名单外的键仍要丢弃');
  const stateWithKbPrefs = await fetch(`${base}/state`).then((response) => response.json()) as {
    prefs: { kbSelectedId?: string; kbView?: string };
  };
  assert.equal(stateWithKbPrefs.prefs.kbSelectedId, KB_PREF_ID, '选中的知识条目应落库');
  assert.equal(stateWithKbPrefs.prefs.kbView, 'preview', '编辑/预览视图偏好应落库');

  // 前端 api.setPrefs 必须拆掉 {prefs:{…}} 信封返回裸 prefs 对象：曾把信封当偏好整份
  // 灌进 state，每写一个键都把 theme / density 等其余键冲掉（暗色主题切换不生效的根因）。
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = ((path: string, init?: RequestInit) => nodeFetch(
    path.startsWith('/api/workbench') ? `${base}${path.slice('/api/workbench'.length)}` : `${base}${path}`,
    init,
  )) as typeof fetch;
  try {
    const saved = await uiApi.setPrefs({ density: 'compact' }) as Record<string, unknown>;
    assert.equal(saved.density, 'compact', 'setPrefs 应返回服务端合并后的偏好值');
    assert.equal(saved.prefs, undefined, 'setPrefs 不许把 {prefs:{…}} 信封整体当偏好返回');
    assert.equal(saved.theme, 'dark', '写一个键不许冲掉已存的其他偏好键');
    assert.equal(saved.kbView, 'preview', '写一个键不许冲掉 kbView 这类模块偏好');
  } finally {
    globalThis.fetch = nodeFetch;
  }

  // 演示数据：灌入后各模块有记录，任务→需求、问题→任务的引用真实存在。
  store.loadDemo();
  const demo = store.read();
  assert.ok(demo.tasks.length >= 4 && demo.logs.length >= 6);
  const requirementIds = new Set(demo.requirements.map((record) => record.id));
  assert.ok(demo.tasks.some((record) => record.refs.some((ref) => ref.type === 'requirements' && requirementIds.has(ref.id))), '任务应引用需求');
  const taskIds = new Set(demo.tasks.map((record) => record.id));
  assert.ok(demo.fixes.some((record) => record.refs.some((ref) => ref.type === 'tasks' && taskIds.has(ref.id))), '问题应引用任务');

  // 知识库：4 条互链演示笔记，正文 [[标题]] 都能解析到，且至少一条引用任务/需求。
  const demoKnowledge = store.read().knowledge;
  assert.ok(demoKnowledge.length >= 4, '演示数据应含 4 条知识笔记');
  const knowledgeIds = new Set(demoKnowledge.map((record) => record.id));
  type LinkRef = { type: string; id: string };
  const refsOfDemo = (record: Record<string, unknown>): LinkRef[] => (Array.isArray(record.refs) ? (record.refs as LinkRef[]) : []);
  assert.ok(demoKnowledge.every((record) => typeof record.body === 'string'), '演示笔记都应有正文');
  const mentioned = demoKnowledge
    .flatMap((record) => String(record.body ?? '').match(/\[\[[^\]]+\]\]/g) ?? [])
    .map((token) => token.slice(2, -2));
  const knowledgeTitles = new Set(demoKnowledge.map((record) => String(record.title)));
  assert.ok(mentioned.length >= 4, '演示笔记正文应含 [[双链]]');
  assert.ok(mentioned.every((title) => knowledgeTitles.has(title)), '正文 [[标题]] 应都能在知识库解析到');
  assert.ok(
    demoKnowledge.some((record) => refsOfDemo(record).some((ref) => ref.type === 'knowledge' && knowledgeIds.has(ref.id))),
    '演示知识笔记应互相引用',
  );
  assert.ok(
    demoKnowledge.some((record) => refsOfDemo(record).some((ref) => (ref.type === 'tasks' && taskIds.has(ref.id)) || (ref.type === 'requirements' && requirementIds.has(ref.id)))),
    '至少一条演示笔记应引用任务/需求',
  );

  // 双向链接：出链 = refs 解析，反链 = 全表反查（含资料模块时间轴记录）。
  const noteA = demoKnowledge.find((record) => refsOfDemo(record).some((ref) => ref.type === 'knowledge'));
  assert.ok(noteA !== undefined, '演示应含引用其他笔记的条目');
  const graph = store.links('knowledge', noteA!.id);
  const expectedOutgoing = refsOfDemo(noteA!).filter((ref) => knowledgeIds.has(ref.id)).map((ref) => ref.id);
  const expectedIncoming = demoKnowledge
    .filter((record) => refsOfDemo(record).some((ref) => ref.type === 'knowledge' && ref.id === noteA!.id))
    .map((record) => record.id);
  assert.deepEqual(graph.outgoing.map((entry) => entry.id).sort(), [...expectedOutgoing].sort(), '出链应等于笔记的知识引用');
  assert.deepEqual(graph.incoming.map((entry) => entry.id).sort(), [...expectedIncoming].sort(), '反链应等于引用本条笔记的记录');
  assert.ok(
    graph.outgoing.every((entry) => demoKnowledge.some((record) => record.id === entry.id && record.title === entry.title)),
    '出链元素的 title 应是目标记录的标题',
  );
  assert.equal(store.links('knowledge', 'missing00-0000-4000-8000-000000000000').incoming.length, 0, '记录不存在时反链为空');
  assert.throws(() => store.links('unknown', 'x'), /未知模块/);
  const dangling = store.addRecord('knowledge', {
    title: '悬空引用不入链', body: '指向已删除记录的 refs 不应出现在出链里。',
    refs: [{ type: 'knowledge', id: 'ghost0000-0000-4000-8000-000000000000' }],
  });
  assert.equal(store.links('knowledge', dangling.id).outgoing.length, 0, '指向不存在记录的引用不入链');

  // links 端点（HTTP）：具体路由先于 /:module 通配注册，返回 { outgoing, incoming }。
  const linksResponse = await fetch(`${base}/links/knowledge/${noteA!.id}`).then((response) => response.json()) as {
    outgoing: Array<{ module: string; id: string; title: string }>;
    incoming: Array<{ module: string; id: string; title: string }>;
  };
  assert.deepEqual(linksResponse.outgoing.map((entry) => entry.id).sort(), [...expectedOutgoing].sort());
  assert.deepEqual(linksResponse.incoming.map((entry) => entry.id).sort(), [...expectedIncoming].sort());
  assert.ok(linksResponse.outgoing.every((entry) => entry.module === 'knowledge' && typeof entry.title === 'string' && entry.title !== ''));
  const crossRef = demoKnowledge
    .flatMap((record) => refsOfDemo(record))
    .find((ref) => ref.type === 'tasks' || ref.type === 'requirements');
  assert.ok(crossRef !== undefined, '应存在跨模块引用');
  const crossLinks = store.links(crossRef!.type, crossRef!.id);
  assert.ok(crossLinks.incoming.some((entry) => entry.module === 'knowledge' && entry.title !== ''), '任务/需求的反链里应出现知识笔记');
  const unknownModuleResponse = await fetch(`${base}/links/unknown/x`);
  assert.equal(unknownModuleResponse.status, 400, '未知模块应回 400');

  // 知识库字段：title 必填、body 长文本可选、通用字段默认值、旧数据缺字段走默认值。
  const note = store.addRecord('knowledge', { title: '知识库字段验证', body: '正文支持 markdown，最长 50000 字。' });
  assert.equal(note.body, '正文支持 markdown，最长 50000 字。');
  assert.deepEqual(note.tags, [], 'knowledge 默认无标签');
  assert.deepEqual(note.refs, []);
  assert.equal(note.starred, false);
  assert.equal(typeof note.createdAt, 'string', 'knowledge 也维护时间戳');
  assert.equal(typeof note.updatedAt, 'string');
  assert.throws(() => store.addRecord('knowledge', { body: '缺少标题' }), /必填/);
  assert.throws(() => store.addRecord('knowledge', { title: '正文类型错误', body: 42 }), /正文/);
  assert.throws(() => store.addRecord('knowledge', { title: '正文超长', body: 'x'.repeat(50001) }), /上限/);

  // R3：store 与 HTTP 都只靠正文解析双链；重名全命中，自链/未知标题跳过，来源引用保留。
  const targetOne = store.addRecord('knowledge', { title: '精确标题' });
  const targetTwo = store.addRecord('knowledge', { title: '精确标题' });
  const wikiBody = '[[ 精确标题 ]] [[源条目]] [[未收录]] [[精确标题]]';
  const source = store.addRecord('knowledge', {
    title: '源条目', body: wikiBody,
    refs: [{ type: 'tasks', id: task.id }, { type: 'tasks', id: task.id }, { type: 'knowledge', id: targetOne.id }],
  });
  const expectedRefs = [
    { type: 'knowledge', id: targetOne.id }, { type: 'knowledge', id: targetTwo.id }, { type: 'tasks', id: task.id },
  ];
  assert.deepEqual(source.refs, expectedRefs, '重名双链排在来源前，未知标题、自链及重复 refs 不落库');
  assert.deepEqual(store.updateRecord('knowledge', source.id, { body: wikiBody, refs: source.refs }).refs, expectedRefs, '前端 buildRefs 再经 R3 应幂等');
  assert.deepEqual(store.updateRecord('knowledge', source.id, { title: '源条目改名' }).refs, expectedRefs, '只改 title 时 refs 不动');
  assert.deepEqual(store.updateRecord('knowledge', source.id, { body: '[[未收录]]' }).refs, [{ type: 'tasks', id: task.id }], '改正文时旧知识链接整体重解析，来源保留');
  const capTargets = Array.from({ length: 21 }, (_, index) => store.addRecord('knowledge', { title: `上限笔记${index}` }));
  const capped = store.addRecord('knowledge', {
    title: '双链上限验证', body: capTargets.map((_, index) => `[[上限笔记${index}]]`).join(' '),
    refs: [{ type: 'tasks', id: task.id }],
  });
  assert.deepEqual(refsOfDemo(capped), capTargets.slice(0, 20).map((record) => ({ type: 'knowledge', id: record.id })), '按正文顺序保留前 20 条，来源排在知识双链后再截断');

  const createdWikiResponse = await fetch(`${base}/knowledge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'HTTP 源', body: '[[精确标题]] [[不存在的笔记]]', refs: [{ type: 'tasks', id: task.id }] }),
  });
  assert.equal(createdWikiResponse.status, 200);
  const createdWiki = (await createdWikiResponse.json() as { record: { id: string; refs: LinkRef[] } }).record;
  assert.deepEqual(createdWiki.refs, expectedRefs, 'HTTP POST 自动解析双链并保留跨模块来源');
  const renamedWikiResponse = await fetch(`${base}/knowledge/${createdWiki.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'HTTP 源改名' }),
  });
  assert.deepEqual((await renamedWikiResponse.json() as { record: { refs: LinkRef[] } }).record.refs, expectedRefs, 'HTTP PATCH 只改标题不动 refs');
  const repeatedWikiResponse = await fetch(`${base}/knowledge/${createdWiki.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '[[精确标题]] [[不存在的笔记]]', refs: expectedRefs }),
  });
  assert.deepEqual((await repeatedWikiResponse.json() as { record: { refs: LinkRef[] } }).record.refs, expectedRefs, 'HTTP PATCH 重复写入幂等');
  const wikiState = await fetch(`${base}/state`).then((response) => response.json()) as { data: { knowledge: Array<{ id: string; refs: LinkRef[] }> } };
  assert.deepEqual(wikiState.data.knowledge.find((record) => record.id === createdWiki.id)?.refs, expectedRefs, 'HTTP 解析结果必须真实落库');

  const legacyKnowledge = store.read();
  legacyKnowledge.knowledge = [
    targetOne,
    { id: 'legacy000-0000-4000-8000-00000000k01e', title: '旧库导入的知识条目' },
    { id: 'legacy000-0000-4000-8000-00000000k02e', title: '导入双链正文', body: '[[精确标题]]', refs: [] },
  ];
  store.import(legacyKnowledge);
  const importedKnowledge = store.read().knowledge.find((record) => record.id === 'legacy000-0000-4000-8000-00000000k01e');
  assert.equal(importedKnowledge?.title, '旧库导入的知识条目', '旧数据导入不丢标题');
  assert.equal(importedKnowledge?.body ?? '', '', '旧数据缺 body：读时按空串兜底');
  assert.deepEqual(importedKnowledge?.tags ?? [], [], '旧数据缺 tags：读时按空数组兜底');
  assert.deepEqual(importedKnowledge?.refs ?? [], [], '旧数据缺 refs：读时按空数组兜底');
  const importedWiki = store.read().knowledge.find((record) => record.id === 'legacy000-0000-4000-8000-00000000k02e');
  assert.deepEqual(importedWiki?.refs, [], '导入有双链正文也不运行 R3，refs 原样保留');
  assert.ok(store.read().knowledge.every((record) => typeof record.knowledgeBaseId === 'string' && record.knowledgeBaseId !== ''), '旧笔记必须迁入默认知识库');
  assert.ok(store.read().knowledgeBases.some((record) => record.id === 'kb-legacy-default'), '迁移应创建可见的默认知识库');

  const secondBase = store.addRecord('knowledgeBases', { title: '第二知识库', description: '范围隔离验证' });
  const folder = store.addRecord('knowledgeFolders', { title: '设计', knowledgeBaseId: secondBase.id });
  const childFolder = store.addRecord('knowledgeFolders', { title: '子目录', knowledgeBaseId: secondBase.id, parentId: folder.id });
  assert.throws(() => store.updateRecord('knowledgeFolders', folder.id, { parentId: childFolder.id }), /循环层级/, '目录不能形成循环');
  assert.equal(store.removeRecord('knowledgeFolders', childFolder.id), true, '空子目录可删除');
  const folderDoc = store.addRecord('knowledge', { title: '第二库文档', knowledgeBaseId: secondBase.id, folderId: folder.id, body: '内容' });
  assert.equal(store.read().knowledge.find((record) => record.id === folderDoc.id)?.folderId, folder.id, '文档目录归属应持久化');
  assert.throws(() => store.updateRecord('knowledge', importedKnowledge!.id, { folderId: folder.id }), /目录不属于所选知识库/, '文档不可移入别的知识库目录');
  assert.throws(() => store.removeRecord('knowledgeFolders', folder.id), /仍有文档/, '有内容的目录不可误删');
  const otherTitle = store.addRecord('knowledge', { title: '精确标题', knowledgeBaseId: secondBase.id });
  const scoped = store.addRecord('knowledge', { title: '库内双链', knowledgeBaseId: secondBase.id, body: '[[精确标题]]' });
  assert.deepEqual(scoped.refs, [{ type: 'knowledge', id: otherTitle.id }], '双链只解析同一知识库的标题');
  store.updateRecord('knowledge', folderDoc.id, { folderId: '' });
  assert.equal(store.removeRecord('knowledgeFolders', folder.id), true, '空目录可删除');
  assert.equal(store.removeRecord('knowledgeBases', secondBase.id), true, '知识库可删除');
  assert.ok(!store.read().knowledge.some((record) => record.knowledgeBaseId === secondBase.id), '删除知识库应清理其文档');
  assert.ok(!store.read().knowledgeFolders.some((record) => record.knowledgeBaseId === secondBase.id), '删除知识库应清理其目录');
  store.resetAll();
  assert.equal(store.read().tasks.length, 0);
  console.log('workbench SQLite: persistence, validation, import rollback and HTTP CRUD passed');
  console.log('workbench SQLite: common fields, timestamps, search, prefs (whitelist, kb keys, envelope) and demo data passed');
  console.log('workbench SQLite: knowledge R3 store and HTTP wiki refs passed');
  console.log('workbench SQLite: knowledge base migration, folder ownership, scoped links and cascade passed');
} finally {
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
