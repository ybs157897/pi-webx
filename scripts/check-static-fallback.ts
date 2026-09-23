import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { serveProductionAssets } from '../server/static';

const dist = mkdtempSync(join(tmpdir(), 'pi-webx-static-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>pi workbench</title>');
const app = express();
app.use('/api', (_request, response) => response.status(404).json({ error: 'unknown API endpoint' }));
assert.equal(serveProductionAssets(app, dist), true);
const server = app.listen(0, '127.0.0.1');

try {
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  for (const route of ['/', '/chat', '/some/session/path']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200, `${route} must serve the SPA`);
    assert.match(await response.text(), /pi workbench/);
  }
  const head = await fetch(`${base}/chat`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const api = await fetch(`${base}/api/unknown`);
  assert.equal(api.status, 404);
  console.log('production SPA fallback: root, /chat, deep link and HEAD passed');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dist, { recursive: true, force: true });
}
