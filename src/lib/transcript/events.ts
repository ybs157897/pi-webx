/**
 * Event reduction: `reduceEvent` routes one pi event into the turn, tool-run
 * and notice machinery, and `applyPiEvent` is the public, never-throwing
 * wrapper every consumer folds the live stream through.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point.
 */

import type { PiEvent, PiQueuedPrompt } from '../../shared/protocol';
import type {
  ApplyPiEvent,
  CompactionEntry,
  ToolResultEntry,
  ToolRun,
  TranscriptState,
} from '../../shared/transcript';

import { contentImageCount, contentImages, contentText } from './blocks';
import { appendEntry, liveEntryId, replaceEntry } from './entries';
import { finalizeTurn } from './fold';
import { asBoolean, asNumber, asRecord, asString, type Dict } from './guards';
import { attemptSummary, makeNotice, retryInfo } from './notices';
import { findToolRunIn, updateToolRun } from './tool-runs';
import { applyMessageUpdate, endMessage, finishStreaming, startMessage } from './turns';

/* ------------------------------------------------------------------ events */

function reduceEvent(state: TranscriptState, event: PiEvent): TranscriptState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, running: true, lastError: null };

    case 'agent_end': {
      // One low-level run finished. A retry (or queued continuation) may follow,
      // so the run is not settled and `retrying` is left alone.
      if (event.willRetry) return state;
      return { ...finishStreaming(state), streamingEntryId: null };
    }

    case 'agent_settled':
      // `turn_end` normally closes the fold window; settle is the backstop for
      // any path that ends a run without one.
      return finalizeTurn({
        ...finishStreaming(state),
        running: false,
        streamingEntryId: null,
        retrying: null,
      });

    case 'turn_start': {
      const last = state.entries[state.entries.length - 1];
      const id = state.turnSeq + 1;
      return { ...state, turnSeq: id, activeTurn: { id, startId: last?.id ?? null } };
    }

    case 'turn_end':
      // Both structural: the message/tool events carry everything shown, and
      // the turn boundary decides what folds (dsh folds at turn end, never
      // while the turn is still running).
      return finalizeTurn(state);

    case 'message_start':
      return startMessage(state, event.message);

    case 'message_update':
      return applyMessageUpdate(state, event.assistantMessageEvent, event.usage);

    case 'message_end':
      return endMessage(state, event.message);

    case 'tool_execution_start': {
      const toolCallId = asString(event.toolCallId) ?? '';
      if (!toolCallId) return state;
      const toolName = asString(event.toolName) ?? 'unknown';
      const args = asRecord(event.args);
      if (findToolRunIn(state.entries, toolCallId)) {
        return updateToolRun(state, toolCallId, (run) => {
          const next: ToolRun = { ...run, toolName: toolName || run.toolName };
          if (args) next.args = { ...run.args, ...args };
          return next;
        });
      }
      // pi can emit execution events for calls this client never saw.
      const at = Date.now();
      const run: ToolRun = {
        toolCallId,
        toolName,
        args: args ? { ...args } : {},
        output: '',
        status: 'running',
        startedAt: at,
      };
      const entry: ToolResultEntry = {
        kind: 'toolResult',
        id: liveEntryId('toolResult', at, state.entries.length),
        at,
        run,
      };
      return appendEntry(state, entry);
    }

    case 'tool_execution_update': {
      const toolCallId = asString(event.toolCallId) ?? '';
      if (!toolCallId) return state;
      const payload = asRecord(event.partialResult);
      // `partialResult` is cumulative output so far: replace, never append.
      const replacesContent = payload !== null && 'content' in payload;
      const replacesDetails = payload !== null && 'details' in payload;
      const output = replacesContent && payload ? contentText(payload.content) : undefined;
      const images = replacesContent && payload ? contentImages(payload.content) : undefined;
      const imageCount = replacesContent && payload ? contentImageCount(payload.content) : undefined;
      const toolName = asString(event.toolName);
      const args = asRecord(event.args);
      return updateToolRun(state, toolCallId, (run) => {
        const next: ToolRun = { ...run };
        if (output !== undefined) next.output = output;
        if (images !== undefined) {
          next.images = images;
          next.imageCount = imageCount;
        }
        if (replacesDetails && payload) next.details = payload.details;
        if (toolName) next.toolName = toolName;
        if (args) next.args = { ...run.args, ...args };
        return next;
      });
    }

    case 'tool_execution_end': {
      const toolCallId = asString(event.toolCallId) ?? '';
      if (!toolCallId) return state;
      const result = asRecord(event.result);
      const replacesContent = result !== null && 'content' in result;
      const replacesDetails = result !== null && 'details' in result;
      const output = replacesContent && result ? contentText(result.content) : undefined;
      const images = replacesContent && result ? contentImages(result.content) : undefined;
      const imageCount = replacesContent && result ? contentImageCount(result.content) : undefined;
      const isError = asBoolean(event.isError) ?? false;
      const toolName = asString(event.toolName);
      const args = asRecord(event.args);
      const at = Date.now();

      if (!findToolRunIn(state.entries, toolCallId)) {
        // Late client: keep the result visible rather than dropping it.
        const run: ToolRun = {
          toolCallId,
          toolName: toolName ?? 'unknown',
          args: args ? { ...args } : {},
          output: output ?? '',
          ...(imageCount ? { images, imageCount } : {}),
          status: isError ? 'error' : 'success',
          startedAt: at,
          endedAt: at,
        };
        if (replacesDetails && result) run.details = result.details;
        const entry: ToolResultEntry = {
          kind: 'toolResult',
          id: liveEntryId('toolResult', at, state.entries.length),
          at,
          run,
        };
        return appendEntry(state, entry);
      }

      return updateToolRun(state, toolCallId, (run) => {
        const next: ToolRun = { ...run };
        if (output !== undefined) next.output = output;
        if (images !== undefined) {
          next.images = images;
          next.imageCount = imageCount;
        }
        if (replacesDetails && result) next.details = result.details;
        if (toolName) next.toolName = toolName;
        if (args) next.args = { ...run.args, ...args };
        return { ...next, status: isError ? 'error' : 'success', endedAt: at };
      });
    }

    case 'bash_execution_update': {
      const id = asString(event.id);
      const delta = asString(event.delta) ?? '';
      if (!id || !delta) return state;
      // Entries for direct `bash` commands are created by the UI with the
      // command's id, which is exactly what pi echoes here.
      return replaceEntry(state, id, (entry) => {
        if (entry.kind !== 'bash') return entry;
        return { ...entry, output: entry.output + delta, streaming: true };
      });
    }

    case 'queue_update': {
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      return {
        ...state,
        queued: {
          // pi always emits both of its own arrays together, so a frame settles
          // them outright: an empty array means an empty queue.
          steering: strings(event.steering),
          followUp: strings(event.followUp),
          /**
           * The wait list is the bridge's, not pi's, so pi's own frames say
           * nothing about it — and a frame that says nothing must not erase it.
           * An absent `pending` means "unchanged"; the host's frames always
           * carry the list.
           */
          pending: Array.isArray(event.pending)
            ? event.pending.filter(
                (item): item is PiQueuedPrompt =>
                  typeof item === 'object' &&
                  item !== null &&
                  typeof (item as PiQueuedPrompt).id === 'string' &&
                  typeof (item as PiQueuedPrompt).text === 'string',
              )
            : state.queued.pending,
        },
      };
    }

    case 'compaction_start': {
      const at = Date.now();
      const entry: CompactionEntry = {
        kind: 'compaction',
        id: liveEntryId('compaction', at, state.entries.length),
        at,
        phase: 'start',
      };
      return { ...state, compacting: true, entries: [...state.entries, entry] };
    }

    case 'compaction_end': {
      // pi's wire payload nests the result under `result`; the shared type also
      // allows the fields at the top level, so accept both.
      const raw = event as unknown as Dict;
      const result = asRecord(raw.result);
      const at = Date.now();
      const entry: CompactionEntry = {
        kind: 'compaction',
        id: liveEntryId('compaction', at, state.entries.length),
        at,
        phase: 'end',
      };
      const summary = asString(event.summary) ?? asString(result?.summary);
      if (summary !== undefined) entry.summary = summary;
      const tokensBefore = asNumber(event.tokensBefore) ?? asNumber(result?.tokensBefore);
      if (tokensBefore !== undefined) entry.tokensBefore = tokensBefore;
      const tokensAfter =
        asNumber(event.tokensAfter) ??
        asNumber(result?.tokensAfter) ??
        asNumber(result?.estimatedTokensAfter);
      if (tokensAfter !== undefined) entry.tokensAfter = tokensAfter;
      const aborted = asBoolean(event.aborted) ?? asBoolean(result?.aborted);
      if (aborted !== undefined) entry.aborted = aborted;
      return { ...state, compacting: false, entries: [...state.entries, entry] };
    }

    case 'auto_retry_start':
    case 'summarization_retry_scheduled': {
      const info = retryInfo(event as unknown as Dict);
      const label =
        event.type === 'auto_retry_start' ? 'Auto-retry' : 'Summarization retry scheduled';
      const summary = attemptSummary(info);
      const text = summary ? `${label}: ${summary}` : label;
      const notice = makeNotice(state, 'warning', text, info.error);
      return { ...state, retrying: info, entries: [...state.entries, notice] };
    }

    case 'auto_retry_end': {
      const success = asBoolean(event.success) ?? true;
      if (success) return { ...state, retrying: null };
      const attempt = asNumber(event.attempt);
      const text = attempt !== undefined ? `Auto-retry failed after ${attempt} attempts` : 'Auto-retry failed';
      const notice = makeNotice(state, 'error', text, asString(event.finalError));
      return { ...state, retrying: null, entries: [...state.entries, notice] };
    }

    case 'summarization_retry_attempt_start': {
      const attempt = asNumber(event.attempt);
      const previous = state.retrying;
      if (attempt === undefined) return state;
      return { ...state, retrying: { ...(previous ?? {}), attempt } };
    }

    case 'summarization_retry_finished':
      return { ...state, retrying: null };

    case 'extension_error': {
      const detail = [
        asString(event.extensionPath) ? `extensionPath: ${asString(event.extensionPath)}` : null,
        asString(event.event) ? `event: ${asString(event.event)}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
      const notice = makeNotice(
        state,
        'error',
        asString(event.error) ?? 'Extension error',
        detail || undefined,
      );
      return { ...state, entries: [...state.entries, notice] };
    }

    case 'extension_ui_request': {
      // Only `setTitle` touches transcript state; dialogs, notify, status and
      // widgets are handled by the UI's own extension channel.
      if (event.method !== 'setTitle') return state;
      const title = asString(event.title);
      if (title === undefined) return state;
      return { ...state, title };
    }

    default:
      // Unknown event types (and `type: "response"`, which is not a state event)
      // are ignored: this folds a live stream and must never throw.
      return state;
  }
}

/** Fold one streaming pi event into the transcript. Never mutates, never throws. */
export const applyPiEvent: ApplyPiEvent = (state, event) => {
  try {
    return reduceEvent(state, event);
  } catch {
    // Defensive: a malformed event must not take down the UI's stream.
    return state;
  }
};
