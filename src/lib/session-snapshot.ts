import type {
  PiAgentMessage,
  PiCompactionSummary,
  PiExtensionUiRequest,
  PiQueuedPrompt,
} from '../shared/protocol';
import type { CompactionEntry, TranscriptEntry, TranscriptState } from '../shared/transcript';
import { applyPiEvent, applySnapshot } from './transcript';

/**
 * What `get_messages` answers with.
 *
 * Beyond the durable history it carries the state that only exists in memory on
 * the server: whether the session is still running, the assistant message being
 * streamed right now, the dialogs an extension is waiting on, and the messages
 * queued behind the running turn.
 */
export interface SessionMessageSnapshot {
  messages: PiAgentMessage[];
  throughSeq?: number;
  running?: boolean;
  streamingMessage?: PiAgentMessage | null;
  pendingDialogs?: PiExtensionUiRequest[];
  queue?: PiQueuedPrompt[];
  /** Compaction summaries `messages` no longer contains, oldest first. */
  compactions?: PiCompactionSummary[];
}

/**
 * Compaction entries for a rebuilt transcript, oldest first.
 *
 * Shaped like the live path's entries (`./transcript/events.ts`): phase `end`
 * with the summary payload — `start` marks a compression in progress, and a
 * summary restored from the session file is a finished one. Tokens-after has no
 * counterpart in the session entry, so the restored row shows the size before
 * the cut alone.
 */
function compactionEntries(compactions: readonly PiCompactionSummary[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const compaction of compactions) {
    // A summary is the entry's whole point; anything else is a malformed row.
    if (typeof compaction.summary !== 'string' || compaction.summary.trim().length === 0) continue;
    const at = typeof compaction.timestamp === 'string' ? Date.parse(compaction.timestamp) : Number.NaN;
    const entry: CompactionEntry = {
      kind: 'compaction',
      id: `snap-compaction-${entries.length}`,
      // A snapshot whose messages carry no timestamps starts at 0 too, and a
      // compaction always precedes the history kept after it.
      at: Number.isFinite(at) ? at : 0,
      phase: 'end',
      summary: compaction.summary,
    };
    if (typeof compaction.tokensBefore === 'number') entry.tokensBefore = compaction.tokensBefore;
    entries.push(entry);
  }
  return entries;
}

/**
 * Rebuild the transcript from a snapshot, including the turn that is still in
 * flight.
 *
 * `applySnapshot` alone restores only what has been written down, so a reload
 * mid-answer lost the half that had already streamed (it reappeared on the next
 * delta, as if the model had restarted). The in-flight message is replayed
 * through the normal `message_start` path so a restored transcript and a live
 * one are shaped by the same reducer. Compaction summaries ride along for the
 * same reason at the other end of history.
 */
export function restoreSessionMessages(
  state: TranscriptState,
  data: SessionMessageSnapshot,
): TranscriptState {
  let transcript = applySnapshot(state, data.messages);
  /**
   * 压缩摘要插在重建转写的**最前部**：它代表的是被压缩掉的早期历史，
   * 而快照里保留的消息已经是压缩之后的那段（`session.messages` 是模型视角，
   * 被折叠的部分不在其中）。放在最前，阅读顺序才与真实时间线一致——先看到
   * 「这里压缩过」，再读压缩后保留的历史；插在末尾则会被误读成刚发生的事。
   */
  if (Array.isArray(data.compactions)) {
    const restored = compactionEntries(data.compactions);
    if (restored.length > 0) transcript = { ...transcript, entries: [...restored, ...transcript.entries] };
  }
  if (typeof data.running === 'boolean') transcript = { ...transcript, running: data.running };
  // The wait list is memory-only on the host, so it comes from the snapshot
  // rather than from the journal: a client opening the session now never sees
  // the frames that announced the rows already in it.
  if (Array.isArray(data.queue)) {
    transcript = { ...transcript, queued: { ...transcript.queued, pending: data.queue } };
  }
  if (data.streamingMessage?.role === 'assistant' || data.streamingMessage?.role === 'user') {
    transcript = applyPiEvent(transcript, {
      type: 'message_start',
      message: data.streamingMessage,
    });
  }
  return transcript;
}
