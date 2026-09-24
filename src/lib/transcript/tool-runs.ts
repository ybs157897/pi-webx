/**
 * Tool-run lifecycle: finding, updating and reconciling a `ToolRun` wherever it
 * lives in the transcript (inside an assistant entry's `tools`, or as a
 * standalone `toolResult` entry for orphaned history), plus the raw-argument
 * buffering that `toolcall_*` deltas stream through.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point,
 * so nothing here is exported to consumers.
 */

import type { PiToolCallBlock } from '../../shared/protocol';
import type {
  ToolResultEntry,
  ToolRun,
  ToolRunStatus,
  TranscriptEntry,
  TranscriptState,
} from '../../shared/transcript';

import { contentImageCount, contentImages, contentText, toolCallBlock } from './blocks';
import { asBoolean, asNumber, asRecord, asString, type Dict } from './guards';

/** Find a tool run by call id anywhere in the transcript (assistant turns or orphans). */
export function findToolRunIn(entries: readonly TranscriptEntry[], toolCallId: string): ToolRun | null {
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

export function updateToolRun(
  state: TranscriptState,
  toolCallId: string,
  update: (run: ToolRun) => ToolRun,
): TranscriptState {
  const entries = updateToolRunIn(state.entries, toolCallId, update);
  return entries ? { ...state, entries } : state;
}

/** Raw (unparsed) tool-call arguments buffered while a `toolcall_*` block streams. */
export function rawArgsOf(run: ToolRun): string {
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
export function deltaToolCall(delta: Dict): PiToolCallBlock | null {
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

export function parseArgsObject(raw: string): Record<string, unknown> | null {
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
export function restoredToolRuns(calls: readonly PiToolCallBlock[], at: number, entryId: string): ToolRun[] {
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
export function attachToolResultIn(
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
  const images = contentImages(rec.content);
  const imageCount = contentImageCount(rec.content);
  const status: ToolRunStatus = (asBoolean(rec.isError) ?? false) ? 'error' : 'success';
  const hasDetails = 'details' in rec;

  const match = findToolRunIn(entries, toolCallId);
  if (match) {
    const updated = updateToolRunIn(entries, toolCallId, (run) => {
      const next: ToolRun = {
        ...run,
        toolName: toolName || run.toolName,
        output,
        ...(imageCount > 0 ? { images, imageCount } : {}),
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
    ...(imageCount > 0 ? { images, imageCount } : {}),
    status,
    startedAt: at,
    endedAt: at,
  };
  if (restored) run.restored = true;
  if (hasDetails) run.details = rec.details;
  const entry: ToolResultEntry = { kind: 'toolResult', id: entryId, at, run };
  return [...entries, entry];
}

export function attachToolResult(
  state: TranscriptState,
  message: unknown,
  at: number,
  entryId: string,
  restored: boolean,
): TranscriptState {
  const entries = attachToolResultIn(state.entries, message, at, entryId, restored);
  return entries ? { ...state, entries } : state;
}

/**
 * Reconcile an assistant entry's tool runs against the authoritative message.
 *
 * Runs already known are kept as-is (status, output, details, restored); they
 * are never resurrected to `running`. Runs the message does not mention are
 * kept at the end so early `tool_execution_*` events are not lost.
 */
export function reconcileToolRuns(
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
