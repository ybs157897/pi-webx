/**
 * Self-check harness for the session journal and prompt-request ledger
 * (`server/pi/session-journal.ts`) — the load-bearing recovery semantics the
 * WebSocket gateway depends on. No framework, same style as check-transcript:
 *
 *   npx tsx scripts/check-journal.ts
 */

import assert from 'node:assert/strict';

import { PromptRequests, SessionJournal } from '../server/pi/session-journal';
import type { ServerFrame } from '../src/shared/protocol';

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

const frame = (n: number): ServerFrame => ({ t: 'error', message: `f${n}` });

check('journal: seq is dense from 1 and replay returns the exact tail', () => {
  const journal = new SessionJournal();
  assert.equal(journal.latestSeq, 0);
  assert.equal(journal.oldestSeq, 1);
  for (let i = 1; i <= 5; i += 1) {
    const entry = journal.append(frame(i));
    assert.equal(entry.seq, i);
  }
  assert.equal(journal.latestSeq, 5);
  assert.equal(journal.oldestSeq, 1);

  const tail = journal.replayFrom(3);
  assert.deepEqual(tail?.map((entry) => entry.seq), [4, 5]);
  assert.deepEqual(journal.replayFrom(5), [], 'nothing newer than the client');
  assert.deepEqual(journal.replayFrom(0)?.map((entry) => entry.seq), [1, 2, 3, 4, 5]);
});

check('journal: replay is refused when the ring no longer reaches back', () => {
  const journal = new SessionJournal();
  for (let i = 1; i <= 1200; i += 1) journal.append(frame(i));
  // CAPACITY=1000: oldest retained is 201. A client that applied through 200
  // is still contiguous (it needs 201+); through 199 is a gap.
  assert.equal(journal.oldestSeq, 201);
  assert.equal(journal.replayFrom(199), null, 'two before the oldest is a gap');
  assert.deepEqual(
    journal.replayFrom(200)?.map((entry) => entry.seq),
    Array.from({ length: 1000 }, (_, i) => 201 + i),
    'exactly contiguous at the oldest',
  );
  const tail = journal.replayFrom(1100);
  assert.deepEqual(tail?.map((entry) => entry.seq), Array.from({ length: 100 }, (_, i) => 1101 + i));
});

check('journal: a client ahead of a restarted journal is refused', () => {
  const journal = new SessionJournal();
  journal.append(frame(1));
  journal.append(frame(2));
  assert.deepEqual(journal.replayFrom(2), []);
  assert.equal(journal.replayFrom(7), null, 'client seq beyond latest => resync, not empty ok');
  assert.equal(journal.replayFrom(-1), null);
});

check('promptRequests: duplicate submit is refused, settled ids stay known', () => {
  const ledger = new PromptRequests();
  assert.equal(ledger.add('r1'), true);
  assert.equal(ledger.add('r1'), false, 'duplicate submit must be detected');
  assert.equal(ledger.consumePending(), 'r1');
  assert.equal(ledger.add('r1'), false, 'a settled id is still a duplicate');
  assert.equal(ledger.consumePending(), null);
});

check('promptRequests: FIFO consumption; forget releases a failed submit', () => {
  const ledger = new PromptRequests();
  ledger.add('r1');
  ledger.add('r2');
  assert.equal(ledger.consumePending(), 'r1');
  assert.equal(ledger.consumePending(), 'r2');
  ledger.add('r3');
  ledger.forget('r3');
  assert.equal(ledger.consumePending(), null);
  assert.equal(ledger.add('r3'), true, 'a forgotten id may be retried');
});

check('promptRequests: the settled set is bounded', () => {
  const ledger = new PromptRequests(3);
  for (let i = 0; i < 10; i += 1) {
    ledger.add(`r${i}`);
    ledger.consumePending();
  }
  // Only the newest 3 settled ids are remembered as duplicates.
  assert.equal(ledger.add('r9'), false);
  assert.equal(ledger.add('r0'), true, 'the oldest settled id has aged out');
});

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nALL CHECKS PASSED');
}
