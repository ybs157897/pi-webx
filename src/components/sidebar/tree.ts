/**
 * Derivation for the workspace browser tree, modelled on deepseek-harness's
 * `ui-workspace` tree.ts and adapted to pi-webx's domain: a workspace is a
 * plain directory path (not a host entity), and sessions come in two kinds —
 * live in-memory sessions hosted by the bridge, and persisted transcripts
 * discovered on disk. Both kinds share one ordered row list per group; the
 * order is the browser's manual (dragged) account when present, else recency.
 */
import type { SessionSummary, StoredSession } from '../../shared/protocol'
import type { StateDotState } from '../../ui/primitives/index.ts'

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
  /** blocked on the reader answering an extension dialog */
  pendingInteraction: boolean
  /**
   * A run finished while this row was not the open session, and the row has not
   * been opened since — dsh's `completionUnread`, the green "done" reminder.
   */
  completed: boolean
  /** when the conversation was last active; orders the list and labels the row */
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

/**
 * One user-visible session status: which dot the leading slot paints, and the
 * label the hover card and screen readers use.
 */
export interface SessionStatus {
  state: StateDotState
  label: string
}

/**
 * The facts a status is read from: a session row, or one search result — both
 * carry the same four live bits plus the row's kind.
 */
type StatusFacts = Pick<
  SessionNode,
  'pendingInteraction' | 'running' | 'alive' | 'kind' | 'completed'
>

/**
 * Session status presentation, adapted to pi-webx's facts and ordered by what
 * the reader has to do about it: a session blocked on an answer outranks one
 * that is merely running (a prompt nobody answers stalls the run forever), and
 * both outrank a finish.
 *
 * A finish has two flavours, and dsh names them separately: `已完成` is the run
 * that ended while you were elsewhere (the green dot, cleared by opening the
 * row), while `空闲`/`历史会话` are rows with nothing to say at all. The hover
 * card spells both out; the row's leading slot paints only the telling half —
 * see {@link sessionShowsDot}.
 */
export function sessionStatuses(node: StatusFacts): readonly SessionStatus[] {
  if (node.pendingInteraction) return [{ state: 'warning', label: '等待你的确认' }]
  if (node.running) return [{ state: 'ongoing', label: '正在执行' }]
  if (node.completed) return [{ state: 'done', label: '已完成' }]
  if (node.kind === 'stored') return [{ state: 'done', label: '历史会话' }]
  if (!node.alive) return [{ state: 'idle', label: '已结束' }]
  return [{ state: 'done', label: '空闲' }]
}

/**
 * Whether a row's leading slot paints a dot at all.
 *
 * This is dsh's `showStatus`: the slot carries a dot only while something asks
 * for the reader — a pending interaction, a run in flight, or the green reminder
 * that a run finished while this row was not the open session. An idle, history
 * or dead row paints nothing and leaves the 16px slot empty.
 *
 * pi-webx used to paint all three states permanently, which is why every stored
 * transcript and every idle session carried the same green dot: a mark that is
 * always there cannot say anything, and it made "finished while you were away"
 * indistinguishable from "nothing is happening".
 */
export function sessionShowsDot(node: StatusFacts): boolean {
  const primary = sessionStatuses(node)[0]
  if (primary === undefined) return false
  return primary.state === 'warning' || primary.state === 'ongoing' || node.completed
}

/** One flat search row: title plus the workspace it belongs to. */
export interface SearchResultNode {
  id: string
  kind: 'live' | 'stored'
  title: string
  workspace: string
  running: boolean
  alive: boolean
  pendingInteraction: boolean
  /** dsh's `completionUnread` on the search row (see {@link SessionNode.completed}). */
  completed: boolean
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
 *
 * `updatedAt` is the hosted transcript's own recency when the row hosts one,
 * and only falls back to the bridge object's `createdAt` for a session with no
 * log to read (in-memory, or one whose first prompt is still being written).
 * Ordering by `createdAt` is the bug this avoids: re-opening an old conversation
 * mints a new session object, and the row announced itself as "刚刚" and jumped
 * to the top of the list.
 */
export function liveNode(
  session: SessionSummary,
  hostedTitle?: string | undefined,
  hostedUpdatedAt?: number | undefined,
  completed = false,
): SessionNode {
  return {
    id: session.id,
    kind: 'live',
    title: session.sessionName ?? hostedTitle ?? workspaceLabel(session.cwd),
    running: session.streaming,
    alive: session.alive,
    pendingInteraction: session.pendingDialogs > 0,
    completed,
    updatedAt: hostedUpdatedAt ?? session.createdAt,
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

/**
 * When a transcript was last active: the payload's recency key, falling back to
 * its start timestamp for a payload that predates the field (a cached bundle
 * talking to a newer server, or the reverse).
 */
export function storedUpdatedAt(session: StoredSession): number {
  if (Number.isFinite(session.updatedAt)) return session.updatedAt
  const parsed = Date.parse(session.startedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Persisted transcript → row node. */
export function storedNode(session: StoredSession): SessionNode {
  return {
    id: `stored:${session.path}`,
    kind: 'stored',
    title: previewTitle(session),
    running: false,
    alive: false,
    pendingInteraction: false,
    // Only a live session can finish a run; a transcript on disk has nothing
    // the reader has not seen.
    completed: false,
    updatedAt: storedUpdatedAt(session),
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
 *
 * The log also lends the live row its recency: the conversation's own last
 * prompt is what the list orders by, and the bridge's session object knows only
 * when it was created.
 */
interface HostedView {
  /** `sessionFile` values a live session is hosting right now. */
  files: ReadonlySet<string>
  /** Log-derived titles, keyed by those same paths. */
  titles: ReadonlyMap<string, string>
  /** Log-derived recency, keyed by those same paths. */
  updatedAt: ReadonlyMap<string, number>
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
  const updatedAt = new Map<string, number>()
  for (const session of stored) {
    if (!files.has(session.path)) continue
    titles.set(session.path, previewTitle(session))
    updatedAt.set(session.path, storedUpdatedAt(session))
  }
  return { files, titles, updatedAt }
}

/** Live row, titled and dated by the transcript it resumed when it hosts one. */
function liveRow(
  session: SessionSummary,
  hosted: HostedView,
  completed: ReadonlySet<string>,
): SessionNode {
  const file = session.sessionFile
  const hostedTitle = file === null ? undefined : hosted.titles.get(file)
  const hostedUpdatedAt = file === null ? undefined : hosted.updatedAt.get(file)
  return liveNode(session, hostedTitle, hostedUpdatedAt, completed.has(session.id))
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
 *
 * `completed` is the set of live sessions whose last run finished while they
 * were not the open one (dsh's `completionUnread`): the flag rides on the row so
 * the renderer only decides how to paint it.
 */
export function deriveGroups(
  workspaces: readonly WorkspaceItem[],
  live: readonly SessionSummary[],
  stored: readonly StoredSession[],
  currentId: string | null,
  expansion: Readonly<Record<string, boolean>>,
  orderByAccount: Readonly<Record<string, readonly string[]>>,
  completed: ReadonlySet<string>,
): GroupNode[] {
  const currentWorkspace = currentId === null
    ? undefined
    : live.find(session => session.id === currentId)?.cwd
  const hosted = hostedView(live, stored)
  const free = unhosted(stored, hosted)
  return workspaces.map((workspace) => {
    const rows: SessionNode[] = [
      ...live
        .filter(session => session.cwd === workspace.key)
        .map(session => liveRow(session, hosted, completed)),
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
  completed: ReadonlySet<string>,
): SessionNode[] {
  const hosted = hostedView(live, stored)
  const rows: SessionNode[] = [
    ...live.map(session => liveRow(session, hosted, completed)),
    ...unhosted(stored, hosted).map(session => storedNode(session)),
  ]
  return reconciledOrder(rows, orderByAccount[FLAT_SESSION_ORDER_KEY])
}

/**
 * Local metadata search across both session kinds: title, workspace label,
 * cwd, and — for live sessions — provider/model. pi-webx has no host content
 * index, so this stays deliberately simple: one case-insensitive substring
 * pass, merged newest-first (both kinds share the one recency clock the tree
 * orders by, so a search hit cannot claim a different position than the row it
 * stands for).
 */
export function deriveSearchResults(
  workspaces: readonly WorkspaceItem[],
  live: readonly SessionSummary[],
  stored: readonly StoredSession[],
  query: string,
  completed: ReadonlySet<string>,
): SearchResultNode[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const labelOf = (cwd: string): string =>
    workspaces.find(workspace => workspace.key === cwd)?.title ?? workspaceLabel(cwd)
  const hosted = hostedView(live, stored)
  const matches: { row: SearchResultNode; updatedAt: number }[] = []
  for (const session of live) {
    const node = liveRow(session, hosted, completed)
    const haystack = [node.title, session.cwd, session.provider ?? '', session.model ?? '']
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(q)) continue
    matches.push({
      updatedAt: node.updatedAt,
      row: {
        id: node.id,
        kind: 'live',
        title: node.title,
        workspace: labelOf(session.cwd),
        running: node.running,
        alive: node.alive,
        pendingInteraction: node.pendingInteraction,
        completed: node.completed,
      },
    })
  }
  for (const session of unhosted(stored, hosted)) {
    const node = storedNode(session)
    const haystack = [node.title, session.cwd, session.preview ?? ''].join('\n').toLowerCase()
    if (!haystack.includes(q)) continue
    matches.push({
      updatedAt: node.updatedAt,
      row: {
        id: node.id,
        kind: 'stored',
        title: node.title,
        workspace: labelOf(session.cwd),
        running: false,
        alive: false,
        pendingInteraction: false,
        completed: false,
      },
    })
  }
  return matches
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.row.id < b.row.id ? -1 : 1))
    .map(match => match.row)
}
