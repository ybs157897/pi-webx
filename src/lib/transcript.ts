/**
 * Transcript reducer: folds pi's event stream into the UI's transcript model.
 *
 * The contract (types + signatures) lives in `src/shared/transcript.ts`; this
 * module is the implementation. Two entry points:
 *
 *   - `applySnapshot(state, messages)` rebuilds `entries` from a `get_messages`
 *     reply (connect / reconnect / session switch)
 *   - `applyPiEvent(state, event)` folds one live pi event in incrementally
 *
 * Both are pure: the input state and its nested arrays/objects are never
 * mutated, and unchanged parts are structurally shared. Nothing here performs
 * I/O; the only ambient read is `Date.now()` for the `at` / `startedAt` /
 * `endedAt` timestamps of new entries (allowed by the contract).
 *
 * Event semantics follow pi's RPC docs (`pi-coding-agent/docs/rpc.md`, "Events"
 * and "Types") and the wire types in `src/shared/protocol.ts`. Two properties
 * that drive most of the design:
 *
 *   - `tool_execution_update.partialResult` is *cumulative*, not a delta: it
 *     REPLACES a run's output. `bash_execution_update.delta` is a real delta and
 *     APPENDS to the matching `bash` entry.
 *   - `message_update.assistantMessageEvent` carries deltas only (no cumulative
 *     message); `message_end.message` is authoritative and is where an
 *     assistant entry is finalised.
 *
 * Nothing in here is allowed to throw: it consumes a live stream, and an
 * exception would take the UI down with it.
 */

import type { PiAgentMessage, PiEvent, PiToolCallBlock } from '../shared/protocol';
import type {
  ApplyPiEvent,
  ApplySnapshot,
  AssistantEntry,
  BashEntry,
  CompactionEntry,
  NoticeEntry,
  NoticeLevel,
  RetryInfo,
  ToolResultEntry,
  ToolRun,
  ToolRunStatus,
  TranscriptEntry,
  TranscriptState,
  TranscriptUsage,
  UserEntry,
} from '../shared/transcript';

/**
 * Re-exported from the shared contract so consumers have a single import site.
 * Rebuilt state: `createTranscript()` -> snapshot -> stream of pi events.
 */
export { createTranscript } from '../shared/transcript';

/* ------------------------------------------------------------------ parsing */
/*
 * Events and messages arrive as JSON. The wire types describe what pi *should*
 * send, but a reducer that throws on a missing field is worse than one that
 * degrades, so every read goes through a total accessor.
 */

type Dict = Record<string, unknown>;

function asRecord(value: unknown): Dict | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Dict;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Text of a `text` content block, or `null` when the block is a different type. */
function textBlockText(block: unknown): string | null {
  const rec = asRecord(block);
  if (!rec || rec.type !== 'text') return null;
  return asString(rec.text) ?? '';
}

/** Text of a `thinking` content block, or `null` when the block is a different type. */
function thinkingBlockText(block: unknown): string | null {
  const rec = asRecord(block);
  if (!rec || rec.type !== 'thinking') return null;
  return asString(rec.thinking) ?? '';
}

function isImageBlock(block: unknown): boolean {
  return asRecord(block)?.type === 'image';
}

/** Normalised `toolCall` block, or `null` when the block is a different type. */
function toolCallBlock(block: unknown): PiToolCallBlock | null {
  const rec = asRecord(block);
  if (!rec || rec.type !== 'toolCall') return null;
  const args = asRecord(rec.arguments);
  return {
    type: 'toolCall',
    id: asString(rec.id) ?? '',
    name: asString(rec.name) ?? 'unknown',
    // Copy so the entry never aliases caller-owned JSON.
    arguments: args ? { ...args } : {},
  };
}

/** Concatenate `text` blocks (join with "\n"); a plain string content is used as-is. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const text = textBlockText(block);
    if (text !== null) parts.push(text);
  }
  return parts.join('\n');
}

/** Concatenate `thinking` blocks (join with "\n"). */
function contentThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const thinking = thinkingBlockText(block);
    if (thinking !== null) parts.push(thinking);
  }
  return parts.join('\n');
}

function contentImageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (isImageBlock(block)) count += 1;
  }
  return count;
}

function contentToolCalls(content: unknown): PiToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: PiToolCallBlock[] = [];
  for (const block of content) {
    const call = toolCallBlock(block);
    if (call) calls.push(call);
  }
  return calls;
}

/** Map pi's provider usage onto the transcript's usage shape. */
function toUsage(usage: unknown): TranscriptUsage | undefined {
  const rec = asRecord(usage);
  if (!rec) return undefined;
  const input = asNumber(rec.input) ?? 0;
  const output = asNumber(rec.output) ?? 0;
  const cacheRead = asNumber(rec.cacheRead) ?? 0;
  const cacheWrite = asNumber(rec.cacheWrite) ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: asNumber(rec.totalTokens) ?? input + output,
    cost: asNumber(asRecord(rec.cost)?.total) ?? 0,
  };
}

function timestampOf(message: unknown, fallback: number): number {
  return asNumber(asRecord(message)?.timestamp) ?? fallback;
}

/* ---------------------------------------------------------------------- ids */

/**
 * Ids for live entries. Derived from the timestamp plus the entry count rather
 * than a module counter, so folding the same state twice yields the same ids.
 * Entries are only ever appended by this reducer, so the pair stays unique.
 */
function liveEntryId(kind: string, at: number, entryCount: number): string {
  return `live-${kind}-${at.toString(36)}-${entryCount.toString(36)}`;
}

function lastEntryAt(entries: readonly TranscriptEntry[], fallback: number): number {
  const last = entries[entries.length - 1];
  return last ? last.at : fallback;
}

/* ------------------------------------------------------------ entry surgery */

function appendEntry(state: TranscriptState, entry: TranscriptEntry): TranscriptState {
  return { ...state, entries: [...state.entries, entry] };
}

/** Replace one entry by id. Returns the same state when nothing matched/changed. */
function replaceEntry(
  state: TranscriptState,
  id: string,
  update: (entry: TranscriptEntry) => TranscriptEntry,
): TranscriptState {
  const index = state.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return state;
  const current = state.entries[index];
  if (!current) return state;
  const next = update(current);
  if (next === current) return state;
  const entries = state.entries.slice();
  entries[index] = next;
  return { ...state, entries };
}

/** Find a tool run by call id anywhere in the transcript (assistant turns or orphans). */
function findToolRunIn(entries: readonly TranscriptEntry[], toolCallId: string): ToolRun | null {
  if (!toolCallId) return null;
  for (const entry of entries) {
    if (entry.kind === 'assistant') {
      const run = entry.tools.find((candidate) => candidate.toolCallId === toolCallId);
      if (run) return run;
    } else if (entry.kind === 'toolResult' && entry.run.toolCallId === toolCallId) {
      return entry.run;
    }
  }
  return null;
}

/**
 * Rewrite the tool run with `toolCallId`, wherever it lives. Returns `null` when
 * no run matched, otherwise a new entries array (structurally shared elsewhere).
 */
function updateToolRunIn(
  entries: readonly TranscriptEntry[],
  toolCallId: string,
  update: (run: ToolRun) => ToolRun,
): TranscriptEntry[] | null {
  if (!toolCallId) return null;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind === 'assistant') {
      let toolsChanged = false;
      const tools = entry.tools.map((run) => {
        if (run.toolCallId !== toolCallId) return run;
        const patched = update(run);
        if (patched !== run) toolsChanged = true;
        return patched;
      });
      if (!toolsChanged) return entry;
      changed = true;
      return { ...entry, tools };
    }
    if (entry.kind === 'toolResult') {
      if (entry.run.toolCallId !== toolCallId) return entry;
      const patched = update(entry.run);
      if (patched === entry.run) return entry;
      changed = true;
      return { ...entry, run: patched };
    }
    return entry;
  });
  return changed ? next : null;
}

function updateToolRun(
  state: TranscriptState,
  toolCallId: string,
  update: (run: ToolRun) => ToolRun,
): TranscriptState {
  const entries = updateToolRunIn(state.entries, toolCallId, update);
  return entries ? { ...state, entries } : state;
}

/** Raw (unparsed) tool-call arguments buffered while a `toolcall_*` block streams. */
function rawArgsOf(run: ToolRun): string {
  const rec = asRecord(run.details);
  const raw = rec?.rawArgs;
  return typeof raw === 'string' ? raw : '';
}

/**
 * The tool call a `toolcall_*` delta belongs to.
 *
 * pi's delta events carry no id or name of their own — the call lives in the
 * event's `partial` message, at `contentIndex`. Reading the identity off the
 * event instead (as this reducer did) minted a synthetic `${entryId}-tool-N`
 * run named `unknown` on every `toolcall_start`, which `message_end` then could
 * not match by id: every parallel call rendered twice, once as the real tool and
 * once as a permanently nameless `unknown` card.
 */
function deltaToolCall(delta: Dict): PiToolCallBlock | null {
  const partial = asRecord(delta['partial']);
  const content = partial?.['content'];
  if (!Array.isArray(content)) return null;
  const contentIndex = asNumber(delta['contentIndex']);
  if (contentIndex !== undefined) return toolCallBlock(content[contentIndex]);
  // No index (an older event shape): the call being streamed is the last one.
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const call = toolCallBlock(content[index]);
    if (call) return call;
  }
  return null;
}

function parseArgsObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const rec = asRecord(parsed);
    return rec ? { ...rec } : null;
  } catch {
    return null;
  }
}

/**
 * Tool runs rendered from history. `startedAt` prefers the message timestamp and
 * falls back to the previous entry's timestamp (or 0 for a detached history).
 */
function restoredToolRuns(calls: readonly PiToolCallBlock[], at: number, entryId: string): ToolRun[] {
  return calls.map((call, index) => ({
    toolCallId: call.id || `${entryId}-tool-${index}`,
    toolName: call.name,
    args: call.arguments ?? {},
    output: '',
    status: 'running' as const,
    startedAt: at,
    restored: true,
  }));
}

/**
 * Attach a `toolResult` message to its tool run (matching `toolCallId` anywhere
 * in the transcript), or - for orphaned history - append a standalone entry.
 * Shared by `applySnapshot` and the live `message_start` / `message_end` paths.
 * Returns a new entries array, or `null` when the message carries no call id at
 * all and there is nothing to match against.
 */
function attachToolResultIn(
  entries: readonly TranscriptEntry[],
  message: unknown,
  at: number,
  entryId: string,
  restored: boolean,
): TranscriptEntry[] | null {
  const rec = asRecord(message);
  if (!rec) return null;
  const toolCallId = asString(rec.toolCallId) ?? '';
  const toolName = asString(rec.toolName) ?? 'unknown';
  const output = contentText(rec.content);
  const status: ToolRunStatus = (asBoolean(rec.isError) ?? false) ? 'error' : 'success';
  const hasDetails = 'details' in rec;

  const match = findToolRunIn(entries, toolCallId);
  if (match) {
    const updated = updateToolRunIn(entries, toolCallId, (run) => {
      const next: ToolRun = {
        ...run,
        toolName: toolName || run.toolName,
        output,
        status,
        endedAt: at,
      };
      if (restored && !next.restored) next.restored = true;
      if (hasDetails) next.details = rec.details;
      return next;
    });
    if (updated) return updated;
  }

  const run: ToolRun = {
    toolCallId,
    toolName,
    args: {},
    output,
    status,
    startedAt: at,
    endedAt: at,
  };
  if (restored) run.restored = true;
  if (hasDetails) run.details = rec.details;
  const entry: ToolResultEntry = { kind: 'toolResult', id: entryId, at, run };
  return [...entries, entry];
}

function attachToolResult(
  state: TranscriptState,
  message: unknown,
  at: number,
  entryId: string,
  restored: boolean,
): TranscriptState {
  const entries = attachToolResultIn(state.entries, message, at, entryId, restored);
  return entries ? { ...state, entries } : state;
}

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

/**
 * Reconcile an assistant entry's tool runs against the authoritative message.
 *
 * Runs already known are kept as-is (status, output, details, restored); they
 * are never resurrected to `running`. Runs the message does not mention are
 * kept at the end so early `tool_execution_*` events are not lost.
 */
function reconcileToolRuns(
  existing: readonly ToolRun[],
  calls: readonly PiToolCallBlock[],
  at: number,
  entryId: string,
): ToolRun[] {
  if (calls.length === 0) return existing.slice();
  const claimed = new Set<number>();
  const next: ToolRun[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (!call) continue;
    const match = call.id
      ? existing.findIndex((run, i) => !claimed.has(i) && run.toolCallId === call.id)
      : -1;
    if (match >= 0) {
      claimed.add(match);
      const run = existing[match];
      if (run) {
        const merged: ToolRun = { ...run, args: { ...run.args } };
        if (call.name) merged.toolName = call.name;
        if (call.arguments && Object.keys(call.arguments).length > 0) merged.args = call.arguments;
        next.push(merged);
        continue;
      }
    }
    next.push({
      toolCallId: call.id || `${entryId}-tool-${index}`,
      toolName: call.name || 'unknown',
      args: call.arguments ?? {},
      output: '',
      status: 'running',
      startedAt: at,
    });
  }
  for (let index = 0; index < existing.length; index += 1) {
    if (claimed.has(index)) continue;
    const run = existing[index];
    if (!run) continue;
    // An unclaimed run whose id is the synthetic one this module mints came from
    // a partial delta that the authoritative message never claimed. Keeping it
    // rendered a second, permanently nameless `unknown` card beside the real one.
    if (run.toolCallId.startsWith(`${entryId}-tool-`)) continue;
    next.push(run);
  }
  return next;
}

/** `message_start`: open (or echo) a message. */
function startMessage(state: TranscriptState, message: PiAgentMessage | undefined): TranscriptState {
  const rec = asRecord(message);
  const role = asString(rec?.role);
  if (!rec || !role) return state;
  const at = timestampOf(rec, Date.now());

  switch (role) {
    case 'user': {
      // Also covers prompts echoed back to us (initial prompt + injected steering).
      const entry: UserEntry = {
        kind: 'user',
        id: liveEntryId('user', at, state.entries.length),
        at,
        text: contentText(rec.content),
        imageCount: contentImageCount(rec.content),
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
function endMessage(state: TranscriptState, message: PiAgentMessage | undefined): TranscriptState {
  const rec = asRecord(message);
  const role = asString(rec?.role);
  if (!rec || !role) return state;

  if (role === 'toolResult') {
    const at = timestampOf(rec, Date.now());
    return attachToolResult(state, rec, at, liveEntryId('toolResult', at, state.entries.length), false);
  }
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
function applyMessageUpdate(
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
function finishStreaming(state: TranscriptState): TranscriptState {
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

/* ---------------------------------------------------------------- notices */

function formatDelay(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function retryInfo(source: Dict): RetryInfo {
  const info: RetryInfo = {};
  const attempt = asNumber(source.attempt);
  if (attempt !== undefined) info.attempt = attempt;
  const maxAttempts = asNumber(source.maxAttempts);
  if (maxAttempts !== undefined) info.maxAttempts = maxAttempts;
  const delayMs = asNumber(source.delayMs);
  if (delayMs !== undefined) info.delayMs = delayMs;
  const error = asString(source.errorMessage);
  if (error !== undefined) info.error = error;
  return info;
}

/** Human-readable "attempt 2/3 in 2s" tail shared by the retry notices. */
function attemptSummary(info: RetryInfo): string {
  const parts: string[] = [];
  if (info.attempt !== undefined) {
    parts.push(info.maxAttempts !== undefined ? `attempt ${info.attempt}/${info.maxAttempts}` : `attempt ${info.attempt}`);
  }
  const delay = formatDelay(info.delayMs);
  if (delay) parts.push(`in ${delay}`);
  return parts.join(' ');
}

function makeNotice(
  state: TranscriptState,
  level: NoticeLevel,
  text: string,
  detail: string | undefined,
): NoticeEntry {
  const at = Date.now();
  const entry: NoticeEntry = {
    kind: 'notice',
    id: liveEntryId('notice', at, state.entries.length),
    at,
    level,
    text,
  };
  if (detail) entry.detail = detail;
  return entry;
}

/* --------------------------------------------------------------- snapshot */

/**
 * `lastError` derived from rebuilt history: only a trailing assistant turn that
 * ended with `stopReason === 'error'` is worth surfacing.
 */
function deriveLastError(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== 'assistant') continue;
    if (entry.stopReason === 'error') return entry.error ?? 'Assistant turn ended with an error';
    return null;
  }
  return null;
}

/**
 * Rebuild the transcript from `get_messages`.
 *
 * Live-session facts that history cannot express (`running`, `compacting`,
 * `retrying`, `queued`, `title`) are carried over untouched: the session may
 * perfectly well still be mid-run when a client reconnects and asks for the
 * message list. `streamingEntryId` is dropped because the entries it pointed at
 * no longer exist, and `lastError` is re-derived from the rebuilt history.
 */
export const applySnapshot: ApplySnapshot = (state, messages) => {
  let entries: TranscriptEntry[] = [];

  messages.forEach((message, index) => {
    const rec = asRecord(message);
    const role = asString(rec?.role);
    if (!rec || !role) return; // unknown roles are ignored silently

    const fallbackAt = lastEntryAt(entries, 0);
    switch (role) {
      case 'user': {
        const at = timestampOf(rec, fallbackAt);
        entries.push({
          kind: 'user',
          id: `snap-${index}`,
          at,
          text: contentText(rec.content),
          imageCount: contentImageCount(rec.content),
        });
        break;
      }
      case 'assistant': {
        const at = timestampOf(rec, fallbackAt);
        const id = `snap-${index}`;
        const entry: AssistantEntry = {
          kind: 'assistant',
          id,
          at,
          text: contentText(rec.content),
          thinking: contentThinking(rec.content),
          streaming: false,
          tools: restoredToolRuns(contentToolCalls(rec.content), at, id),
        };
        const usage = toUsage(rec.usage);
        if (usage) entry.usage = usage;
        const model = asString(rec.model);
        if (model !== undefined) entry.model = model;
        const provider = asString(rec.provider);
        if (provider !== undefined) entry.provider = provider;
        const stopReason = asString(rec.stopReason);
        if (stopReason !== undefined) entry.stopReason = stopReason;
        const error = asString(rec.errorMessage);
        if (error !== undefined) entry.error = error;
        entries.push(entry);
        break;
      }
      case 'toolResult': {
        // Attaches to the matching run anywhere in the entries built so far -
        // typically the assistant turn just above - and appends a standalone
        // entry (identical ids to a fresh snapshot) only for orphaned history.
        const at = timestampOf(rec, fallbackAt);
        const next = attachToolResultIn(entries, rec, at, `snap-${index}`, true);
        if (next) entries = next;
        break;
      }
      case 'bashExecution': {
        const at = timestampOf(rec, fallbackAt);
        entries.push({
          kind: 'bash',
          id: `snap-${index}`,
          at,
          command: asString(rec.command) ?? '',
          output: asString(rec.output) ?? '',
          exitCode: asNumber(rec.exitCode) ?? null,
          cancelled: asBoolean(rec.cancelled) ?? false,
          truncated: asBoolean(rec.truncated) ?? false,
          streaming: false,
        });
        break;
      }
      default:
        // Unknown roles are ignored silently.
        break;
    }
  });

  const derived = deriveLastError(entries);
  return { ...state, entries, streamingEntryId: null, lastError: derived ?? state.lastError };
};

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
      return {
        ...finishStreaming(state),
        running: false,
        streamingEntryId: null,
        retrying: null,
      };

    case 'turn_start':
    case 'turn_end':
      // Structural only: the message/tool events carry everything the UI shows.
      return state;

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
      const toolName = asString(event.toolName);
      const args = asRecord(event.args);
      return updateToolRun(state, toolCallId, (run) => {
        const next: ToolRun = { ...run };
        if (output !== undefined) next.output = output;
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
      const steering = Array.isArray(event.steering)
        ? event.steering.filter((item): item is string => typeof item === 'string')
        : [];
      const followUp = Array.isArray(event.followUp)
        ? event.followUp.filter((item): item is string => typeof item === 'string')
        : [];
      return { ...state, queued: { steering, followUp } };
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
