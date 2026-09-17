/**
 * Presentation helpers shared by the chat surface: value formatting and the
 * one-line summaries used as tool-card headlines.
 */

import type { PiThinkingLevel } from '../shared/protocol';

export const THINKING_LABELS: Record<PiThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

const RELATIVE_STEPS: { limit: number; divisor: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limit: 60_000, divisor: 1_000, unit: 'second' },
  { limit: 3_600_000, divisor: 60_000, unit: 'minute' },
  { limit: 86_400_000, divisor: 3_600_000, unit: 'hour' },
  { limit: 604_800_000, divisor: 86_400_000, unit: 'day' },
  { limit: 2_629_800_000, divisor: 604_800_000, unit: 'week' },
  { limit: Number.POSITIVE_INFINITY, divisor: 2_629_800_000, unit: 'month' },
];

const relative = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

export function formatRelativeTime(timestamp: number | undefined | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const delta = timestamp - Date.now();
  const magnitude = Math.abs(delta);
  if (magnitude < 5_000) return '刚刚';
  for (const step of RELATIVE_STEPS) {
    if (magnitude < step.limit) return relative.format(Math.round(delta / step.divisor), step.unit);
  }
  return '';
}

export function formatClock(timestamp: number | undefined | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatTokens(value: number | undefined | null): string {
  if (!value || !Number.isFinite(value)) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${trimZeros(value / 1_000)}k`;
  return `${trimZeros(value / 1_000_000)}M`;
}

export function formatCost(value: number | undefined | null): string {
  if (!value || !Number.isFinite(value)) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatBytes(value: number | undefined | null): string {
  if (!value || !Number.isFinite(value)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${trimZeros(size)} ${units[index] ?? 'B'}`;
}

const plainNumber = new Intl.NumberFormat('zh-CN');

/** Thousands-separated integer/decimal formatting for dashboard values. */
export function formatNumber(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return plainNumber.format(value);
  return plainNumber.format(Math.round(value * 100) / 100);
}

function trimZeros(value: number): string {
  return value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '');
}

export function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

function readString(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * One-line description of a tool call for the collapsed card header.
 * Falls back to a compact JSON preview for tools we do not know.
 */
export function summarizeToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'bash':
    case 'powershell': {
      const command = readString(args, 'command', 'script');
      return command ? truncate(command, 140) : '';
    }
    case 'read': {
      const file = readString(args, 'path', 'file_path', 'filePath');
      return file ? truncate(file, 140) : '';
    }
    case 'write':
    case 'edit': {
      const file = readString(args, 'path', 'file_path', 'filePath');
      const bytes = readString(args, 'content', 'newText', 'new_string');
      return [file ? truncate(file, 110) : '', bytes ? `· ${formatBytes(bytes.length)}` : '']
        .filter(Boolean)
        .join(' ');
    }
    case 'grep':
    case 'find': {
      const pattern = readString(args, 'pattern', 'query');
      const scope = readString(args, 'path', 'glob');
      return [pattern ? truncate(pattern, 90) : '', scope ? `in ${truncate(scope, 50)}` : '']
        .filter(Boolean)
        .join(' ');
    }
    case 'ls': {
      const dir = readString(args, 'path', 'dir');
      return dir ? truncate(dir, 140) : '';
    }
    default: {
      const entries = Object.entries(args);
      if (entries.length === 0) return '';
      return truncate(JSON.stringify(args), 140);
    }
  }
}

/** Pretty-printed argument payload for the expanded tool card body. */
export function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** Best-effort language hint for the syntax highlighter. */
export function languageFromPath(path: string | undefined | null): string {
  if (!path) return 'text';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    bash: 'bash',
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'c',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'jsx',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'bash',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'tsx',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'bash',
  };
  return map[ext] ?? 'text';
}

/** Number of lines in a block of text (used to size collapsed tool output). */
export function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.split('\n').length;
}

export function isImageContent(content: string | undefined): boolean {
  return typeof content === 'string' && content.startsWith('data:image/');
}
