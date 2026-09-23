/**
 * P3-A self-check: the Team journal and its replay.
 *
 * **No model, no network, no real agent dir.** Every journal in this file lives in
 * a temporary directory, and the runtime is the same pure-in-memory object the
 * other Team checks use — the journal is an optional collaborator, so this script
 * also proves that the P2 path is untouched.
 *
 *   npx tsx scripts/check-agent-team-journal.ts
 *
 * What it pins:
 *
 *   1. write → replay round-trip: team / members / tasks / messages come back field
 *      for field, including a member's result text and a task's revision;
 *   2. a torn final line (a write cut off mid-record) is dropped, does not throw,
 *      and costs nothing but that line;
 *   3. every other unreadable line is skipped **with a reason** — bad JSON, an
 *      unknown schema version, an unknown type, a record belonging to another team;
 *   4. members that were mid-flight come back `interrupted`, and the P2 guard still
 *      refuses to let them write the task board;
 *   5. task revisions survive the replay, so CAS still works (stale refused,
 *      current accepted);
 *   6. one message id gets exactly one delivery claim — across a replay too;
 *   7. no line of any journal contains the power-loss word this design refuses to
 *      claim, and neither does the module;
 *   8. the runtime without a journal still behaves as it did in P2.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRuntime, SettingsManager, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import { AgentTeamRuntime } from '../server/agent-team/team-runtime';
import { PiHost } from '../server/pi/host';
import {
  TEAM_JOURNAL_SCHEMA_VERSION,
  TeamJournal,
  parseJournal,
  type TeamJournalRecord,
} from '../server/agent-team/team-journal';
import { createWorkerTeamTools } from '../server/agent-team/team-tools';
import {
  TEAM_ERROR_CODES,
  TEAM_FAILURE_REASONS,
  TEAM_INTERRUPT_REASONS,
  TEAM_PENDING_REASONS,
  type TeamError,
  type TeamProjection,
} from '../server/agent-team/team-types';
import { freezeDefinition } from '../server/pi/subagent-tool';
import type { AgentDefinition } from '../src/shared/agent-definitions';

/* ------------------------------------------------------------------ runner -- */

let failures = 0;
let checks = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  checks += 1;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error: unknown) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---------------------------------------------------------------- fixtures -- */

const ROOT = mkdtempSync(join(tmpdir(), 'pi-webx-team-journal-'));

function freshJournal(tag: string): TeamJournal {
  return new TeamJournal({ dir: join(ROOT, tag) });
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'journal-definition',
    revision: 2,
    name: 'journal-specialist',
    description: 'A specialist for the journal check',
    systemPrompt: 'JOURNAL-PROMPT',
    model: { mode: 'inherit' },
    tools: { mode: 'all' },
    color: 'blue',
    injectAgentsMd: false,
    maxTurns: 4,
    maxConcurrentInstances: 1,
    enabled: true,
    source: 'user',
    readOnly: false,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** A fully populated team, written through the journal. */
function seedTeam(journal: TeamJournal, parentSessionId: string): {
  runtime: AgentTeamRuntime;
  teamId: string;
  memberId: string;
  settledId: string;
  taskId: string;
  blockedTaskId: string;
  messageId: string;
  hostFieldsId: string;
} {
  const runtime = new AgentTeamRuntime({ journal, now: () => 1_700_000_000_000 });
  const team = runtime.createTeam(parentSessionId);
  const running = runtime.addMember({ teamId: team.id, definition: freezeDefinition(definition()) });
  const settled = runtime.addMember({
    teamId: team.id,
    definition: freezeDefinition(definition({ id: 'settled-definition', revision: 5 })),
  });
  runtime.settleMember({
    teamId: team.id,
    memberId: settled.id,
    status: 'idle',
    text: 'the settled answer',
    sessionId: 'run-journal-1',
  });
  const first = runtime.createTask({
    teamId: team.id,
    title: 'first task',
    description: 'do the first thing',
    writeScopes: ['server/'],
  });
  const blocked = runtime.createTask({
    teamId: team.id,
    title: 'blocked task',
    description: 'waits for the first',
    blockedBy: [first.id],
  });
  runtime.assignTask(team.id, first.id, running.id);
  runtime.updateTask({
    teamId: team.id,
    taskId: first.id,
    expectedRevision: 2,
    patch: { status: 'completed' },
  });
  const message = runtime.appendMessage({
    teamId: team.id,
    from: settled.id,
    to: 'lead',
    kind: 'result',
    payload: { summary: 'done' },
    origin: 'member-message',
    deliveredAsToolResult: false,
  });
  // A second item carries the five P3-B host fields with **non-default** values, so
  // the round-trip proves the journal persists them (condition (c) of the approval).
  // Kept separate from the first message so the delivery-claim group still has a
  // queued item to offer.
  const hostFields = runtime.appendMessage({
    teamId: team.id,
    from: settled.id,
    to: 'lead',
    kind: 'result',
    payload: { summary: 'host fields' },
    origin: 'member-settle',
    deliveredAsToolResult: false,
  });
  runtime.setMessagePendingReason(team.id, hostFields.id, TEAM_PENDING_REASONS.noLiveSession);
  runtime.setMessageDeliveryState(team.id, hostFields.id, 'candidate', { deliveryMode: 'steered' });
  runtime.setMessageDeliveryState(team.id, hostFields.id, 'failed', { failureReason: TEAM_FAILURE_REASONS.memberCancelled });
  return {
    runtime,
    teamId: team.id,
    memberId: running.id,
    settledId: settled.id,
    taskId: first.id,
    blockedTaskId: blocked.id,
    messageId: message.id,
    hostFieldsId: hostFields.id,
  };
}

/** Replay one journal file into a brand-new runtime. */
function replay(journal: TeamJournal, teamId: string): AgentTeamRuntime {
  const read = journal.readTeam(teamId);
  assert.notEqual(read, undefined, `journal file for ${teamId} exists`);
  const replayed = new AgentTeamRuntime({ journal });
  replayed.hydrate({ teamId, records: (read as { records: readonly TeamJournalRecord[] }).records });
  return replayed;
}

/**
 * A projection prepared for a round-trip comparison.
 *
 * One transformation is *allowed* across a restart: a member whose last recorded
 * status was `running`/`cancelling` comes back `interrupted`, because its worker
 * session was in memory. Everything else — ids, revisions, task state, message order,
 * `lastSeq` cursors, sequence numbers — must be identical, and that is what the
 * comparisons using this helper assert.
 *
 * The revive itself is **not** blanked out into nothing: its exact status, prose reason
 * and closed-set `statusReason` are pinned in the dedicated group below (`restart-replay`,
 * never `host-shutdown`). Blanking those three fields here only keeps this helper about
 * everything *else*.
 */
function forRoundTrip(view: TeamProjection | undefined): unknown {
  if (view === undefined) return undefined;
  return {
    ...view,
    members: view.members.map((member) => (
      member.status === 'running' || member.status === 'cancelling' || member.status === 'interrupted'
        ? { ...member, status: '<mid-flight>', hasResult: '<mid-flight>', statusReason: '<mid-flight>', untrustedResult: '<mid-flight>' }
        : member
    )),
  };
}

/* ------------------------------------------------------- 1. round trip ---- */

await check('write → replay: team, members, tasks and messages come back identical', () => {
  const journal = freshJournal('round-trip');
  const seeded = seedTeam(journal, 'parent-rt');
  const before = seeded.runtime.snapshot(seeded.teamId);
  assert.notEqual(before, undefined);

  const replayed = replay(journal, seeded.teamId);
  const after = replayed.snapshot(seeded.teamId);
  assert.deepEqual(forRoundTrip(after), forRoundTrip(before), 'the projection is identical after the replay');

  // And the underlying state, not just the projection: revisions, result text,
  // sequence numbers and membership.
  const original = seeded.runtime.requireTeam(seeded.teamId);
  const restored = replayed.requireTeam(seeded.teamId);
  assert.equal(restored.parentSessionId, 'parent-rt');
  assert.equal(restored.createdAt, original.createdAt);
  assert.equal(restored.seq, original.seq, 'the message sequence continues where it stopped');
  assert.deepEqual(
    [...restored.tasks.values()].map((task) => ({ id: task.id, revision: task.revision, status: task.status })).sort((a, b) => a.id.localeCompare(b.id)),
    [...original.tasks.values()].map((task) => ({ id: task.id, revision: task.revision, status: task.status })).sort((a, b) => a.id.localeCompare(b.id)),
    'task revisions and statuses are preserved',
  );
  assert.equal(replayed.requireMember(seeded.teamId, seeded.settledId).resultText, 'the settled answer', 'the settled text is restored');
  assert.equal(replayed.requireMember(seeded.teamId, seeded.settledId).sessionId, 'run-journal-1');
  assert.equal(replayed.requireMember(seeded.teamId, seeded.settledId).definitionRevision, 5);
  assert.deepEqual(
    restored.messages.map((message) => message.payload),
    original.messages.map((message) => message.payload),
  );
});

await check('replay is idempotent: applying the same records twice changes nothing', () => {
  const journal = freshJournal('idempotent');
  const seeded = seedTeam(journal, 'parent-idem');
  const read = journal.readTeam(seeded.teamId) as { records: readonly TeamJournalRecord[] };
  const replayed = new AgentTeamRuntime({ journal });
  replayed.hydrate({ teamId: seeded.teamId, records: read.records });
  const once = forRoundTrip(replayed.snapshot(seeded.teamId));
  replayed.hydrate({ teamId: seeded.teamId, records: read.records });
  assert.deepEqual(forRoundTrip(replayed.snapshot(seeded.teamId)), once, 'a second replay is a no-op');
});

/* ------------------------------------------------- 2. torn / corrupt lines -- */

await check('a torn final line is dropped, and the rest still replays', () => {
  const journal = freshJournal('torn');
  const seeded = seedTeam(journal, 'parent-torn');
  const file = journal.fileFor(seeded.teamId);
  const before = readFileSync(file, 'utf8');
  // Simulate a write that died mid-record: half a JSON object, no newline.
  writeFileSync(file, `${before}{"v":1,"seq":999,"teamId":"${seeded.teamId}","type":"task-crea`);

  const read = journal.readTeam(seeded.teamId);
  assert.notEqual(read, undefined);
  const result = read as { records: readonly TeamJournalRecord[]; skipped: readonly { reason: string }[] };
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['torn-final-line'], 'exactly the torn line is reported');
  assert.equal(result.records.length, before.trimEnd().split('\n').length, 'every complete line survives');

  const replayed = replay(journal, seeded.teamId);
  assert.deepEqual(
    forRoundTrip(replayed.snapshot(seeded.teamId)),
    forRoundTrip(seeded.runtime.snapshot(seeded.teamId)),
    'the state is intact',
  );
});

await check('every other bad line is skipped with a reason, and nothing throws', () => {
  const journal = freshJournal('corrupt');
  const seeded = seedTeam(journal, 'parent-corrupt');
  const file = journal.fileFor(seeded.teamId);
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  const teamId = seeded.teamId;
  const injected = [
    '{"v":1,"seq":901,"teamId":"' + teamId + '","type":"task-created"',            // truncated, not last
    'not json at all',                                                              // bad json
    JSON.stringify({ v: 99, seq: 902, ts: 0, teamId, type: 'task-created', task: {} }), // unknown version
    JSON.stringify({ v: 1, seq: 903, ts: 0, teamId, type: 'team-exploded' }),        // unknown type
    JSON.stringify({ v: 1, seq: 904, ts: 0, teamId: 'someone-else', type: 'task-created', task: {} }), // foreign
  ];
  writeFileSync(file, [...lines.slice(0, 1), ...injected, ...lines.slice(1)].join('\n') + '\n');

  const read = journal.readTeam(teamId) as { records: readonly TeamJournalRecord[]; skipped: readonly { reason: string }[] };
  assert.deepEqual(
    read.skipped.map((entry) => entry.reason).sort(),
    ['bad-json', 'bad-json', 'foreign-team', 'unknown-type', 'unknown-version'].sort(),
    'each unusable line is accounted for, by reason',
  );
  assert.equal(read.records.length, lines.length, 'and every good line is still replayed');
  const replayed = replay(journal, teamId);
  assert.deepEqual(
    forRoundTrip(replayed.snapshot(teamId)),
    forRoundTrip(seeded.runtime.snapshot(teamId)),
    'the state is intact despite the damage',
  );
});

await check('unknown schema versions are refused as a class, not parsed optimistically', () => {
  const future = JSON.stringify({ v: TEAM_JOURNAL_SCHEMA_VERSION + 1, seq: 1, ts: 0, teamId: 't', type: 'team-created' });
  const result = parseJournal('inline', `${future}\n`, 't');
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['unknown-version']);
});

/* ----------------------------------------- 3. interrupted members + guards -- */

await check('members that were mid-flight replay as interrupted and cannot write the board', async () => {
  const journal = freshJournal('interrupted');
  const seeded = seedTeam(journal, 'parent-interrupted');
  const replayed = replay(journal, seeded.teamId);

  const running = replayed.requireMember(seeded.teamId, seeded.memberId);
  assert.equal(running.status, 'interrupted', 'a running member cannot come back alive');
  assert.match(running.resultText ?? '', /重启/, 'and the reason says why');
  // The closed-set code is pinned here, and it is *this* one: a replay is not a graceful
  // shutdown, and a reader that cannot tell them apart cannot tell "we shut down" from
  // "the last process never finished".
  assert.equal(
    running.statusReason,
    TEAM_INTERRUPT_REASONS.restartReplay,
    'a replayed member carries the restart-replay code',
  );
  assert.notEqual(running.statusReason, TEAM_INTERRUPT_REASONS.hostShutdown, 'which is not the shutdown code');
  const settled = replayed.requireMember(seeded.teamId, seeded.settledId);
  assert.equal(settled.status, 'idle', 'a member that had finished stays finished');
  assert.equal(settled.statusReason, undefined, 'and no replay code is stamped onto it');

  const tools = createWorkerTeamTools({
    teamId: seeded.teamId,
    memberId: seeded.memberId,
    runtime: replayed,
  });
  const update = tools.find((tool) => tool.name === 'update_team_task') as ToolDefinition;
  const before = JSON.stringify(replayed.snapshot(seeded.teamId));
  await assert.rejects(
    () => update.execute('call-1', { taskId: seeded.blockedTaskId, expectedRevision: 2, status: 'in_progress' }, undefined, undefined, {} as ExtensionContext),
    (error: unknown) => {
      assert.equal((error as TeamError).code, TEAM_ERROR_CODES.memberNotActive);
      return true;
    },
  );
  assert.equal(JSON.stringify(replayed.snapshot(seeded.teamId)), before, 'and the refusal changed nothing');
});

/* ------------------------------------------------- 4. revision + CAS ------- */

await check('task revisions survive the replay and CAS still decides', () => {
  const journal = freshJournal('cas');
  const seeded = seedTeam(journal, 'parent-cas');
  const replayed = replay(journal, seeded.teamId);
  const task = replayed.getTask(seeded.teamId, seeded.taskId);
  assert.equal(task?.revision, 3, 'the revision after create(1) + assign(2) + complete(3)');
  assert.equal(task?.status, 'completed');

  assert.throws(
    () => replayed.updateTask({
      teamId: seeded.teamId,
      taskId: seeded.taskId,
      expectedRevision: 1,
      patch: { status: 'pending' },
    }),
    (error: unknown) => (error as TeamError).code === TEAM_ERROR_CODES.taskStaleRevision,
    'a stale revision is still refused',
  );
  const updated = replayed.updateTask({
    teamId: seeded.teamId,
    taskId: seeded.taskId,
    expectedRevision: 3,
    patch: { title: 'renamed after the replay' },
  });
  assert.equal(updated.revision, 4, 'and the current revision is accepted');

  // The blocked dependent was promoted when the first task completed — that derived
  // change is journaled too, so it survives as well.
  assert.equal(replayed.getTask(seeded.teamId, seeded.blockedTaskId)?.status, 'pending');
});

/* --------------------------------------------------- 5. delivery claims ---- */

await check('one message id gets exactly one delivery claim, across a replay', () => {
  const journal = freshJournal('claims');
  const seeded = seedTeam(journal, 'parent-claims');
  const replayed = replay(journal, seeded.teamId);

  assert.deepEqual(
    replayed.pendingDeliveries(seeded.teamId).map((message) => message.id),
    [seeded.messageId],
    'the queued message is offered for delivery',
  );
  assert.equal(replayed.claimDelivery(seeded.teamId, seeded.messageId), true, 'the first claim succeeds');
  assert.equal(replayed.claimDelivery(seeded.teamId, seeded.messageId), false, 'the second is refused');
  assert.equal(replayed.deliveryClaimed(seeded.messageId), true);
  assert.equal(replayed.requireTeam(seeded.teamId).messages[0]?.deliveryState, 'inflight', 'the state moved with the claim');

  // The claim was appended before it was handed out, so a restart cannot re-issue it.
  const afterRestart = replay(journal, seeded.teamId);
  assert.equal(afterRestart.claimDelivery(seeded.teamId, seeded.messageId), false, 'the claim survives the replay');
  assert.deepEqual(afterRestart.pendingDeliveries(seeded.teamId), [], 'so nothing is offered again');
  assert.equal(afterRestart.requireTeam(seeded.teamId).messages[0]?.deliveryState, 'inflight');

  const unknown = new AgentTeamRuntime({ journal });
  unknown.createTeam('parent-unknown');
  assert.equal(unknown.claimDelivery(unknown.requireTeam(unknown.listTeams()[0] as string).id, 'no-such-message'), false);
});

/* --------------------------------------------------------- 6. wording ------ */

await check('no journal line, and no Team module, claims power-loss safety', () => {
  const journal = freshJournal('wording');
  const seeded = seedTeam(journal, 'parent-wording');
  const text = readFileSync(journal.fileFor(seeded.teamId), 'utf8');
  const banned = 'dur' + 'able';
  assert.ok(!text.includes(banned), 'the journal file does not use the word this design refuses');
  assert.ok(!readFileSync(join(import.meta.dirname, '..', 'server', 'agent-team', 'team-journal.ts'), 'utf8').includes(banned));
  assert.ok(!readFileSync(join(import.meta.dirname, '..', 'server', 'agent-team', 'team-runtime.ts'), 'utf8').includes(banned));
  assert.ok(text.includes('"v":1'), 'and every record carries the schema version');
});

/* --------------------------------------------- 7. the P2 path is untouched -- */

await check('a runtime without a journal behaves exactly as it did in P2', () => {
  const runtime = new AgentTeamRuntime();
  const team = runtime.createTeam('parent-memory');
  const member = runtime.addMember({ teamId: team.id, definition: freezeDefinition(definition()) });
  const task = runtime.createTask({ teamId: team.id, title: 't', description: 'd' });
  const message = runtime.appendMessage({ teamId: team.id, from: member.id, to: 'lead', kind: 'result', payload: null });
  assert.equal(runtime.snapshot(team.id)?.members.length, 1);
  assert.equal(runtime.claimDelivery(team.id, message.id), true, 'the ledger works without a journal too');
  assert.equal(runtime.claimDelivery(team.id, message.id), false);
  assert.equal(runtime.getTask(team.id, task.id)?.revision, 1);
});

/* ------------------------------------- 8. the host-level replay is idempotent -- */

await check('hydrateTeams: bounded cost, idempotent second call, no sequence regression', async () => {
  const dir = join(ROOT, 'host-replay');
  const journal = new TeamJournal({ dir });
  const seeded = seedTeam(journal, 'parent-host');
  const file = journal.fileFor(seeded.teamId);
  const bytesOnDisk = readFileSync(file).byteLength;

  const host = new PiHost({
    teamJournalDir: dir,
    definitions: {
      read: async () => ({ schemaVersion: 1, revision: 1, path: join(ROOT, 'definitions.json'), agents: [] }),
    },
  });
  clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  try {
    const first = await host.hydrateTeams();
    assert.equal(first.teams, 1, 'the team is rebuilt');
    assert.equal(first.files, 1, 'from one file');
    assert.equal(first.bytes, bytesOnDisk, 'and the cost is reported in bytes, not guessed');
    assert.ok(typeof first.durationMs === 'number' && first.durationMs >= 0, 'with a measured duration');
    assert.equal(first.interrupted, 1, 'the mid-flight member is reported as interrupted');
    // The numbers the startup log prints, so a reader can see the real cost of the
    // replay this run performed rather than trust an estimate.
    console.log(`     replay cost: ${first.files} file(s), ${first.bytes} bytes, ${first.durationMs}ms, `
      + `${first.teams} team(s), ${first.members} member(s), ${first.tasks} task(s), ${first.messages} message(s)`);

    const snapshot = host.teamSnapshot(seeded.teamId);
    assert.notEqual(snapshot, undefined, 'the projection is reachable by team id right after the replay');
    const second = await host.hydrateTeams();
    assert.equal(second.teams, 0, 'a second call rebuilds nothing');
    assert.equal(second.files, 0, 'and reads nothing: an in-memory team is left alone');
    assert.deepEqual(host.teamSnapshot(seeded.teamId), snapshot, 'so the state is unchanged');
    assert.equal(readFileSync(file).byteLength, bytesOnDisk, 'and the journal was not rewritten');

    // Numbering: a message appended after a replay continues from the replayed max,
    // which is what keeps `seq` monotonic across a restart.
    const replayed = replay(journal, seeded.teamId);
    const team = replayed.requireTeam(seeded.teamId);
    const before = team.seq;
    const added = replayed.appendMessage({
      teamId: seeded.teamId,
      from: seeded.settledId,
      to: 'lead',
      kind: 'answer',
      payload: { after: 'restart' },
    });
    assert.equal(added.seq, before + 1, 'the sequence continues where the replay stopped');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { seq?: number; message?: { seq?: number } };
    assert.equal(last.message?.seq, before + 1, 'and the appended record carries that number');
    assert.ok((last.seq ?? 0) > 0, 'with a monotonic record sequence of its own');
  } finally {
    clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  }
});

/* ------------------------------------------- 9. the three verification fixes -- */

await check('F-A: the replay counts teams that exist, not files that parsed', async () => {
  const dir = join(ROOT, 'metrics');
  mkdirSync(dir, { recursive: true });
  // 200 empty files, plus 25 with a name that matches no team, plus one whose only
  // records belong to another team — the three shapes the verification used.
  for (let index = 0; index < 200; index += 1) writeFileSync(join(dir, `empty-${index}.jsonl`), '');
  for (let index = 0; index < 25; index += 1) {
    writeFileSync(join(dir, `orphan-${index}.jsonl`), `${JSON.stringify({ v: 1, seq: 1, ts: 0, teamId: `other-${index}`, type: 'team-created', parentSessionId: 'p' })}\n`);
  }
  const journal = new TeamJournal({ dir });
  const host = new PiHost({
    teamJournalDir: dir,
    definitions: {
      read: async () => ({ schemaVersion: 1, revision: 1, path: join(ROOT, 'definitions.json'), agents: [] }),
    },
  });
  clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  try {
    const result = await host.hydrateTeams();
    assert.equal(result.teams, 0, 'no team is reported when no team is in memory');
    assert.equal(result.files, 225, 'while the file count still tells the truth (200 empty + 25 orphan)');
    assert.equal(result.unusable, 225, 'and the files that held no team are counted separately');
    assert.equal(result.skipped, 25, 'the foreign records inside them are counted as skipped lines');
    assert.equal((host as unknown as { teams: { listTeams(): string[] } }).teams.listTeams().length, 0);
  } finally {
    clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  }
  void journal;
});

await check('F-B: a journal path occupied by a file degrades to memory, it does not stop the host', async () => {
  const path = join(ROOT, 'occupied-journal');
  writeFileSync(path, 'not a directory\n');

  // Before the fix this threw EEXIST out of the constructor and the server never started.
  const host = new PiHost({
    teamJournalDir: path,
    definitions: {
      read: async () => ({ schemaVersion: 1, revision: 1, path: join(ROOT, 'definitions.json'), agents: [] }),
    },
  });
  clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  try {
    const result = await host.hydrateTeams();
    assert.equal(result.files, 0, 'there is nothing to replay');
    assert.equal(typeof result.journalDisabled, 'string', 'and the degradation is observable, not silent');
    assert.ok((result.journalDisabled ?? '').length > 0, 'with a reason attached');

    // Team functionality still works, in memory only: this is the promise the fix makes.
    const internals = host as unknown as { teams: AgentTeamRuntime };
    const team = internals.teams.createTeam('parent-degraded');
    const member = internals.teams.addMember({ teamId: team.id, definition: freezeDefinition(definition()) });
    const task = internals.teams.createTask({ teamId: team.id, title: 't', description: 'd' });
    internals.teams.updateTask({
      teamId: team.id,
      taskId: task.id,
      expectedRevision: 1,
      patch: { ownerMemberId: member.id, status: 'in_progress' },
    });
    assert.equal(host.teamSnapshot(team.id)?.members.length, 1, 'the runtime still orchestrates');
    assert.equal(host.teamSnapshot(team.id)?.tasks[0]?.status, 'in_progress');
    assert.equal(host.resolveTeamId('parent-degraded'), team.id, 'and the session alias still resolves');
  } finally {
    clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  }
});

await check('F-C: after a replay the parent session id reaches the same Team, and teamId still wins', async () => {
  const dir = join(ROOT, 'alias-replay');
  const journal = new TeamJournal({ dir });
  const seeded = seedTeam(journal, 'session-without-transcript');
  const expected = seeded.runtime.snapshot(seeded.teamId);

  // A brand-new process: no live session table entry for that session at all — the
  // session never wrote a transcript, which is exactly the measured case.
  const host = new PiHost({
    teamJournalDir: dir,
    definitions: {
      read: async () => ({ schemaVersion: 1, revision: 1, path: join(ROOT, 'definitions.json'), agents: [] }),
    },
  });
  clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  try {
    await host.hydrateTeams();
    assert.equal(host.resolveTeamId('session-without-transcript'), seeded.teamId, 'the replayed index answers');
    assert.deepEqual(
      forRoundTrip(host.teamSnapshot('session-without-transcript')),
      forRoundTrip(expected),
      'and the session id yields the identical projection',
    );
    assert.deepEqual(
      host.teamSnapshot('session-without-transcript'),
      host.teamSnapshot(seeded.teamId),
      'as the team id does',
    );

    // Ambiguity is unchanged: an id that is both a team id and a session id in the
    // replay index resolves to the team (the route names a team).
    const internals = host as unknown as { teams: AgentTeamRuntime };
    internals.teams.createTeam(seeded.teamId);
    assert.equal(host.resolveTeamId(seeded.teamId), seeded.teamId, 'teamId still wins');
    assert.equal(host.teamSnapshot('nobody-at-all'), undefined, 'and an unknown id is still 404');
  } finally {
    clearInterval((host as unknown as { sweeper: NodeJS.Timeout }).sweeper);
  }
});

await check('resuming a stored Team reattaches its task board without creating another Team', async () => {
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(ROOT, 'resume-agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const work = join(ROOT, 'resume-work');
  mkdirSync(work, { recursive: true });
  const sessionId = '01a0b900-dead-beef-0000-000000000099';
  const sessionDir = join(ROOT, 'resume-sessions');
  const storedFile = join(sessionDir, `2026-09-22T00-00-00-000Z_${sessionId}.jsonl`);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(storedFile, [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-09-22T00:00:00.000Z', cwd: work }),
    JSON.stringify({
      type: 'message', id: 'e0000001', parentId: null, timestamp: '2026-09-22T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'previous turn' }], timestamp: 1 },
    }),
  ].join('\n') + '\n');

  const journal = freshJournal('resume-team');
  const seeded = new AgentTeamRuntime({ journal });
  const team = seeded.createTeam(sessionId);
  const task = seeded.createTask({ teamId: team.id, title: 'continue this work', description: 'existing task' });
  const member = seeded.addMember({ teamId: team.id, definition: freezeDefinition(definition()) });
  seeded.settleMember({ teamId: team.id, memberId: member.id, status: 'idle', text: 'existing result' });

  let first: PiHost | undefined;
  let second: PiHost | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false,
    });
    const options = {
      teamJournalDir: journal.directory,
      sessionDir,
      definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(ROOT, 'definitions.json'), agents: [] }) },
      modelRuntimeFactory: async () => runtime,
      settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
    };
    first = new PiHost(options);
    const resumed = await first.create({ cwd: work, sessionPath: storedFile });
    assert.equal(resumed.teamMode, true, 'the stored Team enables Team mode without a browser hint');
    assert.equal(resumed.teamId, team.id, 'the original Team id is reused');
    assert.equal(first.teamSnapshot(sessionId)?.tasks[0]?.taskId, task.id, 'the original task remains visible');
    assert.equal(first.teamSnapshot(sessionId)?.members[0]?.untrustedResult?.text, 'existing result');
    await first.disposeAll();
    first = undefined;

    second = new PiHost(options);
    const explicitlyResumed = await second.create({ cwd: work, sessionPath: storedFile, teamMode: true });
    assert.equal(explicitlyResumed.teamId, team.id, 'an explicit Team hint also reuses the stored Team');
    assert.deepEqual(journal.listTeamIds(), [team.id], 'no second journal is created');
  } finally {
    await first?.disposeAll();
    await second?.disposeAll();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
});

await check('blank lines are counted, except the one a trailing newline produces', () => {
  const record = JSON.stringify({ v: 1, seq: 1, ts: 0, teamId: 't', type: 'team-created', parentSessionId: 'p' });
  const healthy = parseJournal('inline', `${record}\n`, 't');
  assert.deepEqual(healthy.skipped, [], 'a normal file reports nothing');
  const withBlank = parseJournal('inline', `${record}\n\n${record}\n`, 't');
  assert.deepEqual(withBlank.skipped.map((entry) => entry.reason), ['blank-line'], 'a blank line between records is counted');
  assert.equal(withBlank.records.length, 2, 'and both records still replay');
});

await check('the five P3-B host fields survive the round trip, each with a non-default value', () => {
  const journal = freshJournal('host-fields');
  const seeded = seedTeam(journal, 'parent-host-fields');
  const before = seeded.runtime.requireTeam(seeded.teamId).messages.find((m) => m.id === seeded.hostFieldsId);
  assert.equal(before?.origin, 'member-settle');
  assert.equal(before?.deliveredAsToolResult, false);
  assert.equal(before?.deliveryMode, 'steered');
  assert.equal(before?.failureReason, TEAM_FAILURE_REASONS.memberCancelled);

  const replayed = replay(journal, seeded.teamId);
  const after = replayed.requireTeam(seeded.teamId).messages.find((m) => m.id === seeded.hostFieldsId);
  assert.equal(after?.origin, before?.origin, 'origin is restored');
  assert.equal(after?.deliveredAsToolResult, before?.deliveredAsToolResult, 'deliveredAsToolResult is restored');
  assert.equal(after?.deliveryMode, before?.deliveryMode, 'deliveryMode is restored');
  assert.equal(after?.failureReason, before?.failureReason, 'failureReason is restored');
  assert.equal(after?.deliveryState, before?.deliveryState, 'and the delivery state');
  // A pending reason is a queued-only marker: the seeded item moved past it, so the
  // journal must have dropped it exactly as the runtime did.
  assert.equal(after?.pendingReason, undefined, 'a non-queued item carries no pendingReason');
  assert.equal(after?.pendingReason, before?.pendingReason);

  // The same item, still queued, keeps its reason across a replay.
  const queued = replayed.appendMessage({
    teamId: seeded.teamId,
    from: seeded.settledId,
    to: 'lead',
    kind: 'result',
    payload: 'not delivered yet',
    origin: 'member-message',
  });
  replayed.setMessagePendingReason(seeded.teamId, queued.id, TEAM_PENDING_REASONS.noLiveSession);
  const read = journal.readTeam(seeded.teamId);
  assert.notEqual(read, undefined);
  const again = new AgentTeamRuntime({ journal });
  again.hydrate({ teamId: seeded.teamId, records: (read as { records: readonly never[] }).records });
  assert.equal(again.requireTeam(seeded.teamId).messages.at(-1)?.pendingReason, TEAM_PENDING_REASONS.noLiveSession);
});

/* ------------------------------------------------------------------ summary -- */

console.log(`\ncheck-agent-team-journal: ${checks - failures}/${checks} passed`);
if (failures > 0) process.exitCode = 1;
else console.log('check-agent-team-journal: all assertions passed');
