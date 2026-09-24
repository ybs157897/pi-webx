/**
 * The isolated test instance: pins for the parts that fail *dangerously*.
 *
 * `scripts/subagents-test-server.ts` is the one place this repo accepts a real
 * credential into a process. Nothing here starts a server or reads a credential:
 * the run directory is a throwaway under the OS temp root, the credential reader
 * is a fake, and every assertion is about a refusal or a metadata-only result.
 *
 * Rules pinned, in the order the bootstrap enforces them:
 *
 *   - a RUN_DIR outside the OS temp root, or inside the project, is refused;
 *   - every management surface is refused for every method, including GET;
 *   - the stored-session list is answered empty rather than read;
 *   - a new session may only be created inside the fixture root, and resume by
 *     `sessionPath`/`sessionId` is refused;
 *   - a fork may only follow an in-process `sessionId`, never a transcript path;
 *   - `bash`/`set_model` and any tool widening to bash/write/edit are refused;
 *   - the credential store serves one provider, reports metadata only, refuses
 *     every write, and never triggers a read it was not asked for;
 *   - a credential kind the public read-only adapter cannot serve stops startup
 *     instead of being worked around;
 *   - no secret reaches anything logged or serialized.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_TEST_PORT,
  DENIED_COMMANDS,
  DENIED_PATH_PREFIXES,
  RunDirError,
  UnsupportedCredentialError,
  attachStaticAssets,
  canonicalize,
  describeCredential,
  contains,
  createReadOnlyCredentialStore,
  decideRequest,
  fingerprintFile,
  readPort,
  resolveRunDir,
  type TestGatePolicy,
} from './subagents-test-server';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const TMP = realpathSync(tmpdir());
const ALLOWED_PROVIDER = 'cmdc';

/** A fresh throwaway run directory per assertion group; cleans up even on throw. */
function withRunDir<T>(run: (runDir: string) => T): T {
  const runDir = mkdtempSync(path.join(TMP, 'pi-webx-sut-'));
  try {
    return run(runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/** Async variant: awaited inside the try so cleanup cannot race the body. */
async function withRunDirAsync<T>(run: (runDir: string) => Promise<T>): Promise<T> {
  const runDir = mkdtempSync(path.join(TMP, 'pi-webx-sut-'));
  try {
    return await run(runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/** A policy pointed at one throwaway run directory. */
function policyFor(runDir: string): TestGatePolicy {
  const fixtureRoot = path.join(runDir, 'fixtures');
  mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  return {
    runDir,
    fixtureRoot,
    model: { providerId: ALLOWED_PROVIDER, modelId: 'deepseek/deepseek-v4.1-flash' },
    allowedCommands: new Set(DEFAULT_ALLOWED_COMMANDS),
  };
}

const decide = (
  policy: TestGatePolicy,
  method: string,
  apiPath: string,
  extra: { body?: unknown; query?: Record<string, unknown> } = {},
) => decideRequest(policy, { method, path: apiPath, ...extra });

/* ---------------------------------------------------------- RUN_DIR contract */

assert.throws(() => resolveRunDir({}, PROJECT_ROOT), RunDirError, '未设 RUN_DIR 必须拒绝');
assert.throws(
  () => resolveRunDir({ RUN_DIR: 'relative/run' }, PROJECT_ROOT),
  RunDirError,
  '相对 RUN_DIR 必须拒绝：它会把转录写到不确定的 cwd 下',
);
assert.throws(
  () => resolveRunDir({ RUN_DIR: PROJECT_ROOT }, PROJECT_ROOT),
  RunDirError,
  'RUN_DIR 指向项目内必须拒绝：那就是要被隔离的树本身',
);
assert.throws(
  () => resolveRunDir({ RUN_DIR: path.join(PROJECT_ROOT, 'run-tmp') }, PROJECT_ROOT),
  RunDirError,
  'RUN_DIR 落在 project 子树内必须拒绝（realpath 后判定）',
);
assert.throws(
  () => resolveRunDir({ RUN_DIR: process.env['HOME'] ?? '/nonexistent-home' }, PROJECT_ROOT),
  RunDirError,
  'RUN_DIR 指向 home 必须拒绝',
);

withRunDir((runDir) => {
  const resolved = resolveRunDir({ RUN_DIR: runDir }, PROJECT_ROOT);
  assert.equal(resolved, realpathSync(runDir), 'RUN_DIR 必须解析成 realpath');
  assert.ok(contains(TMP, resolved), 'RUN_DIR 必须落在 OS tmp 根之下');
  // 0700：同机其他用户不该看到这份转录。
  const mode = statSync(resolved).mode & 0o777;
  assert.equal(mode, 0o700, `RUN_DIR 权限必须是 0700，实际 ${mode.toString(8)}`);
});

/* ------------------------------------------------------------------- the port */

assert.equal(readPort(undefined), DEFAULT_TEST_PORT, '默认端口必须是测试端口');
assert.equal(readPort('  '), DEFAULT_TEST_PORT, '空白 PI_WEBX_PORT 走默认');
assert.equal(readPort('8899'), 8899, '显式端口必须被采用');
assert.equal(readPort('9123'), 9123, '显式端口必须被采用（非默认值）');
for (const bad of ['0', '70000', 'abc', '-1']) {
  assert.throws(() => readPort(bad), RunDirError, `非法端口 ${bad} 必须拒绝而不是静默回退`);
}
assert.notEqual(DEFAULT_TEST_PORT, 8787, '测试端口不得与原实例端口相同');

/* ------------------------------------------------------------------ the gate */

withRunDir((runDir) => {
  const policy = policyFor(runDir);

  // 管理面：任何方法都拒绝，GET 也不例外（否则 harness 会拿到真实模型配置）。
  for (const apiPath of DENIED_PATH_PREFIXES.flatMap((prefix) => [prefix, `${prefix}/x`])) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      const decision = decide(policy, method, `/api${apiPath}`);
      assert.equal(decision.kind, 'deny', `${method} ${apiPath} 必须拒绝`);
    }
  }

  // 只读面：测试真正需要的 GET 才放行。
  assert.equal(decide(policy, 'GET', '/api/health').kind, 'allow', 'health 必须放行');
  assert.equal(decide(policy, 'GET', '/api/config').kind, 'allow', 'config 必须放行');
  assert.equal(decide(policy, 'GET', '/api/agent-definitions').kind, 'allow', '定义列表必须放行');
  assert.equal(decide(policy, 'GET', '/api/agent-definitions/tools').kind, 'allow', '定义工具面必须放行');

  // 会话列表：返回空，而不是去读用户的真实会话目录。
  assert.equal(
    decide(policy, 'GET', '/api/stored-sessions').kind,
    'allow-empty-sessions',
    'stored-sessions 必须以空列表应答，绝不可读真实会话目录',
  );
  // 按路径/按 id 恢复真实会话：拒绝。
  assert.equal(
    decide(policy, 'GET', '/api/sessions', { query: { sessionPath: '/tmp/real.jsonl' } }).kind,
    'deny',
    '带真实 sessionPath 的 GET 必须拒绝',
  );
  assert.equal(
    decide(policy, 'GET', '/api/sessions', { query: { sessionId: 'real-id' } }).kind,
    'deny',
    '带真实 sessionId 的 GET 必须拒绝',
  );
  assert.equal(decide(policy, 'GET', '/api/sessions').kind, 'allow', '普通会话列表必须放行');
  assert.equal(decide(policy, 'GET', '/api/sessions/abc').kind, 'deny', '会话明细 GET 不在白名单内');

  // 新会话：cwd 必须在 fixture 根内。
  assert.equal(decide(policy, 'POST', '/api/sessions', { body: {} }).kind, 'deny', '缺 cwd 必须拒绝');
  assert.equal(
    decide(policy, 'POST', '/api/sessions', { body: { cwd: PROJECT_ROOT } }).kind,
    'deny',
    'cwd 指向项目必须拒绝：验收会在真实树里写文件',
  );
  assert.equal(
    decide(policy, 'POST', '/api/sessions', { body: { cwd: policy.fixtureRoot } }).kind,
    'allow',
    'fixture 根内新建会话必须放行',
  );
  for (const field of ['sessionPath', 'sessionId']) {
    assert.equal(
      decide(policy, 'POST', '/api/sessions', {
        body: { cwd: policy.fixtureRoot, [field]: '/tmp/real.jsonl' },
      }).kind,
      'deny',
      `新建会话带 ${field} 必须拒绝`,
    );
  }

  // fork：只允许进程内 sessionId，按 path 一律拒绝。
  assert.equal(
    decide(policy, 'POST', '/api/sessions/fork', { body: { path: '/tmp/real.jsonl' } }).kind,
    'deny',
    'fork by path 必须拒绝：那是真实转录',
  );
  assert.equal(decide(policy, 'POST', '/api/sessions/fork', { body: {} }).kind, 'deny', 'fork 缺 sessionId 必须拒绝');
  assert.equal(
    decide(policy, 'POST', '/api/sessions/fork', { body: { sessionId: 'in-process-1' } }).kind,
    'allow',
    '进程内 sessionId 的 fork 必须放行',
  );
  assert.equal(
    decide(policy, 'POST', '/api/sessions/fork', {
      body: { sessionId: 'in-process-1', cwd: PROJECT_ROOT },
    }).kind,
    'deny',
    'fork 的 cwd 指向项目必须拒绝',
  );

  // 命令面：工具、路由与 shell 都钉住。
  const command = (body: Record<string, unknown>) =>
    decide(policy, 'POST', '/api/sessions/s1/command', { body: { command: { type: 'prompt', ...body } } });
  assert.equal(command({}).kind, 'allow', 'prompt 必须放行');
  for (const type of DENIED_COMMANDS) {
    const decision = decide(policy, 'POST', '/api/sessions/s1/command', { body: { command: { type } } });
    assert.equal(decision.kind, 'deny', `命令 ${type} 必须拒绝`);
  }
  assert.equal(
    decide(policy, 'POST', '/api/sessions/s1/command', {
      body: { command: { type: 'set_tools', toolNames: ['read', 'bash'] } },
    }).kind,
    'deny',
    'set_tools 扩到 bash 必须拒绝：测试只读',
  );
  assert.equal(
    decide(policy, 'POST', '/api/sessions/s1/command', {
      body: { command: { type: 'set_tools', toolNames: ['read'] } },
    }).kind,
    'allow',
    'set_tools 仅 read 必须放行',
  );
  assert.equal(command({ provider: 'other' }).kind, 'deny', '指定其它 provider 必须拒绝');
  assert.equal(command({ modelId: 'gpt-x' }).kind, 'deny', '指定其它模型必须拒绝');
  assert.equal(
    command({ provider: ALLOWED_PROVIDER, modelId: 'deepseek/deepseek-v4.1-flash' }).kind,
    'allow',
    '指定允许的 provider/模型必须放行',
  );
  assert.equal(
    decide(policy, 'POST', '/api/sessions/s1/command', { body: { command: { type: 'nope' } } }).kind,
    'deny',
    '未知命令必须拒绝',
  );

  // 定义 CRUD：放行写入（测试目标本身），但仍受管理面拒绝约束。
  assert.equal(decide(policy, 'POST', '/api/agent-definitions').kind, 'allow', '定义写入必须放行');
  assert.equal(decide(policy, 'PATCH', '/api/agent-definitions/a1').kind, 'allow', '定义编辑必须放行');
  assert.equal(decide(policy, 'DELETE', '/api/agent-definitions/a1').kind, 'allow', '定义删除必须放行');
  assert.equal(decide(policy, 'PUT', '/api/unknown').kind, 'deny', '白名单外的写入必须拒绝');
});

/* -------------------------------------------------- credential store contract */

const SECRET = 'sk-test-secret-must-not-leak';
const credential = { type: 'api_key' as const, key: SECRET };
let readCalls: string[] = [];
const store = createReadOnlyCredentialStore('/nonexistent/auth.json', ALLOWED_PROVIDER, (providerId) => {
  readCalls.push(providerId);
  return providerId === ALLOWED_PROVIDER ? credential : undefined;
});

assert.equal(await store.read(ALLOWED_PROVIDER), credential, '允许的 provider 必须拿到凭据（交 SDK 内存消费）');

readCalls = [];
assert.equal(await store.read('openai'), undefined, '其它 provider 必须返回 undefined');
assert.deepEqual(readCalls, [], '其它 provider 不得触发任何凭据读取——不许读不需要的 secret');

const info = await store.list();
assert.deepEqual(info, [{ providerId: ALLOWED_PROVIDER, type: 'api_key' }], 'list 只允许 {providerId,type} 元数据');
assert.equal(JSON.stringify(info).includes(SECRET), false, 'list 结果绝不能含 secret 值');

for (const operation of ['modify', 'delete'] as const) {
  assert.throws(
    () => (store[operation] as unknown as () => unknown)(),
    /cannot modify|Read-only/i,
    `${operation} 必须抛错：只读语义要可断言，不能只是约定`,
  );
}
assert.equal(
  Object.values(store).every((member) => typeof member === 'function'),
  true,
  'CredentialStore 适配器只应暴露方法，不携带任何数据字段',
);
// 取消 token：签名必须接受 signal，而不是吞掉它。
assert.equal(store.read.length >= 1, true, 'read 必须接受参数（含可选 signal）');
assert.equal(store.list.length >= 0, true, 'list 必须可被无参调用');

/* -------------------------------------- unsupported credential stops startup */

assert.equal(
  describeCredential('/nonexistent/auth.json', ALLOWED_PROVIDER, () => ({ type: 'api_key', key: SECRET })),
  'api_key',
  '有 api_key 条目时必须报告其类型',
);
// 缺条目不是错误：provider 的 key 可能由 SDK 只读载入的 models.json 配置提供，
// 解析器对 credential: undefined 是接受的。这里绝不能再退回 fail fast。
assert.equal(
  describeCredential('/nonexistent/auth.json', ALLOWED_PROVIDER, () => undefined),
  'absent',
  '缺失条目必须报告 absent 而不是阻塞：config 提供的 auth 是合法路径',
);
const oauthCredential = {
  type: 'oauth' as const,
  refresh: 'r',
  access: 'a',
  expires: 0,
};
assert.throws(
  () => describeCredential('/nonexistent/auth.json', ALLOWED_PROVIDER, () => oauthCredential),
  UnsupportedCredentialError,
  'OAuth 凭据必须阻塞：本适配器不实现 refresh，不假装支持',
);
const unsupportedMessage = (() => {
  try {
    describeCredential('/nonexistent/auth.json', ALLOWED_PROVIDER, () => oauthCredential);
    return '';
  } catch (error: unknown) {
    return error instanceof Error ? error.message : '';
  }
})();
assert.equal(unsupportedMessage.includes(SECRET), false, '阻塞消息里不得出现任何 secret 值');

/* ------------------------------------------- symlinked temp root regression */

{
  // macOS 的 OS tmp 根是符号链接（/var -> /private/var）。调用方按环境给出的
  // RUN_DIR 传 cwd 是合法的，但它的字面路径与 canonical fixtureRoot 不同前缀；
  // 曾经因此把**合法**的 fixture cwd 判成越界（真机复现过），这里钉住修复。
  const runDir = mkdtempSync(path.join(TMP, 'pi-webx-sut-'));
  try {
    const fixturePath = path.join(runDir, 'fixtures');
    mkdirSync(fixturePath, { recursive: true });
    const fixtureRoot = realpathSync(fixturePath);
    const policy: TestGatePolicy = {
      runDir,
      fixtureRoot,
      model: { providerId: ALLOWED_PROVIDER, modelId: 'deepseek/deepseek-v4.1-flash' },
      allowedCommands: new Set(DEFAULT_ALLOWED_COMMANDS),
    };
    const decision = decideRequest(policy, {
      method: 'POST',
      path: '/api/sessions',
      body: { cwd: path.join(runDir, 'fixtures') },
    });
    assert.equal(
      decision.kind,
      'allow',
      '符号链接同一目录下的 fixture cwd 必须放行：不能因 /var 与 /private/var 前缀差异误判越界',
    );
    // 反向仍需拒绝：真越界不能因为规范化而被放过。
    assert.equal(
      decideRequest(policy, { method: 'POST', path: '/api/sessions', body: { cwd: '/tmp' } }).kind,
      'deny',
      '规范化不能把真实越界路径放进来',
    );
    assert.equal(canonicalize(path.join(runDir, 'fixtures')), fixtureRoot, 'canonicalize 必须与 realpath 一致');
    assert.equal(canonicalize('/nonexistent/definitely/not/here'), '/nonexistent/definitely/not/here', '不存在路径必须回退为 resolve 结果而不是抛错');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------- static SPA assets */

{
  // 缺 dist/index.html：必须报告 missing，让调用方 fail fast，而不是静默退化成纯 API。
  const recorders: string[] = [];
  const app = { use: (...handlers: unknown[]) => { recorders.push(`mw${handlers.length}`); } };
  const missing = attachStaticAssets(app, '/nonexistent-dist', () => false, () => undefined);
  assert.equal(missing.kind, 'missing', '缺 dist/index.html 必须报 missing（fail fast 的依据）');
  assert.equal(recorders.length, 0, '缺 index.html 时不得挂任何静态中间件');
  assert.equal(missing.indexHtml.endsWith('index.html'), true, 'missing 结果必须带出期望路径');

  // 有 index.html：挂 static + SPA fallback 两层，且 /api 与非 GET 都交给下游。
  const mws: Array<(req: { method: string; path: string }, res: unknown, next: () => void) => void> = [];
  const app2 = { use: (...handlers: unknown[]) => { for (const h of handlers) mws.push(h as never); } };
  const served = attachStaticAssets(app2, '/fake-dist', () => true, () => undefined);
  assert.equal(served.kind, 'served', '存在 index.html 时必须 report served');
  assert.equal(mws.length, 2, 'served 时必须同时挂 static 与 SPA fallback');

  const fallback = mws[1]!;
  let sent: string | undefined;
  let nexted = false;
  const res = { sendFile: (file: string) => { sent = file; } };
  fallback({ method: 'GET', path: '/' }, res, () => { nexted = true; });
  assert.equal(sent?.endsWith('index.html'), true, '非 /api 的 GET 必须回 SPA index.html');
  assert.equal(nexted, false, 'SPA fallback 命中后不得继续 next');

  sent = undefined;
  fallback({ method: 'GET', path: '/api/health' }, res, () => { nexted = true; });
  assert.equal(sent, undefined, '/api 路径必须交给 API 链路，不能被 SPA 吞掉');

  nexted = false;
  fallback({ method: 'POST', path: '/' }, res, () => { nexted = true; });
  assert.equal(nexted, true, '非 GET/HEAD 不得走 SPA fallback');
}

/* ------------------------------------------------- no secret in what we log */

withRunDir((runDir) => {
  // 这里刻意用假值：断言的是「日志面不含 secret」，不是真实密钥。
  const policy = policyFor(runDir);
  const serialized = JSON.stringify({ runDir, fixtureRoot: policy.fixtureRoot, model: policy.model });
  assert.equal(serialized.includes(SECRET), false, '环境/策略序列化里不得出现 secret 值');
  assert.equal(/["'](key|apiKey|token|secret)["']\s*:/i.test(serialized), false, '不得携带任何 secret 字段名');
});

/* -------------------------------------------- metadata fingerprint is read-only */

await withRunDirAsync(async (runDir) => {
  const target = path.join(runDir, 'probe.txt');
  writeFileSync(target, 'hello');
  const before = statSync(target);
  const fingerprint = await fingerprintFile(target);
  const after = statSync(target);
  assert.equal(fingerprint.exists, true, '存在的文件必须被指纹记录');
  assert.equal(fingerprint.sha256?.length, 64, 'sha256 必须是 64 位十六进制串');
  assert.equal(after.size, before.size, '指纹核对不得改变文件大小');
  assert.equal(after.mtimeMs, before.mtimeMs, '指纹核对必须是只读：mtime 不许变');
  const missing = await fingerprintFile(path.join(runDir, 'nope.txt'));
  assert.equal(missing.exists, false, '缺失文件必须报 exists=false，而不是抛错');
});

console.log(
  'PASS 隔离测试服务：RUN_DIR 限 OS tmp 且 0700、管理面全拒、stored-sessions 空应答、' +
    '会话仅 fixture 新建/fork 仅进程内、命令禁 shell 与换模型、凭据只读且单 provider、' +
    '不支持凭据启动即阻塞、日志无 secret',
);
