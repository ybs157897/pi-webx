/**
 * Self-check harness for the transcript reducer (`src/lib/transcript.ts`).
 *
 * Plain `node:assert` + console output, no test framework:
 *
 *   npx tsx scripts/check-transcript.ts
 *
 * It covers the reducer's load-bearing semantics (snapshot reconstruction,
 * streamed turns, cumulative vs delta output, immutability, unknown events)
 * plus the event types whose semantics are easy to get wrong.
 */

import assert from 'node:assert/strict';

import type { PiAgentMessage, PiEvent } from '../src/shared/protocol';
import {
  addEcho,
  answerIndexOf,
  applyPiEvent,
  applySnapshot,
  createTranscript,
  retireEcho,
} from '../src/lib/transcript';
import type {
  AssistantEntry,
  BashEntry,
  CompactionEntry,
  NoticeEntry,
  ToolResultEntry,
  TranscriptState,
  UserEntry,
} from '../src/shared/transcript';

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

const ev = (event: unknown): PiEvent => event as PiEvent;

function entriesOfKind<K extends TranscriptState['entries'][number]['kind']>(
  state: TranscriptState,
  kind: K,
): Extract<TranscriptState['entries'][number], { kind: K }>[] {
  return state.entries.filter((entry): entry is Extract<TranscriptState['entries'][number], { kind: K }> =>
    entry.kind === kind,
  );
}

function only<K extends TranscriptState['entries'][number]['kind']>(
  state: TranscriptState,
  kind: K,
): Extract<TranscriptState['entries'][number], { kind: K }> {
  const found = entriesOfKind(state, kind);
  assert.equal(found.length, 1, `expected exactly 1 ${kind} entry, got ${found.length}`);
  return found[0]!;
}

/* 1 ------------------------------------------------------------------------ */

check('snapshot: [user, assistant(text+toolCall), toolResult] -> run is resolved', () => {
  const messages: PiAgentMessage[] = [
    { role: 'user', content: 'List the files', timestamp: 1000 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
      ],
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } },
      stopReason: 'toolUse',
      timestamp: 2000,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'file.txt' }],
      details: { truncation: null },
      isError: false,
      timestamp: 3000,
    },
  ];

  const state = applySnapshot(createTranscript(), messages);
  assert.equal(state.entries.length, 2, 'toolResult must attach to its call, not add an entry');
  const user = only(state, 'user') as UserEntry;
  assert.equal(user.text, 'List the files');
  assert.equal(user.imageCount, 0);

  const assistant = only(state, 'assistant') as AssistantEntry;
  assert.equal(assistant.text, 'Let me look.');
  assert.equal(assistant.streaming, false);
  assert.equal(assistant.tools.length, 1);
  const run = assistant.tools[0]!;
  assert.equal(run.toolCallId, 'call_1');
  assert.equal(run.toolName, 'bash');
  assert.equal(run.status, 'success');
  assert.equal(run.output, 'file.txt');
  assert.deepEqual(run.args, { command: 'ls' });
  assert.equal(run.restored, true);
  assert.equal(run.startedAt, 2000);
  assert.equal(run.endedAt, 3000);
  assert.deepEqual(run.details, { truncation: null });
  assert.equal(assistant.usage?.totalTokens, 15);
  assert.equal(assistant.usage?.cost, 0.25);
  assert.equal(assistant.stopReason, 'toolUse');
  assert.equal(state.streamingEntryId, null);
});

/* 2 ------------------------------------------------------------------------ */

check('stream: message_start -> text deltas -> message_end yields Hello / not streaming', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' } }),
  );
  // text_end carries the finished block; it must not duplicate the deltas.
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello' } }),
  );
  assert.equal((only(state, 'assistant') as AssistantEntry).text, 'Hello');

  state = applyPiEvent(
    state,
    ev({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        stopReason: 'stop',
        timestamp: 4000,
      },
    }),
  );
  const assistant = only(state, 'assistant') as AssistantEntry;
  assert.equal(assistant.text, 'Hello');
  assert.equal(assistant.streaming, false);
  assert.equal(state.streamingEntryId, null);
  assert.equal(assistant.stopReason, 'stop');
});

/* 3 ------------------------------------------------------------------------ */

check('tool_execution_update: cumulative partialResult replaces output', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_9', toolName: 'bash' } }),
  );
  state = applyPiEvent(
    state,
    ev({
      type: 'tool_execution_update',
      toolCallId: 'call_9',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'line 1\n' }] },
    }),
  );
  state = applyPiEvent(
    state,
    ev({
      type: 'tool_execution_update',
      toolCallId: 'call_9',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'line 1\nline 2\n' }] },
    }),
  );
  const run = (only(state, 'assistant') as AssistantEntry).tools[0]!;
  assert.equal(run.output, 'line 1\nline 2\n', 'output must be the second (cumulative) value only');
  assert.equal(run.status, 'running');
});

/* 4 ------------------------------------------------------------------------ */

check('unknown event type is ignored and does not throw', () => {
  let state = applyPiEvent(createTranscript(), ev({ type: 'message_start', message: { role: 'user', content: 'hi' } }));
  const before = structuredClone(state);
  state = applyPiEvent(state, ev({ type: 'totally_unknown' }));
  assert.deepStrictEqual(state, before);
  state = applyPiEvent(state, ev({ type: 'response', command: 'get_state', success: true }));
  assert.deepStrictEqual(state, before);
  // turn events add no entries, and a turn with no answer folds nothing.
  state = applyPiEvent(state, ev({ type: 'turn_start' }));
  state = applyPiEvent(state, ev({ type: 'turn_end', message: { role: 'assistant', content: [] } }));
  assert.deepStrictEqual(state.entries, before.entries, 'turn events add no entries');
  assert.deepStrictEqual(state.turnProcesses, {}, 'a turn without an answer does not fold');
});

/* 5 ------------------------------------------------------------------------ */

check('immutability: input state and its arrays are never mutated', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'user', content: 'hi' } }));
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } }),
  );
  const snapshot = structuredClone(state);
  const entriesRef = state.entries;

  const next = applyPiEvent(
    state,
    ev({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'y' },
    }),
  );

  assert.deepStrictEqual(state, snapshot, 'original state must be untouched');
  assert.strictEqual(state.entries, entriesRef, 'original entries array identity must be untouched');
  assert.notStrictEqual(next.entries, state.entries, 'a change must produce a new entries array');
  assert.notStrictEqual(next.entries[1], state.entries[1], 'the touched entry must be a new object');
  assert.strictEqual(next.entries[0], state.entries[0], 'untouched entries are structurally shared');
  assert.equal((next.entries[1] as AssistantEntry).text, 'xy');
});

/* 6 ------------------------------------------------------------------------ */

check('thinking deltas do not pollute text', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Let me ' } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'check.' } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Let me check.' } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Answer.' } }),
  );
  const assistant = only(state, 'assistant') as AssistantEntry;
  assert.equal(assistant.thinking, 'Let me check.');
  assert.equal(assistant.text, 'Answer.');
});

/* ------------------------------------------------------------ extra coverage */

check('agent_settled closes streaming entries and running tools', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'agent_start' }));
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_a', toolName: 'read' } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' }),
  );
  assert.equal(state.running, true);
  assert.equal(state.retrying?.attempt, 1);
  assert.equal(state.retrying?.delayMs, 2000);
  assert.equal(entriesOfKind(state, 'notice').length, 1);

  state = applyPiEvent(state, ev({ type: 'agent_end', willRetry: true }));
  assert.equal(state.running, true, 'a retry keeps the run alive');
  state = applyPiEvent(state, ev({ type: 'agent_settled' }));
  assert.equal(state.running, false);
  assert.equal(state.streamingEntryId, null);
  assert.equal(state.retrying, null);
  const assistant = only(state, 'assistant') as AssistantEntry;
  assert.equal(assistant.streaming, false);
  assert.equal(assistant.tools[0]!.status, 'success');
});

check('toolcall delta fragments buffer into args, malformed JSON is preserved', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_j', toolName: 'bash' } }),
  );
  for (const fragment of ['{"comm', 'and":"ls ', '-la"}']) {
    state = applyPiEvent(
      state,
      ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: fragment } }),
    );
  }
  let run = (only(state, 'assistant') as AssistantEntry).tools[0]!;
  assert.deepEqual(run.args, { command: 'ls -la' });

  // Malformed: keep {} but never lose the raw text.
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call_bad', toolName: 'write' } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"x"' } }),
  );
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1 } }),
  );
  run = (only(state, 'assistant') as AssistantEntry).tools[1]!;
  assert.deepEqual(run.args, {});
  assert.deepEqual(run.details, { rawArgs: '{"path":"x"' });
});

check('tool_execution_end sets output/status/endedAt; message_end keeps finished runs', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_e', toolName: 'bash' } }),
  );
  state = applyPiEvent(
    state,
    ev({
      type: 'tool_execution_end',
      toolCallId: 'call_e',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'done' }], details: { truncation: null } },
      isError: false,
    }),
  );
  let run = (only(state, 'assistant') as AssistantEntry).tools[0]!;
  assert.equal(run.status, 'success');
  assert.equal(run.output, 'done');
  assert.equal(typeof run.endedAt, 'number');
  const endedAt = run.endedAt;

  state = applyPiEvent(
    state,
    ev({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Ran it.' },
          { type: 'toolCall', id: 'call_e', name: 'bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        timestamp: 5000,
      },
    }),
  );
  const assistant = only(state, 'assistant') as AssistantEntry;
  run = assistant.tools[0]!;
  assert.equal(run.status, 'success', 'a finished run must not be resurrected to running');
  assert.equal(run.output, 'done');
  assert.equal(run.endedAt, endedAt);
  assert.deepEqual(run.args, { command: 'ls' });
  assert.equal(assistant.text, 'Ran it.');
});

check('live toolResult attaches to its run; orphan becomes a standalone entry', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  state = applyPiEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_m', toolName: 'bash' } }),
  );
  state = applyPiEvent(
    state,
    ev({
      type: 'message_start',
      message: { role: 'toolResult', toolCallId: 'call_m', toolName: 'bash', content: [{ type: 'text', text: 'out' }], isError: false },
    }),
  );
  state = applyPiEvent(
    state,
    ev({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'call_m', toolName: 'bash', content: [{ type: 'text', text: 'out' }], isError: false },
    }),
  );
  assert.equal(entriesOfKind(state, 'toolResult').length, 0, 'no duplicate entry for a known call');
  assert.equal((only(state, 'assistant') as AssistantEntry).tools[0]!.output, 'out');

  state = applyPiEvent(
    state,
    ev({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'call_orphan', toolName: 'read', content: [{ type: 'text', text: 'orphan' }], isError: true },
    }),
  );
  const orphan = only(state, 'toolResult') as ToolResultEntry;
  assert.equal(orphan.run.toolCallId, 'call_orphan');
  assert.equal(orphan.run.status, 'error');
  assert.equal(orphan.run.output, 'orphan');
});

check('bash_execution_update appends to the entry with the matching command id', () => {
  const base: TranscriptState = {
    ...createTranscript(),
    entries: [
      { kind: 'bash', id: 'req-1', at: 1, command: 'ls', output: '', exitCode: null, cancelled: false, truncated: false, streaming: true },
    ],
  };
  let state = applyPiEvent(base, ev({ type: 'bash_execution_update', id: 'req-1', delta: 'total 48\n' }));
  state = applyPiEvent(state, ev({ type: 'bash_execution_update', id: 'req-1', delta: 'a.txt\n' }));
  assert.equal((only(state, 'bash') as BashEntry).output, 'total 48\na.txt\n');

  const ignored = applyPiEvent(state, ev({ type: 'bash_execution_update', id: 'nope', delta: 'x' }));
  assert.deepStrictEqual(ignored, state, 'no matching entry: state unchanged');
});

check('compaction start/end flags and payloads', () => {
  let state = applyPiEvent(createTranscript(), ev({ type: 'compaction_start', reason: 'threshold' }));
  assert.equal(state.compacting, true);
  const start = only(state, 'compaction') as CompactionEntry;
  assert.equal(start.phase, 'start');

  // Real pi payloads nest the result; the shared type also allows top-level fields.
  state = applyPiEvent(
    state,
    ev({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 'So far...', tokensBefore: 150000, estimatedTokensAfter: 32000 },
      aborted: false,
    }),
  );
  assert.equal(state.compacting, false);
  const all = entriesOfKind(state, 'compaction') as CompactionEntry[];
  assert.equal(all.length, 2);
  assert.equal(all[0]!.phase, 'start');
  assert.equal(all[0]!.summary, undefined, 'the start entry is not rewritten');
  assert.equal(all[1]!.phase, 'end');
  assert.equal(all[1]!.summary, 'So far...');
  assert.equal(all[1]!.tokensBefore, 150000);
  assert.equal(all[1]!.tokensAfter, 32000);
  assert.equal(all[1]!.aborted, false);
});

check('retries surface notices; final failure clears retrying', () => {
  let state = applyPiEvent(createTranscript(), ev({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'rate limited' }));
  assert.deepEqual(state.retrying, { attempt: 2, maxAttempts: 3, delayMs: 500, error: 'rate limited' });
  let notice = only(state, 'notice') as NoticeEntry;
  assert.equal(notice.level, 'warning');
  assert.match(notice.text, /attempt 2\/3/);
  assert.equal(notice.detail, 'rate limited');

  state = applyPiEvent(state, ev({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'still overloaded' }));
  assert.equal(state.retrying, null);
  const notices = entriesOfKind(state, 'notice') as NoticeEntry[];
  assert.equal(notices.length, 2);
  assert.equal(notices[1]!.level, 'error');
  assert.equal(notices[1]!.detail, 'still overloaded');

  state = applyPiEvent(state, ev({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 1000 }));
  assert.equal(state.retrying?.attempt, 1);
  state = applyPiEvent(state, ev({ type: 'summarization_retry_finished' }));
  assert.equal(state.retrying, null);
});

check('queue_update replaces both queues', () => {
  const state = applyPiEvent(
    createTranscript(),
    ev({ type: 'queue_update', steering: ['focus'], followUp: ['then summarise'] }),
  );
  assert.deepEqual(state.queued, { steering: ['focus'], followUp: ['then summarise'], pending: [] });
  const cleared = applyPiEvent(state, ev({ type: 'queue_update' }));
  assert.deepEqual(cleared.queued, { steering: [], followUp: [], pending: [] });
});

check('queue_update carries the wait list and drops malformed rows', () => {
  const state = applyPiEvent(
    createTranscript(),
    ev({
      type: 'queue_update',
      steering: [],
      followUp: [],
      pending: [
        { id: 'q1', text: '先别动，等这轮结束', imageCount: 2, createdAt: 1 },
        // A row without an id cannot be addressed by any dock action, so it is
        // not a row: dropping it beats rendering a control that cannot work.
        { text: 'no id', imageCount: 0, createdAt: 2 } as never,
      ],
    }),
  );
  assert.deepEqual(state.queued.pending, [
    { id: 'q1', text: '先别动，等这轮结束', imageCount: 2, createdAt: 1 },
  ]);
  // pi's own frames settle its two queues but say nothing about the wait list,
  // which is the bridge's: an absent `pending` therefore means "unchanged".
  // Erasing it here would let every steer the dock performs wipe the dock.
  const fromPi = applyPiEvent(state, ev({ type: 'queue_update', steering: ['now'], followUp: [] }));
  assert.deepEqual(fromPi.queued.steering, ['now']);
  assert.deepEqual(fromPi.queued.pending, state.queued.pending);
  // The host does clear it by naming an empty list.
  const cleared = applyPiEvent(state, ev({ type: 'queue_update', steering: [], followUp: [], pending: [] }));
  assert.deepEqual(cleared.queued.pending, []);
});

check('extension setTitle updates the title, other methods are ignored', () => {
  let state = applyPiEvent(
    createTranscript(),
    ev({ type: 'extension_ui_request', id: 'u1', method: 'setTitle', title: 'pi - my project' }),
  );
  assert.equal(state.title, 'pi - my project');
  const after = applyPiEvent(
    state,
    ev({ type: 'extension_ui_request', id: 'u2', method: 'notify', message: 'hi', notifyType: 'info' }),
  );
  assert.deepStrictEqual(after, state);
});

check('extension_error becomes an error notice with context', () => {
  const state = applyPiEvent(
    createTranscript(),
    ev({ type: 'extension_error', extensionPath: '/tmp/ext.ts', event: 'tool_call', error: 'boom' }),
  );
  const notice = only(state, 'notice') as NoticeEntry;
  assert.equal(notice.level, 'error');
  assert.equal(notice.text, 'boom');
  assert.match(notice.detail ?? '', /\/tmp\/ext\.ts/);
  assert.match(notice.detail ?? '', /tool_call/);
});

check('snapshot is deterministic and preserves title/live flags', () => {
  const messages: PiAgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'x', mimeType: 'image/png' }] },
    { role: 'bashExecution', command: 'ls', output: 'a.txt\n', exitCode: 0, cancelled: false, truncated: false, fullOutputPath: null },
    // Unknown role from a newer pi version: ignored, not fatal.
    { role: 'custom', customType: 'note', content: 'hi' } as unknown as PiAgentMessage,
    // Orphaned tool result: keeps its own entry.
    { role: 'toolResult', toolCallId: 'gone', toolName: 'read', content: [{ type: 'text', text: 'stale' }], isError: false, timestamp: 42 },
  ];
  const seeded: TranscriptState = {
    ...createTranscript(),
    title: 'kept',
    running: true,
    retrying: { attempt: 1 },
    queued: { steering: ['a'], followUp: [], pending: [] },
  };

  const first = applySnapshot(seeded, messages);
  const second = applySnapshot(seeded, messages);
  assert.deepStrictEqual(first, second, 'snapshot ids/entries must be deterministic');

  assert.equal(first.title, 'kept');
  assert.equal(first.running, true, 'live flags are not derivable from history');
  assert.deepEqual(first.retrying, { attempt: 1 });
  assert.deepEqual(first.queued, { steering: ['a'], followUp: [], pending: [] });

  const user = only(first, 'user') as UserEntry;
  assert.equal(user.text, 'look');
  assert.equal(user.imageCount, 1);
  assert.equal(user.id, 'snap-0');
  assert.equal((only(first, 'bash') as BashEntry).id, 'snap-1');
  const orphan = only(first, 'toolResult') as ToolResultEntry;
  assert.equal(orphan.id, 'snap-3');
  assert.equal(orphan.run.restored, true);
  assert.equal(orphan.at, 42, 'uses the message timestamp');

  const errored = applySnapshot(createTranscript(), [
    { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error', errorMessage: 'quota', timestamp: 7 },
  ]);
  assert.equal(errored.lastError, 'quota');
});

check('snapshot: assistant tool calls keep their order and fall back to the previous timestamp', () => {
  const state = applySnapshot(createTranscript(), [
    { role: 'user', content: 'go', timestamp: 111 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'toolCall', id: 'call_1', name: 'read' },
        { type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'ls' } },
      ],
    },
  ]);
  const assistant = only(state, 'assistant') as AssistantEntry;
  assert.equal(assistant.at, 111, 'falls back to the previous entry timestamp');
  assert.deepEqual(assistant.tools.map((run) => run.toolName), ['read', 'bash']);
  assert.deepEqual(assistant.tools[0]!.args, {});
  assert.equal(assistant.thinking, 'hmm');
  assert.equal(assistant.text, '');
  assert.equal(assistant.tools[0]!.startedAt, 111);
});

check('empty and malformed input never throws', () => {
  const state = createTranscript();
  const weird: unknown[] = [
    undefined,
    null,
    42,
    'nope',
    {},
    { type: 'message_start' },
    { type: 'message_start', message: null },
    { type: 'message_update' },
    { type: 'message_update', assistantMessageEvent: {} },
    { type: 'message_start', message: { role: 'wat' } },
    { type: 'message_end', message: { role: 'wat' } },
    { type: 'tool_execution_start' },
    { type: 'tool_execution_update', toolCallId: 'x' },
    { type: 'tool_execution_end' },
    { type: 'bash_execution_update' },
    { type: 'extension_ui_request', id: 'x', method: 'setTitle' },
  ];
  for (const payload of weird) {
    const next = applyPiEvent(state, payload as PiEvent);
    assert.equal(next.entries.length, 0, `unexpected entry for ${JSON.stringify(payload)}`);
  }
  assert.equal(applySnapshot(state, [] as PiAgentMessage[]).entries.length, 0);

  // A content-less assistant message still opens an entry (pi may open a stream
  // before any block arrives); it must not throw on the missing content array.
  const bare = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant' } }));
  const assistant = only(bare, 'assistant') as AssistantEntry;
  assert.equal(assistant.text, '');
  assert.equal(assistant.thinking, '');
  assert.equal(assistant.streaming, true);

  // ...and an assistant `message_end` with a junk `content` value still closes a
  // turn cleanly (empty text) instead of throwing on a non-array.
  const closed = applyPiEvent(
    state,
    ev({ type: 'message_end', message: { role: 'assistant', content: 42 } }),
  );
  const closedAssistant = only(closed, 'assistant') as AssistantEntry;
  assert.equal(closedAssistant.text, '');
  assert.equal(closedAssistant.streaming, false);
  assert.equal(closed.streamingEntryId, null);
});

check('end-to-end turn: prompt -> thinking/text/tool stream -> result -> settle', () => {
  let state = createTranscript();
  for (const event of [
    { type: 'agent_start' },
    { type: 'turn_start' },
    // pi echoes the prompt back before the assistant answers.
    { type: 'message_start', message: { role: 'user', content: 'What is in this repo?', timestamp: 10 } },
    { type: 'message_end', message: { role: 'user', content: 'What is in this repo?', timestamp: 10 } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Need to list files.' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Need to list files.' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Listing now.' } },
    { type: 'message_update', usage: { input: 120, output: 8, totalTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } }, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call_x', toolName: 'bash' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{"command":"ls"}' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'call_x', name: 'bash', arguments: { command: 'ls' } } } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Need to list files.' }, { type: 'text', text: 'Listing now.' }, { type: 'toolCall', id: 'call_x', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'toolUse', timestamp: 20 } },
    { type: 'turn_end' },
    { type: 'tool_execution_start', toolCallId: 'call_x', toolName: 'bash', args: { command: 'ls' } },
    { type: 'tool_execution_update', toolCallId: 'call_x', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'a.txt\n' }] } },
    { type: 'tool_execution_end', toolCallId: 'call_x', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.txt\nb.txt\n' }] }, isError: false },
    { type: 'message_start', message: { role: 'toolResult', toolCallId: 'call_x', toolName: 'bash', content: [{ type: 'text', text: 'a.txt\nb.txt\n' }], isError: false, timestamp: 30 } },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_x', toolName: 'bash', content: [{ type: 'text', text: 'a.txt\nb.txt\n' }], isError: false, timestamp: 30 } },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  ]) {
    state = applyPiEvent(state, ev(event));
  }

  assert.equal(state.entries.length, 2, 'one user entry + one assistant entry');
  assert.equal(state.running, false);
  assert.equal(state.streamingEntryId, null);
  assert.equal(state.lastError, null);

  const user = only(state, 'user') as UserEntry;
  assert.equal(user.text, 'What is in this repo?');

  const assistant = only(state, 'assistant') as AssistantEntry;
  assert.equal(assistant.text, 'Listing now.');
  assert.equal(assistant.thinking, 'Need to list files.');
  assert.equal(assistant.streaming, false);
  assert.equal(assistant.stopReason, 'toolUse');
  assert.equal(assistant.usage?.totalTokens, 128);
  assert.equal(assistant.tools.length, 1);
  const run = assistant.tools[0]!;
  assert.equal(run.toolCallId, 'call_x');
  assert.equal(run.status, 'success');
  assert.equal(run.output, 'a.txt\nb.txt\n');
  assert.deepEqual(run.args, { command: 'ls' });
  assert.equal(entriesOfKind(state, 'toolResult').length, 0, 'no orphan entry for the tool result');
});

check('echo: add shows the submit immediately, retire removes it, no duplicates', () => {
  let state = createTranscript();
  state = addEcho(state, { requestId: 'req-1', text: 'go', imageCount: 1 });
  // Adding the same submission twice must not render two bubbles.
  state = addEcho(state, { requestId: 'req-1', text: 'go', imageCount: 1 });
  const echo = only(state, 'user') as UserEntry;
  assert.equal(echo.text, 'go');
  assert.equal(echo.imageCount, 1);
  assert.equal(echo.echo?.requestId, 'req-1');

  // The durable frame retires the echo and appends the real message in the
  // same update: retire first, then apply the message_start.
  state = retireEcho(state, 'req-1');
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'user', content: 'go', timestamp: 10 } }));
  const users = entriesOfKind(state, 'user');
  assert.equal(users.length, 1, 'exactly one of echo/durable is visible');
  assert.equal(users[0]!.echo, undefined);
  assert.equal(users[0]!.text, 'go');

  // Retiring an unknown or already-retired id is a no-op.
  const before = structuredClone(state);
  state = retireEcho(state, 'req-unknown');
  assert.deepStrictEqual(state, before);
});

check('echo survives unrelated events and is re-added after a snapshot rebuild', () => {
  let state = createTranscript();
  state = addEcho(state, { requestId: 'req-2', text: 'later', imageCount: 0 });
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  assert.equal(entriesOfKind(state, 'user').length, 1, 'echo unaffected by other events');

  // A snapshot (reconnect rebuild) drops echoes; the caller re-adds pending ones.
  state = applySnapshot(state, [{ role: 'user', content: 'earlier', timestamp: 1 }]);
  assert.equal(entriesOfKind(state, 'user').length, 1);
  assert.equal((entriesOfKind(state, 'user')[0] as UserEntry).echo, undefined);
  state = addEcho(state, { requestId: 'req-2', text: 'later', imageCount: 0 });
  assert.equal(entriesOfKind(state, 'user').length, 2, 'echo re-added after rebuild');
  assert.equal((entriesOfKind(state, 'user')[1] as UserEntry).echo?.requestId, 'req-2');
});

/* ------------------------------------------------------- turn fold (compact) */

/** One step of a turn: thinking, a tool call, and its result. */
function applyStep(state: TranscriptState, callId: string): TranscriptState {
  let next = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  next = applyPiEvent(
    next,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm ' } }),
  );
  next = applyPiEvent(
    next,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: callId, toolName: 'bash' } }),
  );
  next = applyPiEvent(
    next,
    ev({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm ' },
          { type: 'toolCall', id: callId, name: 'bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        timestamp: 10,
      },
    }),
  );
  next = applyPiEvent(
    next,
    ev({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text: 'out' }], isError: false, timestamp: 11 },
    }),
  );
  return next;
}

/** The final answer step: text, no tool calls. */
function applyAnswer(state: TranscriptState, text: string): TranscriptState {
  let next = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  next = applyPiEvent(
    next,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } }),
  );
  return applyPiEvent(
    next,
    ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 12 } }),
  );
}

check('turn fold: turn_end folds the process and keeps the answer visible', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'agent_start' }));
  state = applyPiEvent(state, ev({ type: 'turn_start' }));
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'user', content: 'go', timestamp: 1 } }));
  state = applyStep(state, 'call_1');
  state = applyStep(state, 'call_2');
  state = applyAnswer(state, 'Done.');
  state = applyPiEvent(state, ev({ type: 'turn_end' }));

  const process = state.turnProcesses[1];
  assert.ok(process, 'turn 1 is folded at turn_end');
  assert.equal(process!.toolCalls, 2);
  assert.equal(process!.messages, 2);
  assert.equal(process!.thought, true);
  assert.equal(process!.anchorThought, false, 'this answer carried no reasoning of its own');

  const users = entriesOfKind(state, 'user');
  const assistants = entriesOfKind(state, 'assistant') as AssistantEntry[];
  const answer = assistants[assistants.length - 1]!;
  assert.equal(process!.anchorId, answer.id, 'anchor is the final text step');
  assert.ok(!process!.hiddenIds.includes(users[0]!.id), 'the user message never folds');
  assert.ok(!process!.hiddenIds.includes(answer.id), 'the answer never folds');
  assert.deepEqual(
    process!.hiddenIds,
    [assistants[0]!.id, assistants[1]!.id],
    'both intermediate steps fold, in order',
  );
  assert.equal(state.activeTurn, null, 'the window is closed');
});

check('turn fold: agent_settled is the backstop when turn_end never fires', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'turn_start' }));
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'user', content: 'go', timestamp: 1 } }));
  state = applyStep(state, 'call_x');
  state = applyAnswer(state, 'ok');
  state = applyPiEvent(state, ev({ type: 'agent_settled' }));
  assert.ok(state.turnProcesses[1], 'folded on settle');
});

check('turn fold: no textual answer means nothing folds', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'turn_start' }));
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'user', content: 'go', timestamp: 1 } }));
  state = applyStep(state, 'call_only');
  state = applyPiEvent(state, ev({ type: 'turn_end' }));
  assert.deepStrictEqual(state.turnProcesses, {}, 'process with no answer stays inline');
});

check('turn fold: a history rebuild mid-turn skips folding instead of guessing', () => {
  let state = createTranscript();
  state = applyPiEvent(state, ev({ type: 'turn_start' }));
  state = applyPiEvent(state, ev({ type: 'message_start', message: { role: 'user', content: 'go', timestamp: 1 } }));
  // Reconnect rebuild replaces every id the window marker pointed at.
  state = applySnapshot(state, [{ role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 9 }]);
  state = applyPiEvent(state, ev({ type: 'turn_end' }));
  assert.deepStrictEqual(state.turnProcesses, {}, 'nothing folded after the marker vanished');
});

check('turn fold: history rebuilt from get_messages folds the same way', () => {
  const messages: PiAgentMessage[] = [
    { role: 'user', content: 'go', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'toolCall', id: 'c1', name: 'bash' }], stopReason: 'toolUse', timestamp: 2 },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'out' }], isError: false, timestamp: 3 },
    { role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }], stopReason: 'stop', timestamp: 4 },
    { role: 'user', content: 'again', timestamp: 5 },
    { role: 'assistant', content: [{ type: 'text', text: 'No steps.' }], stopReason: 'stop', timestamp: 6 },
  ];
  const state = applySnapshot(createTranscript(), messages);
  assert.equal(state.turnSeq, 2, 'two turns derived from the message list');
  const process = state.turnProcesses[1];
  assert.ok(process, 'the stepful turn folds');
  assert.equal(process!.toolCalls, 1);
  assert.equal(process!.messages, 1);
  assert.equal(process!.thought, true);
  // The second turn is a single text message: nothing to fold.
  assert.equal(state.turnProcesses[2], undefined);
  // The folded entry is the intermediate step, not the answer.
  const assistants = entriesOfKind(state, 'assistant') as AssistantEntry[];
  assert.deepEqual(process!.hiddenIds, [assistants[0]!.id]);
  assert.equal(process!.anchorId, assistants[1]!.id);
});

check('turn fold: a thinking-only answer folds just its reasoning', () => {
  const state = applySnapshot(createTranscript(), [
    { role: 'user', content: 'hi', timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thought about it' },
        { type: 'text', text: 'Hello.' },
      ],
      stopReason: 'stop',
      timestamp: 2,
    },
  ]);
  const process = state.turnProcesses[1];
  assert.ok(process, 'a turn whose only process is the answer reasoning folds too (dsh does)');
  assert.deepEqual(process!.hiddenIds, [], 'no separate steps fold');
  assert.equal(process!.anchorThought, true, 'the answer reasoning is hidden with the fold');
  assert.equal(process!.thought, true);
  assert.equal(process!.toolCalls, 0);
  assert.equal(process!.messages, 0);
});

/* -------------------------------------------------------------- answers */

/** A step that ended with prose and, optionally, tool calls. */
function stepEntry(id: string, text: string, toolCalls = 0): AssistantEntry {
  return {
    kind: 'assistant',
    id,
    at: 1,
    text,
    thinking: '',
    streaming: false,
    tools: Array.from({ length: toolCalls }, (_, index) => ({
      toolCallId: `${id}-t${index}`,
      toolName: 'bash',
      args: {},
      output: '',
      status: 'success' as const,
      startedAt: 1,
    })),
  };
}

function resultEntry(id: string): ToolResultEntry {
  return {
    kind: 'toolResult',
    id,
    at: 1,
    run: {
      toolCallId: `${id}-t0`,
      toolName: 'bash',
      args: {},
      output: '',
      status: 'success',
      startedAt: 1,
    },
  };
}

check('answers: the answer is the last prose step that called no tools', () => {
  // A turn narrates, reaches for a tool, narrates again. Only the last step is
  // what the reader asked to keep: the message view offers to copy that one and
  // nothing else, which is why this rule must not drift from the fold's.
  const region = [
    stepEntry('a1', '先看看有什么。', 1),
    resultEntry('r1'),
    stepEntry('a2', '看完了，接着写。', 1),
    resultEntry('r2'),
    stepEntry('a3', '这是最终答案。'),
  ];
  assert.equal(answerIndexOf(region), 4, 'the closing prose step is the answer');
});

check('answers: a turn whose every step called a tool has no answer', () => {
  // A step that reached for a tool is not a candidate even when it carries
  // prose: the reader's answer is the step that *closed* the turn in words. A
  // turn that never did — it stopped on a tool call — has nothing to offer, and
  // the fold agrees, which is the point of the rule living in one place.
  const region = [stepEntry('a1', '中间说明。', 1), resultEntry('r1')];
  assert.equal(answerIndexOf(region), -1);
});

check('answers: tool steps and empty prose are never the answer', () => {
  assert.equal(answerIndexOf([stepEntry('a1', '', 1)]), -1, 'a tool-only step');
  assert.equal(answerIndexOf([stepEntry('a1', '   ')]), -1, 'whitespace is not prose');
  assert.equal(answerIndexOf([]), -1, 'an empty region');
});

/* ------------------------------------------------- inserted / custom messages */

/** A pi `custom` message: what an extension inserts into the conversation. */
function customMessage(display: boolean, text: string, at = 1): PiAgentMessage {
  return {
    role: 'custom',
    customType: 'demo',
    content: [{ type: 'text', text }],
    display,
    timestamp: at,
  } as PiAgentMessage;
}

check('custom: a visible inserted message lands in the transcript exactly once', () => {
  // pi emits message_start *and* message_end for the same inserted message, so
  // the second delivery must not append a duplicate row.
  let state = applyPiEvent(createTranscript(), ev({ type: 'message_start', message: customMessage(true, '插入的一句') }));
  state = applyPiEvent(state, ev({ type: 'message_end', message: customMessage(true, '插入的一句') }));
  const entry = only(state, 'custom');
  assert.equal(entry.text, '插入的一句');
  assert.equal(entry.customType, 'demo');
});

check('custom: display:false stays out of the transcript', () => {
  // These are model context (pi keeps them in the conversation), not something
  // the reader asked to see. Rendering them would put internal notes on screen.
  const state = applyPiEvent(createTranscript(), ev({ type: 'message_start', message: customMessage(false, '内部约定') }));
  assert.equal(entriesOfKind(state, 'custom').length, 0);
});

check('custom: rebuilding history keeps a visible insertion and drops a hidden one', () => {
  const state = applySnapshot(createTranscript(), [
    { role: 'user', content: 'hi', timestamp: 1 },
    customMessage(true, '插入的一句', 2),
    customMessage(false, '内部约定', 3),
  ] as PiAgentMessage[]);
  const custom = entriesOfKind(state, 'custom');
  assert.equal(custom.length, 1, 'exactly the visible insertion survives the rebuild');
  assert.equal(custom[0]!.text, '插入的一句');
});

check('custom: an inserted message is not a fold step', () => {
  // Folding hides the machinery of a turn. An insertion is not machinery the
  // reader should lose, so it must not appear in hiddenIds.
  const state = applySnapshot(createTranscript(), [
    { role: 'user', content: 'hi', timestamp: 1 },
    customMessage(true, '插入的一句', 2),
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      stopReason: 'stop',
      timestamp: 3,
    },
  ] as PiAgentMessage[]);
  const inserted = only(state, 'custom');
  for (const process of Object.values(state.turnProcesses)) {
    assert.ok(
      !process!.hiddenIds.includes(inserted.id),
      'an inserted message must never be folded away',
    );
  }
});

/* -------------------------------------------------------------- images */

const pngBlock = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });

check('images: an attached image is carried, not just counted', () => {
  // The count alone left the reader looking at "1 张图片" with no picture.
  const state = applySnapshot(createTranscript(), [
    { role: 'user', content: [pngBlock('AAAA'), { type: 'text', text: '看这张' }], timestamp: 1 },
  ] as PiAgentMessage[]);
  const user = only(state, 'user');
  assert.equal(user.imageCount, 1);
  assert.equal(user.images?.length, 1);
  assert.equal(user.images?.[0]!.mimeType, 'image/png');
  assert.equal(user.images?.[0]!.data, 'AAAA');
});

check('images: an unsupported media type or an oversized payload is dropped', () => {
  // Content comes from a model or a tool; it reaches an <img>, so it is
  // validated rather than trusted.
  const state = applySnapshot(createTranscript(), [
    {
      role: 'user',
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/svg+xml' },
        { type: 'image', data: 'A'.repeat(8_000_001), mimeType: 'image/png' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 'ok' },
      ],
      timestamp: 1,
    },
  ] as PiAgentMessage[]);
  const user = only(state, 'user');
  assert.equal(user.images?.length, 1, 'only the well-formed PNG is kept');
});

check('images: a tool result carries the images it returned', () => {
  const state = applySnapshot(createTranscript(), [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'generating' },
        { type: 'toolCall', id: 'c1', name: 'render', arguments: {} },
      ],
      stopReason: 'toolUse',
      timestamp: 1,
    },
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'render',
      content: [pngBlock('BBBB')],
      isError: false,
      timestamp: 2,
    },
  ] as PiAgentMessage[]);
  // A snapshot attaches the result to the call that produced it, so the run
  // lives on the assistant entry rather than in an entry of its own.
  const run = only(state, 'assistant').tools[0]!;
  assert.equal(run.imageCount, 1);
  assert.equal(run.images?.[0]!.data, 'BBBB');
});

/* ------------------------------------------------------------------------ */

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nALL CHECKS PASSED');
}
