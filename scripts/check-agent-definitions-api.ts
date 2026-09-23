/**
 * Self-check for `server/agent-definitions-routes.ts` — the HTTP management
 * surface.
 *
 * Boots a real Express app on a random loopback port with a temp store and a
 * mock host, then drives it over `fetch`. Nothing here touches a real session, a
 * model runtime or the user's `~/.pi/agent/**`: the mock host counts model
 * lookups and the check asserts that count is zero.
 *
 *   npx tsx scripts/check-agent-definitions-api.ts
 *
 * Covers: the happy paths and their status codes (201/200), `{error}`-only
 * bodies, the `application/json` write guard, cross-site refusal (Origin,
 * Sec-Fetch-Site, and a spoofed `X-Forwarded-Host` that must not help), the
 * explicit `PI_WEBX_ALLOWED_ORIGIN` allowance, session-scoped vs builtin tool
 * catalogues with builtin/extension classification and restricted names removed,
 * fixed-model refusal before any write, and "no CRUD on the command surface".
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';

import express from 'express';

import { AgentDefinitionStore } from '../server/agent-definitions';
import { createAgentDefinitionsRouter } from '../server/agent-definitions-routes';
import type { PiHost } from '../server/pi/host';
import type {
  AgentDefinition,
  AgentDefinitionsResponse,
  AgentToolsResponse,
} from '../src/shared/agent-definitions';

let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((error: unknown) => {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(error instanceof Error ? error.message : String(error));
    });
}

const root = mkdtempSync(path.join(os.tmpdir(), 'piwebx-agentdefs-api-'));
const dir = path.join(root, 'store');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const filePath = path.join(dir, 'agent-definitions.json');
const store = new AgentDefinitionStore({ filePath });

/** Model lookups observed by the mock host; the check requires zero. */
let modelCalls = 0;

/** What `resolveModel` was asked, so the fixed-model path is observable. */
const resolvedAsks: string[] = [];
let resolveModelAnswer = true;

const mockHost = {
  get: (id: string) =>
    id === 'live'
      ? {
          session: {
            getAllTools: () => [
              { name: 'read', description: 'Read a file.' },
              { name: 'my_ext_tool', description: 'An extension tool.' },
              { name: 'subagent', description: 'Dispatch (must never be offered).' },
            ],
          },
        }
      : undefined,
  getModelRuntime: async () => {
    modelCalls += 1;
    throw new Error('this check must never need a model runtime');
  },
};
// A test double, not a request body: only the two members the router uses are
// implemented, and `resolveModel` below keeps the real catalog path out of it.
const host = mockHost as unknown as PiHost;

const app = express();
app.use(express.json());
app.use(
  '/api/agent-definitions',
  createAgentDefinitionsRouter({
    store,
    host,
    resolveModel: async (providerId, modelId) => {
      resolvedAsks.push(`${providerId}/${modelId}`);
      return resolveModelAnswer;
    },
  }),
);
app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

const server = createServer(app);

interface Answer {
  status: number;
  contentType: string;
  body: unknown;
}

async function call(
  method: string,
  route: string,
  options: { body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let payload: string | undefined;
  if (options.raw !== undefined) {
    payload = options.raw;
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  }
  const response = await fetch(`${base}${route}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // Leave the raw text: a non-JSON body is itself a failure worth seeing.
  }
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: parsed };
}

function input(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: 'A test agent.',
    systemPrompt: 'Do the thing.',
    model: { mode: 'inherit' },
    tools: { mode: 'all' },
    maxTurns: 4,
    maxConcurrentInstances: 1,
    enabled: true,
    ...overrides,
  };
}

function expectErrorBody(answer: Answer, status: number, label: string): string {
  assert.equal(answer.status, status, `${label}: status`);
  assert.ok(answer.contentType.includes('application/json'), `${label}: json content type`);
  const body = answer.body;
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body), `${label}: object body`);
  assert.deepEqual(Object.keys(body as object), ['error'], `${label}: {error} only`);
  const message = (body as { error: unknown }).error;
  assert.equal(typeof message, 'string', `${label}: error is a string`);
  assert.ok((message as string).trim().length > 0, `${label}: message not empty`);
  return message as string;
}

/** The user definitions in a response: built-ins are always merged in first. */
function users(body: unknown): AgentDefinition[] {
  return (body as AgentDefinitionsResponse).agents.filter((agent) => agent.source === 'user');
}

/** The n-th user definition — what essentially every case here creates. */
function userAt(body: unknown, index = 0): AgentDefinition {
  const found = users(body)[index];
  assert.ok(found !== undefined, `user definition #${String(index)} exists`);
  return found;
}

/**
 * A fingerprint of the definitions file, or `absent` when it does not exist.
 *
 * "Unchanged" has to cover "still not created": a refused write must not create
 * the file, and reading it to hash it would itself be the failure.
 */
function fileState(): string {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return 'absent';
  }
}

async function currentRevision(): Promise<number> {
  const answer = await call('GET', '/api/agent-definitions');
  assert.equal(answer.status, 200, 'reading the file for its revision');
  return (answer.body as AgentDefinitionsResponse).revision;
}

/**
 * A request whose `Host` header keeps its written case.
 *
 * `fetch` normalizes what it can and forbids some headers, so the case-folding
 * check needs a hand-written request: the point is a client (or a
 * case-preserving proxy) sending `Host: LocalHost:port` while the browser-shaped
 * `Origin` is already lowercased by `URL`.
 */
function rawRequest(options: {
  method: string;
  port: number;
  path: string;
  hostHeader: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: unknown }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          host: options.hostHeader,
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          let parsed: unknown = text;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : undefined;
          } catch {
            // Raw text is itself worth seeing.
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

let base = '';

async function main(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'server address');
  const port = address.port;
  base = `http://127.0.0.1:${String(port)}`;
  const sameOrigin = base;

  await check('GET / is an empty store at revision 0 with the server path', async () => {
    const answer = await call('GET', '/api/agent-definitions');
    assert.equal(answer.status, 200);
    const body = answer.body as AgentDefinitionsResponse;
    assert.equal(body.revision, 0);
    assert.deepEqual(users(answer.body), [], 'no user definitions yet');
    assert.deepEqual(
      body.agents.map((agent) => agent.id),
      ['builtin:general-purpose', 'builtin:explore'],
    );
    assert.equal(body.path, filePath);
  });

  await check('the built-ins are listed, read-only, and server-owned', async () => {
    const answer = await call('GET', '/api/agent-definitions');
    const agents = (answer.body as AgentDefinitionsResponse).agents;
    const general = agents[0]!;
    assert.equal(general.id, 'builtin:general-purpose');
    assert.equal(general.source, 'builtin');
    assert.equal(general.readOnly, true);
    assert.equal(general.enabled, true);
    assert.equal(general.color, 'blue');
    assert.equal(general.injectAgentsMd, true);
    assert.equal(agents[1]!.id, 'builtin:explore');
    assert.deepEqual(agents[1]!.tools, { mode: 'selected', names: ['read', 'grep', 'find', 'ls'] });

    const before = fileState();
    assert.equal(
      expectErrorBody(
        await call('PATCH', '/api/agent-definitions/builtin:general-purpose', {
          body: { expectedRevision: await currentRevision(), patch: { description: 'hijacked' } },
        }),
        400,
        'patch a built-in',
      ),
      '内置子智能体不可修改',
    );
    assert.equal(
      expectErrorBody(
        await call('DELETE', '/api/agent-definitions/builtin:explore', {
          body: { expectedRevision: await currentRevision() },
        }),
        400,
        'delete a built-in',
      ),
      '内置子智能体不可删除',
    );
    assert.equal(fileState(), before, 'refused built-in writes leave the file untouched (still absent)');

    // The derived fields are server-owned: a request cannot forge them.
    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        body: {
          expectedRevision: await currentRevision(),
          definition: { ...input('forge-source'), source: 'builtin' },
        },
      }),
      400,
      'source is server-owned',
    );
    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        body: {
          expectedRevision: await currentRevision(),
          definition: { ...input('forge-readonly'), readOnly: true },
        },
      }),
      400,
      'readOnly is server-owned',
    );
    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        body: {
          expectedRevision: await currentRevision(),
          definition: { ...input('forge-id'), id: 'builtin:mine' },
        },
      }),
      400,
      'id is server-owned',
    );
  });

  await check('POST / creates (201) and the body is the whole file', async () => {
    const answer = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: 0, definition: input('scout') },
    });
    assert.equal(answer.status, 201);
    const body = answer.body as AgentDefinitionsResponse;
    assert.equal(body.revision, 1);
    assert.equal(users(body).length, 1, 'one user definition, plus the two built-ins');
    assert.equal(userAt(body, 0).name, 'scout');
    assert.equal(userAt(body, 0).enabled, true);
  });

  await check('a stale expectedRevision is 409; a bad definition is 400', async () => {
    const stale = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: 0, definition: input('other') },
    });
    expectErrorBody(stale, 409, 'stale create');
    const bad = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: 1, definition: input('bad', { maxTurns: 0 }) },
    });
    expectErrorBody(bad, 400, 'maxTurns 0');
    const after = await call('GET', '/api/agent-definitions');
    assert.equal(users(after.body).length, 1, 'a refused write changed nothing');
  });

  await check('PATCH bumps and DELETE removes, with 404 for unknown ids', async () => {
    const current = (await call('GET', '/api/agent-definitions')).body as AgentDefinitionsResponse;
    const id = userAt(current, 0).id;
    const patched = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: current.revision, patch: { description: 'updated' } },
    });
    assert.equal(patched.status, 200);
    const afterPatch = patched.body as AgentDefinitionsResponse;
    assert.equal(userAt(afterPatch, 0).description, 'updated');
    assert.equal(userAt(afterPatch, 0).revision, 2);

    const noop = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: afterPatch.revision, patch: {} },
    });
    assert.equal((noop.body as AgentDefinitionsResponse).revision, afterPatch.revision, 'no-op patch');

    expectErrorBody(
      await call('PATCH', '/api/agent-definitions/nope', { body: { expectedRevision: afterPatch.revision, patch: {} } }),
      404,
      'patch unknown id',
    );
    expectErrorBody(
      await call('DELETE', '/api/agent-definitions/nope', { body: { expectedRevision: afterPatch.revision } }),
      404,
      'delete unknown id',
    );

    const deleted = await call('DELETE', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: afterPatch.revision },
    });
    assert.equal(deleted.status, 200);
    assert.equal(users(deleted.body).length, 0);
  });

  await check('PATCH thinkingLevel: omit preserves, null clears, a level sets', async () => {
    const created = await call('POST', '/api/agent-definitions', {
      body: {
        expectedRevision: await currentRevision(),
        definition: { ...input('level-agent'), thinkingLevel: 'low' },
      },
    });
    assert.equal(created.status, 201);
    const id = (created.body as AgentDefinitionsResponse).agents.find((agent) => agent.name === 'level-agent')!.id;

    const findById = (body: unknown): Record<string, unknown> =>
      (body as AgentDefinitionsResponse).agents.find((agent) => agent.id === id) as unknown as Record<string, unknown>;

    // 1) a patch that says nothing about the level leaves it alone
    const renamed = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: await currentRevision(), patch: { description: 'edited' } },
    });
    assert.equal(renamed.status, 200);
    assert.equal(findById(renamed.body)['thinkingLevel'], 'low', 'omitting the key preserves the level');

    // 2) null clears it, and the returned JSON has no key to render
    const cleared = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: await currentRevision(), patch: { thinkingLevel: null } },
    });
    assert.equal(cleared.status, 200, 'null must be an accepted patch value');
    assert.equal(Object.hasOwn(findById(cleared.body), 'thinkingLevel'), false, 'no key in the response');
    assert.equal(readFileSync(filePath, 'utf8').includes('thinkingLevel'), false, 'no key on disk either');

    // 3) an explicit level sets again
    const set = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: await currentRevision(), patch: { thinkingLevel: 'high' } },
    });
    assert.equal(set.status, 200);
    assert.equal(findById(set.body)['thinkingLevel'], 'high');

    // null is patch-only: a create must refuse it and leave the file alone
    const before = readFileSync(filePath, 'utf8');
    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        body: {
          expectedRevision: await currentRevision(),
          definition: { ...input('null-create'), thinkingLevel: null },
        },
      }),
      400,
      'create with thinkingLevel null',
    );
    assert.equal(readFileSync(filePath, 'utf8'), before, 'a refused create writes nothing');

    expectErrorBody(
      await call('PATCH', `/api/agent-definitions/${id}`, {
        body: { expectedRevision: await currentRevision(), patch: { thinkingLevel: 'ultra' } },
      }),
      400,
      'a bogus level is still a bogus level',
    );
    expectErrorBody(
      await call('PATCH', `/api/agent-definitions/${id}`, {
        body: { expectedRevision: await currentRevision(), patch: { role: 'orchestrator' } },
      }),
      400,
      'unknown patch key',
    );
  });

  await check('color and injectAgentsMd round-trip; color:null deletes the key', async () => {
    const created = await call('POST', '/api/agent-definitions', {
      body: {
        expectedRevision: await currentRevision(),
        definition: { ...input('coloured-api'), color: 'orange', injectAgentsMd: false },
      },
    });
    assert.equal(created.status, 201);
    const agentOf = (body: unknown): Record<string, unknown> =>
      (body as AgentDefinitionsResponse).agents.find(
        (agent) => agent.name === 'coloured-api',
      ) as unknown as Record<string, unknown>;
    assert.equal(agentOf(created.body)['color'], 'orange');
    assert.equal(agentOf(created.body)['injectAgentsMd'], false, 'an explicit false is written');

    const id = (created.body as AgentDefinitionsResponse).agents.find(
      (agent) => agent.name === 'coloured-api',
    )!.id;

    // Omit keeps both.
    const untouched = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: await currentRevision(), patch: { description: 'kept both' } },
    });
    assert.equal(untouched.status, 200);
    assert.equal(agentOf(untouched.body)['color'], 'orange', 'omitting color preserves it');
    assert.equal(agentOf(untouched.body)['injectAgentsMd'], false, 'omitting the toggle preserves false');

    // null deletes the colour, the response has no key, and the file does not
    // spell a null either.
    const cleared = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: await currentRevision(), patch: { color: null } },
    });
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn(agentOf(cleared.body), 'color'), false, 'no color key in the response');
    assert.equal(readFileSync(filePath, 'utf8').includes('"color"'), false, 'no color key on disk');

    const flipped = await call('PATCH', `/api/agent-definitions/${id}`, {
      body: { expectedRevision: await currentRevision(), patch: { injectAgentsMd: true } },
    });
    assert.equal(flipped.status, 200);
    assert.equal(agentOf(flipped.body)['injectAgentsMd'], true);
  });

  await check('new fields and names reject bad input with ZCode copy, file untouched', async () => {
    const sha = (): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');

    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        body: {
          expectedRevision: await currentRevision(),
          definition: { ...input('bad-colour-api'), color: 'turquoise' },
        },
      }),
      400,
      'unknown colour',
    );
    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        body: {
          expectedRevision: await currentRevision(),
          definition: { ...input('bad-inject-api'), injectAgentsMd: 'yes' },
        },
      }),
      400,
      'non-boolean injectAgentsMd',
    );

    // The name rule: 2 and 51 code points refused, 3 Chinese ones accepted.
    const shortName = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('ab') },
    });
    assert.equal(
      expectErrorBody(shortName, 400, '2-code-point name'),
      '长度必须在 3 到 50 个字符之间',
      'the length message is ZCode\'s, verbatim',
    );
    assert.equal(
      expectErrorBody(
        await call('POST', '/api/agent-definitions', {
          body: { expectedRevision: await currentRevision(), definition: input('a'.repeat(51)) },
        }),
        400,
        '51-code-point name',
      ),
      '长度必须在 3 到 50 个字符之间',
    );
    assert.equal(
      expectErrorBody(
        await call('POST', '/api/agent-definitions', {
          body: { expectedRevision: await currentRevision(), definition: input('有 空格') },
        }),
        400,
        'name with a space',
      ),
      '仅允许使用字母、数字和连字符',
    );

    // Unknown keys are still refused after the new fields joined the allowlist.
    const before = sha();
    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        body: {
          expectedRevision: await currentRevision(),
          definition: { ...input('unknown-key-api'), skills: ['x'] },
        },
      }),
      400,
      'unknown definition key',
    );
    const current = (await call('GET', '/api/agent-definitions')).body as AgentDefinitionsResponse;
    expectErrorBody(
      await call('PATCH', `/api/agent-definitions/${userAt(current, 0).id}`, {
        body: { expectedRevision: current.revision, patch: { permissionMode: 'read' } },
      }),
      400,
      'unknown patch key',
    );
    assert.equal(sha(), before, 'refused writes leave the file byte-identical');

    const chinese = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('代码审查员') },
    });
    assert.equal(chinese.status, 201, 'a Chinese name of five code points is legal');
  });

  await check('writes require application/json', async () => {
    expectErrorBody(
      await call('POST', '/api/agent-definitions', {
        raw: JSON.stringify({ expectedRevision: await currentRevision(), definition: input('plain') }),
        headers: { 'content-type': 'text/plain' },
      }),
      400,
      'text/plain body',
    );
    // No body at all: `fetch` sets no content type, which is the native-caller
    // shape the guard must refuse rather than treat as an empty edit.
    expectErrorBody(await call('POST', '/api/agent-definitions'), 400, 'no content type');

    const withCharset = await call('POST', '/api/agent-definitions', {
      raw: JSON.stringify({ expectedRevision: await currentRevision(), definition: input('charset') }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    assert.equal(withCharset.status, 201, 'the media type is parsed, so a charset parameter is fine');
  });

  await check('cross-site writers are refused; same-origin and native callers are not', async () => {
    const crossOrigin = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('evil') },
      headers: { origin: 'http://evil.example' },
    });
    expectErrorBody(crossOrigin, 403, 'cross-origin');

    // A spoofable forwarding header must not be what decides.
    const spoofed = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('evil2') },
      headers: { origin: 'http://evil.example', 'x-forwarded-host': 'evil.example' },
    });
    expectErrorBody(spoofed, 403, 'x-forwarded-host does not authorize');

    const wrongPort = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('evil3') },
      headers: { origin: `http://127.0.0.1:${String(port + 1)}`, 'x-forwarded-host': `127.0.0.1:${String(port + 1)}` },
    });
    expectErrorBody(wrongPort, 403, 'origin port mismatch');

    const fetchSite = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('evil4') },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expectErrorBody(fetchSite, 403, 'sec-fetch-site');

    const same = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('same-origin') },
      headers: { origin: sameOrigin },
    });
    assert.equal(same.status, 201, 'same-origin is allowed (changeOrigin:false keeps Host = Origin)');

    const native = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('native-caller') },
    });
    assert.equal(native.status, 201, 'no Origin at all is a native caller');

    const previous = process.env['PI_WEBX_ALLOWED_ORIGIN'];
    process.env['PI_WEBX_ALLOWED_ORIGIN'] = 'http://proxy.internal:8443';
    try {
      const allowed = await call('POST', '/api/agent-definitions', {
        body: { expectedRevision: await currentRevision(), definition: input('proxied') },
        headers: { origin: 'http://proxy.internal:8443' },
      });
      assert.equal(allowed.status, 201, 'the explicit allowlist admits a proxied origin');
    } finally {
      if (previous === undefined) delete process.env['PI_WEBX_ALLOWED_ORIGIN'];
      else process.env['PI_WEBX_ALLOWED_ORIGIN'] = previous;
    }
  });

  await check('Host/Origin comparison folds case but not port, and trusts no substring', async () => {
    const writeBody = async (name: string): Promise<unknown> => ({
      expectedRevision: await currentRevision(),
      definition: input(name),
    });

    // `Host` as written, `Origin` as a browser/`URL` would normalize it — the
    // same origin, so it must pass.
    const folded = await rawRequest({
      method: 'POST',
      port,
      path: '/api/agent-definitions',
      hostHeader: `LocalHost:${String(port)}`,
      headers: { origin: `http://localhost:${String(port)}` },
      body: await writeBody('case-folded-host'),
    });
    assert.equal(folded.status, 201, 'DNS names are case-insensitive: this is same-origin');

    const evil = await rawRequest({
      method: 'POST',
      port,
      path: '/api/agent-definitions',
      hostHeader: `LocalHost:${String(port)}`,
      headers: { origin: 'http://evil.example' },
      body: await writeBody('case-folded-evil'),
    });
    assert.equal(evil.status, 403, 'case folding must not admit a different host');

    const wrongPort = await rawRequest({
      method: 'POST',
      port,
      path: '/api/agent-definitions',
      hostHeader: `LocalHost:${String(port)}`,
      headers: { origin: `http://localhost:${String(port + 1)}` },
      body: await writeBody('case-folded-port'),
    });
    assert.equal(wrongPort.status, 403, 'the port is still compared');

    // The allowlist is an exact origin match, never a substring test.
    const previous = process.env['PI_WEBX_ALLOWED_ORIGIN'];
    process.env['PI_WEBX_ALLOWED_ORIGIN'] = 'http://proxy.internal:8443';
    try {
      const needed = await rawRequest({
        method: 'POST',
        port,
        path: '/api/agent-definitions',
        hostHeader: `LocalHost:${String(port)}`,
        headers: { origin: 'http://proxy.internal:8443' },
        body: await writeBody('allowlisted-exact'),
      });
      assert.equal(needed.status, 201, 'the exact allowlisted origin still passes');

      const embedded = await rawRequest({
        method: 'POST',
        port,
        path: '/api/agent-definitions',
        hostHeader: `LocalHost:${String(port)}`,
        headers: { origin: 'http://evil.example/?next=http://proxy.internal:8443' },
        body: await writeBody('allowlisted-substring'),
      });
      assert.equal(embedded.status, 403, 'a substring of a trusted origin is not trusted');
    } finally {
      if (previous === undefined) delete process.env['PI_WEBX_ALLOWED_ORIGIN'];
      else process.env['PI_WEBX_ALLOWED_ORIGIN'] = previous;
    }
  });

  await check('GET /tools without a session lists builtins, no restricted names', async () => {
    const answer = await call('GET', '/api/agent-definitions/tools');
    assert.equal(answer.status, 200);
    const body = answer.body as AgentToolsResponse;
    assert.equal(body.sessionScoped, false);
    const names = body.tools.map((tool) => tool.name);
    for (const builtin of ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']) {
      assert.ok(names.includes(builtin), `builtin ${builtin} is offered`);
    }
    assert.ok(body.tools.every((tool) => tool.source === 'builtin'), 'no session means builtin only');
    for (const restricted of ['subagent', 'Agent', 'workflow']) {
      assert.equal(names.includes(restricted), false, `${restricted} must not be offered`);
    }
    assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right, 'en')), 'sorted');
    assert.deepEqual(names, [...new Set(names)], 'deduped');
    assert.ok(body.excluded.some((entry) => entry.includes('agent_definition')), 'excluded list is reported');
  });

  await check('GET /tools?sessionId classifies builtin vs extension and drops restricted', async () => {
    const answer = await call('GET', '/api/agent-definitions/tools?sessionId=live');
    assert.equal(answer.status, 200);
    const body = answer.body as AgentToolsResponse;
    assert.equal(body.sessionScoped, true);
    const byName = new Map(body.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('read')?.source, 'builtin');
    assert.equal(byName.get('my_ext_tool')?.source, 'extension');
    assert.equal(byName.has('subagent'), false, 'the dispatch tool is filtered from a live session too');
    expectErrorBody(
      await call('GET', '/api/agent-definitions/tools?sessionId=missing'),
      404,
      'unknown session',
    );
  });

  await check('a fixed model is verified before anything is written', async () => {
    const before = readFileSync(filePath, 'utf8');
    const current = (await call('GET', '/api/agent-definitions')).body as AgentDefinitionsResponse;

    resolveModelAnswer = false;
    const refused = await call('POST', '/api/agent-definitions', {
      body: {
        expectedRevision: current.revision,
        definition: input('fixed-bad', { model: { mode: 'fixed', providerId: 'p', modelId: 'm' } }),
      },
    });
    expectErrorBody(refused, 400, 'unroutable fixed model');
    assert.equal(readFileSync(filePath, 'utf8'), before, 'a refused fixed model must not write');
    assert.deepEqual(resolvedAsks, ['p/m'], 'the check asked about the requested pair');

    resolveModelAnswer = true;
    const accepted = await call('POST', '/api/agent-definitions', {
      body: {
        expectedRevision: current.revision,
        definition: input('fixed-ok', { model: { mode: 'fixed', providerId: 'p', modelId: 'm' } }),
      },
    });
    assert.equal(accepted.status, 201);

    const latest = (await call('GET', '/api/agent-definitions')).body as AgentDefinitionsResponse;
    resolveModelAnswer = false;
    expectErrorBody(
      await call('PATCH', `/api/agent-definitions/${userAt(latest, 0).id}`, {
        body: {
          expectedRevision: latest.revision,
          patch: { model: { mode: 'fixed', providerId: 'x', modelId: 'y' } },
        },
      }),
      400,
      'patch to an unroutable fixed model',
    );
  });

  await check('a same-named user definition replaces the built-in over HTTP', async () => {
    const created = await call('POST', '/api/agent-definitions', {
      body: { expectedRevision: await currentRevision(), definition: input('general-purpose') },
    });
    assert.equal(created.status, 201);
    const ids = (created.body as AgentDefinitionsResponse).agents.map((agent) => agent.id);
    assert.equal(ids.includes('builtin:general-purpose'), false, 'the shadowed built-in is gone');
    assert.equal(ids.includes('builtin:explore'), true);
    // By name, not by index: earlier cases left their own user definitions behind.
    const mine = (created.body as AgentDefinitionsResponse).agents.find(
      (agent) => agent.name === 'general-purpose',
    )!;
    assert.equal(mine.source, 'user', 'the user definition is the one listed');
    assert.equal(mine.readOnly, false);
  });

  await check('management is HTTP-only: no command route, no model lookup', async () => {
    // Nothing under this namespace answers to a command-style path.
    expectErrorBody(
      await call('POST', '/api/agent-definitions/command', { body: { command: { type: 'prompt' } } }),
      404,
      'command path',
    );
    expectErrorBody(await call('POST', '/api/agent-definitions/tools', { body: {} }), 404, 'tools is GET-only');

    const methods: string[] = [];
    const router = createAgentDefinitionsRouter({
      store,
      host,
      resolveModel: async () => true,
    });
    for (const layer of (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack) {
      const route = layer.route;
      if (route === undefined) continue;
      for (const [method, enabled] of Object.entries(route.methods)) {
        if (enabled) methods.push(`${method.toUpperCase()} ${route.path}`);
      }
    }
    assert.deepEqual(
      methods.sort(),
      ['DELETE /:id', 'GET /', 'GET /tools', 'PATCH /:id', 'POST /'],
      'the router exposes exactly the management routes',
    );
    assert.equal(modelCalls, 0, 'no route needed a model runtime');
  });

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CHECKS PASSED');
  }
  console.log(`sandbox: ${root}`);
  console.log(`port: ${port}`);
}

main()
  .catch((error: unknown) => {
    failures += 1;
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
  });
