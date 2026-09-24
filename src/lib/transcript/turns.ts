/**
 * The message state machine: `message_start` / `message_end` /
 * `message_update` turn pi's messages and assistant deltas into transcript
 * entries, and `finishStreaming` closes whatever a settled run left open.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point,
 * so nothing here is exported to consumers.
 */

import type { PiAgentMessage } from '../../shared/protocol';
import type {
  AssistantEntry,
  BashEntry,
  ToolRun,
  TranscriptState,
  UserEntry,
} from '../../shared/transcript';

import {
  contentImageCount,
  contentImages,
  contentText,
  contentThinking,
  contentToolCalls,
  toUsage,
  toolCallBlock,
} from './blocks';
import { appendEntry, liveEntryId, replaceEntry } from './entries';
import { asBoolean, asNumber, asRecord, asString, timestampOf } from './guards';
import {
  attachToolResult,
  deltaToolCall,
  parseArgsObject,
  rawArgsOf,
  reconcileToolRuns,
} from './tool-runs';

/* ------------------------------------------------------- streaming assistant */

function makeAssistantEntry(id: string, at: number): AssistantEntry {
  return { kind: 'assistant', id, at, text: '', thinking: '', streaming: true, tools: [] };
}

/**
 * The assistant entry deltas are routed to. Prefers `streamingEntryId`, falls
 * back to a still-open trailing entry, and creates one if the stream is
 * somehow missing a `message_start` (deltas must never be dropped).
 */
function resolveAssistantEntry(
  state: TranscriptState,
  at: number,
): { state: TranscriptState; entry: AssistantEntry } {
  const id = state.streamingEntryId;
  if (id) {
    const found = state.entries.find(
      (entry): entry is AssistantEntry => entry.kind === 'assistant' && entry.id === id && entry.streaming,
    );
    if (found) return { state, entry: found };
  }
  const last = state.entries[state.entries.length - 1];
  if (last && last.kind === 'assistant' && last.streaming) return { state, entry: last };
  const entry = makeAssistantEntry(liveEntryId('assistant', at, state.entries.length), at);
  return { state: { ...state, entries: [...state.entries, entry], streamingEntryId: entry.id }, entry };
}

/** `message_start`: open (or echo) a message. */
export function startMessage(state: TranscriptState, message: PiAgentMessage | undefined): TranscriptState {
  const rec = asRecord(message);
  const role = asString(rec?.role);
  if (!rec || !role) return state;
  const at = timestampOf(rec, Date.now());

  switch (role) {
    case 'custom': {
      // An inserted message the extension asked to be visible. `display: false`
      // ones stay in the conversation as model context but are not the reader's.
      if (rec.display !== true) return state;
      const customType = asString(rec.customType) ?? 'custom';
      const text = contentText(rec.content);
      // Re-delivered on both message_start and message_end; append once.
      if (
        state.entries.some(
          (entry) =>
            entry.kind === 'custom' &&
            entry.at === at &&
            entry.customType === customType &&
            entry.text === text,
        )
      ) {
        return state;
      }
      return appendEntry(state, {
        kind: 'custom',
        id: liveEntryId('custom', at, state.entries.length),
        at,
        customType,
        text,
        details: rec.details,
      });
    }
    case 'user': {
      // Also covers prompts echoed back to us (initial prompt + injected steering).
      const entry: UserEntry = {
        kind: 'user',
        id: liveEntryId('user', at, state.entries.length),
        at,
        text: contentText(rec.content),
        imageCount: contentImageCount(rec.content),
        images: contentImages(rec.content),
      };
      return appendEntry(state, entry);
    }
    case 'assistant': {
      // `message_start` is usually an empty partial; seeding from its content
      // keeps providers that never stream deltas from losing the turn.
      const entry = makeAssistantEntry(liveEntryId('assistant', at, state.entries.length), at);
      entry.text = contentText(rec.content);
      entry.thinking = contentThinking(rec.content);
      const usage = toUsage(rec.usage);
      if (usage) entry.usage = usage;
      const model = asString(rec.model);
      if (model !== undefined) entry.model = model;
      const provider = asString(rec.provider);
      if (provider !== undefined) entry.provider = provider;
      return { ...state, entries: [...state.entries, entry], streamingEntryId: entry.id };
    }
    case 'toolResult':
      return attachToolResult(state, rec, at, liveEntryId('toolResult', at, state.entries.length), false);
    case 'bashExecution': {
      const entry: BashEntry = {
        kind: 'bash',
        id: liveEntryId('bash', at, state.entries.length),
        at,
        command: asString(rec.command) ?? '',
        output: asString(rec.output) ?? '',
        exitCode: asNumber(rec.exitCode) ?? null,
        cancelled: asBoolean(rec.cancelled) ?? false,
        truncated: asBoolean(rec.truncated) ?? false,
        streaming: false,
      };
      return appendEntry(state, entry);
    }
    default:
      return state;
  }
}

/** `message_end`: the message is authoritative. */
export function endMessage(state: TranscriptState, message: PiAgentMessage | undefined): TranscriptState {
  const rec = asRecord(message);
  const role = asString(rec?.role);
  if (!rec || !role) return state;

  if (role === 'toolResult') {
    const at = timestampOf(rec, Date.now());
    return attachToolResult(state, rec, at, liveEntryId('toolResult', at, state.entries.length), false);
  }
  // A custom message is appended by its `message_start`, and pi emits the same
  // message again on `message_end`; re-running start keeps that path idempotent
  // instead of dropping a message seen only at the end.
  if (role === 'custom') return startMessage(state, message);
  // A user message was appended by its `message_start`; `bashExecution` output
  // arrives whole (and via `bash_execution_update`), so neither ends here.
  if (role !== 'assistant') return state;

  const at = timestampOf(rec, Date.now());
  const resolved = resolveAssistantEntry(state, at);
  const entry = resolved.entry;
  const calls = contentToolCalls(rec.content);
  const tools = reconcileToolRuns(entry.tools, calls, at, entry.id);

  const next: AssistantEntry = {
    ...entry,
    text: contentText(rec.content),
    thinking: contentThinking(rec.content),
    streaming: false,
    tools,
  };

  // Authoritative optional fields. `usage` is kept when the final message does
  // not repeat it, because the streamed value is the same cumulative number and
  // dropping it would only lose information.
  const usage = toUsage(rec.usage);
  if (usage) next.usage = usage;
  const stopReason = asString(rec.stopReason);
  if (stopReason !== undefined) next.stopReason = stopReason;
  else delete next.stopReason;
  const error = asString(rec.errorMessage);
  if (error !== undefined) next.error = error;
  else delete next.error;
  const model = asString(rec.model);
  if (model !== undefined) next.model = model;
  const provider = asString(rec.provider);
  if (provider !== undefined) next.provider = provider;

  const updated = replaceEntry(resolved.state, entry.id, () => next);
  return {
    ...updated,
    streamingEntryId: updated.streamingEntryId === entry.id ? null : updated.streamingEntryId,
    lastError:
      stopReason === 'error' ? (error ?? 'Assistant turn ended with an error') : updated.lastError,
  };
}

/** `message_update`: fold one `assistantMessageEvent` delta into the open entry. */
export function applyMessageUpdate(
  state: TranscriptState,
  assistantMessageEvent: unknown,
  usage: unknown,
): TranscriptState {
  const delta = asRecord(assistantMessageEvent);
  const type = asString(delta?.type);
  if (!delta || !type) return state;

  const resolved = resolveAssistantEntry(state, Date.now());
  const entry = resolved.entry;
  let next: AssistantEntry | null = null;

  switch (type) {
    case 'text_delta': {
      const text = asString(delta.delta) ?? '';
      if (text) next = { ...entry, text: entry.text + text, streaming: true };
      break;
    }
    case 'text_end': {
      // `content` is the finished block. Deltas for this block were already
      // appended, so append `content` only when it is not already the tail of
      // the accumulated text (which is exactly the "deltas already streamed"
      // case for pi's contiguous per-block streams, and idempotent on replay).
      // `message_end` then replaces the whole text authoritatively.
      const content = asString(delta.content);
      if (content && !entry.text.endsWith(content)) {
        next = { ...entry, text: entry.text + content };
      }
      break;
    }
    case 'thinking_delta': {
      const text = asString(delta.delta) ?? '';
      if (text) next = { ...entry, thinking: entry.thinking + text, streaming: true };
      break;
    }
    case 'thinking_end': {
      const content = asString(delta.content);
      if (content && !entry.thinking.endsWith(content)) {
        next = { ...entry, thinking: entry.thinking + content };
      }
      break;
    }
    case 'toolcall_start': {
      const call = deltaToolCall(delta);
      const toolCallId =
        call?.id || asString(delta.id) || `${entry.id}-tool-${entry.tools.length}`;
      if (entry.tools.some((run) => run.toolCallId === toolCallId)) break;
      const run: ToolRun = {
        toolCallId,
        toolName: call?.name || asString(delta.toolName) || 'unknown',
        args: call?.arguments ?? {},
        output: '',
        status: 'running',
        startedAt: Date.now(),
      };
      next = { ...entry, tools: [...entry.tools, run] };
      break;
    }
    case 'toolcall_delta': {
      // Argument fragments stream contiguously for one call, so they route to
      // that call by id (falling back to the newest run). The raw text is
      // buffered in `details` until it parses (or until `toolcall_end`), so no
      // fragment is ever lost.
      const fragment = asString(delta.delta) ?? '';
      const streamed = deltaToolCall(delta);
      const byId = streamed?.id
        ? entry.tools.findIndex((run) => run.toolCallId === streamed.id)
        : -1;
      const index = byId >= 0 ? byId : entry.tools.length - 1;
      const run = entry.tools[index];
      if (!fragment || !run) break;
      const raw = rawArgsOf(run) + fragment;
      const parsed = parseArgsObject(raw);
      const patched: ToolRun = { ...run };
      if (parsed) patched.args = parsed;
      else patched.details = { rawArgs: raw };
      const tools = entry.tools.slice();
      tools[index] = patched;
      next = { ...entry, tools };
      break;
    }
    case 'toolcall_end': {
      const call = toolCallBlock(delta.toolCall) ?? deltaToolCall(delta);
      const byId = call?.id
        ? entry.tools.findIndex((run) => run.toolCallId === call.id)
        : -1;
      const index = byId >= 0 ? byId : entry.tools.length - 1;
      const run = entry.tools[index];
      if (!run) break;
      const raw = rawArgsOf(run);
      const fromMessage = call?.arguments && Object.keys(call.arguments).length > 0 ? call.arguments : null;
      const parsed = fromMessage ?? parseArgsObject(raw);
      const patched: ToolRun = { ...run };
      if (call?.name) patched.toolName = call.name;
      if (parsed) patched.args = parsed;
      if (parsed) delete patched.details;
      else if (raw) patched.details = { rawArgs: raw };
      const tools = entry.tools.slice();
      tools[index] = patched;
      next = { ...entry, tools };
      break;
    }
    default:
      // `text_start` / `thinking_start` carry no content - nothing to append.
      break;
  }

  const latestUsage = toUsage(usage);
  const updated = latestUsage ? { ...(next ?? entry), usage: latestUsage } : next;

  if (!updated || updated === entry) return resolved.state;
  return replaceEntry(resolved.state, entry.id, () => updated);
}

/* -------------------------------------------------------------- settle-up */

/** A settled run has no in-flight tools: close every open entry/tool it left behind. */
export function finishStreaming(state: TranscriptState): TranscriptState {
  let changed = false;
  const entries = state.entries.map((entry) => {
    if (entry.kind === 'assistant') {
      let toolsChanged = false;
      const tools = entry.tools.map((run) => {
        if (run.status !== 'running') return run;
        toolsChanged = true;
        return { ...run, status: 'success' as const };
      });
      if (!entry.streaming && !toolsChanged) return entry;
      changed = true;
      return { ...entry, streaming: false, tools };
    }
    if (entry.kind === 'bash' && entry.streaming) {
      changed = true;
      return { ...entry, streaming: false };
    }
    return entry;
  });
  return changed ? { ...state, entries } : state;
}
