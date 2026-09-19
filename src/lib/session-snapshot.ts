import type { PiAgentMessage, PiExtensionUiRequest } from '../shared/protocol';
import type { TranscriptState } from '../shared/transcript';
import { applyPiEvent, applySnapshot } from './transcript';

/**
 * What `get_messages` answers with.
 *
 * Beyond the durable history it carries the state that only exists in memory on
 * the server: whether the session is still running, the assistant message being
 * streamed right now, and the dialogs an extension is waiting on.
 */
export interface SessionMessageSnapshot {
  messages: PiAgentMessage[];
  throughSeq?: number;
  running?: boolean;
  streamingMessage?: PiAgentMessage | null;
  pendingDialogs?: PiExtensionUiRequest[];
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
  if (data.streamingMessage?.role === 'assistant' || data.streamingMessage?.role === 'user') {
    transcript = applyPiEvent(transcript, {
      type: 'message_start',
      message: data.streamingMessage,
    });
  }
  return transcript;
}
