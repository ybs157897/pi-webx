/**
 * The pending question, in the composer's seat — dsh's `QuestionComposer`.
 *
 * When the agent asks something, the composer is not merely blocked: it is
 * *replaced*. That is the whole point of the surface. A question is the only
 * thing the run can proceed on, so the box the user types into becomes the box
 * they answer in — no modal to dismiss, no second place to look, and no way to
 * type a reply the agent is not listening for. (The composer itself stays
 * mounted and hidden, which is what keeps a half-written draft alive across the
 * question: dsh hides its fallback with `display: none` for the same reason.)
 *
 * pi's extension-UI protocol asks one thing at a time (`select`, `confirm`,
 * `input`, `editor`), so this is always a single-question flow: no pager, no
 * aggregate submit. A `select` answers on click — dsh's single-select advance —
 * while the free-text methods need the explicit submit, because Enter belongs to
 * the textarea (Shift+Enter breaks the line).
 */

import { useEffect, useRef, useState } from 'react';

import type { PendingDialog } from '../lib/usePiSession';
import type { PiExtensionUiRequest } from '../shared/protocol';
import { Button, IconCloseOutline16, Tooltip } from '../ui/primitives/index.ts';
import css from './QuestionComposer.module.css';

/** The answer shapes pi's extension-UI protocol accepts for each dialog method. */
interface QuestionAnswer {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** Chrome copy, kept in one place: the surface is small but says six things. */
const COPY = {
  cancel: '放弃本次提问',
  cancelAction: '取消',
  selectHint: '点击一个选项即可回答',
  textHint: '回车提交，Shift+回车换行',
  submit: '提交',
  yes: '是',
  no: '否',
  placeholder: '输入你的答案',
  timeout: (seconds: number) => `${String(seconds)} 秒未响应将自动取消`,
};

function Options({
  request,
  onAnswer,
}: {
  request: PiExtensionUiRequest;
  onAnswer: (value: string) => void;
}) {
  // Nothing is preselected and nothing is focused: a select that opens with
  // option 1 highlighted lets a click confirm an answer nobody read.
  return (
    <div className={css.body} role="radiogroup" aria-label={request.title ?? '选项'}>
      {(request.options ?? []).map((option, index) => (
        <button
          key={`${String(index)}-${option}`}
          type="button"
          role="radio"
          aria-checked={false}
          className={css.option}
          onClick={() => { onAnswer(option); }}
        >
          <span className={css.optionNumber}>{index + 1}</span>
          <span className={css.optionLabel}>{option}</span>
        </button>
      ))}
    </div>
  );
}

export function QuestionComposer({
  dialog,
  onRespond,
}: {
  dialog: PendingDialog;
  onRespond: (body: QuestionAnswer) => void;
}) {
  const { request } = dialog;
  const cancel = () => { onRespond({ cancelled: true }); };
  const [text, setText] = useState(request.method === 'editor' ? (request.prefill ?? '') : '');
  const area = useRef<HTMLTextAreaElement | null>(null);

  // Keyed to the request: the next question must not inherit this one's text or
  // caret. The effect also owns the focus, so only one place focuses the field.
  useEffect(() => {
    setText(request.method === 'editor' ? (request.prefill ?? '') : '');
    area.current?.focus();
  }, [request.id, request.method, request.prefill]);

  const isText = request.method === 'input' || request.method === 'editor';
  const isSelect = request.method === 'select';
  const isConfirm = request.method === 'confirm';

  return (
    <div className={css.frame}>
      <div className={css.card}>
        <div className={css.header}>
          <h2 className={css.title}>
            {request.title?.trim() || (isSelect ? '请选择一个选项' : '请输入')}
          </h2>
          <Tooltip label={COPY.cancel}>
            <button type="button" className={css.close} aria-label={COPY.cancel} onClick={cancel}>
              <IconCloseOutline16 />
            </button>
          </Tooltip>
        </div>

        {isSelect && <Options request={request} onAnswer={(value) => { onRespond({ value }); }} />}

        {isConfirm && (
          <div className={css.body}>
            <p className={css.message}>{request.message ?? ''}</p>
          </div>
        )}

        {isText && (
          <div className={css.body}>
            <textarea
              ref={area}
              className={css.input}
              value={text}
              rows={request.method === 'editor' ? 8 : 2}
              placeholder={request.placeholder ?? COPY.placeholder}
              onChange={(event) => { setText(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                // An IME's Enter confirms a candidate; it does not submit.
                if (event.nativeEvent.isComposing) return;
                event.preventDefault();
                onRespond({ value: text });
              }}
            />
          </div>
        )}

        <div className={css.footer}>
          <span className={css.hint}>
            {isSelect ? COPY.selectHint : isText ? COPY.textHint : ''}
          </span>
          {typeof request.timeout === 'number' && request.timeout > 0 && (
            <span className={css.hint} style={{ flex: 'none' }}>
              {COPY.timeout(Math.round(request.timeout / 1000))}
            </span>
          )}
          <div className={css.actions}>
            {isConfirm ? (
              <>
                <Button variant="outline" size="sm" onClick={() => { onRespond({ confirmed: false }); }}>
                  {COPY.no}
                </Button>
                <Button variant="primary" size="sm" onClick={() => { onRespond({ confirmed: true }); }}>
                  {COPY.yes}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={cancel}>
                  {COPY.cancelAction}
                </Button>
                {isText && (
                  <Button variant="primary" size="sm" onClick={() => { onRespond({ value: text }); }}>
                    {COPY.submit}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
