/**
 * One agent question, in the transcript — dsh's `AskQuestionRow`.
 *
 * The row is the same disclosure line as every other tool call (glyph · title ·
 * summary) and it is closed by default: "提问 · 1/1 已回答" says what happened
 * without spending the reader's attention on a question they already answered.
 * Opening it reveals the question (tertiary) and the chosen answer (primary) —
 * the two things the row's collapsed form deliberately hides.
 *
 * While the question is still pending the summary reads 等待回答 and the body
 * lists the questions with no answer under them — the answer is being given in
 * the composer, which is where the question itself is shown.
 */

import { Flexbox, Text } from '@lobehub/ui';
import { theme } from 'antd';
import { useState } from 'react';

import type { AskCard } from '../lib/ask-card';
import { IconQuestionOutline14 } from '../ui/primitives/index.ts';
import { LeadingGlyph } from './LeadingGlyph';
import css from './AskQuestionCard.module.css';

function Card({ card }: { card: AskCard }) {
  /**
   * Nothing has been answered yet — either because the run was cancelled, or
   * because the answer is being given in the composer right now.
   *
   * Neither case gets the answered layout: an answer line reading 「未回答」
   * under a question the user is looking at would say they skipped it.
   */
  if (card.state !== 'answered') {
    return (
      <div className={css.card}>
        {card.verdict !== undefined && <p className={css.verdict}>{card.verdict}</p>}
        <ul className={css.questionList}>
          {card.questions.map((question) => (
            <li key={question.id} className={css.unansweredQuestion}>
              {question.question}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <dl className={css.card}>
      {card.questions.map((question) => (
        <div key={question.id} className={css.item}>
          <dt className={css.question}>{question.question}</dt>
          <dd className={css.answer} style={{ margin: 0 }}>
            {question.answers.length === 0 ? (
              <span className={css.skipped}>{card.skippedLabel}</span>
            ) : (
              question.answers.map((answer, index) => (
                <span key={`${question.id}-${String(index)}`} className={css.answerLine}>
                  {answer}
                </span>
              ))
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AskQuestionCard({ card }: { card: AskCard }) {
  const { token } = theme.useToken();
  const [manual, setManual] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);

  // Closed by default in every state, like dsh's row: the summary is the point.
  const open = manual ?? false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Flexbox
        horizontal
        align="center"
        gap={6}
        style={{ height: 24, cursor: 'pointer' }}
        onClick={() => { setManual(!open); }}
        onMouseEnter={() => { setHovered(true); }}
        onMouseLeave={() => { setHovered(false); }}
      >
        <LeadingGlyph icon={<IconQuestionOutline14 />} swap={hovered || open} />
        <Text fontSize={13} style={{ fontFamily: token.fontFamilyCode, flexShrink: 0 }}>
          提问
        </Text>
        <Text fontSize={13} type="secondary" style={{ flexShrink: 0, opacity: 0.45 }}>
          ·
        </Text>
        <Text fontSize={13} type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }}>
          {card.summary}
        </Text>
      </Flexbox>

      {/* The card carries its own `margin: 4px 0 4px 4px` indent (dsh's), so the
          row adds none of its own. */}
      {open && <Card card={card} />}
    </div>
  );
}
