import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { CodesIdeRuntime } from '../server/modules/codes/ide-runtime';
import { createCodesIdeRouter } from '../server/modules/codes/ide-router';
import { CodesIdeWebSockets } from '../server/modules/codes/ide-proxy';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'pi-webx-codes-ide-'));
const runtime = new CodesIdeRuntime();
const sockets = new CodesIdeWebSockets(runtime);
let selectedRoot: string | undefined = fixture;
const app = express();
app.use(express.json());
app.use('/api/codes', createCodesIdeRouter(runtime, async () => {
  if (!selectedRoot) throw new Error('代码开发 Agent 配置不可用');
  return selectedRoot;
}));
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (!sockets.handleUpgrade(req, socket, head)) socket.destroy();
});

try {
  const missing = new CodesIdeRuntime(fixture);
  assert.equal((await missing.status()).ready, false);
  await assert.rejects(missing.start(), /未构建/);
  const status = await runtime.status();
  assert.equal(status.ready, true, status.error);
  await writeFile(path.join(fixture, 'Hello.java'), 'class Hello {}\n');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (url: string, init?: RequestInit) => fetch(base + url, init);

  const config = await (await request('/api/codes/ide/config')).json() as Record<string, unknown>;
  assert.equal(config.gatewayUrl, '/api/codes/gateway');
  assert.equal(config.token, '');
  assert.equal(config.embedded, true);
  assert.equal(config.defaultRoot, fixture);
  selectedRoot = undefined;
  assert.equal((await request('/api/codes/ide/config')).status, 503);
  selectedRoot = fixture;
  const embeddedPage = await request('/api/codes/ide/');
  assert.equal(embeddedPage.status, 200);
  assert.match(await embeddedPage.text(), /\/api\/codes\/ide\/assets\//);
  assert.equal(runtime.getConnection(), undefined, 'readiness must not spawn gateway');

  const blocked = await request('/api/codes/ide/start', {
    method: 'POST', headers: { Origin: 'http://malicious.example' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(runtime.getConnection(), undefined);

  const started = await request('/api/codes/ide/start', { method: 'POST' });
  assert.equal(started.status, 200, await started.text());
  const connection = runtime.getConnection();
  assert.ok(connection);
  assert.equal(JSON.stringify(await (await request('/api/codes/ide/config')).json()).includes(connection.token), false);
  const upstreamPort = connection.port;
  await request('/api/codes/ide/start', { method: 'POST' });
  assert.equal(runtime.getConnection()?.port, upstreamPort, 'start should reuse one child');

  const create = await request('/api/codes/gateway/api/v1/workspaces', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: fixture }),
  });
  assert.equal(create.status, 201);
  const workspace = await create.json() as { id: string };
  assert.ok(workspace?.id);
  const basePath = `/api/codes/gateway/api/v1/workspaces/${workspace.id}`;

  const file = await request(`${basePath}/fs/file?path=Hello.java`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'class Hello {}\n');
  const update = await request(`${basePath}/fs/file?path=Hello.java`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: 'class Updated {}\n',
  });
  assert.equal(update.status, 204, await update.text());
  assert.equal(await (await request(`${basePath}/fs/file?path=Hello.java`)).text(), 'class Updated {}\n');

  const traversal = await request(`${basePath}/fs/file?path=../outside.txt`);
  assert.equal(traversal.status, 400);
  const unknown = await request('/api/codes/gateway/healthz');
  assert.equal(unknown.status, 404);
  const crossSite = await request(`${basePath}/fs/file?path=Hello.java`, {
    headers: { Origin: 'http://malicious.example' },
  });
  assert.equal(crossSite.status, 403);

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}${basePath}/lsp`);
  const wsResult = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 3_000);
    const done = (result: string) => { clearTimeout(timer); resolve(result); };
    ws.once('open', () => done('open'));
    ws.once('unexpected-response', (_req, response) => { response.resume(); done(`status:${response.statusCode}`); });
    ws.once('error', (error) => done(`error:${error.message}`));
  });
  assert.notEqual(wsResult, 'timeout');
  ws.terminate();

  const deniedWs = new WebSocket(`ws://127.0.0.1:${address.port}${basePath}/lsp`, {
    headers: { Origin: 'http://malicious.example' },
  });
  const deniedResult = await new Promise<string>((resolve) => {
    deniedWs.once('open', () => resolve('open'));
    deniedWs.once('error', () => resolve('blocked'));
  });
  assert.equal(deniedResult, 'blocked');

  const deleted = await request(basePath, { method: 'DELETE' });
  assert.equal(deleted.status, 204, await deleted.text());
  sockets.close();
  await runtime.stop();
  await waitForProcessStop(upstreamPort);
  await checkFirstWebSocketFrame();
  await checkSidecarCleanup();
  await checkStartStopBeforeSpawn();
  console.log('codes IDE: static config, lazy process, HTTP read/write/jail, origin, WS and shutdown passed');
} finally {
  sockets.close();
  await runtime.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(fixture, { recursive: true, force: true });
}

async function waitForProcessStop(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(200) });
    } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('gateway process remained reachable after stop');
}

async function checkFirstWebSocketFrame(): Promise<void> {
  const upstreamServer = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamServer.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers.authorization, 'Bearer private-test-token');
    setTimeout(() => upstreamWss.handleUpgrade(req, socket, head, (ws) => {
      upstreamWss.emit('connection', ws, req);
    }), 150);
  });
  upstreamWss.on('connection', (ws) => ws.on('message', (data) => ws.send(data)));
  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstreamServer.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');

  const bridge = new CodesIdeWebSockets({
    start: async () => ({ port: upstreamAddress.port, token: 'private-test-token' }),
  });
  const browserServer = http.createServer();
  browserServer.on('upgrade', (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => browserServer.listen(0, '127.0.0.1', resolve));
  const browserAddress = browserServer.address();
  assert.ok(browserAddress && typeof browserAddress !== 'string');
  const browser = new WebSocket(`ws://127.0.0.1:${browserAddress.port}/api/codes/gateway/api/v1/workspaces/fixture/lsp`);
  try {
    const echo = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('首帧未从延迟握手的上游回显')), 3_000);
      browser.once('open', () => browser.send('initialize'));
      browser.once('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
      browser.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal(echo, 'initialize');
  } finally {
    browser.terminate();
    bridge.close();
    upstreamWss.close();
    browserServer.closeAllConnections();
    upstreamServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => browserServer.close(() => resolve())),
      new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
    ]);
  }
}

async function checkSidecarCleanup(): Promise<void> {
  if (process.platform === 'win32') return;
  const fakeRepo = await mkdtemp(path.join(os.tmpdir(), 'pi-webx-codes-process-'));
  const fakeRuntime = new CodesIdeRuntime(fakeRepo);
  const pidFile = path.join(fakeRepo, 'sidecar.pid');
  const binary = path.join(fakeRepo, '.local/bin/web-idea-gateway');
  const oldPidFile = process.env.PI_WEBX_TEST_SIDECAR_PID_FILE;
  let sidecarPid: number | undefined;
  try {
    await mkdir(path.join(fakeRepo, 'apps/web/dist'), { recursive: true });
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(path.join(fakeRepo, 'apps/web/dist/index.html'), '<!doctype html>');
    await writeFile(binary, `#!/usr/bin/env node
const http = require('node:http');
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const sidecar = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.env.PI_WEBX_TEST_SIDECAR_PID_FILE, String(sidecar.pid));
const port = Number(process.env.WEBIDEA_LISTEN.split(':').at(-1));
http.createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1');
`);
    await chmod(binary, 0o755);
    process.env.PI_WEBX_TEST_SIDECAR_PID_FILE = pidFile;
    await fakeRuntime.start();
    sidecarPid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isInteger(sidecarPid) && sidecarPid > 0);
    assert.equal(processState(sidecarPid)?.startsWith('Z'), false);
    await fakeRuntime.stop();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && processState(sidecarPid) && !processState(sidecarPid)?.startsWith('Z')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(!processState(sidecarPid) || processState(sidecarPid)?.startsWith('Z'), 'gateway sidecar survived stop');
  } finally {
    await fakeRuntime.stop();
    if (sidecarPid && processState(sidecarPid) && !processState(sidecarPid)?.startsWith('Z')) {
      process.kill(sidecarPid, 'SIGKILL');
    }
    if (oldPidFile === undefined) delete process.env.PI_WEBX_TEST_SIDECAR_PID_FILE;
    else process.env.PI_WEBX_TEST_SIDECAR_PID_FILE = oldPidFile;
    await rm(fakeRepo, { recursive: true, force: true });
  }
}

function processState(pid: number): string | undefined {
  try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
  catch { return undefined; }
}

async function checkStartStopBeforeSpawn(): Promise<void> {
  const fakeRepo = await mkdtemp(path.join(os.tmpdir(), 'pi-webx-codes-race-'));
  const binary = path.join(fakeRepo, '.local/bin/web-idea-gateway');
  const marker = path.join(fakeRepo, 'spawned');
  let reachedPort!: () => void;
  let releasePort!: (port: number) => void;
  const atPort = new Promise<void>((resolve) => { reachedPort = resolve; });
  const heldPort = new Promise<number>((resolve) => { releasePort = resolve; });
  const runtime = new CodesIdeRuntime(fakeRepo, () => {
    reachedPort();
    return heldPort;
  });
  try {
    await mkdir(path.join(fakeRepo, 'apps/web/dist'), { recursive: true });
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(path.join(fakeRepo, 'apps/web/dist/index.html'), '<!doctype html>');
    await writeFile(binary, `#!/bin/sh\nprintf spawned > '${marker}'\n`);
    await chmod(binary, 0o755);
    const starting = runtime.start();
    await atPort;
    await runtime.stop();
    releasePort(19099);
    await assert.rejects(starting, /已关闭/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    releasePort(19099);
    await runtime.stop();
    await rm(fakeRepo, { recursive: true, force: true });
  }
}
