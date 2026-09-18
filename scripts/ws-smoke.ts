/**
 * Headless smoke test for the /api/ws gateway + journal mechanics.
 * No model calls happen: the fresh session has no usable provider credential,
 * so a prompt turns into an immediate local error that still exercises the
 * journal, the error frames and the requestId lifecycle on the wire.
 *
 *   PI_WEBX_PORT=8899 npx tsx scripts/ws-smoke.ts
 */

import assert from 'node:assert/strict';
import WebSocket from 'ws';

const port = process.env.PI_WEBX_PORT ?? '8899';
const base = `http://127.0.0.1:${port}`;

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const created = await post('/api/sessions', { cwd: '/tmp', noSession: true });
  const sessionId = ((created as { session?: { id?: string } }).session ?? {}).id;
  assert.ok(sessionId, `session created: ${JSON.stringify(created)}`);
  console.log('ok   session created', sessionId);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const received: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => received.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ t: 'subscribe', sessionId }));
  await wait(300);

  assert.ok(received.find((m) => m.t === 'welcome'), 'welcome received');
  const subscribed = received.find((m) => m.t === 'subscribed' && m.sessionId === sessionId);
  assert.ok(subscribed, 'subscribed received');
  assert.equal(subscribed?.latestSeq, 0, 'fresh journal reports latestSeq 0');
  assert.equal(subscribed?.cwd, '/tmp');
  console.log('ok   welcome + subscribed(latestSeq=0)');

  const response = await post(`/api/sessions/${sessionId}/command`, {
    command: { type: 'get_messages', id: 'probe-1' },
  });
  const rpc = response.response as Record<string, unknown>;
  assert.equal(rpc.success, true);
  assert.equal(typeof (rpc.data as Record<string, unknown>)?.throughSeq, 'number');
  assert.equal(rpc.id, 'probe-1', 'command response echoes the correlation id');
  console.log('ok   get_messages carries throughSeq; response echoes id');

  // A prompt with no usable credential: accepted by preflight, the turn errors
  // locally, one error frame is journaled, and the failed requestId is
  // released — retrying the same id re-attempts rather than being swallowed.
  const first = ((
    await post(`/api/sessions/${sessionId}/command`, {
      command: { type: 'prompt', message: '', id: 'dup-1' },
    })
  ).response ?? {}) as Record<string, unknown>;
  await wait(300);
  const events = received.filter((m) => m.t === 'event');
  assert.ok(events.length >= 1, `journaled frame(s) delivered: ${events.length}`);
  assert.equal(events[0]?.sessionId, sessionId);
  assert.equal(typeof events[0]?.seq, 'number');
  console.log('ok   journaled frames stream as ws events with seq');

  const second = ((
    await post(`/api/sessions/${sessionId}/command`, {
      command: { type: 'prompt', message: '', id: 'dup-1' },
    })
  ).response ?? {}) as Record<string, unknown>;
  assert.equal(second.id, 'dup-1', 'retry echoes id');
  assert.notEqual((second.data as Record<string, unknown>)?.deduplicated, true, 'failed submit is retryable');
  console.log('ok   errored submit releases its requestId (retry allowed)');

  // Replay: a second subscriber joining from seq 0 gets the same frames the
  // live subscriber has (both include everything journaled so far).
  const replayed: Array<Record<string, unknown>> = [];
  const watcher = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  watcher.on('message', (raw) => replayed.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve) => watcher.once('open', resolve));
  watcher.send(JSON.stringify({ t: 'subscribe', sessionId, fromSeq: 0 }));
  await wait(400);
  const replayEvents = replayed.filter((m) => m.t === 'event');
  const liveEvents = received.filter((m) => m.t === 'event');
  assert.ok(replayEvents.length >= 2, `replay covered both frames: ${replayEvents.length}`);
  assert.deepEqual(
    replayEvents.map((m) => m.seq),
    liveEvents.map((m) => m.seq),
    'replay yields the identical seq sequence',
  );
  console.log('ok   journal replay is identical to the live sequence');

  // An unreachable fromSeq demands a resync instead of a partial replay.
  watcher.send(JSON.stringify({ t: 'subscribe', sessionId, fromSeq: 999 }));
  await wait(300);
  assert.ok(
    replayed.find((m) => m.t === 'resync-required' && m.sessionId === sessionId),
    'resync-required received',
  );
  console.log('ok   unreachable fromSeq answers resync-required');

  socket.send(JSON.stringify({ t: 'subscribe', sessionId: 'nope' }));
  await wait(200);
  const closed = received.find((m) => m.t === 'closed' && m.sessionId === 'nope');
  assert.equal(closed?.reason, 'unknown');
  console.log('ok   unknown session answers closed(unknown)');

  socket.close();
  watcher.close();
  console.log('\nALL SMOKE CHECKS PASSED');
  process.exit(0);
}

void main().catch((error) => {
  console.error('SMOKE FAILED:', error);
  process.exit(1);
});
