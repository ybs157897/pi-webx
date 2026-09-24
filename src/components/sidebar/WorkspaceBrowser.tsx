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
 *
 * The list bodies and the small chrome parts live next door —
 * `SessionTree.tsx` (grouped), `SessionFlatList.tsx` (one list),
 * `SessionSearchResults.tsx` (search), and `WorkspaceBrowserParts.tsx` — while
 * this file owns the region chrome, its state and its dialogs.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SessionSummary, StoredSession } from '../../shared/protocol'
import {
  IconCloseFill14,
  IconProjectAddOutline16,
  IconSearchOutline16,
  Tooltip,
} from '../../ui/primitives/index.ts'
import type { SessionNode, WorkspaceItem } from './tree.ts'
import { useWorkspaceView, viewActions } from './stores.ts'
import { useCompletionUnread } from './completion.ts'
import {
  SessionRenameDialog,
  ViewOptionsMenu,
  useSessionRename,
} from './WorkspaceBrowserParts.tsx'
import { SessionTree } from './SessionTree.tsx'
import { SessionFlatList } from './SessionFlatList.tsx'
import { SessionSearchResults } from './SessionSearchResults.tsx'
import type { TreeBodyProps } from './workspace-browser-utils.ts'
import {
  EXPAND_SLIDE_MS,
  SEARCH_QUERY_MAX_CODE_UNITS,
  sanitizeSearchQuery,
} from './workspace-browser-utils.ts'
import css from './WorkspaceBrowser.module.css'

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
  /**
   * The green "finished while you were elsewhere" reminder (dsh's
   * `completionUnread`). Tracked from the raw live list — not the archived-filtered
   * one — so hiding a row cannot silently drop the fact that it finished; the
   * filter below only decides whether a row is drawn.
   */
  const completed = useCompletionUnread(live, currentId)
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

  // Session rename dialog (browser-owned so it outlives row unmounts); see
  // `useSessionRename` for the state machine and the dialog part next door.

  // Kill confirmation (browser-owned): ending a live session aborts whatever
  // it is running, so — unlike dsh's dialog-free archive — this asks first.

  // Delete-from-disk confirmation: the transcript file goes away permanently.

  const rename = useSessionRename(onRename)

  const treeProps: TreeBodyProps = {
    workspaces: orderedWorkspaces,
    live: visibleLive,
    stored: visibleStored,
    currentId,
    home,
    orderBy,
    groupExpansion,
    sessionOrderByAccount,
    completed,
    revealSessionId,
    onSessionRevealed: acknowledgeSessionReveal,
    openNode,
    onSessionRename: rename.open,
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
            <SessionSearchResults
              query={normalizedQuery}
              workspaces={orderedWorkspaces}
              live={live}
              stored={stored}
              currentId={currentId}
              completed={completed}
              openResult={openSearchResult}
            />
          )
          : groupBy === 'flat'
            ? <SessionFlatList {...treeProps} />
            : <SessionTree {...treeProps} />)}
      </div>

      <SessionRenameDialog
        open={rename.target !== null}
        draft={rename.draft}
        renaming={rename.renaming}
        blocked={rename.blocked}
        onDraftChange={rename.setDraft}
        onClose={rename.close}
        onConfirm={rename.confirm}
      />
    </div>
  )
}
