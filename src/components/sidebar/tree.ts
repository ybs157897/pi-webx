/**
 * Derivation for the workspace browser tree, modelled on deepseek-harness's
 * `ui-workspace` tree.ts and adapted to pi-webx's domain: a workspace is a
 * plain directory path (not a host entity), and sessions come in two kinds —
 * live in-memory sessions hosted by the bridge, and persisted transcripts
 * discovered on disk. Both kinds share one ordered row list per group; the
 * order is the browser's manual (dragged) account when present, else recency.
 */
import type { SessionSummary, StoredSession } from '../../shared/protocol'

/** Order-account key of the flat "In one list" view. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/** One workspace as the browser sees it: a directory path plus display facts. */
export interface WorkspaceItem {
  /** absolute path — the group's identity */
  key: string
  /** display title: the directory's own name (the path lives in the hover card) */
  title: string
  isCurrent: boolean
  isDefault: boolean
}

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  /** live session id, or `stored:` + the transcript's absolute path */
  id: string
  kind: 'live' | 'stored'
  title: string
  /** live session currently streaming a run */
  running: boolean
  /** live session with a live process (a dead one renders dimmed) */
  alive: boolean
  updatedAt: number
  live?: SessionSummary
  stored?: StoredSession
}

/** One workspace group section: header row facts + visible session rows. */
export interface GroupNode {
  key: string
  cwd: string
  label: string
  isCurrent: boolean
  isDefault: boolean
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint). */
  containsCurrent: boolean
  sessions: readonly SessionNode[]
}

/** One flat search row: title plus the workspace it belongs to. */
export interface SearchResultNode {
  id: string
  kind: 'live' | 'stored'
  title: string
  workspace: string
  running: boolean
  alive: boolean
}

/** `/Users/x/work/api` → `~/work/api` when it lives under the reported home dir. */
export function shortenCwd(path: string, home: string | undefined): string {
  if (home !== undefined && home.length > 0 && path.startsWith(home)) {
    const rest = path.slice(home.length)
    return rest.length === 0 ? '~' : `~${rest}`
  }
  return path
}

/** Directory display label: basename of the path, falling back to the path itself. */
export function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const base = cwd.split('/').filter(Boolean).pop() ?? ''
  return base !== '' ? base : cwd
}

/** Recency comparator: newest first, id as the deterministic tiebreak. */
function byRecency(a: SessionNode, b: SessionNode): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/**
 * Live session → row node.
 *
 * Its display title is the name pi echoes, else the title of the transcript it
 * resumed, else the folder it runs in — the directory's own name, never the
 * path: a row under a workspace header repeats that header at worst, where a
 * path repeats the whole filesystem. The hover card is where the path is
 * spelled out.
 */
export function liveNode(session: SessionSummary, hostedTitle?: string | undefined): SessionNode {
  return {
    id: session.id,
    kind: 'live',
    title: session.sessionName ?? hostedTitle ?? workspaceLabel(session.cwd),
    running: session.streaming,
    alive: session.alive,
    updatedAt: session.createdAt,
    live: session,
  }
}

/** Truncate a stored preview the way the old tree did (single line, bounded). */
function previewTitle(session: StoredSession): string {
  const preview = session.preview?.trim()
  if (preview !== undefined && preview.length > 0) {
    return preview.length > 60 ? `${preview.slice(0, 60)}…` : preview
  }
  return session.id.slice(0, 12)
}

/** Persisted transcript → row node. */
export function storedNode(session: StoredSession): SessionNode {
  const parsed = Date.parse(session.startedAt)
  return {
    id: `stored:${session.path}`,
    kind: 'stored',
    title: previewTitle(session),
    running: false,
    alive: false,
    updatedAt: Number.isNaN(parsed) ? 0 : parsed,
    stored: session,
  }
}

/* ------------------------------------------- transcripts a live session hosts */

/**
 * What the live sessions are currently hosting, seen from the stored list.
 *
 * Resuming a transcript loads it into a hosted session that keeps writing to the
 * *same* file, so the file is then both a history row and a live row: two rows
 * for one conversation, and the one the user just clicked looks like a second,
 * brand new session. Derivation therefore drops the stored row, and titles the
 * live row from the log — pi carries no session name for a log it resumed, so
 * without that the row would fall back to the folder name and read as a fresh
 * session in that folder all over again.
 */
interface HostedView {
  /** `sessionFile` values a live session is hosting right now. */
  files: ReadonlySet<string>
  /** Log-derived titles, keyed by those same paths. */
  titles: ReadonlyMap<string, string>
}

function hostedView(
  live: readonly SessionSummary[],
  stored: readonly StoredSession[],
): HostedView {
  const files = new Set<string>()
  for (const session of live) {
    if (session.sessionFile !== null) files.add(session.sessionFile)
  }
  const titles = new Map<string, string>()
  for (const session of stored) {
    if (files.has(session.path)) titles.set(session.path, previewTitle(session))
  }
  return { files, titles }
}

/** Live row, titled by the transcript it resumed when pi reports no name. */
function liveRow(session: SessionSummary, hosted: HostedView): SessionNode {
  const hostedTitle = session.sessionFile === null ? undefined : hosted.titles.get(session.sessionFile)
  return liveNode(session, hostedTitle)
}

/** Stored rows that are already represented by a live row. */
function unhosted(stored: readonly StoredSession[], hosted: HostedView): StoredSession[] {
  return stored.filter(session => !hosted.files.has(session.path))
}

/**
 * Reconcile a stored order account with the rows that exist now: stored ids
 * first (unknown ids dropped), then every current row the account does not
 * know yet, by recency.
 */
export function reconciledOrder(
  rows: readonly SessionNode[],
  stored: readonly string[] | undefined,
): SessionNode[] {
  if (stored === undefined) return [...rows].sort(byRecency)
  const byId = new Map(rows.map(row => [row.id, row]))
  const included = new Set<string>()
  const ordered: SessionNode[] = []
  for (const key of stored) {
    const row = byId.get(key)
    if (row === undefined || included.has(key)) continue
    ordered.push(row)
    included.add(key)
  }
  for (const row of [...rows].sort(byRecency)) {
    if (included.has(row.id)) continue
    ordered.push(row)
  }
  return ordered
}

/**
 * Derive the workspace groups: one per workspace in the given order, each
 * with its live + stored sessions in the group's reconciled order. Only
 * expanded groups carry their rows; `containsCurrent` is computed here so the
 * renderer never scans.
 */
export function deriveGroups(
  workspaces: readonly WorkspaceItem[],
  live: readonly SessionSummary[],
  stored: readonly StoredSession[],
  currentId: string | null,
  expansion: Readonly<Record<string, boolean>>,
  orderByAccount: Readonly<Record<string, readonly string[]>>,
): GroupNode[] {
  const currentWorkspace = currentId === null
    ? undefined
    : live.find(session => session.id === currentId)?.cwd
  const hosted = hostedView(live, stored)
  const free = unhosted(stored, hosted)
  return workspaces.map((workspace) => {
    const rows: SessionNode[] = [
      ...live.filter(session => session.cwd === workspace.key).map(session => liveRow(session, hosted)),
      ...free.filter(session => session.cwd === workspace.key).map(session => storedNode(session)),
    ]
    // No pin tier: dsh's list is one recency-ordered run, so a session's place
    // in it is earned by being recent rather than by being held there.
    const ordered = reconciledOrder(rows, orderByAccount[workspace.key])
    const expanded = expansion[workspace.key] ?? workspace.isCurrent
    return {
      key: workspace.key,
      cwd: workspace.key,
      label: workspace.title,
      isCurrent: workspace.isCurrent,
      isDefault: workspace.isDefault,
      sessionCount: rows.length,
      expanded,
      containsCurrent: workspace.key === currentWorkspace,
      sessions: expanded ? ordered : [],
    }
  })
}

/** Derive the flat session list ("In one list" mode), newest first. */
export function deriveFlat(
  live: readonly SessionSummary[],
  stored: readonly StoredSession[],
  orderByAccount: Readonly<Record<string, readonly string[]>>,
): SessionNode[] {
  const hosted = hostedView(live, stored)
  const rows: SessionNode[] = [
    ...live.map(session => liveRow(session, hosted)),
    ...unhosted(stored, hosted).map(session => storedNode(session)),
  ]
  return reconciledOrder(rows, orderByAccount[FLAT_SESSION_ORDER_KEY])
}

/**
 * Local metadata search across both session kinds: title, workspace label,
 * cwd, and — for live sessions — provider/model. pi-webx has no host content
 * index, so this stays deliberately simple: one case-insensitive substring
 * pass, results newest-first.
 */
export function deriveSearchResults(
  workspaces: readonly WorkspaceItem[],
  live: readonly SessionSummary[],
  stored: readonly StoredSession[],
  query: string,
): SearchResultNode[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const labelOf = (cwd: string): string =>
    workspaces.find(workspace => workspace.key === cwd)?.title ?? workspaceLabel(cwd)
  const hosted = hostedView(live, stored)
  const results: SearchResultNode[] = []
  for (const session of live) {
    const node = liveRow(session, hosted)
    const haystack = [node.title, session.cwd, session.provider ?? '', session.model ?? '']
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(q)) continue
    results.push({
      id: node.id,
      kind: 'live',
      title: node.title,
      workspace: labelOf(session.cwd),
      running: node.running,
      alive: node.alive,
    })
  }
  for (const session of unhosted(stored, hosted)) {
    const node = storedNode(session)
    const haystack = [node.title, session.cwd, session.preview ?? ''].join('\n').toLowerCase()
    if (!haystack.includes(q)) continue
    results.push({
      id: node.id,
      kind: 'stored',
      title: node.title,
      workspace: labelOf(session.cwd),
      running: false,
      alive: false,
    })
  }
  return results
}
