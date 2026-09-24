import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import piWebxKnowledgeExtension from '../extensions/pi-webx-knowledge';
import { createWorkbenchRouter } from '../server/workbench/router';
import { WorkbenchStore } from '../server/workbench/store';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: { ok: boolean; action: string; error?: string; hits?: Array<{ module: string; id: string }>; record?: Record<string, unknown> };
};
type KnowledgeTool = { execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult> };

const store = new WorkbenchStore(':memory:');
const app = express();
app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use((error: Error & { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error.status ?? 500).json({ error: error.message });
});
const server = app.listen(0, '127.0.0.1');
const previousBase = process.env.PI_WEBX_WORKBENCH_URL;

try {
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.PI_WEBX_WORKBENCH_URL = `http://127.0.0.1:${address.port}`;

  const requirement = store.addRecord('requirements', { title: '知识工具来源需求' });
  const target = store.addRecord('knowledge', { title: '既有规范' });
  store.addRecord('tasks', { title: '工作台知识工具让结论可检索' });

  let tool: KnowledgeTool | undefined;
  piWebxKnowledgeExtension({ registerTool: (registered: KnowledgeTool) => { tool = registered; } });
  assert.ok(tool, '扩展应注册 knowledge 工具');
  const call = (params: Record<string, unknown>): Promise<ToolResult> => tool!.execute('acceptance', params);

  const created = await call({
    action: 'create', title: '工作台知识工具让结论可检索', body: '按 [[既有规范]] 落地。',
    tags: ['需求'], refs: [{ type: 'requirements', id: requirement.id }],
  });
  assert.equal(created.details.ok, true, created.content[0]?.text);
  const id = String(created.details.record?.id ?? '');
  assert.ok(id !== '');
  assert.deepEqual(created.details.record?.refs, [
    { type: 'knowledge', id: target.id }, { type: 'requirements', id: requirement.id },
  ]);
  console.log(`knowledge create: ok, id=${id}, refs=2`);

  const searched = await call({ action: 'search', q: '工作台知识工具让结论可检索', limit: 5 });
  assert.equal(searched.details.ok, true, searched.content[0]?.text);
  assert.deepEqual(searched.details.hits?.map(hit => hit.id), [id], '工具层应过滤掉同标题的 tasks 命中');
  console.log(`knowledge search: ok, knowledge hits=${searched.details.hits?.length}`);

  const read = await call({ action: 'read', id });
  assert.equal(read.details.ok, true, read.content[0]?.text);
  assert.deepEqual(read.details.record?.tags, ['需求']);
  assert.deepEqual(read.details.record?.refs, created.details.record?.refs);
  assert.equal(typeof read.details.record?.createdAt, 'string');
  assert.equal(typeof read.details.record?.updatedAt, 'string');
  console.log('knowledge read: ok, body/tags/refs/timestamps present');

  const updated = await call({ action: 'update', id, body: '修订后仍关联 [[既有规范]]。', tags: ['需求', '经验'] });
  assert.equal(updated.details.ok, true, updated.content[0]?.text);
  assert.deepEqual(updated.details.record?.refs, created.details.record?.refs);
  assert.deepEqual(updated.details.record?.tags, ['需求', '经验']);
  assert.equal(store.read().knowledge.find(row => row.id === id)?.body, '修订后仍关联 [[既有规范]]。');
  console.log('knowledge update: ok, persisted body/tags and preserved refs');

  const invalid = await call({ action: 'create', body: '缺标题' });
  assert.equal(invalid.details.ok, false);
  assert.ok(invalid.content[0]?.text.includes('需要非空'));
  const rejectedByRest = await call({ action: 'create', title: 'x'.repeat(201) });
  assert.equal(rejectedByRest.details.ok, false);
  assert.ok(rejectedByRest.content[0]?.text.includes('title 超过 200 字上限'));
  console.log('knowledge validation: ok, local and REST errors use readable content and structured details');
} finally {
  if (previousBase === undefined) delete process.env.PI_WEBX_WORKBENCH_URL;
  else process.env.PI_WEBX_WORKBENCH_URL = previousBase;
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
}
