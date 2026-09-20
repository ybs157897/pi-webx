import type { PiAgentMessage, PiExtensionUiRequest, PiQueuedPrompt } from '../shared/protocol';
import type { TranscriptState } from '../shared/transcript';
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
}

/**
 * Rebuild the transcript from a snapshot, including the turn that is still in
 * flight.
 *
 * `applySnapshot` alone restores only what has been written down, so a reload
 * mid-answer lost the half that had already streamed (it reappeared on the next
 * delta, as if the model had restarted). The in-flight message is replayed
 * through the normal `message_start` path so a restored transcript and a live
 * one are shaped by the same reducer.
 */
export function restoreSessionMessages(
  state: TranscriptState,
  data: SessionMessageSnapshot,
): TranscriptState {
  let transcript = applySnapshot(state, data.messages);
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
