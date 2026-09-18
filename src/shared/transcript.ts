/**
 * Transcript model: the shape the UI renders, plus the pure reducer contract.
 *
 * The reducer lives in `src/lib/transcript.ts`. Two ways to fill the model:
 *   - `applySnapshot` rebuilds from a `get_messages` reply (used on connect/reconnect)
 *   - `applyPiEvent` folds streaming events in incrementally
 *
 * Both are pure: they return a new state and never mutate the input.
 */

import type { PiAgentMessage, PiEvent, PiModelCost } from './protocol';

/* -------------------------------------------------------------------- usage */

export interface TranscriptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** total cost in USD */
  cost: number;
}

/* ---------------------------------------------------------------- tool runs */

export type ToolRunStatus = 'running' | 'success' | 'error';

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /**
   * Tool output text. pi's `tool_execution_update.partialResult` is already
   * cumulative, so updates replace this rather than append.
   */
  output: string;
  details?: unknown;
  status: ToolRunStatus;
  startedAt: number;
  endedAt?: number;
  /** true when the run came from history and never streamed live */
  restored?: boolean;
}

/* ----------------------------------------------------------------- entries */

export interface UserEntry {
  kind: 'user';
  id: string;
  at: number;
  text: string;
  imageCount: number;
  /**
   * Present while the entry is an optimistic echo of a just-submitted prompt,
   * not yet replaced by the durable user message. `requestId` correlates it
   * with the submit; the echo is retired (removed) when the frame carrying
   * `source.requestId` arrives, in the same update that appends the durable
   * entry — so exactly one of the two is ever visible.
   */
  echo?: { requestId: string };
}

export interface AssistantEntry {
  kind: 'assistant';
  id: string;
  at: number;
  text: string;
  thinking: string;
  /** true while text/thinking deltas are still arriving */
  streaming: boolean;
  model?: string;
  provider?: string;
  usage?: TranscriptUsage;
  stopReason?: string;
  error?: string;
  /** tool calls made by this turn, in call order */
  tools: ToolRun[];
}

/** A tool result with no matching call in the transcript (e.g. replayed history). */
export interface ToolResultEntry {
  kind: 'toolResult';
  id: string;
  at: number;
  run: ToolRun;
}

/** Direct `bash` RPC command, not an LLM tool call. */
export interface BashEntry {
  kind: 'bash';
  id: string;
  at: number;
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  streaming: boolean;
}

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface NoticeEntry {
  kind: 'notice';
  id: string;
  at: number;
  level: NoticeLevel;
  text: string;
  detail?: string;
}

export interface CompactionEntry {
  kind: 'compaction';
  id: string;
  at: number;
  phase: 'start' | 'end';
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  aborted?: boolean;
}

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ToolResultEntry
  | BashEntry
  | NoticeEntry
  | CompactionEntry;

/* ------------------------------------------------------------------- state */

export interface RetryInfo {
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  error?: string;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

export interface TranscriptState {
  entries: TranscriptEntry[];
  /** id of the assistant entry currently receiving deltas, if any */
  streamingEntryId: string | null;
  /** an agent run is in flight (between agent_start and agent_settled) */
  running: boolean;
  compacting: boolean;
  retrying: RetryInfo | null;
  queued: QueuedMessages;
  /** last hard error worth surfacing, cleared on the next successful start */
  lastError: string | null;
  /** session title pushed by an extension via `setTitle` */
  title: string | null;
}

/* ------------------------------------------------------------------ reducer */

export function createTranscript(): TranscriptState {
  return {
    entries: [],
    streamingEntryId: null,
    running: false,
    compacting: false,
    retrying: null,
    queued: { steering: [], followUp: [] },
    lastError: null,
    title: null,
  };
}

/** Rebuild the transcript from a full message list. Replaces `entries`. */
export type ApplySnapshot = (
  state: TranscriptState,
  messages: readonly PiAgentMessage[],
) => TranscriptState;

/** Fold one streaming pi event into the transcript. */
export type ApplyPiEvent = (state: TranscriptState, event: PiEvent) => TranscriptState;

/** What `addEcho` needs to render a just-submitted prompt immediately. */
export interface EchoSubmission {
  requestId: string;
  text: string;
  imageCount: number;
}

/** Show a submitted prompt before the server has echoed it back (optimistic). */
export type AddEcho = (state: TranscriptState, submission: EchoSubmission) => TranscriptState;

/** Remove the echo once the durable message with `source.requestId` arrived. */
export type RetireEcho = (state: TranscriptState, requestId: string) => TranscriptState;

export type { PiAgentMessage, PiEvent, PiModelCost };
