/**
 * 会话事件扇出与等待队列：pi 会话事件的桥接、订阅流的唯一来源（journal 优先），
 * 以及 dsh 式的「忙时排队、闲时逐条放行」等待队列。
 *
 * 全部函数的第一个参数是 `HostInternals`（PiHost 的内部依赖面），`this.` 一律换成
 * `host.`——这些行为没有自己的状态，状态在 hosted 与 host 上。
 */
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type {
  PiEvent,
  PiQueueAction,
  PiQueuedPrompt,
  ServerFrame,
} from '../../src/shared/protocol';
import { errorText, type HostedSession, type HostInternals, type QueuedPrompt } from './host-contract';
import { refreshSubagentTool } from './host-teams';

/** 事件桥接：维护 streaming 状态、把事件切给订阅流，并在回合收尾时放行等待队列。 */
export function onEvent(host: HostInternals, hosted: HostedSession, event: AgentSessionEvent): void {
  hosted.lastSeen = Date.now();
  if (event.type === 'agent_start') hosted.streaming = true;
  if (event.type === 'agent_settled' || event.type === 'agent_end') hosted.streaming = false;
  // SDK events are a superset of the RPC-mode union the client models; the
  // transcript reducer ignores the extras (entry_appended, …) safely.
  const source = claimPromptSource(hosted, event);
  broadcast(host, hosted, {
    t: 'pi',
    event: event as unknown as PiEvent,
    ...(source === undefined ? {} : { source }),
  });
  // The wait list's clock: a settled turn is the only moment a queued message
  // may start the next one. Broadcast first, so the client's `running` has
  // already gone false by the time the flush's own events arrive.
  if (event.type === 'agent_settled') void flushQueue(host, hosted);
}

/**
 * Correlate a durable user message with the prompt command that produced it.
 *
 * pi has no requestId on its own events, so the host is the adapter: the
 * oldest still-pending requestId claims the next user message, and the frame
 * carries it as `source.requestId` for the browser's echo retire.
 */
function claimPromptSource(hosted: HostedSession, event: AgentSessionEvent): { requestId: string } | undefined {
  if (event.type !== 'message_start') return undefined;
  const message = (event as { message?: { role?: unknown } }).message;
  if (message === undefined || message.role !== 'user') return undefined;
  const requestId = hosted.promptRequests.consumePending();
  return requestId === null ? undefined : { requestId };
}

export function broadcast(_host: HostInternals, hosted: HostedSession, frame: ServerFrame): void {
  // Everything a subscriber can see passes through the journal first, so a
  // reconnecting client's replay and a live client's stream share one order.
  const entry = hosted.journal.append(frame);
  for (const subscriber of hosted.subscribers) subscriber.frame(entry);
}

export function broadcastError(host: HostInternals, hosted: HostedSession, message: string): void {
  broadcast(host, hosted, { t: 'error', message });
}

/* ------------------------------------------------------------ wait list */

/** The dock's projection of the wait list: text and id, images reduced to a count. */
export function queueView(hosted: HostedSession): PiQueuedPrompt[] {
  return hosted.queue.map((item) => ({
    id: item.id,
    text: item.text,
    imageCount: item.images?.length ?? 0,
    createdAt: item.createdAt,
  }));
}

/**
 * Publish the wait list, alongside pi's own two queues.
 *
 * One frame carries all three because the reducer replaces the whole
 * `queued` object: a frame that named only the wait list would erase pi's
 * arrays, and vice versa.
 */
export function broadcastQueue(host: HostInternals, hosted: HostedSession): void {
  broadcast(host, hosted, {
    t: 'pi',
    event: {
      type: 'queue_update',
      steering: [...hosted.session.getSteeringMessages()],
      followUp: [...hosted.session.getFollowUpMessages()],
      pending: queueView(hosted),
    } as unknown as PiEvent,
  });
}

/**
 * Accept a message the running turn is not ready for — dsh's queue.
 *
 * Owning the list here rather than handing it to pi is what makes each row
 * addressable (steer / edit / remove) and keeps its images; `flushQueue` is
 * what eventually starts the turn that carries it.
 */
export function enqueue(
  host: HostInternals,
  hosted: HostedSession,
  text: string,
  images?: readonly ImageContent[],
): QueuedPrompt {
  const item: QueuedPrompt = {
    id: crypto.randomUUID(),
    text,
    ...(images !== undefined && images.length > 0 ? { images: [...images] } : {}),
    createdAt: Date.now(),
  };
  hosted.queue.push(item);
  broadcastQueue(host, hosted);
  return item;
}

/**
 * One row action: dsh's `session.updateQueue`.
 *
 * `steer` is the only one that talks to pi, and only while a turn is running —
 * that is the window in which a steer is delivered (after the current
 * assistant turn's tool calls). Everything else is a local edit, so nothing
 * can be lost to a queue pi has already begun to drain.
 *
 * @returns the failure to report, or `null` when the action was applied.
 */
export async function updateQueue(
  host: HostInternals,
  hosted: HostedSession,
  id: string,
  action: PiQueueAction,
): Promise<string | null> {
  const index = hosted.queue.findIndex((item) => item.id === id);
  if (index < 0) return '这条消息已经开始发送了。';

  if (action.kind === 'remove') {
    hosted.queue.splice(index, 1);
    broadcastQueue(host, hosted);
    return null;
  }

  const item = hosted.queue[index]!;
  if (action.kind === 'edit') {
    const text = action.text.trim();
    if (text.length === 0) return '这条消息的内容不能为空。';
    hosted.queue[index] = { ...item, text };
    broadcastQueue(host, hosted);
    return null;
  }

  if (!hosted.session.isStreaming) return '仅运行中可插话发送。';
  hosted.queue.splice(index, 1);
  broadcastQueue(host, hosted);
  try {
    await hosted.session.steer(item.text, item.images);
  } catch (error) {
    // Put it back where it was: the user's message is not the failure's cost.
    hosted.queue.splice(Math.min(index, hosted.queue.length), 0, item);
    broadcastQueue(host, hosted);
    return `插话发送失败：${errorText(error)}`;
  }
  return null;
}

/**
 * Hand pi the next queued message once a turn has fully settled.
 *
 * One row per settle is dsh's drain rule (`next-turn` claims exactly one
 * message per turn) and it is what keeps a batch of queued instructions from
 * collapsing into a single turn. `agent_settled` is pi's "nothing left to
 * run" edge — retries and compaction included — so this cannot fire mid-run;
 * a message that fails to start stays queued and is reported instead, because
 * a failure here is not a reason to silently drop what the user wrote.
 */
export async function flushQueue(host: HostInternals, hosted: HostedSession): Promise<void> {
  if (hosted.flushing === true || !hosted.alive || hosted.queue.length === 0) return;
  if (hosted.session.isStreaming || !hosted.session.isIdle) return;
  const item = hosted.queue[0];
  if (item === undefined) return;
  hosted.flushing = true;
  try {
    // A queued row starts a new turn, so it gets the same freshness guarantee
    // as a directly submitted prompt.
    await refreshSubagentTool(host, hosted);
    let reason: string | null = null;
    const accepted = await new Promise<boolean>((resolve) => {
      void hosted.session
        .prompt(item.text, {
          ...(item.images !== undefined && item.images.length > 0 ? { images: item.images } : {}),
          preflightResult: resolve,
        })
        .catch((error: unknown) => {
          reason = errorText(error);
        });
    });
    if (!accepted) {
      broadcastError(
        host,
        hosted,
        `排队消息未能发送${reason === null ? '' : `：${reason}`}。它仍在待发送里。`,
      );
      return;
    }
    hosted.queue = hosted.queue.filter((entry) => entry.id !== item.id);
    broadcastQueue(host, hosted);
  } finally {
    hosted.flushing = false;
  }
}
