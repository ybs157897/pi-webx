/**
 * Self-check for `server/agent-definitions.ts` — the user-owned sub-agent store.
 *
 * Runs entirely in throwaway directories with an explicit `filePath`, so the
 * user's real `~/.pi/agent/**` is never read or written. Only the one case about
 * default path resolution touches `PI_CODING_AGENT_DIR`, and it points that at a
 * temp directory first.
 *
 *   npx tsx scripts/check-agent-definitions.ts
 *
 * Covers: missing-file read, create/update/delete round-trip, identity and
 * revision bookkeeping, `all` vs `selected []`, NFKC + case-folded name
 * uniqueness, unknown-field rejection, limits/model/thinking validation,
 * restricted dispatch names, `expectedRevision` typing and 409 CAS (including
 * two winners-at-one-revision), corrupt-file refusal without overwrite, disk
 * re-read through a fresh store, 0600 mode, tmp-file cleanup on success and on a
 * failed write, and "no credentials/path ever land in the file".
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentDefinitionError,
  AgentDefinitionStore,
  RESTRICTED_AGENT_TOOL_DISPLAY_NAMES,
  agentDefinitionsStore,
  isRestrictedAgentTool,
} from '../server/agent-definitions';
import {
  SUBAGENT_COLORS,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentDefinitionsResponse,
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

const root = mkdtempSync(path.join(os.tmpdir(), 'piwebx-agentdefs-'));

function freshStore(label: string): { store: AgentDefinitionStore; filePath: string; dir: string } {
  const dir = path.join(root, label);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, 'agent-definitions.json');
  return { store: new AgentDefinitionStore({ filePath }), filePath, dir };
}

function input(overrides: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    name: 'scout',
    description: 'Recon a codebase and report compressed findings.',
    systemPrompt: 'You are a scout. Read only, report facts with file paths.',
    model: { mode: 'inherit' },
    tools: { mode: 'all' },
    maxTurns: 8,
    maxConcurrentInstances: 1,
    enabled: true,
    ...overrides,
  };
}

/** The user definitions in a response: built-ins are always merged in first. */
function users(response: AgentDefinitionsResponse): AgentDefinition[] {
  return response.agents.filter((agent) => agent.source === 'user');
}

/** The n-th user definition — what essentially every case here creates. */
function userAt(response: AgentDefinitionsResponse, index = 0): AgentDefinition {
  const found = users(response)[index];
  assert.ok(found !== undefined, `user definition #${String(index)} exists`);
  return found;
}

async function expectStatus(
  promise: Promise<unknown>,
  status: number,
  label: string,
): Promise<AgentDefinitionError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof AgentDefinitionError,
      `${label}: expected AgentDefinitionError, got ${String(error)}`,
    );
    assert.equal(error.status, status, `${label}: status`);
    assert.ok(error.message.trim().length > 0, `${label}: message must not be empty`);
    return error;
  }
  return assert.fail(`${label}: expected status ${status}, but the call resolved`);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      collectKeys(entry, into);
    }
  }
}

async function main(): Promise<void> {
  assert.ok(agentDefinitionsStore instanceof AgentDefinitionStore, 'singleton is exported');

  await check('missing file reads as revision 0, no agents, with the server path', async () => {
    const { store, filePath } = freshStore('missing');
    const read = await store.read();
    assert.equal(read.schemaVersion, 1);
    assert.equal(read.revision, 0);
    assert.deepEqual(users(read), [], 'the file holds no user definitions yet');
    assert.deepEqual(
      read.agents.map((agent) => agent.id),
      ['builtin:general-purpose', 'builtin:explore'],
      'a missing file still lists the two built-ins',
    );
    assert.equal(read.path, filePath);
    assert.equal(statSync(filePath, { throwIfNoEntry: false }), undefined, 'a read must not create the file');
  });

  await check('built-ins: merged first, always enabled, never written to disk', async () => {
    const { store, filePath } = freshStore('builtins');
    const read = await store.read();
    assert.deepEqual(
      read.agents.map((agent) => agent.id),
      ['builtin:general-purpose', 'builtin:explore'],
      'fixed ids, built-ins before user definitions',
    );
    const general = read.agents[0]!;
    const explore = read.agents[1]!;

    for (const agent of [general, explore]) {
      assert.equal(agent.source, 'builtin');
      assert.equal(agent.readOnly, true);
      assert.equal(agent.enabled, true, 'a built-in has no enable switch');
      assert.equal(agent.revision, 1);
      assert.equal(agent.createdAt, '', 'no creation record to render');
      assert.equal(agent.updatedAt, '');
      assert.equal(agent.maxTurns, 4);
      assert.equal(agent.maxConcurrentInstances, 1);
      assert.deepEqual(agent.model, { mode: 'inherit' });
      assert.equal(Object.hasOwn(agent, 'thinkingLevel'), false);
      assert.ok(agent.systemPrompt.includes('\n\nNotes:'), 'the ZCode Notes section is appended');
      assert.ok(agent.systemPrompt.includes('never relative) that are relevant to the task'));
      assert.ok(agent.systemPrompt.includes('Do NOT Write report/summary/findings/analysis .md files.'));
    }

    assert.equal(general.name, 'general-purpose');
    assert.deepEqual(general.tools, { mode: 'all' });
    assert.equal(general.color, 'blue');
    assert.equal(general.injectAgentsMd, true);

    assert.equal(explore.name, 'Explore');
    assert.deepEqual(
      explore.tools,
      { mode: 'selected', names: ['read', 'grep', 'find', 'ls'] },
      'Explore is read-only in the tool policy, not just in prose',
    );
    assert.equal(explore.color, 'cyan');
    assert.equal(explore.injectAgentsMd, false);
    assert.ok(explore.systemPrompt.includes('Use find for broad file pattern matching'));
    assert.ok(explore.systemPrompt.includes('Use grep for searching file contents with regex'));
    assert.ok(explore.systemPrompt.includes('Use read when you know the specific file path you need to read'));
    assert.equal(
      explore.systemPrompt.includes('Use Bash ONLY for read-only operations'),
      false,
      'the Bash guidelines are gone',
    );
    assert.equal(explore.systemPrompt.includes('NEVER use Bash for'), false);
    assert.ok(explore.systemPrompt.includes('You have no Bash tool and no write tool of any kind'));

    assert.equal(statSync(filePath, { throwIfNoEntry: false }), undefined, 'built-ins do not create the file');

    const created = await store.create({ expectedRevision: 0, definition: input({ name: 'disk-check' }) });
    assert.equal(users(created).length, 1);
    const text = readFileSync(filePath, 'utf8');
    assert.equal(text.includes('builtin:'), false, 'no built-in id lands on disk');
    assert.equal(text.includes('"source"'), false, 'source is derived on read, never stored');
    assert.equal(text.includes('"readOnly"'), false, 'readOnly is derived on read, never stored');
  });

  await check('a built-in id is read-only: PATCH and DELETE are 400 and write nothing', async () => {
    const { store, filePath } = freshStore('builtin-lock');
    const created = await store.create({ expectedRevision: 0, definition: input({ name: 'keeper' }) });
    const sha = (): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const before = sha();

    const patched = await expectStatus(
      store.update('builtin:general-purpose', {
        expectedRevision: created.revision,
        patch: { description: 'hijacked' },
      }),
      400,
      'patch a built-in',
    );
    assert.equal(patched.message, '内置子智能体不可修改');
    const deleted = await expectStatus(
      store.delete('builtin:explore', { expectedRevision: created.revision }),
      400,
      'delete a built-in',
    );
    assert.equal(deleted.message, '内置子智能体不可删除');
    assert.equal(sha(), before, 'a refused built-in write leaves the file byte-identical');

    // The built-in answer is not a revision question: even a stale
    // `expectedRevision` reports the built-in refusal, not a 409.
    const stale = await expectStatus(
      store.update('builtin:explore', { expectedRevision: 99, patch: {} }),
      400,
      'built-in beats CAS',
    );
    assert.equal(stale.message, '内置子智能体不可修改');
    assert.deepEqual(
      (await store.read()).agents.map((agent) => agent.id),
      ['builtin:general-purpose', 'builtin:explore', userAt(created).id],
    );

    // And a built-in id against a file that does not exist must not create one.
    const fresh = freshStore('builtin-lock-missing');
    await expectStatus(
      fresh.store.delete('builtin:explore', { expectedRevision: 0 }),
      400,
      'delete a built-in on a missing file',
    );
    await expectStatus(
      fresh.store.update('builtin:general-purpose', { expectedRevision: 0, patch: { color: 'red' } }),
      400,
      'patch a built-in on a missing file',
    );
    assert.equal(statSync(fresh.filePath, { throwIfNoEntry: false }), undefined, 'still no file');
  });

  await check('a same-named user definition shadows the built-in', async () => {
    const { store } = freshStore('shadow');
    const created = await store.create({
      expectedRevision: 0,
      definition: input({ name: 'general-purpose', description: 'my own general-purpose' }),
    });
    const ids = created.agents.map((agent) => agent.id);
    assert.equal(ids.includes('builtin:general-purpose'), false, 'the shadowed built-in is not listed');
    assert.equal(ids.includes('builtin:explore'), true, 'the other built-in survives');
    assert.equal(created.agents.length, 2);
    const mine = userAt(created);
    assert.equal(mine.name, 'general-purpose');
    assert.equal(mine.source, 'user');
    assert.equal(mine.readOnly, false);
    assert.equal(mine.description, 'my own general-purpose');

    // Shadowing uses the same NFKC + case-fold key as uniqueness.
    const both = await store.create({
      expectedRevision: created.revision,
      definition: input({ name: 'EXPLORE' }),
    });
    assert.equal(both.agents.length, 2, 'both built-ins are now shadowed');
    assert.equal(both.agents.every((agent) => agent.source === 'user'), true);
  });

  await check('create assigns identity and returns the whole file (no path on disk)', async () => {
    const { store, filePath } = freshStore('create');
    const created = await store.create({ expectedRevision: 0, definition: input({ name: '  scout  ' }) });
    assert.equal(created.revision, 1);
    assert.equal(users(created).length, 1);
    const agent = userAt(created, 0);
    assert.equal(agent.name, 'scout', 'name is trimmed');
    assert.equal(agent.revision, 1);
    assert.match(agent.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid');
    assert.ok(!Number.isNaN(Date.parse(agent.createdAt)), 'createdAt is a time');
    assert.equal(agent.createdAt, agent.updatedAt);
    assert.equal(agent.enabled, true);
    const onDisk = readJson(filePath);
    assert.equal(onDisk['path'], undefined, 'path is added on read, never stored');
    assert.equal(onDisk['revision'], 1);
    assert.equal((onDisk['agents'] as unknown[]).length, 1);
  });

  await check('tools: explicit all has no names; selected [] is legal and preserved', async () => {
    const { store } = freshStore('tools-default');
    const all = await store.create({ expectedRevision: 0, definition: input({ name: 'all-tools' }) });
    assert.deepEqual(userAt(all, 0).tools, { mode: 'all' });
    const second = await store.create({
      expectedRevision: 1,
      definition: input({ name: 'no-tools', tools: { mode: 'selected', names: [] } }),
    });
    assert.deepEqual(userAt(second, 1).tools, { mode: 'selected', names: [] });
    const third = await store.create({
      expectedRevision: 2,
      definition: input({ name: 'some-tools', tools: { mode: 'selected', names: ['read', 'grep'] } }),
    });
    assert.deepEqual(userAt(third, 2).tools, { mode: 'selected', names: ['read', 'grep'] });
  });

  await check('unicode names collide after NFKC + case folding', async () => {
    const { store } = freshStore('unicode');
    await store.create({ expectedRevision: 0, definition: input({ name: 'Scout' }) });
    await expectStatus(
      store.create({ expectedRevision: 1, definition: input({ name: 'scout', description: 'other' }) }),
      400,
      'ascii case-fold',
    );
    await expectStatus(
      store.create({ expectedRevision: 1, definition: input({ name: 'ＳＣＯＵＴ' }) }),
      400,
      'fullwidth NFKC collision',
    );
    const distinct = await store.create({ expectedRevision: 1, definition: input({ name: '侦察兵' }) });
    assert.equal(users(distinct).length, 2, 'a genuinely different name is accepted');
  });

  await check('thinkingLevel: omit preserves, null clears, a level sets', async () => {
    const { store, filePath } = freshStore('thinking-level');
    const created = await store.create({
      expectedRevision: 0,
      definition: input({ thinkingLevel: 'low' }),
    });
    const id = userAt(created, 0).id;
    assert.equal(userAt(created, 0).thinkingLevel, 'low');

    // 1) a patch that says nothing about the level leaves it alone
    const renamed = await store.update(id, {
      expectedRevision: created.revision,
      patch: { name: 'scout-renamed' },
    });
    assert.equal(userAt(renamed, 0).thinkingLevel, 'low', 'omitting thinkingLevel preserves it');

    // 2) null deletes the property — absent from the DTO and from the file
    const cleared = await store.update(id, {
      expectedRevision: renamed.revision,
      patch: { thinkingLevel: null },
    });
    assert.equal(
      Object.hasOwn(userAt(cleared, 0), 'thinkingLevel'),
      false,
      'the response must not carry the key at all',
    );
    const diskAgents = readJson(filePath)['agents'] as Record<string, unknown>[];
    assert.equal(Object.hasOwn(diskAgents[0]!, 'thinkingLevel'), false, 'nor may the file');
    assert.equal(
      readFileSync(filePath, 'utf8').includes('thinkingLevel'),
      false,
      'no null is spelled anywhere on disk',
    );
    assert.equal(userAt(cleared, 0).revision, userAt(renamed, 0).revision + 1, 'clearing is a real edit');

    // 3) an explicit level can be set again
    const set = await store.update(id, {
      expectedRevision: cleared.revision,
      patch: { thinkingLevel: 'high' },
    });
    assert.equal(userAt(set, 0).thinkingLevel, 'high');
    assert.equal((readJson(filePath)['agents'] as Record<string, unknown>[])[0]!['thinkingLevel'], 'high');
  });

  await check('null is a patch-only verb: create rejects it, a null on disk is a 500', async () => {
    const { store, filePath } = freshStore('null-forms');
    await expectStatus(
      store.create({ expectedRevision: 0, definition: { ...input(), thinkingLevel: null } }),
      400,
      'create thinkingLevel null',
    );
    await expectStatus(
      store.create({ expectedRevision: 0, definition: { ...input(), name: null } }),
      400,
      'create name null',
    );

    const created = await store.create({ expectedRevision: 0, definition: input({ thinkingLevel: 'low' }) });
    const id = userAt(created, 0).id;
    await expectStatus(
      store.update(id, { expectedRevision: created.revision, patch: { name: null } }),
      400,
      'patch name null',
    );
    await expectStatus(
      store.update(id, { expectedRevision: created.revision, patch: { role: 'orchestrator' } }),
      400,
      'patch unknown key',
    );

    // A file that already carries a null level is corrupt, and stays untouched.
    const withNull = `${JSON.stringify(
      { schemaVersion: 1, revision: created.revision, agents: [{ ...userAt(created, 0), thinkingLevel: null }] },
      null,
      2,
    )}\n`;
    writeFileSync(filePath, withNull, { mode: 0o600 });
    await expectStatus(store.read(), 500, 'disk thinkingLevel null read');
    await expectStatus(
      store.update(id, { expectedRevision: created.revision, patch: { name: 'renamed' } }),
      500,
      'write against a null level',
    );
    assert.equal(readFileSync(filePath, 'utf8'), withNull, 'the corrupt bytes stay put');
  });

  await check('color: valid values round-trip, absent by default, enums enforced', async () => {
    const { store, filePath } = freshStore('color');
    const first = await store.create({
      expectedRevision: 0,
      definition: input({ name: 'coloured', color: 'purple' }),
    });
    assert.equal(userAt(first, 0).color, 'purple');
    assert.equal((readJson(filePath)['agents'] as Record<string, unknown>[])[0]!['color'], 'purple');

    // Every colour in the contract is accepted, in any position.
    let revision = first.revision;
    for (const [index, color] of SUBAGENT_COLORS.entries()) {
      const created = await store.create({
        expectedRevision: revision,
        definition: input({ name: `colour-${String(index)}`, color }),
      });
      revision = created.revision;
      assert.equal(created.agents.at(-1)!.color, color, `${color} is a legal colour`);
    }

    // Absent means unspecified — no key at all, not a null.
    const plain = await store.create({ expectedRevision: revision, definition: input({ name: 'plain-agent' }) });
    revision = plain.revision;
    assert.equal(Object.hasOwn(plain.agents.at(-1)!, 'color'), false, 'no colour is spelled as no key');
    const diskPlain = (readJson(filePath)['agents'] as Record<string, unknown>[]).at(-1)!;
    assert.equal(Object.hasOwn(diskPlain, 'color'), false);

    for (const bogus of ['turquoise', 'YELLOW', '', 42, true, ['red']]) {
      const error = await expectStatus(
        store.create({ expectedRevision: revision, definition: { ...input({ name: 'bad-colour' }), color: bogus } }),
        400,
        `color ${JSON.stringify(bogus)}`,
      );
      assert.equal(error.message, `颜色必须是 ${SUBAGENT_COLORS.join('/')} 之一`);
    }
  });

  await check('color patch: omit keeps, null deletes the key', async () => {
    const { store, filePath } = freshStore('color-patch');
    const created = await store.create({
      expectedRevision: 0,
      definition: input({ name: 'colour-patch', color: 'cyan' }),
    });
    const id = userAt(created, 0).id;

    const untouched = await store.update(id, {
      expectedRevision: created.revision,
      patch: { description: 'still cyan' },
    });
    assert.equal(userAt(untouched, 0).color, 'cyan', 'omitting color preserves it');

    const cleared = await store.update(id, {
      expectedRevision: untouched.revision,
      patch: { color: null },
    });
    assert.equal(Object.hasOwn(userAt(cleared, 0), 'color'), false, 'null deletes the key from the DTO');
    const diskAgents = readJson(filePath)['agents'] as Record<string, unknown>[];
    assert.equal(Object.hasOwn(diskAgents[0]!, 'color'), false, 'and from the file');
    assert.equal(readFileSync(filePath, 'utf8').includes('"color"'), false, 'no null is spelled on disk');

    const again = await store.update(id, {
      expectedRevision: cleared.revision,
      patch: { color: 'green' },
    });
    assert.equal(userAt(again, 0).color, 'green', 'a colour can be set again');
  });

  await check('injectAgentsMd: false round-trips, non-booleans are refused', async () => {
    const { store, filePath } = freshStore('inject');
    // `false` must be *written*, not dropped as a falsy default.
    const off = await store.create({
      expectedRevision: 0,
      definition: input({ name: 'inject-off', injectAgentsMd: false }),
    });
    assert.equal(userAt(off, 0).injectAgentsMd, false);
    const diskOff = (readJson(filePath)['agents'] as Record<string, unknown>[])[0]!;
    assert.equal(Object.hasOwn(diskOff, 'injectAgentsMd'), true, 'the explicit false is stored');
    assert.equal(diskOff['injectAgentsMd'], false);

    const on = await store.create({
      expectedRevision: off.revision,
      definition: input({ name: 'inject-on', injectAgentsMd: true }),
    });
    assert.equal(userAt(on, 1).injectAgentsMd, true);

    // Absent is legal and distinct from an explicit false only in spelling.
    const absent = await store.create({ expectedRevision: on.revision, definition: input({ name: 'inject-unset' }) });
    assert.equal(Object.hasOwn(userAt(absent, 2), 'injectAgentsMd'), false);

    for (const bogus of ['yes', 1, null, {}]) {
      await expectStatus(
        store.create({
          expectedRevision: absent.revision,
          definition: { ...input({ name: 'inject-bad' }), injectAgentsMd: bogus },
        }),
        400,
        `injectAgentsMd ${JSON.stringify(bogus)}`,
      );
    }

    // PATCH writes both directions; omit keeps.
    const target = userAt(on, 1).id;
    const flipped = await store.update(target, {
      expectedRevision: absent.revision,
      patch: { injectAgentsMd: false },
    });
    assert.equal(userAt(flipped, 1).injectAgentsMd, false, 'patch can turn it off again');
    const kept = await store.update(target, {
      expectedRevision: flipped.revision,
      patch: { description: 'unchanged toggle' },
    });
    assert.equal(userAt(kept, 1).injectAgentsMd, false, 'omitting the key preserves false');
    await expectStatus(
      store.update(target, { expectedRevision: kept.revision, patch: { injectAgentsMd: null } }),
      400,
      'patch injectAgentsMd null',
    );
  });

  await check('name rule: 3..50 code points of Unicode letters, digits and hyphen', async () => {
    const { store } = freshStore('names');
    let revision = 0;

    // Boundaries, counted in code points.
    for (const [label, name, expected] of [
      ['2 code points refused', 'ab', 400],
      ['3 code points accepted', 'abc', 0],
      ['50 code points accepted', 'a'.repeat(50), 0],
      ['51 code points refused', 'a'.repeat(51), 400],
      ['Chinese 3 code points accepted', '代码审', 0],
      ['digits and hyphen accepted', '9-9', 0],
      ['space refused', 'a b', 400],
      ['underscore refused', 'a_b', 400],
      ['emoji refused', '✅✅✅', 400],
      ['punctuation refused', 'a.b', 400],
    ] as const) {
      if (expected === 0) {
        const created = await store.create({ expectedRevision: revision, definition: input({ name }) });
        revision = created.revision;
        assert.equal(created.agents.at(-1)!.name, name, label);
        continue;
      }
      await expectStatus(
        store.create({ expectedRevision: revision, definition: input({ name }) }),
        expected,
        label,
      );
    }

    // The two messages are ZCode's, verbatim.
    const tooShort = await expectStatus(
      store.create({ expectedRevision: revision, definition: input({ name: 'ab' }) }),
      400,
      'length message',
    );
    assert.equal(tooShort.message, '长度必须在 3 到 50 个字符之间');
    const badChars = await expectStatus(
      store.create({ expectedRevision: revision, definition: input({ name: 'a_b' }) }),
      400,
      'charset message',
    );
    assert.equal(badChars.message, '仅允许使用字母、数字和连字符');

    // PATCH goes through the same rule.
    const id = userAt(await store.read()).id;
    await expectStatus(
      store.update(id, { expectedRevision: revision, patch: { name: 'ab' } }),
      400,
      'patch to a 2-code-point name',
    );
    await expectStatus(
      store.update(id, { expectedRevision: revision, patch: { name: '好 名字' } }),
      400,
      'patch with a space',
    );
  });

  await check('reads do not re-judge historical names', async () => {
    const { store, filePath } = freshStore('legacy-names');
    const now = new Date().toISOString();
    // A file written before the rule existed: too short, with an underscore and
    // an emoji. Reading it must not fail — only writing is judged.
    const legacy = `${JSON.stringify(
      {
        schemaVersion: 1,
        revision: 2,
        agents: [
          { ...input({ name: 'ab' }), id: 'legacy-1', revision: 1, createdAt: now, updatedAt: now },
          { ...input({ name: 'my_agent' }), id: 'legacy-2', revision: 1, createdAt: now, updatedAt: now },
          { ...input({ name: '✅ 好' }), id: 'legacy-3', revision: 1, createdAt: now, updatedAt: now },
        ],
      },
      null,
      2,
    )}\n`;
    writeFileSync(filePath, legacy, { mode: 0o600 });
    const read = await store.read();
    assert.equal(read.revision, 2);
    assert.deepEqual(
      users(read).map((agent) => agent.name),
      ['ab', 'my_agent', '✅ 好'],
      'stored names come back exactly as written',
    );
    // An unrelated edit of a legacy row must still succeed — "validate on write"
    // cannot mean "freeze every pre-rule definition out of being edited" — while
    // writing that non-compliant name again is refused.
    const patched = await store.update('legacy-1', {
      expectedRevision: 2,
      patch: { description: 'edited while the stored name is non-compliant' },
    });
    assert.equal(patched.revision, 3);
    assert.equal(userAt(patched, 0).name, 'ab', 'the stored name survives the edit untouched');
    assert.equal(userAt(patched, 0).description, 'edited while the stored name is non-compliant');
    await expectStatus(
      store.update('legacy-1', { expectedRevision: 3, patch: { name: 'ab' } }),
      400,
      'but re-writing the legacy name is still refused',
    );
  });

  await check('unknown keys and wrong types are 400 with the file untouched', async () => {
    const { store, filePath } = freshStore('strict-keys');
    const created = await store.create({ expectedRevision: 0, definition: input({ name: 'strict-keys' }) });
    const id = userAt(created, 0).id;
    const sha = (): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const before = sha();

    await expectStatus(
      store.create({ expectedRevision: created.revision, definition: { ...input({ name: 'unknown-key' }), skills: [] } }),
      400,
      'unknown definition key',
    );
    await expectStatus(
      store.update(id, { expectedRevision: created.revision, patch: { permissionMode: 'read' } }),
      400,
      'unknown patch key',
    );
    await expectStatus(
      store.update(id, { expectedRevision: created.revision, patch: { color: 'turquoise' } }),
      400,
      'wrong enum',
    );
    await expectStatus(
      store.update(id, { expectedRevision: created.revision, patch: { injectAgentsMd: 'true' } }),
      400,
      'wrong type',
    );
    assert.equal(sha(), before, 'no refused request may change a byte of the file');

    // The accepted shape still writes.
    const ok = await store.create({
      expectedRevision: created.revision,
      definition: input({ name: 'with-new-fields', color: 'pink', injectAgentsMd: true }),
    });
    assert.notEqual(sha(), before, 'a legal write does change the file');
    assert.equal(ok.agents.at(-1)!.color, 'pink');
    assert.equal(ok.agents.at(-1)!.injectAgentsMd, true);
  });

  await check('unknown fields are rejected, not dropped', async () => {
    const { store } = freshStore('unknown');
    await expectStatus(
      store.create({ expectedRevision: 0, definition: { ...input(), credentials: { apiKey: 'x' } } }),
      400,
      'definition.credentials',
    );
    await expectStatus(
      store.create({ expectedRevision: 0, definition: { ...input(), id: 'mine' } }),
      400,
      'definition.id',
    );
    await expectStatus(
      store.create({ expectedRevision: 0, definition: { ...input(), role: 'orchestrator' } }),
      400,
      'definition.role',
    );
    await expectStatus(
      store.create({ expectedRevision: 0, definition: input(), extra: true }),
      400,
      'top-level extra',
    );
    const created = await store.create({ expectedRevision: 0, definition: input() });
    const id = userAt(created, 0).id;
    await expectStatus(
      store.update(id, { expectedRevision: 1, patch: { revision: 99 } }),
      400,
      'patch.revision',
    );
    await expectStatus(
      store.update(id, { expectedRevision: 1, patch: { modelOverride: 'x' } }),
      400,
      'patch.modelOverride',
    );
  });

  await check('limits, model shape and thinking level are validated', async () => {
    const { store } = freshStore('limits');
    let revision = 0;
    for (const [label, definition] of [
      ['maxTurns 0', input({ maxTurns: 0 })],
      ['maxTurns 101', input({ maxTurns: 101 })],
      ['maxTurns 1.5', input({ maxTurns: 1.5 })],
      ['maxConcurrentInstances 5', input({ maxConcurrentInstances: 5 })],
      ['maxConcurrentInstances 0', input({ maxConcurrentInstances: 0 })],
      ['thinkingLevel bogus', { ...input(), thinkingLevel: 'ultra' } as AgentDefinitionInput],
      ['model mode bogus', { ...input(), model: { mode: 'auto' } } as unknown as AgentDefinitionInput],
      ['fixed with blank providerId', { ...input(), model: { mode: 'fixed', providerId: '  ', modelId: 'm' } } as unknown as AgentDefinitionInput],
      ['inherit with extra key', { ...input(), model: { mode: 'inherit', providerId: 'p' } } as unknown as AgentDefinitionInput],
      ['selected names not unique', { ...input(), tools: { mode: 'selected', names: ['read', 'read'] } } as unknown as AgentDefinitionInput],
      ['all carrying names', { ...input(), tools: { mode: 'all', names: ['read'] } } as unknown as AgentDefinitionInput],
      ['name too long', input({ name: 'x'.repeat(51) })],
      ['description too long', input({ description: 'x'.repeat(501) })],
      ['systemPrompt too long', input({ systemPrompt: 'x'.repeat(32001) })],
      ['enabled not boolean', { ...input(), enabled: 'yes' } as unknown as AgentDefinitionInput],
    ] as const) {
      await expectStatus(
        store.create({ expectedRevision: revision, definition }),
        400,
        label,
      );
    }
    const ok = await store.create({
      expectedRevision: revision,
      definition: { ...input(), thinkingLevel: 'high', maxTurns: 100, maxConcurrentInstances: 4 },
    });
    revision = ok.revision;
    assert.equal(userAt(ok, 0).thinkingLevel, 'high');
    assert.equal(userAt(ok, 0).maxTurns, 100);
  });

  await check('restricted dispatch and management names are refused', async () => {
    for (const name of ['subagent', 'SubAgent', 'spawn_agent', 'dispatch_agent', 'spawn_teammate', 'subagent_fork', 'workflow', 'Agent', 'team_task_list', 'agent_definitions_delete', '   ']) {
      assert.equal(isRestrictedAgentTool(name), true, `${JSON.stringify(name)} must be restricted`);
    }
    for (const name of ['read', 'bash', 'grep', 'my_extension_tool']) {
      assert.equal(isRestrictedAgentTool(name), false, `${name} must be allowed`);
    }
    assert.ok(RESTRICTED_AGENT_TOOL_DISPLAY_NAMES.includes('agent_definitions*'));
    const { store } = freshStore('restricted');
    for (const name of ['subagent', 'spawn_agent', 'Agent', 'team_task_list']) {
      await expectStatus(
        store.create({
          expectedRevision: 0,
          definition: input({ tools: { mode: 'selected', names: [name] } }),
        }),
        400,
        `selected name ${name}`,
      );
    }
  });

  await check('expectedRevision must be a non-negative safe integer', async () => {
    const { store } = freshStore('expected');
    for (const value of [undefined, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 2]) {
      await expectStatus(
        store.create({ expectedRevision: value, definition: input() }),
        400,
        `expectedRevision ${String(value)}`,
      );
    }
  });

  await check('a stale expectedRevision is a 409 and the file does not move', async () => {
    const { store, filePath } = freshStore('stale');
    await store.create({ expectedRevision: 0, definition: input() });
    const before = readFileSync(filePath, 'utf8');
    await expectStatus(store.create({ expectedRevision: 0, definition: input({ name: 'other' }) }), 409, 'stale create');
    await expectStatus(store.delete(userAt(await store.read()).id, { expectedRevision: 7 }), 409, 'stale delete');
    assert.equal(readFileSync(filePath, 'utf8'), before, 'a refused write must not touch the bytes');
  });

  await check('concurrent creates at one revision: exactly one winner', async () => {
    const { store, filePath } = freshStore('concurrent');
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_unused, index) =>
        store.create({ expectedRevision: 0, definition: input({ name: `agent-${String(index)}` }) }),
      ),
    );
    const winners = results.filter((entry) => entry.status === 'fulfilled');
    const losers = results.filter((entry) => entry.status === 'rejected');
    assert.equal(winners.length, 1, 'one writer wins');
    assert.equal(losers.length, 3, 'the rest are refused');
    for (const loser of losers) {
      assert.ok(loser.status === 'rejected');
      assert.ok(loser.reason instanceof AgentDefinitionError);
      assert.equal(loser.reason.status, 409);
    }
    assert.equal((readJson(filePath)['agents'] as unknown[]).length, 1, 'only one agent landed');
  });

  await check('empty patch is a read-back at the same revision', async () => {
    const { store, filePath } = freshStore('noop-patch');
    const created = await store.create({ expectedRevision: 0, definition: input() });
    const before = readFileSync(filePath, 'utf8');
    const after = await store.update(userAt(created, 0).id, { expectedRevision: created.revision, patch: {} });
    assert.equal(after.revision, created.revision, 'file revision unchanged');
    assert.equal(userAt(after, 0).revision, 1, 'agent revision unchanged');
    assert.equal(readFileSync(filePath, 'utf8'), before, 'nothing was written');
  });

  await check('patch bumps both revisions and keeps identity', async () => {
    const { store } = freshStore('patch');
    const created = await store.create({ expectedRevision: 0, definition: input() });
    const target = userAt(created, 0);
    const updated = await store.update(target.id, {
      expectedRevision: created.revision,
      patch: { description: 'now with a sharper brief', tools: { mode: 'selected', names: ['read'] } },
    });
    assert.equal(updated.revision, 2);
    const agent = userAt(updated, 0);
    assert.equal(agent.id, target.id, 'id is immutable');
    assert.equal(agent.revision, 2);
    assert.equal(agent.createdAt, target.createdAt);
    assert.notEqual(agent.updatedAt, target.updatedAt);
    assert.equal(agent.createdAt <= agent.updatedAt, true);
    assert.deepEqual(agent.tools, { mode: 'selected', names: ['read'] });
    assert.equal(agent.name, 'scout', 'untouched fields survive the patch');
    await expectStatus(store.update('nope', { expectedRevision: updated.revision, patch: { name: 'renamed' } }), 404, 'unknown id');
  });

  await check('delete removes the definition and never reuses the id', async () => {
    const { store, filePath } = freshStore('delete');
    const created = await store.create({ expectedRevision: 0, definition: input() });
    const id = userAt(created, 0).id;
    const deleted = await store.delete(id, { expectedRevision: created.revision });
    assert.equal(users(deleted).length, 0);
    assert.equal(deleted.revision, created.revision + 1);
    assert.equal(readJson(filePath)['revision'], deleted.revision);
    await expectStatus(store.delete(id, { expectedRevision: deleted.revision }), 404, 'second delete');
    const again = await store.create({ expectedRevision: deleted.revision, definition: input() });
    assert.notEqual(userAt(again, 0).id, id, 'the uuid is not reused');
  });

  await check('a corrupt or unsupported file is a 500 and is never overwritten', async () => {
    const { store, filePath } = freshStore('corrupt');
    writeFileSync(filePath, '{ not json at all', { mode: 0o600 });
    const before = readFileSync(filePath, 'utf8');
    await expectStatus(store.read(), 500, 'bad json read');
    await expectStatus(store.create({ expectedRevision: 0, definition: input() }), 500, 'bad json write');
    assert.equal(readFileSync(filePath, 'utf8'), before, 'the corrupt bytes stay put');

    writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, revision: 3, agents: [] }), { mode: 0o600 });
    await expectStatus(store.read(), 500, 'unsupported schema');

    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, revision: 3, agents: [{ id: 'x', revision: 1 }] }),
      { mode: 0o600 },
    );
    await expectStatus(store.read(), 500, 'entry missing required fields');

    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        agents: [
          { ...input(), id: 'a', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { ...input({ name: 'SCOUT' }), id: 'b', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
      }),
      { mode: 0o600 },
    );
    await expectStatus(store.read(), 500, 'duplicate names inside one file');
  });

  await check('a fresh store on the same path sees what the first wrote', async () => {
    const { store, filePath } = freshStore('reread');
    const created = await store.create({ expectedRevision: 0, definition: input({ name: 'persisted' }) });
    const reopened = new AgentDefinitionStore({ filePath });
    const read = await reopened.read();
    assert.equal(read.revision, created.revision);
    assert.deepEqual(read.agents, created.agents, 'the round-trip is lossless');
  });

  await check('two spellings of one file share a queue: one winner, no lost update', async () => {
    // A symlinked parent directory is the alias the per-file queue used to miss:
    // both writers read revision 0, both "succeeded", and one update vanished.
    const realDir = path.join(root, 'alias-real');
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    const aliasDir = path.join(root, 'alias-link');
    symlinkSync(realDir, aliasDir, 'dir');

    const realFile = path.join(realDir, 'defs.json');
    const aliasFile = path.join(aliasDir, 'defs.json');
    assert.notEqual(realFile, aliasFile, 'the two spellings differ as written');

    const viaReal = new AgentDefinitionStore({ filePath: realFile });
    const viaAlias = new AgentDefinitionStore({ filePath: aliasFile });

    const results = await Promise.allSettled([
      viaReal.create({ expectedRevision: 0, definition: input({ name: 'via-real' }) }),
      viaAlias.create({ expectedRevision: 0, definition: input({ name: 'via-alias' }) }),
    ]);
    const winners = results.filter((entry) => entry.status === 'fulfilled');
    const losers = results.filter((entry) => entry.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one writer may win the CAS');
    assert.equal(losers.length, 1, 'the alias writer must be refused, not silently dropped');
    const loser = losers[0]!;
    assert.ok(loser.status === 'rejected' && loser.reason instanceof AgentDefinitionError);
    assert.equal(loser.reason.status, 409);

    const onDisk = readJson(realFile);
    assert.equal((onDisk['agents'] as unknown[]).length, 1, 'no lost update: one agent on disk');
    assert.equal(onDisk['revision'], 1);
    const winnerName = (winners[0] as PromiseFulfilledResult<AgentDefinitionsResponse>).value.agents.at(-1)!.name;
    const seenThroughAlias = await viaAlias.read();
    assert.equal(userAt(seenThroughAlias).name, winnerName, 'both spellings address one file');
    assert.equal(seenThroughAlias.revision, 1);
  });

  await check('a symlinked file is written through, not replaced', async () => {
    const { store, filePath } = freshStore('symlink-file');
    const created = await store.create({ expectedRevision: 0, definition: input({ name: 'original' }) });
    const id = userAt(created, 0).id;

    const linkDir = path.join(root, 'symlink-file-link');
    mkdirSync(linkDir, { recursive: true, mode: 0o700 });
    const linkPath = path.join(linkDir, 'defs-link.json');
    symlinkSync(filePath, linkPath);

    const viaLink = new AgentDefinitionStore({ filePath: linkPath });
    const updated = await viaLink.update(id, {
      expectedRevision: created.revision,
      patch: { name: 'renamed-through-link' },
    });
    assert.equal(updated.revision, created.revision + 1);
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'the link must survive the write');
    assert.equal(
      (readJson(filePath)['agents'] as Record<string, unknown>[])[0]!['name'],
      'renamed-through-link',
      'the write landed on the real file the link points at',
    );
    assert.equal(readJson(filePath)['revision'], updated.revision);
  });

  await check('reading through an alias creates neither file nor directory', async () => {
    // A dangling directory symlink: the canonical key walks up to the last real
    // ancestor, and a read must never mkdir on the way.
    const realMissing = path.join(root, 'ghost-real');
    const aliasMissing = path.join(root, 'ghost-alias');
    symlinkSync(realMissing, aliasMissing);

    const store = new AgentDefinitionStore({ filePath: path.join(aliasMissing, 'defs.json') });
    const read = await store.read();
    assert.equal(read.revision, 0);
    assert.deepEqual(users(read), [], 'no user definition was invented');
    assert.equal(read.agents.length, 2, 'the built-ins are always listed');
    assert.equal(read.path, path.join(aliasMissing, 'defs.json'), 'the reported path is the store\'s own');
    assert.equal(statSync(realMissing, { throwIfNoEntry: false }), undefined, 'no directory was created');
    assert.equal(statSync(aliasMissing, { throwIfNoEntry: false }), undefined, 'the alias still dangles');
  });

  await check('the file is 0600 and no tmp file survives', async () => {
    const { store, filePath, dir } = freshStore('mode');
    await store.create({ expectedRevision: 0, definition: input() });
    if (process.platform !== 'win32') {
      assert.equal(statSync(filePath).mode & 0o777, 0o600, 'file mode');
      assert.equal(statSync(dir).mode & 0o777, 0o700, 'directory mode');
    }
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.tmp-')),
      [],
      'no tmp file after a successful write',
    );

    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    // A write that cannot land must still not leave its tmp file behind.
    chmodSync(dir, 0o500);
    try {
      await expectStatus(store.update(userAt(await store.read()).id, { expectedRevision: 1, patch: { name: 'nope' } }), 500, 'unwritable dir');
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.tmp-')),
      [],
      'no tmp file after a failed write',
    );
  });

  await check('no credentials and no stored path ever land in the file', async () => {
    const { store, filePath } = freshStore('nokeys');
    await store.create({ expectedRevision: 0, definition: input({ model: { mode: 'inherit' } }) });
    const keys = new Set<string>();
    collectKeys(readJson(filePath), keys);
    for (const forbidden of ['apiKey', 'credentials', 'auth', 'token', 'secret', 'apiKeySource', 'path']) {
      assert.equal(keys.has(forbidden), false, `the file must not carry ${forbidden}`);
    }
  });

  await check('path resolution: explicit wins, env must be absolute, else the agent dir', async () => {
    const explicit = path.join(root, 'explicit', 'defs.json');
    assert.equal(new AgentDefinitionStore({ filePath: explicit }).filePath(), explicit);

    const previousEnv = process.env['PI_WEBX_SUBAGENTS_FILE'];
    const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
    const sandboxAgentDir = path.join(root, 'agent-dir');
    mkdirSync(sandboxAgentDir, { recursive: true });
    try {
      process.env['PI_CODING_AGENT_DIR'] = sandboxAgentDir;
      delete process.env['PI_WEBX_SUBAGENTS_FILE'];
      assert.equal(
        new AgentDefinitionStore().filePath(),
        path.join(sandboxAgentDir, 'pi-webx', 'agent-definitions.json'),
        'default sits beside pi models.json, in pi-webx\'s own subdirectory',
      );

      const envPath = path.join(root, 'from-env', 'defs.json');
      process.env['PI_WEBX_SUBAGENTS_FILE'] = envPath;
      assert.equal(new AgentDefinitionStore().filePath(), envPath, 'env override wins');

      process.env['PI_WEBX_SUBAGENTS_FILE'] = 'relative/defs.json';
      const store = new AgentDefinitionStore();
      assert.throws(
        () => store.filePath(),
        (error: unknown) => error instanceof AgentDefinitionError && error.status === 500,
        'a relative env path must be a loud 500, not a silent cwd-relative file',
      );
      await expectStatus(store.read(), 500, 'relative env path read');
    } finally {
      if (previousEnv === undefined) delete process.env['PI_WEBX_SUBAGENTS_FILE'];
      else process.env['PI_WEBX_SUBAGENTS_FILE'] = previousEnv;
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CHECKS PASSED');
  }
  // Left in place so the corrupt/refused bytes can be inspected; the OS reaps
  // its own temp tree. Matches the other `check-*.ts` scripts.
  console.log(`sandbox: ${root}`);
}

void main();
