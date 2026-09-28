import assert from 'node:assert/strict';

import { readConfiguredCodeWorkspace } from '../src/workbench-app/modules/codes/workspace-binding.mjs';

const url = '/api/module-agents/codes/settings';
const canonical = '/private/tmp/web-idea/project';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const calls: { url: string; init: RequestInit }[] = [];
const signal = new AbortController().signal;
const configured = await readConfiguredCodeWorkspace({
  root: '/tmp/iframe-attempt',
  signal,
  request: async (requestUrl: string, init: RequestInit = {}) => {
    calls.push({ url: requestUrl, init });
    return json({ workspacePath: canonical, workspace: '/tmp/alias', revision: 'latest' });
  },
});
assert.equal(configured, canonical, 'ignore an iframe-provided root and use Agent settings');
assert.deepEqual(calls.map(call => [call.url, call.init.method ?? 'GET']), [[url, 'GET']], 'opening code editor only reads settings');
assert.equal(calls[0]!.init.signal, signal, 'abort signal reaches settings GET');
assert.equal(calls[0]!.init.body, undefined, 'iframe cannot send a workspace override in a request body');

for (const invalid of [undefined, null, '', 'relative/project', '/bad\0project']) {
  let count = 0;
  await assert.rejects(readConfiguredCodeWorkspace({
    request: async (_requestUrl: string, init: RequestInit = {}) => {
      count += 1;
      assert.notEqual(init.method, 'PUT');
      return json({ workspacePath: invalid });
    },
  }), /未配置有效的绝对工作区目录/);
  assert.equal(count, 1, 'invalid configured path causes no save');
}

let unavailableCalls = 0;
await assert.rejects(readConfiguredCodeWorkspace({
  request: async () => { unavailableCalls += 1; return json({ error: '无法读取 Agent 设置' }, 503); },
}), /无法读取 Agent 设置/, 'GET 503 reaches the caller');
assert.equal(unavailableCalls, 1, 'failed GET is not retried as a write');

await assert.rejects(readConfiguredCodeWorkspace({
  request: async () => new Response('not json', { status: 200 }),
}), /配置响应无效/, 'invalid API response has a clear error');

const controller = new AbortController();
const aborted = readConfiguredCodeWorkspace({
  signal: controller.signal,
  request: async (_requestUrl: string, init: RequestInit = {}) => {
    assert.equal(init.signal, controller.signal);
    controller.abort();
    throw new DOMException('The operation was aborted', 'AbortError');
  },
});
await assert.rejects(aborted, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');

console.log('PASS 代码工作区读取：仅 GET 配置目录、路径校验、API 错误与取消传播');
