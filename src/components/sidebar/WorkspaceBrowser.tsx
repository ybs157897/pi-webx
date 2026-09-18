/**
 * The workspace/session browsing region, ported from deepseek-harness's
 * `ui-workspace` WorkspaceBrowser: section header (title + expanding search +
 * view options + add workspace), the grouped tree or flat list, and the
 * browser-owned dialogs (rename, kill, delete-transcript). Wide state renders
 * the full browser; rail state renders the two region icons as 36px controls,
 * each requesting expansion through the owner share.
 *
 * pi-webx adaptations: sessions are live bridge sessions or on-disk
 * transcripts (two row kinds), workspaces are directory paths (rename/delete
 * don't exist — the menu offers switch/default/forget), search is local
 * metadata only, and every order persists to localStorage through the view
 * store (there is no host to write manual order back to).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SessionSummary, StoredSession } from '../../shared/protocol'
import {
  Button,
  IconCloseFill14,
  IconPersonalizationOutline16,
  IconProjectAddOutline16,
  IconSearchOutline16,
  Menu,
  Modal,
  Tooltip,
} from '../../ui/primitives/index.ts'
import type { SessionNode, WorkspaceItem } from './tree.ts'
import {
  FLAT_SESSION_ORDER_KEY,
  deriveFlat,
  deriveGroups,
  deriveSearchResults,
} from './tree.ts'
import { useWorkspaceView, viewActions } from './stores.ts'
import { ProjectRowItem, SearchResultItem, SessionNodeItem } from './Rows.tsx'
import css from './WorkspaceBrowser.module.css'

/** Column slide length (--ds-transition-duration-slow): rail-search focus waits it out. */
const EXPAND_SLIDE_MS = 300
/** Session rows visible per workspace before the local overflow control. */
const COLLAPSED_SESSION_LIMIT = 5
/** Keep the controlled input bounded (mirrors the dsh wire cap). */
const SEARCH_QUERY_MAX_CODE_UNITS = 500

/** Fold one workspace without charging against the ordinary-row limit. */
function collapsedSessionRows(sessions: readonly SessionNode[]): {
  rows: readonly SessionNode[]
  hiddenCount: number
} {
  const rows = sessions.slice(0, COLLAPSED_SESSION_LIMIT)
  return { rows, hiddenCount: sessions.length - rows.length }
}

/** Keep the controlled input inside the bound, without splitting a surrogate pair. */
function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul
  let end = SEARCH_QUERY_MAX_CODE_UNITS
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return withoutNul.slice(0, end)
}

/** Immutable membership toggle for the local expand-all array. */
function toggled(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(k => k !== key) : [...list, key]
}

/**
 * Accept the native drag at document level while a row drag is active: row
 * hover still owns the insertion marker, and releasing outside the list must
 * not be rendered as a rejected drop before dragend commits that last marker.
 */
function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
}

/** Grouping and ordering menu; own open state so it resets with the wide chrome. */
function ViewOptionsMenu({ groupBy, orderBy, onGroupPick, onOrderPick }: {
  groupBy: 'workspace' | 'flat'
  orderBy: 'manual' | 'updated'
  onGroupPick: (mode: 'workspace' | 'flat') => void
  onOrderPick: (mode: 'manual' | 'updated') => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { type: 'label' as const, id: 'group-by', text: '分组方式' },
        { id: 'workspace', label: '按工作区' },
        { id: 'flat', label: '一个列表' },
        { type: 'separator' as const, id: 'order-by-separator' },
        { type: 'label' as const, id: 'order-by', text: '排序方式' },
        { id: 'manual', label: '手动排序' },
        { id: 'updated', label: '最近更新' },
      ]}
      selectedIds={[groupBy, orderBy]}
      onSelect={(id) => {
        if (id === 'workspace' || id === 'flat') onGroupPick(id)
        else if (id === 'manual' || id === 'updated') onOrderPick(id)
        setOpen(false)
      }}
      align="end"
      dense
      // Portal: the section header clips overflow, so an in-place list would
      // be cut off at the header's bounds.
      portal
      anchor={(
        <Tooltip label="视图选项" side="bottom" delayMs={500}>
          <button
            type="button"
            className={clsx(css.iconButton, css.wide)}
            aria-label="视图选项"
            onClick={() => { setOpen(v => !v) }}
          >
            <IconPersonalizationOutline16 />
          </button>
        </Tooltip>
      )}
    />
  )
}

/** In-flight root-row drag: source identity plus the current insert marker. */
interface DragState {
  /** Workspace path, or FLAT_SESSION_ORDER_KEY for the flat account. */
  accountKey: string
  sessionId: string
  /** Row the marker sits on and which half (insert above/below it). */
  over: { id: string; half: 'before' | 'after' } | null
}

/** In-flight workspace-row drag: source identity plus the current marker. */
interface WorkspaceDragState {
  workspaceId: string
  over: { id: string; half: 'before' | 'after' } | null
}

/** Resolve an insertion side from the full rendered workspace group. */
function workspaceGroupHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** Everything the tree bodies need that they don't own themselves. */
interface TreeBodyProps {
  workspaces: readonly WorkspaceItem[]
  live: readonly SessionSummary[]
  stored: readonly StoredSession[]
  currentId: string | null
  home: string | undefined
  orderBy: 'manual' | 'updated'
  groupExpansion: Readonly<Record<string, boolean>>
  sessionOrderByAccount: Readonly<Record<string, readonly string[]>>
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
interface RowSection {
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
function rowSections(rows: readonly SessionNode[]): RowSection[] {
  return rows.length > 0 ? [{ rows: [...rows] }] : []
}

/** The scrolling session tree; manual drag order persists into the view store. */
function SessionTree(props: TreeBodyProps) {
  const {
    workspaces, live, stored, currentId, home, orderBy, groupExpansion, sessionOrderByAccount,
    revealSessionId, onSessionRevealed, openNode,
    onSessionRename, onSessionFork, onSessionArchive,
    onWorkspacePick, onWorkspaceDefault, onWorkspaceForget, onNewSession,
  } = props
  const orderAccounts = orderBy === 'manual' ? sessionOrderByAccount : {}
  const groups = useMemo(
    () => deriveGroups(workspaces, live, stored, currentId, groupExpansion, orderAccounts),
    [workspaces, live, stored, currentId, groupExpansion, orderAccounts],
  )
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<string[]>([])
  const [drag, setDrag] = useState<DragState | null>(null)
  const sessionDropCommitted = useRef(false)
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null)
  const workspaceDropCommitted = useRef(false)
  useNativeDragAcceptance(drag !== null || workspaceDrag !== null)

  // The group holding the current session always starts expanded.
  const currentGroup = groups.find(group => group.containsCurrent)?.key
  useEffect(() => {
    if (currentGroup === undefined || Object.hasOwn(groupExpansion, currentGroup)) return
    viewActions.setGroupExpanded(currentGroup, true)
  }, [currentGroup, groupExpansion])

  // Search navigation: expand the chosen session's group, then unfold the
  // overflow until the row is rendered and can scroll into view.
  const revealGroup = revealSessionId === undefined
    ? undefined
    : groups.find(group => group.sessions.some(row => row.id === revealSessionId))?.key
      ?? groups.find(group => live.some(
        session => session.cwd === group.key && session.id === revealSessionId,
      ))?.key
  useEffect(() => {
    if (revealGroup === undefined || groupExpansion[revealGroup] === true) return
    viewActions.setGroupExpanded(revealGroup, true)
  }, [groupExpansion, revealGroup])
  useEffect(() => {
    if (revealSessionId === undefined || revealGroup === undefined) return
    const group = groups.find(candidate => candidate.key === revealGroup)
    if (group === undefined || !group.expanded || !group.sessions.some(row => row.id === revealSessionId)) return
    if (collapsedSessionRows(group.sessions).rows.some(row => row.id === revealSessionId)) return
    setExpandedSessionGroups(keys => keys.includes(revealGroup) ? keys : [...keys, revealGroup])
  }, [groups, revealGroup, revealSessionId])

  const now = Date.now()

  const commitSessionDrag = (activeDrag: DragState, over: NonNullable<DragState['over']>): void => {
    if (sessionDropCommitted.current) return
    sessionDropCommitted.current = true
    setDrag(null)
    const group = groups.find(candidate => candidate.key === activeDrag.accountKey)
    if (group === undefined) return
    const sessionsExpanded = expandedSessionGroups.includes(group.key)
    const renderedSessions = sessionsExpanded ? group.sessions : collapsedSessionRows(group.sessions).rows
    const targetIndex = renderedSessions.findIndex(session => session.id === over.id)
    if (targetIndex === -1) return
    const sourceIndex = renderedSessions.findIndex(session => session.id === activeDrag.sessionId)
    if (over.id === activeDrag.sessionId) return
    const withoutSource = renderedSessions.filter(session => session.id !== activeDrag.sessionId)
    const targetWithoutSourceIndex = withoutSource.findIndex(session => session.id === over.id)
    if (targetWithoutSourceIndex === -1) return
    const visibleInsertAt = over.half === 'before' ? targetWithoutSourceIndex : targetWithoutSourceIndex + 1
    if (sourceIndex !== -1 && visibleInsertAt === sourceIndex) return
    const accountIds = group.sessions.map(row => row.id)
    const nextOrder = accountIds.filter(id => id !== activeDrag.sessionId)
    const anchor = over.half === 'before' ? over.id : renderedSessions[targetIndex + 1]?.id
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId)
    viewActions.setSessionOrder(activeDrag.accountKey, nextOrder)
  }

  const commitWorkspaceDrag = (
    activeDrag: WorkspaceDragState,
    over: NonNullable<WorkspaceDragState['over']>,
  ): void => {
    if (workspaceDropCommitted.current) return
    workspaceDropCommitted.current = true
    setWorkspaceDrag(null)
    const ordered = props.workspaces.map(workspace => workspace.key)
    const rowIndex = ordered.indexOf(over.id)
    if (rowIndex === -1) return
    const anchor = over.half === 'before' ? over.id : ordered[rowIndex + 1]
    if (anchor === activeDrag.workspaceId) return
    const sourceIndex = ordered.indexOf(activeDrag.workspaceId)
    const anchorIndex = anchor === undefined ? ordered.length : ordered.indexOf(anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    const nextOrder = ordered.filter(id => id !== activeDrag.workspaceId)
    nextOrder.splice(anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor), 0, activeDrag.workspaceId)
    viewActions.setWorkspaceOrder(nextOrder)
  }

  const workspaceDropAtListStart = groups[0] !== undefined
    && workspaceDrag?.over?.id === groups[0].key
    && workspaceDrag.over.half === 'before'

  return (
    <div className={clsx(css.treeBody, css.wide)}>
      {workspaceDropAtListStart && <span className={css.listTopDropIndicator} aria-hidden="true" />}
      <div
        className={clsx(css.list, workspaceDropAtListStart && css.listTopDropActive)}
        role="tree"
        aria-label="会话"
      >
        {groups.length === 0 && (
          <div className={css.empty}>暂无会话</div>
        )}
        {groups.map((group) => {
          const collapsed = collapsedSessionRows(group.sessions)
          const sessionsExpanded = expandedSessionGroups.includes(group.key)
          const workspaceMarker = workspaceDrag?.over?.id === group.key ? workspaceDrag.over.half : null
          const workspaceDragProps = orderBy !== 'manual' ? undefined : {
            start: () => {
              workspaceDropCommitted.current = false
              setWorkspaceDrag({ workspaceId: group.key, over: null })
            },
            end: () => {
              if (workspaceDrag?.over !== null && workspaceDrag?.over !== undefined) {
                commitWorkspaceDrag(workspaceDrag, workspaceDrag.over)
              } else {
                setWorkspaceDrag(null)
              }
              workspaceDropCommitted.current = false
            },
          }
          const hoverWorkspace = (half: 'before' | 'after') => {
            setWorkspaceDrag(active => active === null ? active : { ...active, over: { id: group.key, half } })
          }
          const dropWorkspace = (half: 'before' | 'after') => {
            if (workspaceDrag === null) return
            commitWorkspaceDrag(workspaceDrag, { id: group.key, half })
          }
          return (
            <div
              key={group.key}
              className={clsx(
                css.groupSection,
                workspaceMarker === 'before' && css.workspaceDropBefore,
                workspaceMarker === 'after' && css.workspaceDropAfter,
              )}
              onDragOver={workspaceDrag === null
                ? undefined
                : (e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  hoverWorkspace(workspaceGroupHalf(e))
                }}
              onDrop={workspaceDrag === null
                ? undefined
                : (e) => {
                  e.preventDefault()
                  dropWorkspace(workspaceGroupHalf(e))
                }}
            >
              <ProjectRowItem
                group={group}
                home={home}
                onToggle={() => {
                  if (group.expanded) {
                    setExpandedSessionGroups(keys => keys.filter(key => key !== group.key))
                  }
                  viewActions.setGroupExpanded(group.key, !group.expanded)
                }}
                onCreate={() => {
                  viewActions.setGroupExpanded(group.key, true)
                  onNewSession(group.key)
                }}
                drag={workspaceDragProps}
                actions={{
                  pick: () => { onWorkspacePick(group.key) },
                  setDefault: () => { onWorkspaceDefault(group.key) },
                  forget: () => { onWorkspaceForget(group.key) },
                }}
              />
              {(sessionsExpanded ? group.sessions : collapsed.rows).length > 0
                && rowSections(sessionsExpanded ? group.sessions : collapsed.rows)
                  .flatMap(section => [
                    ...(section.label === undefined ? [] : [
                      <div
                        key={`${group.key}:section:${section.label}`}
                        className={css.rowGroupLabel}
                        aria-hidden="true"
                      >
                        {section.label}
                      </div>,
                    ]),
                    ...section.rows.map((node) => {
                      const sameGroupDrag = drag !== null && drag.accountKey === group.key
                      const dragProps = orderBy !== 'manual' ? undefined : {
                        start: () => {
                          sessionDropCommitted.current = false
                          setDrag({ accountKey: group.key, sessionId: node.id, over: null })
                        },
                        active: sameGroupDrag,
                        marker: sameGroupDrag && drag.over?.id === node.id ? drag.over.half : null,
                        hover: (half: 'before' | 'after') => {
                          setDrag(d => (d === null ? d : { ...d, over: { id: node.id, half } }))
                        },
                        drop: (half: 'before' | 'after') => {
                          if (drag === null) return
                          commitSessionDrag(drag, { id: node.id, half })
                        },
                        end: () => {
                          if (drag?.over !== null && drag?.over !== undefined) commitSessionDrag(drag, drag.over)
                          else setDrag(null)
                          sessionDropCommitted.current = false
                        },
                      }
                      return (
                        <SessionNodeItem
                          key={node.id}
                          node={node}
                          currentId={currentId ?? undefined}
                          now={now}
                          onOpen={openNode}
                          onRename={onSessionRename}
                          onReveal={node.id === revealSessionId && group.key === revealGroup
                            ? () => { onSessionRevealed(node.id) }
                            : undefined}
                          onFork={onSessionFork}
                          onArchive={onSessionArchive}
                          drag={dragProps}
                        />
                      )
                    }),
                  ])}
              {collapsed.hiddenCount > 0 && (
                <button
                  type="button"
                  className={css.sessionOverflowButton}
                  aria-expanded={sessionsExpanded}
                  onClick={() => { setExpandedSessionGroups(keys => toggled(keys, group.key)) }}
                >
                  {sessionsExpanded ? '收起' : `展开其余 ${collapsed.hiddenCount} 条`}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <span className={css.fade} />
    </div>
  )
}

/** The flat "In one list" body: every session is one draggable top-level row. */
function FlatList(props: TreeBodyProps) {
  const {
    live, stored, currentId, orderBy, sessionOrderByAccount,
    revealSessionId, onSessionRevealed, openNode,
    onSessionRename, onSessionFork, onSessionArchive,
  } = props
  const orderAccounts = orderBy === 'manual' ? sessionOrderByAccount : {}
  const rows = useMemo(
    () => deriveFlat(live, stored, orderAccounts),
    [live, stored, orderAccounts],
  )
  const [drag, setDrag] = useState<DragState | null>(null)
  const dropCommitted = useRef(false)
  useNativeDragAcceptance(drag !== null)

  const commitDrag = (activeDrag: DragState, over: NonNullable<DragState['over']>): void => {
    if (dropCommitted.current) return
    dropCommitted.current = true
    setDrag(null)
    const targetIndex = rows.findIndex(row => row.id === over.id)
    if (targetIndex === -1) return
    const anchor = over.half === 'before' ? over.id : rows[targetIndex + 1]?.id
    if (anchor === activeDrag.sessionId) return
    const sourceIndex = rows.findIndex(row => row.id === activeDrag.sessionId)
    const anchorIndex = anchor === undefined ? rows.length : rows.findIndex(row => row.id === anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    const nextOrder = rows.map(row => row.id).filter(id => id !== activeDrag.sessionId)
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId)
    viewActions.setSessionOrder(FLAT_SESSION_ORDER_KEY, nextOrder)
  }

  const now = Date.now()
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={clsx(css.list, css.flatList)} role="tree" aria-label="会话">
        {rows.length === 0 && (
          <div className={css.empty}>暂无会话</div>
        )}
        {rows.length > 0 && rowSections(rows)
          .flatMap(section => [
            ...(section.label === undefined ? [] : [
              <div
                key={`section:${section.label}`}
                className={css.rowGroupLabel}
                aria-hidden="true"
              >
                {section.label}
              </div>,
            ]),
            ...section.rows.map((node) => {
              const active = drag !== null
              return (
                <SessionNodeItem
                  key={node.id}
                  node={node}
                  currentId={currentId ?? undefined}
                  now={now}
                  onOpen={openNode}
                  onRename={onSessionRename}
                  onFork={onSessionFork}
                  onArchive={onSessionArchive}
                  onReveal={node.id === revealSessionId
                    ? () => { onSessionRevealed(node.id) }
                    : undefined}
                  flat
                  drag={orderBy !== 'manual' ? undefined : {
                    start: () => {
                      dropCommitted.current = false
                      setDrag({ accountKey: FLAT_SESSION_ORDER_KEY, sessionId: node.id, over: null })
                    },
                    active,
                    marker: active && drag.over?.id === node.id ? drag.over.half : null,
                    hover: (half) => {
                      setDrag(current => current === null ? current : { ...current, over: { id: node.id, half } })
                    },
                    drop: (half) => {
                      if (drag !== null) commitDrag(drag, { id: node.id, half })
                    },
                    end: () => {
                      if (drag?.over !== null && drag?.over !== undefined) commitDrag(drag, drag.over)
                      else setDrag(null)
                      dropCommitted.current = false
                    },
                  }}
                />
              )
            }),
          ])}
      </div>
      <span className={css.fade} />
    </div>
  )
}

/** The flat search body: local metadata matches across both session kinds. */
function SearchResults({ query, workspaces, live, stored, currentId, openResult }: {
  query: string
  workspaces: readonly WorkspaceItem[]
  live: readonly SessionSummary[]
  stored: readonly StoredSession[]
  currentId: string | null
  openResult: (node: SessionNode | { id: string; kind: 'live' | 'stored' }) => void
}) {
  const results = useMemo(
    () => deriveSearchResults(workspaces, live, stored, query),
    [workspaces, live, stored, query],
  )
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={css.list}>
        <div className={css.searchTree} role="tree" aria-label="搜索结果">
          {results.map(result => (
            <SearchResultItem
              key={`${result.kind}:${result.id}`}
              result={result}
              currentId={currentId ?? undefined}
              onOpen={openResult}
            />
          ))}
        </div>
        {results.length === 0 && (
          <div className={css.empty}>没有匹配的会话</div>
        )}
      </div>
      <span className={css.fade} />
    </div>
  )
}

/** The browsing region's props: raw session data plus pi-webx action callbacks. */
export interface WorkspaceBrowserProps {
  wide: boolean
  expandSidebar: () => void
  home?: string | undefined
  workspaces: readonly WorkspaceItem[]
  live: readonly SessionSummary[]
  stored: readonly StoredSession[]
  currentId: string | null
  onSwitch: (id: string) => void
  onNewSession: (cwd: string) => void
  onRename: (id: string, name: string) => void
  /** Open a stored transcript, loading it into a hosted session. */
  onResume: (session: StoredSession) => void
  /** dsh's `分叉会话`: copy the session into a new transcript and open it. */
  onFork: (node: SessionNode) => void
  onPickWorkspace: (path: string) => void
  onSetDefault: (path: string) => void
  onForgetWorkspace: (path: string) => void
  onBrowseWorkspace: () => void
}

/**
 * Render the browsing region.
 * @param props - shell owner share + raw session data + pi-webx actions.
 * @returns the region element tree.
 */
export function WorkspaceBrowser({
  wide,
  expandSidebar,
  home,
  workspaces,
  live,
  stored,
  currentId,
  onSwitch,
  onNewSession,
  onRename,
  onResume,
  onFork,
  onPickWorkspace,
  onSetDefault,
  onForgetWorkspace,
  onBrowseWorkspace,
}: WorkspaceBrowserProps) {
  const groupBy = useWorkspaceView(s => s.groupBy)
  const orderBy = useWorkspaceView(s => s.orderBy)
  const groupExpansion = useWorkspaceView(s => s.groupExpansion)
  const sessionOrderByAccount = useWorkspaceView(s => s.sessionOrderByAccount)
  const workspaceOrder = useWorkspaceView(s => s.workspaceOrder)
  const archivedSessions = useWorkspaceView(s => s.archivedSessions)
  const archivedSet = useMemo(() => new Set(archivedSessions), [archivedSessions])
  /**
   * dsh's `归档会话`: hide the row; the transcript on disk is never touched.
   *
   * A resumed conversation is a live row *and* the transcript it is writing to,
   * so hiding the live row alone would just reveal its history row under another
   * id — the archive would look like it did nothing. Both ids go: the log
   * outlives the hiding either way, which is the archive contract.
   */
  const archiveSession = (node: SessionNode): void => {
    viewActions.archiveSession(node.id)
    const hostedFile = node.kind === 'live' ? node.live?.sessionFile ?? null : null
    if (hostedFile === null) return
    if (stored.some(session => session.path === hostedFile)) {
      viewActions.archiveSession(`stored:${hostedFile}`)
    }
  }
  /**
   * Archived rows leave here, before derivation: one filtering point means the
   * groups, the per-workspace counts and the search results all agree without
   * each re-checking the set. dsh hides an archived session from "every grouping
   * surface" the same way.
   *
   * A transcript a live session is hosting is dropped inside derivation instead
   * (see tree.ts): telling those two rows apart needs both lists, and the live
   * row is the one standing for the open conversation.
   */
  const visibleLive = useMemo(
    () => live.filter(session => !archivedSet.has(session.id)),
    [archivedSet, live],
  )
  const visibleStored = useMemo(
    () => stored.filter(session => !archivedSet.has(`stored:${session.path}`)),
    [archivedSet, stored],
  )

  // Manual workspace order (drag) reconciled with the owner's list: stored
  // order leads, workspaces the store does not know yet append in arrival order.
  const orderedWorkspaces = useMemo(() => {
    if (workspaceOrder.length === 0) return workspaces
    const byKey = new Map(workspaces.map(workspace => [workspace.key, workspace]))
    const ordered: WorkspaceItem[] = []
    for (const key of workspaceOrder) {
      const workspace = byKey.get(key)
      if (workspace !== undefined) ordered.push(workspace)
    }
    const included = new Set(ordered.map(workspace => workspace.key))
    for (const workspace of workspaces) {
      if (!included.has(workspace.key)) ordered.push(workspace)
    }
    return ordered
  }, [workspaces, workspaceOrder])

  // The query outlives the tree and the input (both wide-only) so collapsing
  // does not silently drop an in-progress filter.
  const [query, setQuery] = useState('')
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [revealSessionId, setRevealSessionId] = useState<string | undefined>(undefined)
  const normalizedQuery = sanitizeSearchQuery(query).trim()
  const searchRoot = useRef<HTMLDivElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const composingRef = useRef(false)

  const openNode = (node: SessionNode | { id: string; kind: 'live' | 'stored' }): void => {
    if (node.kind === 'live') {
      onSwitch(node.id)
      return
    }
    const full = 'stored' in node && node.stored !== undefined
      ? node.stored
      : stored.find(session => `stored:${session.path}` === node.id)
    if (full !== undefined) onResume(full)
  }

  const openSearchResult = (node: { id: string; kind: 'live' | 'stored' }): void => {
    setRevealSessionId(node.id)
    setQuery('')
    setSearchExpanded(false)
    openNode(node)
  }
  const acknowledgeSessionReveal = (sessionId: string): void => {
    setRevealSessionId(current => current === sessionId ? undefined : current)
  }
  useEffect(() => {
    if (normalizedQuery !== '') setRevealSessionId(undefined)
  }, [normalizedQuery])

  // Rail search = expand + land in the search box: the flag arms before the
  // expand request; once the shell flips wide the input mounts and takes focus.
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (wide && searchOnExpand) {
      const timer = window.setTimeout(() => {
        searchInput.current?.focus({ preventScroll: true })
        setSearchOnExpand(false)
      }, EXPAND_SLIDE_MS)
      return () => { window.clearTimeout(timer) }
    }
  }, [wide, searchOnExpand])

  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return
    searchInput.current?.focus({ preventScroll: true })
  }, [wide, searchExpanded, searchOnExpand])

  // Outside-click dismissal stays off while the rail gesture is in flight
  // (searchOnExpand): the rail click flips the shell wide and mounts this
  // listener during its own dispatch, then keeps bubbling to document with
  // the now-unmounted rail button as its target — outside searchRoot, so the
  // listener would dismiss the search that click just opened.
  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return
      searchInput.current?.blur()
      if (normalizedQuery !== '') return
      setSearchExpanded(false)
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, [normalizedQuery, wide, searchExpanded, searchOnExpand])

  // Session rename dialog (browser-owned so it outlives row unmounts). Unlike
  // workspace rename in dsh, an unchanged title is NOT blocked: confirming the
  // current automatic title is the gesture that pins it.
  const [sessionRenameTarget, setSessionRenameTarget] = useState<{ sessionId: string; currentTitle: string } | null>(null)
  const [sessionRenameDraft, setSessionRenameDraft] = useState('')
  const [sessionRenaming, setSessionRenaming] = useState(false)
  const sessionRenameTrimmed = sessionRenameDraft.trim()
  const sessionRenameBlocked = sessionRenaming || sessionRenameTrimmed === '' || sessionRenameTarget === null
  const closeSessionRename = () => {
    if (sessionRenaming) return
    setSessionRenameTarget(null)
  }
  const confirmSessionRename = () => {
    if (sessionRenameBlocked || sessionRenameTarget === null) return
    setSessionRenaming(true)
    Promise.resolve(onRename(sessionRenameTarget.sessionId, sessionRenameTrimmed))
      .then(() => {
        setSessionRenaming(false)
        setSessionRenameTarget(null)
      })
      .catch(() => {
        setSessionRenaming(false)
      })
  }
  const onSessionRename = (sessionId: string, currentTitle: string) => {
    setSessionRenameTarget({ sessionId, currentTitle })
    setSessionRenameDraft(currentTitle)
  }

  // Kill confirmation (browser-owned): ending a live session aborts whatever
  // it is running, so — unlike dsh's dialog-free archive — this asks first.

  // Delete-from-disk confirmation: the transcript file goes away permanently.

  const treeProps: TreeBodyProps = {
    workspaces: orderedWorkspaces,
    live: visibleLive,
    stored: visibleStored,
    currentId,
    home,
    orderBy,
    groupExpansion,
    sessionOrderByAccount,
    revealSessionId,
    onSessionRevealed: acknowledgeSessionReveal,
    openNode,
    onSessionRename,
    onSessionFork: onFork,
    onSessionArchive: archiveSession,
    onWorkspacePick: onPickWorkspace,
    onWorkspaceDefault: onSetDefault,
    onWorkspaceForget: onForgetWorkspace,
    onNewSession,
  }

  return (
    <div className={clsx(css.root, !wide && css.rail)}>
      <div className={css.sectionHeader}>
        {wide && (
          <span className={clsx(css.sectionLabel, css.wide, searchExpanded && css.sectionLabelHidden)}>
            {groupBy === 'flat' ? '会话' : '工作区'}
          </span>
        )}
        {wide && (
          <div className={clsx(css.searchSlot, searchExpanded && css.searchSlotExpanded)}>
            <div
              ref={searchRoot}
              className={clsx(css.search, searchExpanded && css.searchExpanded)}
              onClick={() => {
                setSearchExpanded(true)
                searchInput.current?.focus()
              }}
            >
              <Tooltip label="搜索" side="bottom" delayMs={500} disabled={searchExpanded}>
                <button
                  type="button"
                  className={css.searchButton}
                  aria-label="搜索会话"
                  aria-expanded={searchExpanded}
                  onClick={() => {
                    setSearchExpanded(true)
                  }}
                >
                  <IconSearchOutline16 size={searchExpanded ? 11 : 14} />
                </button>
              </Tooltip>
              <input
                ref={searchInput}
                className={css.searchInput}
                type="text"
                placeholder="搜索会话"
                maxLength={SEARCH_QUERY_MAX_CODE_UNITS}
                value={query}
                tabIndex={searchExpanded ? 0 : -1}
                onChange={(e) => { setQuery(sanitizeSearchQuery(e.target.value)) }}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  setQuery('')
                  setSearchExpanded(false)
                }}
              />
              {searchExpanded && (
                <button
                  type="button"
                  className={css.clearButton}
                  aria-label="清除搜索"
                  onClick={(e) => {
                    e.stopPropagation()
                    setQuery('')
                    setSearchExpanded(false)
                  }}
                >
                  <IconCloseFill14 />
                </button>
              )}
            </div>
          </div>
        )}
        <div className={clsx(css.headerActions, wide && searchExpanded && css.headerActionsHidden)}>
          {wide && (
            <ViewOptionsMenu
              groupBy={groupBy}
              orderBy={orderBy}
              onGroupPick={(mode) => { viewActions.setGroupBy(mode) }}
              onOrderPick={(mode) => { viewActions.setOrderBy(mode) }}
            />
          )}
          <Tooltip label="添加工作区" side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.iconButton}
              aria-label="添加工作区"
              onClick={() => {
                onBrowseWorkspace()
              }}
            >
              <IconProjectAddOutline16 size={wide ? 16 : 18} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* The collapsed rail keeps search as its own 36px control. */}
      {!wide && <div className={css.search}>
        <Tooltip label="搜索">
          <button
            type="button"
            className={css.searchButton}
            aria-label="搜索会话"
            onClick={() => {
              setSearchExpanded(true)
              setSearchOnExpand(true)
              expandSidebar()
            }}
          >
            <IconSearchOutline16 size={18} />
          </button>
        </Tooltip>
      </div>}

      {/* Always-mounted seat keeps the region's flex slot while the list
          itself is wide-only. */}
      <div className={css.listArea}>
        {wide && (normalizedQuery !== ''
          ? (
            <SearchResults
              query={normalizedQuery}
              workspaces={orderedWorkspaces}
              live={live}
              stored={stored}
              currentId={currentId}
              openResult={openSearchResult}
            />
          )
          : groupBy === 'flat'
            ? <FlatList {...treeProps} />
            : <SessionTree {...treeProps} />)}
      </div>

      <Modal
        open={sessionRenameTarget !== null}
        onClose={closeSessionRename}
        closeLabel="关闭"
        title="重命名会话"
        footer={(
          <>
            <Button variant="outline" disabled={sessionRenaming} onClick={closeSessionRename}>取消</Button>
            <Button variant="primary" disabled={sessionRenameBlocked} onClick={confirmSessionRename}>重命名</Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={sessionRenameDraft}
          aria-label="会话名称"
          autoFocus
          disabled={sessionRenaming}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setSessionRenameDraft(e.target.value) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmSessionRename()
            }
          }}
        />
      </Modal>
    </div>
  )
}
