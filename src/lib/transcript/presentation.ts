/**
 * Presentation policy for the transcript: the runtime vocabulary derived from
 * the persisted work-details mode (工作步骤展示), ported from dsh's
 * `presentation-policy.ts`. Renderers select single fields of a policy; none of
 * them compares the mode enum, so adding a mode changes only the table below.
 *
 * Pure UI concern — the reducer (`fold.ts` and friends) always computes
 * `turnProcesses`; the policy only decides how much of them the view hides.
 */

import { summarizeToolCall } from '../format';
import type { ActiveTurn, TranscriptEntry } from '../../shared/transcript';

/* ------------------------------------------------------------------- modes */

export const TRANSCRIPT_VIEW_MODES = ['compact', 'standard', 'detailed', 'verbose'] as const;

export type TranscriptViewMode = (typeof TRANSCRIPT_VIEW_MODES)[number];

export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = 'standard';

/** Persisted values may be stale or garbage (SQLite prefs, localStorage); those fall back to the default. */
export function parseTranscriptViewMode(value: unknown): TranscriptViewMode {
  return typeof value === 'string' && (TRANSCRIPT_VIEW_MODES as readonly string[]).includes(value)
    ? (value as TranscriptViewMode)
    : DEFAULT_TRANSCRIPT_VIEW_MODE;
}

/* ------------------------------------------------------------------ policy */

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Mode this policy was derived from; for diagnostics, never for branching in renderers. */
  readonly mode: TranscriptViewMode;
  /** Whether a normally completed turn folds its process rows behind the whole-turn control. */
  readonly foldCompletedTurns: boolean;
  /** Collapsible group headers for all turns, historical turns only, or no turns. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none';
  /** Show the running command, path, or query detail in the live group title. */
  readonly liveProcessDetail: boolean;
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean;
}

const POLICIES: Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: false,
    settledReasoningPreview: false,
  },
  standard: {
    mode: 'standard',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'history',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  verbose: {
    mode: 'verbose',
    foldCompletedTurns: false,
    stepGrouping: 'none',
    liveProcessDetail: false,
    settledReasoningPreview: true,
  },
};

/**
 * Resolve the policy constant for one mode. The same mode always yields the
 * same object, so memo dependencies comparing policies see stable identities.
 */
export function presentationPolicyFor(mode: TranscriptViewMode): ChatPresentationPolicy {
  return POLICIES[mode];
}

/* -------------------------------------------------------- live turn groups */

export type LiveActivity =
  | 'think' | 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'bash'
  | 'code' | 'webSearch' | 'web' | 'subagents' | 'plan' | 'questions' | 'tools';

/** What the live group's header shows while the turn is in flight. */
export interface LiveProcessSpec {
  readonly activity: LiveActivity;
  /** Activity type only — “正在运行命令”, never the command itself. */
  readonly label: string;
  /** Command / path / pattern summary (the `summarizeToolCall` vocabulary), '' when none. */
  readonly detail: string;
}

export interface CompletedProcessSpec {
  readonly activity: LiveActivity;
  readonly label: string;
}

interface ActivityCopy {
  readonly activity: LiveActivity;
  readonly label: string;
  readonly done: string;
}

const ANALYSIS: ActivityCopy = {
  activity: 'think', label: '正在分析请求', done: '已完成分析',
};

const ACTIVITY_OF_TOOL: Record<string, ActivityCopy> = {
  bash: { activity: 'bash', label: '正在运行命令', done: '执行了命令' },
  powershell: { activity: 'bash', label: '正在运行命令', done: '执行了命令' },
  read: { activity: 'read', label: '正在读取文件', done: '已读取文件' },
  ls: { activity: 'read', label: '正在读取文件', done: '已读取文件' },
  read_image: { activity: 'readImage', label: '正在读取图片', done: '已读取图片' },
  write: { activity: 'write', label: '正在写入文件', done: '已写入文件' },
  edit: { activity: 'edit', label: '正在编辑文件', done: '修改了文件' },
  apply_patch: { activity: 'edit', label: '正在编辑文件', done: '修改了文件' },
  grep: { activity: 'search', label: '正在搜索代码', done: '已搜索代码' },
  find: { activity: 'search', label: '正在搜索代码', done: '已搜索代码' },
  glob: { activity: 'search', label: '正在搜索代码', done: '已搜索代码' },
  run_code: { activity: 'code', label: '正在运行代码', done: '运行了代码' },
  websearch: { activity: 'webSearch', label: '正在搜索网页', done: '已搜索网页' },
  webfetch: { activity: 'web', label: '正在访问网页', done: '已访问网页' },
  todo: { activity: 'plan', label: '正在更新计划', done: '更新了计划' },
  todo_write: { activity: 'plan', label: '正在更新计划', done: '更新了计划' },
  question: { activity: 'questions', label: '等待你的操作', done: '向用户提出了问题' },
};

const DEFAULT_ACTIVITY: ActivityCopy = {
  activity: 'tools', label: '正在调用工具', done: '已调用工具',
};

function activityOfTool(name: string): ActivityCopy {
  const normalized = name.toLowerCase();
  if (normalized === 'subagent' || normalized.startsWith('subagent_')) {
    return { activity: 'subagents', label: '正在协调子代理', done: '已协调子代理' };
  }
  return ACTIVITY_OF_TOOL[normalized] ?? DEFAULT_ACTIVITY;
}

/** Closed process titles follow dsh's ranked activity vocabulary, without counts. */
export function completedProcessSpec(entries: readonly TranscriptEntry[]): CompletedProcessSpec {
  const counts = new Map<LiveActivity, { copy: ActivityCopy; count: number; order: number }>();
  const seenCalls = new Set<string>();
  let order = 0;
  const record = (name: string, id: string): void => {
    if (seenCalls.has(id)) return;
    seenCalls.add(id);
    const copy = activityOfTool(name);
    const current = counts.get(copy.activity);
    if (current) current.count += 1;
    else counts.set(copy.activity, { copy, count: 1, order: order++ });
  };
  for (const entry of entries) {
    if (entry.kind === 'assistant') {
      for (const run of entry.tools) record(run.toolName, run.toolCallId);
    } else if (entry.kind === 'toolResult') {
      record(entry.run.toolName, entry.run.toolCallId);
    } else if (entry.kind === 'bash') {
      record('bash', entry.id);
    }
  }
  const ranked = [...counts.values()].sort((left, right) => right.count - left.count || left.order - right.order);
  if (ranked.length === 0) return { activity: ANALYSIS.activity, label: ANALYSIS.done };
  const labels = ranked.slice(0, 3).map(({ copy }) => copy.done);
  const first = labels[0]!;
  const second = labels[1];
  let label = first;
  if (second !== undefined) {
    if (labels.length === 2) {
      const continuation = first.startsWith('已') && second.startsWith('已') ? second.slice(1) : second;
      label = `${first}并${continuation}`;
    } else {
      label = labels.join('，');
      if (ranked.length > 3) label += '等';
    }
  }
  return { activity: ranked[0]!.copy.activity, label };
}

/**
 * The entries after the active turn's start marker — the window that will close
 * into `turnProcesses` at `turn_end`. `null` when the marker points at nothing
 * (a history rebuild between turn start and end), matching `finalizeTurn`'s
 * refusal to fold a guess.
 */
export function activeRegion(
  entries: readonly TranscriptEntry[],
  active: ActiveTurn,
): TranscriptEntry[] | null {
  if (active.startId === null) return entries.slice();
  const index = entries.findIndex((entry) => entry.id === active.startId);
  if (index < 0) return null;
  return entries.slice(index + 1);
}

/**
 * Text-only replies stay visible even between message_end and agent_settled.
 * A wire-step boundary must not make the answer vanish until the reader expands
 * the process row. Tool and reasoning steps still belong to the process.
 */
export function isLiveFoldMember(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'assistant':
      return entry.tools.length > 0 || entry.text.trim().length === 0;
    case 'toolResult':
    case 'bash':
      return true;
    default:
      return false;
  }
}

/**
 * When no tool is running, the agent is analyzing the request again. A finished
 * command must not stay labelled as running while the model writes its reply.
 */
export function liveProcessSpec(
  region: readonly TranscriptEntry[],
  streamingEntryId: string | null,
): LiveProcessSpec {
  let running: { toolName: string; args: Record<string, unknown> } | null = null;
  let thinkingDetail = '';
  for (const entry of region) {
    if (entry.kind === 'assistant') {
      for (const run of entry.tools) {
        const call = { toolName: run.toolName, args: run.args };
        if (run.status === 'running') running = call;
      }
      if (
        entry.id === streamingEntryId &&
        entry.thinking.trim().length > 0
      ) {
        const lines = entry.thinking.split(/\r?\n/);
        thinkingDetail = lines.length > 1 ? (lines.at(-2) ?? '').trim() : '';
      }
    } else if (entry.kind === 'toolResult') {
      const call = { toolName: entry.run.toolName, args: entry.run.args };
      if (entry.run.status === 'running') running = call;
    } else if (entry.kind === 'bash') {
      const call = { toolName: 'bash', args: { command: entry.command } };
      if (entry.streaming) running = call;
    }
  }
  if (running !== null) {
    const copy = activityOfTool(running.toolName);
    return { activity: copy.activity, label: copy.label, detail: summarizeToolCall(running.toolName, running.args) };
  }
  return { activity: ANALYSIS.activity, label: ANALYSIS.label, detail: thinkingDetail };
}
