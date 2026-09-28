import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore } from '../server/workbench/store';
import { createDataSourceRegistry } from '../server/data-sources/registry';
import { SourceError, type SourceConfig } from '../server/data-sources/contracts';
import { sourceTools } from '../server/data-sources/tools';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { loadAgentProfiles, defaultAgentsConfigRoot } from '../server/module-agents/profiles';

const root = await mkdtemp(join(tmpdir(), 'data-source-adapters-'));
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
const app = express(); app.use(express.json());
const requests: Array<{ path: string; body: unknown; query: unknown }> = [];
app.use((req, res, next) => {
  requests.push({ path: req.path, body: req.body, query: req.query });
  if (req.path.startsWith('/auth') && req.headers.authorization !== 'fixture-private-token') { res.status(401).json({ secret: 'MUST-NOT-LEAK' }); return; }
  next();
});
app.get('/v1/logs', (req, res) => res.json({ payload: { rows: [{ key: 'same/id', msg: '连接失败', at: 1700000000, sev: 'ERR' }], total: 1, cursor: 'page-2' } }));
app.get('/v1/item/:id', (req, res) => res.json({ item: { key: req.params.id, msg: '连接失败', at: 1700000000, sev: 'ERR' } }));
app.post('/v2/search', (req, res) => res.json({ result: [{ uuid: 'same/id', content: { text: '连接失败' }, timestamp: '2023-11-14T22:13:20Z', priority: 3 }], count: 1, next: 42 }));
app.get('/v2/item/:id', (req, res) => res.json({ uuid: req.params.id, content: { text: '连接失败' }, timestamp: '2023-11-14T22:13:20Z', priority: 3 }));
app.get('/issues', (_req, res) => res.json({ rows: [{ ticket: 'I-1', subject: '登录错误', state: 'WIP' }] }));
app.get('/issue/:id', (req, res) => res.json({ ticket: req.params.id, subject: '登录错误', state: 'WIP' }));
app.get('/slow', (_req, res) => { const timer = setTimeout(() => res.json({ rows: [] }), 3000); res.on('close', () => clearTimeout(timer)); });
app.get('/bad', (_req, res) => res.json({ payload: { rows: [{ msg: 'no id' }] } }));
app.get('/huge', (_req, res) => res.json({ payload: { rows: [], secret: 'x'.repeat(4096) } }));
app.get('/missing/:id', (_req, res) => res.status(404).end());
app.get('/auth', (_req, res) => res.json({ payload: { rows: [] } }));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
const registry = createDataSourceRegistry(store);
const first: SourceConfig = {
  id: 'source-one', adapter: 'http-json', options: { baseUrl,
    search: { method: 'GET', path: '/v1/logs', query: { keyword: '{q}', count: '{limit}', page: '{cursor}' }, itemsPath: 'payload.rows', totalPath: 'payload.total', nextCursorPath: 'payload.cursor' },
    read: { method: 'GET', path: '/v1/item/{id}', resultPath: 'item' },
    fields: { id: 'key', message: 'msg', occurredAt: { path: 'at', unit: 'seconds' }, level: { path: 'sev', values: { ERR: 'error' } } },
  },
};
const second: SourceConfig = {
  id: 'source-two', adapter: 'http-json', options: { baseUrl,
    search: { method: 'POST', path: '/v2/search', body: { filter: { words: '{q}' }, size: '{limit}', continuation: '{cursor}' }, itemsPath: 'result', totalPath: 'count', nextCursorPath: 'next' },
    read: { method: 'GET', path: '/v2/item/{id}' },
    fields: { id: 'uuid', message: 'content.text', occurredAt: 'timestamp', level: { path: 'priority', values: { '3': 'error' } } },
  },
};
try {
  const a = registry.create('logs', first); const b = registry.create('logs', second);
  const one = await a.search({ q: '连接', limit: 5 }); const two = await b.search({ q: '连接', limit: 5, cursor: '42' });
  for (const page of [one, two]) {
    const item = page.items[0]!; assert.equal(item.kind, 'logs');
    if (item.kind === 'logs') { assert.equal(item.message, '连接失败'); assert.equal(item.level, 'error'); assert.equal(item.occurredAt, '2023-11-14T22:13:20.000Z'); }
    assert.equal(item.id, 'same/id'); assert.equal(page.total, 1);
  }
  assert.equal(one.nextCursor, 'page-2'); assert.equal(two.nextCursor, '42');
  assert.notEqual(one.items[0]!.sourceId, two.items[0]!.sourceId);
  assert.deepEqual({ ...requests[0]?.query as object }, { keyword: '连接', count: '5' });
  assert.deepEqual(requests[1]?.body, { filter: { words: '连接' }, size: 5, continuation: '42' });
  assert.equal((await a.read('same/id'))?.id, 'same/id', 'path parameter is encoded');
  const tool = sourceTools('logs', b, 24000).find(item => item.name === 'logs_read')!;
  const refused = await tool.execute('probe', { id: 'same/id', sourceId: 'source-one' }, undefined, undefined, {} as never);
  assert.ok(JSON.stringify(refused).includes('invalid_query'));
  await assert.rejects(a.search({ from: '2024-01-01' }), (e: any) => e.code === 'unsupported_query');
  await assert.rejects(a.search({ limit: 1000 }), (e: any) => e.code === 'invalid_query');
  const issues = registry.create('issues', { id: 'tickets', adapter: 'http-json', options: {
    baseUrl, search: { method: 'GET', path: '/issues', query: { take: '{limit}' }, itemsPath: 'rows' },
    read: { method: 'GET', path: '/issue/{id}' }, fields: { id: 'ticket', title: 'subject', status: { path: 'state', values: { WIP: 'in_progress' } } },
  } });
  const issue = (await issues.search({})).items[0]!;
  assert.equal(issue.kind, 'issues'); if (issue.kind === 'issues') { assert.equal(issue.status, 'in_progress'); assert.equal(issue.createdAt, null); }
  assert.equal((await issues.read('I-1'))?.id, 'I-1');
  const altered = (path: string, extra: Record<string, unknown> = {}) => registry.create('logs', { ...first, options: { ...first.options, ...extra, search: { ...(first.options.search as object), path } } });
  await assert.rejects(altered('/bad').search({}), (e: any) => e.code === 'invalid_response');
  await assert.rejects(altered('/huge', { maxResponseBytes: 128 }).search({}), (e: any) => e.code === 'invalid_response');
  await assert.rejects(altered('/auth').search({}), (e: any) => e.code === 'unauthorized' && !e.message.includes('MUST-NOT-LEAK'));
  process.env.ADAPTER_FIXTURE_TOKEN = 'fixture-private-token';
  assert.deepEqual((await altered('/auth', { headerRefs: { Authorization: 'ADAPTER_FIXTURE_TOKEN' } }).search({})).items, []);
  delete process.env.ADAPTER_FIXTURE_TOKEN;
  await assert.rejects(altered('/slow', { timeoutMs: 30 }).search({}), (e: any) => e.code === 'timeout');
  const cancel = new AbortController(); const waiting = altered('/slow').search({}, cancel.signal); setTimeout(() => cancel.abort(), 30);
  await assert.rejects(waiting, (e: any) => e.code === 'cancelled');
  const disposed = altered('/slow'); const inFlight = disposed.search({}); await disposed.dispose?.(); await assert.rejects(inFlight, (e: any) => e.code === 'cancelled');
  const localLog = store.addRecord('logs', { text: '本地错误', level: 'error', date: '2026-09-28', source: 'local' });
  const localIssue = store.addRecord('fixes', { title: '本地问题', status: 'doing', priority: 'high' });
  for (const [kind, id] of [['logs', localLog.id], ['issues', localIssue.id]] as const) {
    const source = registry.create(kind, { id: `local-${kind}`, adapter: 'workbench', options: {} });
    assert.equal((await source.read(String(id)))?.id, id);
    assert.equal((await source.search({ limit: 1 })).items.length, 1);
  }
  const custom = createDataSourceRegistry(store, [{ id: 'custom-fixture', create: ({ config, kind }) => ({
    search: async query => ({ items: [], source: { id: config.id, kind, adapter: 'custom-fixture' }, query }), read: async () => null,
  }) }]);
  assert.equal((await custom.create('logs', { id: 'custom', adapter: 'custom-fixture', options: {} }).search({})).source.adapter, 'custom-fixture');
  assert.throws(() => registry.create('logs', { ...first, adapter: 'missing' }), SourceError);
  const profileResult = (await loadAgentProfiles(defaultAgentsConfigRoot())).get('logs'); assert.ok(profileResult?.ok);
  let released = 0;
  const owned = createDataSourceRegistry(store, [{ id: 'owned-fixture', create: ({config,kind}) => ({
    search: async query => ({ items: [], source: {id: config.id, kind, adapter: 'owned-fixture'}, query }), read: async () => null,
    dispose: async () => { released += 1; },
  }) }]);
  const bad = structuredClone(profileResult.profile); bad.config.dataSources.logs!.adapter = 'owned-fixture'; bad.config.tools.push('invalid.tool');
  await assert.rejects(assembleModuleAgent({store,workspaceKey:'cleanup',agentId:'logs',profile:bad,dataSourceRegistry:owned}));
  assert.equal(released, 1, 'failed assembly releases its owned adapters');

  console.log('PASS 数据源适配：异构 GET/POST 与字段/枚举/时间/分页映射、来源隔离、问题工具契约、认证脱敏、错误/超时/取消/销毁、本地源与自定义插件');
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); }
