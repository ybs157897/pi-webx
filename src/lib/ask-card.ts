/**
 * The transcript card for an agent question — dsh's `AskQuestionRow`.
 *
 * Two things shape this model, and both come from the harness it is modelled on:
 *
 *   - The row is *closed* by default and summarised in one line ("提问 · 1/1
 *     已回答"). The question and the chosen answer are the expanded body, not the
 *     row, so a conversation with several questions still reads as a
 *     conversation.
 *   - Nothing is inferred from prose. pi's `ask_question` extension returns a
 *     structured `details` payload — `{question, answer}` for one question,
 *     `{questions, answers}` for a batch — and the card is built from it. A run
 *     without that payload is not an ask card at all: the caller keeps the
 *     generic tool card, which is where a raw error belongs.
 *
 * Pure on purpose: `scripts/check-ask-card.ts` pins the mapping without a DOM.
 */

import type { ToolRun } from '../shared/transcript';

/** The tool names whose runs are rendered as a question card. */
const ASK_TOOL_NAMES = new Set(['ask_question', 'ask_user_question']);

export interface AskCardQuestion {
  id: string;
  question: string;
  /** Chosen answers, in order; empty means the question was left unanswered. */
  answers: string[];
}

export type AskCardState = 'waiting' | 'answered' | 'cancelled';

export interface AskCard {
  state: AskCardState;
  /** The collapsed row's text: 等待回答 / n/m 已回答 / 已取消 */
  summary: string;
  /** Shown as a question's answer when it has none — dsh's `ask.skipped`. */
  skippedLabel: string;
  /** Verdict line for the unanswered card, e.g. 本轮已取消，未提交回答. */
  verdict?: string;
  questions: AskCardQuestion[];
}

export const ASK_SKIPPED_LABEL = '未回答';
export const ASK_CANCELLED_DETAIL = '本轮已取消，未提交回答';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Whether one answer counts as given.
 *
 * `false` is an answer — a confirm question the user declined is answered, not
 * skipped — while `null`, `undefined` and a blank string are not.
 */
function hasAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return true;
  return false;
}

/** The answer's display text: the label the user saw, else the raw value. */
function answerText(value: unknown, label: unknown): string {
  if (typeof label === 'string' && label.length > 0) return label;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** The questions the call asked, from either the batch shape or the single one. */
function askedQuestions(args: Record<string, unknown>): Array<{ id: string; question: string }> | null {
  const batch = args['questions'];
  if (Array.isArray(batch) && batch.length > 0) {
    return batch.flatMap((entry, index) => {
      if (!isRecord(entry)) return [];
      return [{ id: text(entry['id']) || `q${String(index + 1)}`, question: text(entry['question']) }];
    });
  }
  const question = args['question'];
  if (typeof question !== 'string' || question.length === 0) return null;
  return [{ id: 'default', question }];
}

/**
 * Build the card for a tool run, or `null` when the run is not a question this
 * card can render (a different tool, an unparseable call, a real failure).
 */
export function askCardFromRun(run: Pick<ToolRun, 'toolName' | 'args' | 'details' | 'status'>): AskCard | null {
  if (!ASK_TOOL_NAMES.has(run.toolName)) return null;
  const asked = askedQuestions(run.args ?? {});
  if (asked === null) return null;

  const details = isRecord(run.details) ? run.details : null;
  if (details === null) {
    // A call still in flight has no result yet; its questions still belong on
    // screen so the transcript shows what is being asked. A settled run with no
    // structured result is a failure the generic card should show instead.
    if (run.status !== 'running') return null;
    return waitingCard(asked);
  }

  if (details['cancelled'] === true) {
    return {
      state: 'cancelled',
      summary: '已取消',
      skippedLabel: ASK_SKIPPED_LABEL,
      verdict: ASK_CANCELLED_DETAIL,
      questions: asked.map((entry) => ({ ...entry, answers: [] })),
    };
  }

  // Batch shape: the extension echoes the questions it asked and answers them
  // by id, so ids — not positions — pair them.
  const rawAnswers = details['answers'];
  if (Array.isArray(rawAnswers)) {
    const byId = new Map<string, string[]>();
    for (const entry of rawAnswers) {
      if (!isRecord(entry)) continue;
      const id = text(entry['id']);
      if (id.length === 0) continue;
      const answers: string[] = [];
      if (hasAnswer(entry['value'])) answers.push(answerText(entry['value'], entry['label']));
      else if (text(entry['label']).length > 0) answers.push(text(entry['label']));
      byId.set(id, answers);
    }
    const questions = asked.map((entry) => ({ ...entry, answers: byId.get(entry.id) ?? [] }));
    return answeredCard(questions);
  }

  // Single-question shape.
  const answers: string[] = [];
  if (hasAnswer(details['answer'])) {
    answers.push(answerText(details['answer'], details['answerLabel']));
  } else if (details['answered'] === true && text(details['answerLabel']).length > 0) {
    answers.push(text(details['answerLabel']));
  }
  if (details['answered'] === false && answers.length === 0 && run.status === 'running') {
    return waitingCard(asked);
  }
  return answeredCard([{ ...asked[0]!, answers }]);
}

function waitingCard(questions: Array<{ id: string; question: string }>): AskCard {
  return {
    state: 'waiting',
    summary: '等待回答',
    skippedLabel: ASK_SKIPPED_LABEL,
    questions: questions.map((entry) => ({ ...entry, answers: [] })),
  };
}

function answeredCard(questions: AskCardQuestion[]): AskCard {
  const answered = questions.filter((entry) => entry.answers.length > 0).length;
  return {
    state: 'answered',
    summary: `${String(answered)}/${String(questions.length)} 已回答`,
    skippedLabel: ASK_SKIPPED_LABEL,
    questions,
  };
}
