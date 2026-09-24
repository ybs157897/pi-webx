/**
 * Non-rendering vocabulary of the workspace browser: the constants its chrome
 * and list bodies share, the pure row folding / query sanitizing / section
 * splitting / drag geometry applied to them, and the types the browser passes
 * down to its bodies.
 */
import type { SessionSummary, StoredSession } from '../../shared/protocol'
import type { SessionNode, WorkspaceItem } from './tree.ts'

/** Column slide length (--ds-transition-duration-slow): rail-search focus waits it out. */
export const EXPAND_SLIDE_MS = 300
/** Session rows visible per workspace before the local overflow control. */
const COLLAPSED_SESSION_LIMIT = 5
/** Keep the controlled input bounded (mirrors the dsh wire cap). */
export const SEARCH_QUERY_MAX_CODE_UNITS = 500

/** Fold one workspace without charging against the ordinary-row limit. */
export function collapsedSessionRows(sessions: readonly SessionNode[]): {
  rows: readonly SessionNode[]
  hiddenCount: number
} {
  const rows = sessions.slice(0, COLLAPSED_SESSION_LIMIT)
  return { rows, hiddenCount: sessions.length - rows.length }
}

/** Keep the controlled input inside the bound, without splitting a surrogate pair. */
export function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul
  let end = SEARCH_QUERY_MAX_CODE_UNITS
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return withoutNul.slice(0, end)
}

/** Immutable membership toggle for the local expand-all array. */
export function toggled(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(k => k !== key) : [...list, key]
}

/** In-flight root-row drag: source identity plus the current insert marker. */
export interface DragState {
  /** Workspace path, or FLAT_SESSION_ORDER_KEY for the flat account. */
  accountKey: string
  sessionId: string
  /** Row the marker sits on and which half (insert above/below it). */
  over: { id: string; half: 'before' | 'after' } | null
}

/** In-flight workspace-row drag: source identity plus the current marker. */
export interface WorkspaceDragState {
  workspaceId: string
  over: { id: string; half: 'before' | 'after' } | null
}

/** Resolve an insertion side from the full rendered workspace group. */
export function workspaceGroupHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** Everything the tree bodies need that they don't own themselves. */
export interface TreeBodyProps {
  workspaces: readonly WorkspaceItem[]
  live: readonly SessionSummary[]
  stored: readonly StoredSession[]
  currentId: string | null
  home: string | undefined
  orderBy: 'manual' | 'updated'
  groupExpansion: Readonly<Record<string, boolean>>
  sessionOrderByAccount: Readonly<Record<string, readonly string[]>>
  /** Live sessions whose last run finished while they were not the open one. */
  completed: ReadonlySet<string>
  revealSessionId: string | undefined
  onSessionRevealed: (id: string) => void
  openNode: (node: SessionNode | { id: string; kind: 'live' | 'stored' }) => void
  onSessionRename: (id: string, currentTitle: string) => void
  /** Fork the session into a new transcript (dsh's `分叉会话`). */
  onSessionFork: (node: SessionNode) => void
  /** Hide the session from the list; its transcript is untouched (`归档会话`). */
  onSessionArchive: (node: SessionNode) => void
  onWorkspacePick: (path: string) => void
  onWorkspaceDefault: (path: string) => void
  onWorkspaceForget: (path: string) => void
  onNewSession: (cwd: string) => void
}

/** One labeled run of session rows inside a list. */
export interface RowSection {
  label?: string
  rows: SessionNode[]
}

/**
 * Split one pre-ordered row list into render sections.
 *
 * There is exactly one run: dsh's list has no pin tier and no calendar-day
 * buckets, so the rows read as one recency-ordered (or manually ordered) list
 * with the relative time on each row. The split never reorders rows, so the
 * drag math keeps reading the flat list.
 */
export function rowSections(rows: readonly SessionNode[]): RowSection[] {
  return rows.length > 0 ? [{ rows: [...rows] }] : []
}
