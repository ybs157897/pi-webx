/**
 * Gate for `server/security-middleware.ts`: the loopback bridge's global
 * Host-allowlist (DNS rebinding) and write-Origin (CSRF) guards.
 *
 * Behavioral half drives a minimal express app through raw `node:http`
 * requests — undici/fetch will not let a caller forge the Host header, and
 * forging it is exactly the attack. Wiring half asserts the guards are mounted
 * ahead of the first router and cover the WebSocket upgrade handshake, so a
 * future router cannot silently appear in front of them.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { guardUpgrade, hostAllowlist, originGuard } from '../server/security-middleware';

const app = express();
app.use(express.json());
app.use(hostAllowlist());
app.use(originGuard());
app.get('/probe', (_req, res) => { res.json({ ok: true }); });
app.post('/probe', (_req, res) => { res.json({ ok: true }); });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;

/** Raw request with full control over the Host header; resolves the status. */
function request(method: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/probe', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

/** Hand-written request lines on a bare socket — node's client would forge a
 * Host header we are deliberately trying to omit. Resolves the status line. */
function rawRequest(lines: string[], body = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => socket.write(lines.join('\r\n') + '\r\n\r\n' + body));
    socket.on('data', (chunk) => { data += chunk; socket.end(); });
    socket.on('end', () => resolve(data.split('\r\n', 1)[0] ?? ''));
    socket.on('error', reject);
  });
}

const withSavedEnv = async <T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
};

try {
  /* Host allowlist: a rebinned name never reaches a router. */
  assert.equal(await request('GET', { host: 'attacker.example' }), 403, 'foreign Host GET is refused');
  assert.equal(await request('POST', { host: 'attacker.example:8787' }), 403, 'foreign Host POST is refused');
  assert.match(
    await rawRequest(['POST /probe HTTP/1.1', 'Content-Length: 2', 'Connection: close'], '{}'),
    /^HTTP\/1\.1 (403|400)/,
    'a request with no Host header at all is refused',
  );
  assert.equal(await request('GET', { host: '[::1]:8787' }), 200, 'bracketed loopback IPv6 is allowed');

  /* Loopback on any port: the Vite dev proxy (changeOrigin: false) forwards the
   * browser's own Host, which is loopback but rarely the bridge's port. */
  assert.equal(await request('POST', { host: '127.0.0.1:59999' }), 200, 'any loopback port is allowed');
  assert.equal(await request('POST', { host: 'LocalHost:5173' }), 200, 'Host case is folded');

  /* Origin guard on writes: no Origin (curl, native, checks) passes. */
  assert.equal(await request('POST', { host: '127.0.0.1' }), 200, 'no-Origin write passes');
  assert.equal(
    await request('POST', { host: 'localhost:5173', origin: 'http://localhost:5173' }),
    200,
    'dev-proxy same-origin write passes',
  );
  assert.equal(
    await request('POST', { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }),
    403,
    'cross-origin write is refused',
  );
  assert.equal(
    await request('POST', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' }),
    403,
    'sec-fetch-site cross-site write is refused',
  );
  assert.equal(
    await request('POST', { host: `127.0.0.1:${port}`, origin: '::not a url::' }),
    403,
    'unparseable Origin is refused',
  );

  /* Reads are Host-guarded only: a foreign Origin on a GET changes nothing. */
  assert.equal(
    await request('GET', { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }),
    200,
    'GET is not Origin-guarded',
  );

  /* Deliberate widenings are env-driven and read per call. */
  await withSavedEnv('PI_WEBX_ALLOWED_ORIGIN', 'http://proxy.internal:8443', async () => {
    assert.equal(
      await request('POST', { host: `127.0.0.1:${port}`, origin: 'http://proxy.internal:8443' }),
      200,
      'PI_WEBX_ALLOWED_ORIGIN entry is an allowed writer',
    );
    assert.equal(
      await request('POST', { host: `127.0.0.1:${port}`, origin: 'http://proxy.internal:9999' }),
      403,
      'a different port on the same host is not the allowed origin',
    );
  });
  assert.equal(
    await request('POST', { host: `127.0.0.1:${port}`, origin: 'http://proxy.internal:8443' }),
    403,
    'allowance disappears once the env is unset',
  );
  await withSavedEnv('PI_WEBX_EXTRA_HOSTS', 'box.local, lan.example:9000', async () => {
    assert.equal(await request('GET', { host: 'box.local' }), 200, 'PI_WEBX_EXTRA_HOSTS host on any port');
    assert.equal(await request('GET', { host: 'lan.example:9000' }), 200, 'listed host with port matches');
    assert.equal(await request('GET', { host: 'lan.example:9001' }), 403, 'port must match when one is listed');
  });

  /* The WebSocket upgrade handshake applies both rules to every upgrade path. */
  const upgradeReq = (headers: Record<string, string>) =>
    guardUpgrade({ headers, url: '/api/ws', method: 'GET' } as unknown as http.IncomingMessage);
  assert.equal(upgradeReq({ host: 'attacker.example' }), false, 'upgrade: foreign Host refused');
  assert.equal(upgradeReq({ host: '127.0.0.1:8787', origin: 'http://evil.example' }), false, 'upgrade: cross-origin refused');
  assert.equal(upgradeReq({ host: 'localhost:5173', origin: 'http://localhost:5173' }), true, 'upgrade: dev proxy passes');
  assert.equal(upgradeReq({ host: '127.0.0.1:8787' }), true, 'upgrade: no-Origin native client passes');

  /* Wiring: the guards sit ahead of every router and the upgrade dispatch. */
  const repoRoot = new URL('..', import.meta.url);
  const indexSource = await readFile(new URL('server/index.ts', repoRoot), 'utf8');
  const firstRouter = indexSource.indexOf("app.use('/api/workbench'");
  assert.ok(firstRouter !== -1, 'index.ts still mounts the workbench router');
  assert.ok(
    indexSource.indexOf('app.use(hostAllowlist())') !== -1
      && indexSource.indexOf('app.use(originGuard())') !== -1
      && indexSource.indexOf('app.use(originGuard())') < firstRouter,
    'index.ts mounts both guards before the first router',
  );
  const wsSource = await readFile(new URL('server/ws.ts', repoRoot), 'utf8');
  const upgradeHandler = wsSource.indexOf("server.on('upgrade'");
  const dispatch = wsSource.indexOf('if (pathname !== WS_PATH)');
  assert.ok(
    upgradeHandler !== -1 && dispatch !== -1
      && wsSource.indexOf('guardUpgrade(req)', upgradeHandler) !== -1
      && wsSource.indexOf('guardUpgrade(req)', upgradeHandler) < dispatch,
    'ws.ts guards the upgrade handshake before dispatching to any upgrade path',
  );

  console.log('PASS 全局安全防护：Host 白名单拦 rebinding、写请求拦跨站、WS 握手同规则、env 放行可控、接线先于路由');
} finally {
  server.close();
  await once(server, 'close');
}
