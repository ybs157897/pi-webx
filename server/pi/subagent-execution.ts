/** Turn execution and result validation; lifecycle and SDK assembly live elsewhere. */
import { MAX_RESULT_CHARACTERS, type SubagentDispatchRequest } from './subagent-tool';
import { SubagentRunError } from './subagent-error';

/** The last assistant message's visible text, plus how its turn ended. */
interface VisibleAssistantMessage {
  readonly content: readonly { readonly type?: string; readonly text?: string }[];
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

/**
 * Validate one entry of a session's message list.
 *
 * The messages come from a foreign package, so this reads them defensively
 * rather than asserting a shape: anything that is not an assistant message with
 * a content array is simply not the final answer.
 */
function visibleAssistantMessage(value: unknown): VisibleAssistantMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (candidate.role !== 'assistant' || !Array.isArray(candidate.content)) return undefined;
  return {
    content: candidate.content as readonly { type?: string; text?: string }[],
    ...(typeof candidate.stopReason === 'string' ? { stopReason: candidate.stopReason } : {}),
    ...(typeof candidate.errorMessage === 'string' ? { errorMessage: candidate.errorMessage } : {}),
  };
}

function finalAssistantText(session: WorkerSessionLike): {
  text: string;
  stopReason: string | undefined;
  errorMessage: string | undefined;
} {
  const messages = session.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = visibleAssistantMessage(messages[index]);
    if (message === undefined) continue;
    const text = message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
    return { text, stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return { text: '', stopReason: undefined, errorMessage: undefined };
}

/** Truncate one answer to the size the parent is promised. */
function boundText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARACTERS) return { text, truncated: false };
  return { text: text.slice(0, MAX_RESULT_CHARACTERS), truncated: true };
}

export interface RunOutcome {
  readonly text: string;
  readonly truncated: boolean;
  readonly turns: number;
}

/**
 * The slice of an agent session the run loop uses.
 *
 * Structural rather than `AgentSession` so the loop — the part with the turn
 * budget, the wall clock and the cancellation ordering — can be exercised with a
 * fake session and no SDK runtime at all.
 */
export interface WorkerSessionLike {
  subscribe(listener: (event: { readonly type: string; readonly toolResults?: readonly unknown[] }) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  readonly messages: readonly unknown[];
}

/**
 * Run one prompt to completion under a turn budget and the
 * parent's cancellation.
 *
 * `void session.abort()` rather than `await`: the abort is requested from inside
 * an event listener, where awaiting would block the very loop
 * that has to observe the abort.
 *
 * An already-aborted signal throws **before** the prompt: `abort()` only stops a
 * turn that is already in flight, so calling it on an idle session and then
 * prompting would still spend one real model call on a cancelled dispatch.
 */
export async function executeWorkerSession(
  session: WorkerSessionLike,
  request: SubagentDispatchRequest,
): Promise<RunOutcome> {
  const { definition, task, signal } = request;
  let turns = 0;
  let limitReached = false;
  let parentAborted = signal?.aborted === true;

  const abortFor = (): void => {
    void session.abort().catch(() => undefined);
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== 'turn_end') return;
    if (signal?.aborted) return;
    turns += 1;
    request.onUpdate?.(`完成第 ${turns}/${definition.maxTurns} 轮。`);
    // The budget stops the loop only when the worker still wants another turn:
    // a final answer that happened to land on the last turn is a success.
    if (turns >= definition.maxTurns && (event.toolResults?.length ?? 0) > 0 && !limitReached) {
      limitReached = true;
      request.onUpdate?.(`已达到 ${definition.maxTurns} 轮上限，正在停止。`);
      abortFor();
    }
  });
  const onParentAbort = (): void => {
    parentAborted = true;
    abortFor();
  };
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    // Re-checked after the listener is registered: an abort that landed between
    // the caller's own check and this line must not start a turn either.
    if (parentAborted) {
      throw signal?.reason ?? new SubagentRunError('parent-aborted', '父会话取消了这次子智能体调用。');
    }
    await session.prompt(task);
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
    unsubscribe();
  }

  const final = finalAssistantText(session);
  const bounded = boundText(final.text);
  if (parentAborted) {
    const reason = signal?.reason;
    throw reason instanceof SubagentRunError
      ? new SubagentRunError(reason.code, reason.message, bounded.text)
      : new SubagentRunError('parent-aborted', '父会话取消了这次子智能体调用。', bounded.text);
  }
  if (limitReached) {
    throw new SubagentRunError(
      'max-turns',
      `子智能体「${definition.name}」达到 ${definition.maxTurns} 轮上限仍未给出最终答复；`
      + '任务可以继续拆小，或调高该定义的最大轮数。',
      bounded.text,
    );
  }
  if (final.stopReason === 'error' || final.stopReason === 'aborted') {
    throw new SubagentRunError(
      'model-error',
      `子智能体「${definition.name}」执行失败：${final.errorMessage ?? final.stopReason}`,
      bounded.text,
    );
  }
  if (final.stopReason === 'length') {
    throw new SubagentRunError(
      'model-error',
      `子智能体「${definition.name}」在输出上限处结束，答复不完整。`,
      bounded.text,
    );
  }
  if (final.stopReason !== 'stop') {
    throw new SubagentRunError(
      'no-output',
      `子智能体「${definition.name}」没有产生最终答复（stopReason=${String(final.stopReason)}）。`,
      bounded.text,
    );
  }
  // `stop` with nothing to read is not an answer: a turn that only produced
  // thinking blocks, or an empty text block, must not reach the parent as a
  // successful empty result.
  if (bounded.text.trim().length === 0) {
    throw new SubagentRunError(
      'no-output',
      `子智能体「${definition.name}」结束了但没有产生可读答复。`,
    );
  }
  return { text: bounded.text, truncated: bounded.truncated, turns };
}
