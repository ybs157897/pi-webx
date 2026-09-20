/**
 * Self-check harness for the question card (`src/lib/ask-card.ts`).
 *
 *   npx tsx scripts/check-ask-card.ts
 *
 * The mapping it pins is the one that makes a question readable in the
 * transcript: which runs become a card at all, what the collapsed summary says,
 * and which answers count as given. All of it is decided from the extension's
 * own structured `details` — never from the result prose — so the cases below
 * are the shapes that payload actually takes.
 */

import assert from 'node:assert/strict';

import { askCardFromRun } from '../src/lib/ask-card';
import type { ToolRun } from '../src/shared/transcript';

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

function run(partial: Partial<ToolRun> & Pick<ToolRun, 'toolName' | 'args'>): ToolRun {
  return {
    toolCallId: 'call-1',
    output: '',
    status: 'success',
    startedAt: 0,
    details: undefined,
    ...partial,
  };
}

check('a non-ask tool has no card', () => {
  assert.equal(askCardFromRun(run({ toolName: 'bash', args: { command: 'ls' } })), null);
});

check('a running question waits, and still lists what is being asked', () => {
  const card = askCardFromRun(
    run({
      toolName: 'ask_question',
      status: 'running',
      args: { question: '想从哪里开始？', type: 'select', options: ['A', 'B'] },
    }),
  );
  assert.ok(card);
  assert.equal(card.state, 'waiting');
  assert.equal(card.summary, '等待回答');
  assert.deepEqual(card.questions, [{ id: 'default', question: '想从哪里开始？', answers: [] }]);
});

check('a settled question without structured details keeps the generic card', () => {
  // No `details` means the extension never produced a result — an error the
  // generic card is better at showing than an empty question list.
  assert.equal(
    askCardFromRun(
      run({ toolName: 'ask_question', args: { question: '选一个' }, details: undefined }),
    ),
    null,
  );
});

check('a single answer is labelled, and counted', () => {
  const card = askCardFromRun(
    run({
      toolName: 'ask_question',
      args: { question: '想从哪里开始？', type: 'select' },
      details: {
        question: '想从哪里开始？',
        type: 'select',
        answer: '帮我梳理 pi-webx 的整体架构和数据流',
        answerLabel: '先看懂这个项目',
        answered: true,
      },
    }),
  );
  assert.ok(card);
  assert.equal(card.summary, '1/1 已回答');
  assert.deepEqual(card.questions, [
    { id: 'default', question: '想从哪里开始？', answers: ['先看懂这个项目'] },
  ]);
});

check('a declined confirm is answered, not skipped', () => {
  const card = askCardFromRun(
    run({
      toolName: 'ask_question',
      args: { question: '删除这个分支？', type: 'confirm' },
      details: { question: '删除这个分支？', type: 'confirm', answer: false, answered: true },
    }),
  );
  assert.ok(card);
  assert.equal(card.summary, '1/1 已回答');
  assert.deepEqual(card.questions[0]?.answers, ['否']);
});

check('a cancelled question says so and shows the questions', () => {
  const card = askCardFromRun(
    run({
      toolName: 'ask_question',
      args: { question: '想从哪里开始？', type: 'select' },
      details: { question: '想从哪里开始？', type: 'select', answer: null, answered: false, cancelled: true },
    }),
  );
  assert.ok(card);
  assert.equal(card.state, 'cancelled');
  assert.equal(card.summary, '已取消');
  assert.equal(card.verdict, '本轮已取消，未提交回答');
  assert.deepEqual(card.questions[0]?.answers, []);
});

check('a batch pairs answers by id, and counts only the given ones', () => {
  const card = askCardFromRun(
    run({
      toolName: 'ask_question',
      args: {
        questions: [
          { id: 'q1', type: 'select', question: '先做哪个？' },
          { id: 'q2', type: 'input', question: '提交信息写什么？' },
          { id: 'q3', type: 'input', question: '要跑测试吗？' },
        ],
      },
      details: {
        questions: [],
        answers: [
          { id: 'q1', type: 'select', value: 'fix', label: '先修 bug', wasCustom: false },
          { id: 'q2', type: 'input', value: 'fix(session): resume', wasCustom: true },
          // `null` is the cancelled/skipped shape: the question is listed, not answered.
          { id: 'q3', type: 'input', value: null },
        ],
        cancelled: false,
      },
    }),
  );
  assert.ok(card);
  assert.equal(card.summary, '2/3 已回答');
  assert.deepEqual(card.questions, [
    { id: 'q1', question: '先做哪个？', answers: ['先修 bug'] },
    { id: 'q2', question: '提交信息写什么？', answers: ['fix(session): resume'] },
    { id: 'q3', question: '要跑测试吗？', answers: [] },
  ]);
});

check('a blank string is not an answer', () => {
  const card = askCardFromRun(
    run({
      toolName: 'ask_question',
      args: { question: '说明一下', type: 'input' },
      details: { question: '说明一下', type: 'input', answer: '   ', answered: true },
    }),
  );
  assert.ok(card);
  assert.equal(card.summary, '0/1 已回答');
  assert.deepEqual(card.questions[0]?.answers, []);
});

check('the dsh tool name is recognised too', () => {
  const card = askCardFromRun(
    run({
      toolName: 'ask_user_question',
      args: { question: '继续吗？', type: 'confirm' },
      details: { question: '继续吗？', type: 'confirm', answer: true, answered: true },
    }),
  );
  assert.ok(card);
  assert.equal(card.summary, '1/1 已回答');
});

if (failures > 0) {
  console.error(`\n${String(failures)} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
