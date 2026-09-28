/**
 * 模块 Agent 受限知识访问 + 日志领域服务门禁（A05 的服务端部分）。
 *
 * 钉死的行为：三个 Agent 各绑一个知识库，放同关键词不同哨兵后 search 只见
 * 自己库；read 越界只回拒绝不泄露标题；update 借 knowledgeBaseId 挪库被拒且
 * 记录不变；create 固定落 home 库；ensureBinding 幂等返回同一 id。日志服务
 * 校验 level/日期过滤与 limit 上限。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkbenchStore } from '../server/workbench/store';
import { ensureBinding, createKnowledgeAccess } from '../server/module-agents/knowledge';
import { createDataSourceRegistry } from '../server/data-sources/registry';

const dir = await mkdtemp(join(tmpdir(), 'module-agent-knowledge-'));
const store = new WorkbenchStore(join(dir, 'workbench.sqlite'));

try {
  const bindings = {
    requirements: ensureBinding(store, 'default', 'requirements', 'requirements'),
    codes: ensureBinding(store, 'default', 'codes', 'codes'),
    logs: ensureBinding(store, 'default', 'logs', 'logs'),
  };
  const baseIds = new Set(Object.values(bindings).map((binding) => binding.homeBaseId));
  assert.equal(baseIds.size, 3, '三个 Agent 应绑定三个不同知识库');

  /* ensureBinding 幂等：重复调用返回同一 home id，不重复建库 */
  const again = ensureBinding(store, 'default', 'logs', 'logs');
  assert.equal(again.homeBaseId, bindings.logs.homeBaseId, '重复 ensureBinding 应返回同一绑定');
  const baseCount = store.read().knowledgeBases.length;
  ensureBinding(store, 'default', 'logs', 'logs');
  assert.equal(store.read().knowledgeBases.length, baseCount, '重复绑定不得再建库');

  /* 三库放同关键词不同哨兵 */
  const access = {
    requirements: createKnowledgeAccess(store, bindings.requirements),
    codes: createKnowledgeAccess(store, bindings.codes),
    logs: createKnowledgeAccess(store, bindings.logs),
  };
  const sentinelDocs: Record<string, { id: string }> = {};
  for (const [agent, api] of Object.entries(access)) {
    const created = api.create({ title: `哨兵-${agent}`, body: `共同关键词 sentinel-${agent}` });
    assert.ok(created.ok === true, `${agent} create 应成功`);
    if (created.ok) {
      assert.equal(created.record.knowledgeBaseId, bindings[agent as keyof typeof bindings].homeBaseId, 'create 必须落 home 库');
      sentinelDocs[agent] = { id: String(created.record.id) };
    }
  }

  /* search 只见自己库 */
  for (const [agent, api] of Object.entries(access)) {
    const hits = api.search('sentinel', 10).hits;
    assert.equal(hits.length, 1, `${agent} 只能命中自己库`);
    assert.equal(hits[0]?.knowledgeBaseId, bindings[agent as keyof typeof bindings].homeBaseId);
  }

  /* read 越界：不泄露标题，只回统一拒绝 */
  const crossRead = access.logs.read(sentinelDocs.codes.id);
  assert.ok(crossRead.ok === false, '跨库 read 应被拒');
  const missingRead = access.logs.read('missing-id');
  assert.ok(missingRead.ok === false, '不存在 id 应返回未找到');
  if (!crossRead.ok && !missingRead.ok) {
    // 存在性不泄露：越界与不存在必须是同一条文案，否则报错本身就成了探测器。
    assert.equal(crossRead.error, missingRead.error, '越界与不存在须同文案');
    assert.ok(!crossRead.error.includes('哨兵'), '拒绝信息不得泄露目标标题');
  }
  assert.ok(access.logs.read(sentinelDocs.logs.id).ok === true, '本库 read 应可读');

  /* update 只允许 home；借 knowledgeBaseId 挪库被拒且记录不变 */
  const moved = access.logs.update(sentinelDocs.logs.id, {
    title: '改名', knowledgeBaseId: bindings.codes.homeBaseId,
  } as never);
  assert.ok(moved.ok === true, 'home 库 update 应成功');
  const afterMove = store.readKnowledge(sentinelDocs.logs.id);
  assert.equal(afterMove?.knowledgeBaseId, bindings.logs.homeBaseId, 'update 不得改动 knowledgeBaseId');
  const crossUpdate = access.logs.update(sentinelDocs.codes.id, { title: '越界改名' });
  assert.ok(crossUpdate.ok === false, '跨库 update 应被拒');
  assert.equal(store.readKnowledge(sentinelDocs.codes.id)?.title, '哨兵-codes', '被拒 update 不得落库');
  const folderEscape = access.logs.update(sentinelDocs.logs.id, { folderId: 'whatever' } as never);
  assert.ok(folderEscape.ok === true);
  assert.notEqual(store.readKnowledge(sentinelDocs.logs.id)?.folderId, 'whatever', 'update 不得改动 folderId');

  /* create 忽略调用方给的归属字段 */
  const forged = access.logs.create({
    title: '伪造归属',
    ...({ knowledgeBaseId: bindings.codes.homeBaseId, folderId: 'x' } as object),
  } as never);
  assert.ok(forged.ok === true);
  if (forged.ok) assert.equal(forged.record.knowledgeBaseId, bindings.logs.homeBaseId, 'create 归属由服务端填');

  /* 日志领域服务：过滤与上限 */
  const seed = [
    { text: '网关超时 timeout-AAA', level: 'error', source: 'server', date: '2026-09-20' },
    { text: '网关恢复 timeout-AAA', level: 'info', source: 'server', date: '2026-09-21' },
    { text: '前端渲染闪烁 timeout-AAA', level: 'warn', source: 'web', date: '2026-09-22' },
  ];
  for (const row of seed) store.addRecord('logs', row);
  const logs = createDataSourceRegistry(store).create('logs', { id: 'workbench-logs', adapter: 'workbench', options: {} });
  const errors = await logs.search({ level: 'error' });
  assert.equal(errors.total, 1, 'level 过滤应只留 error');
  assert.equal((errors.items[0] as any)?.message, '网关超时 timeout-AAA');
  const ranged = await logs.search({ from: '2026-09-21', to: '2026-09-22' });
  assert.equal(ranged.total, 2, '日期闭区间过滤');
  const bySource = await logs.search({ service: 'web' });
  assert.equal(bySource.total, 1);
  const byQ = await logs.search({ q: '恢复' });
  assert.equal(byQ.total, 1, '关键词过滤');
  for (let index = 0; index < 60; index += 1) store.addRecord('logs', { text: `bulk-${index}`, level: 'info', source: 's', date: '2026-09-23' });
  await assert.rejects(logs.search({ q: 'bulk', limit: 500 }));
  const capped = await logs.search({ q: 'bulk', limit: 50 });
  assert.equal(capped.items.length, 50, 'limit 上限 50 必须生效');
  assert.equal(capped.source.id, 'workbench-logs', '结果必须带来源标识');
  const readBack = await logs.read(errors.items[0]!.id as string);
  assert.ok(readBack !== null);
  assert.equal(await logs.read('nope'), null);

  console.log('PASS 模块 Agent 知识访问：三库绑定幂等、search/read/update/create 作用域隔离不泄露，日志查询过滤与上限正确');
} finally {
  store.close();
  await rm(dir, { recursive: true, force: true });
}
