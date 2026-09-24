/**
 * Optimistic echo: the just-submitted prompt shown before the server echoes it
 * back, and its retirement once the durable record arrives.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point.
 */

import type {
  AddEcho,
  EchoSubmission,
  RetireEcho,
  TranscriptEntry,
  UserEntry,
} from '../../shared/transcript';

/* ------------------------------------------------------------ optimistic echo */

const isEchoOf = (entry: TranscriptEntry, requestId: string): boolean =>
  entry.kind === 'user' && entry.echo?.requestId === requestId;

/**
 * Show a submitted prompt immediately. Purely a display projection: the queue
 * and the durable record are the server's truth, and a `get_messages` snapshot
 * (which drops echoes) is reconciled by re-adding still-pending submissions.
 */
export const addEcho: AddEcho = (state, submission: EchoSubmission) => {
  if (state.entries.some((entry) => isEchoOf(entry, submission.requestId))) return state;
  const entry: UserEntry = {
    kind: 'user',
    id: `echo-${submission.requestId}`,
    at: Date.now(),
    text: submission.text,
    imageCount: submission.imageCount,
    images: submission.images,
    echo: { requestId: submission.requestId },
  };
  return { ...state, entries: [...state.entries, entry] };
};

export const retireEcho: RetireEcho = (state, requestId) => {
  if (!state.entries.some((entry) => isEchoOf(entry, requestId))) return state;
  return { ...state, entries: state.entries.filter((entry) => !isEchoOf(entry, requestId)) };
};
