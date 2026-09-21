/**
 * Workspace browser row components, ported from deepseek-harness's
 * `ui-workspace` Rows.tsx: pure presentational — all data and callbacks arrive
 * via props. Hover swaps (folder→chevron, time→ellipsis, action buttons) are
 * CSS-only, driven by the vendored Rows.module.css. pi-webx adaptations:
 * sessions come in two kinds (live / stored transcripts), workspaces are
 * directory paths without host metadata, and the row verbs are pi-webx's own
 * (rename/kill, resume/delete) instead of dsh's (rename/fork/archive).
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  HoverCard,
  IconArchiveOutline20,
  IconBranchOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconTrashOutline16,
  IconTriangleRightFill14,
  Menu,
  StateDot,
  relativeTime,
} from '../../ui/primitives/index.ts'
import type { GroupNode, SearchResultNode, SessionNode } from './tree.ts'
import { sessionShowsDot, sessionStatuses, shortenCwd } from './tree.ts'
import css from './Rows.module.css'

/* ------------------------------------------------------------- time labels */

/** Compact relative time for the row's trailing cell ("刚刚"/"5分钟"/"3小时"). */
export function timeLabel(updatedAt: number, now: number): string {
  const { unit, n } = relativeTime(updatedAt, now)
  switch (unit) {
    case 'now': return '刚刚'
    case 'minutes': return `${n}分钟`
    case 'hours': return `${n}小时`
    case 'days': return `${n}天`
    case 'months': return `${n}个月`
    case 'years': return `${n}年`
  }
}

/** Hover-card variant: distances wrap in the ago template. */
function hoverTimeLabel(updatedAt: number, now: number): string {
  const { unit, n } = relativeTime(updatedAt, now)
  switch (unit) {
    case 'now': return '刚刚'
    case 'minutes': return `${n} 分钟前`
    case 'hours': return `${n} 小时前`
    case 'days': return `${n} 天前`
    case 'months': return `${n} 个月前`
    case 'years': return `${n} 年前`
  }
}

/* --------------------------------------------------------------------- drag */

/**
 * Row drag wiring supplied by the tree owner. `drop` reports the half of the
 * row where the pointer released so the owner can resolve an insert anchor.
 */
export interface RowDragProps {
  /** Start dragging this row. */
  start: () => void
  /** A compatible row drag is in flight. */
  active: boolean
  /** Current marker on this row: insert line above, below, or none. */
  marker: 'before' | 'after' | null
  /** Report the hovered half while a compatible drag passes over this row. */
  hover: (half: 'before' | 'after') => void
  drop: (half: 'before' | 'after') => void
  end: () => void
}

/** Drag lifecycle owned by a workspace row; its enclosing group owns hit testing. */
interface WorkspaceRowDragProps {
  start: () => void
  end: () => void
}

/** Pointer-position half of a row (insert line above or below). */
function rowHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/* ------------------------------------------------------------- project row */

/** Hover-card body: workspace title and its full directory path. */
function WorkspaceHoverContent({ label, cwd }: { label: string; cwd: string | undefined }) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{label}</div>
      <div className={css.hoverPath}>{cwd}</div>
    </div>
  )
}

/**
 * Project (workspace) header row: folder + title; hover reveals the chevron
 * and the create/overflow actions, and dwelling shows the hover card.
 * `containsCurrent` arrives on the node (derivation fact, no renderer scan).
 */
export function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home }: {
  group: GroupNode
  onToggle: () => void
  onCreate: () => void
  /** Workspace actions (switch-current / set-default / forget). */
  actions?: {
    pick: () => void
    setDefault: () => void
    forget: () => void
  } | undefined
  /** Present only in the grouped view's manual mode. */
  drag?: WorkspaceRowDragProps | undefined
  home?: string | undefined
}) {
  const row = group
  const active = group.expanded && group.containsCurrent
  const [menuOpen, setMenuOpen] = useState(false)
  const workspaceMenuItems = [
    { id: 'pick', label: '设为当前工作区', icon: <IconFolderOpen16 />, disabled: group.isCurrent },
    { id: 'default', label: '设为默认工作区', icon: <IconCheckMarker />, disabled: group.isDefault },
    // The current workspace is the one a live session runs in, so the list never
    // subtracts it: saying so beats an item that looks enabled and does nothing.
    group.isCurrent
      ? { id: 'forget', label: '当前工作区不可移除', icon: <IconTrashOutline16 />, disabled: true }
      : { id: 'forget', label: '从列表移除', icon: <IconTrashOutline16 />, danger: true },
  ]
  const ownRow = (
    <div
      className={clsx(css.projectRow, menuOpen && css.menuOpen)}
      role="treeitem"
      aria-expanded={row.expanded}
      onClick={onToggle}
      draggable={drag !== undefined}
      onDragStart={drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', row.key)
          drag.start()
        }}
      onDragEnd={drag?.end}
    >
      <span className={clsx(css.slot, css.folder, active && css.folderActive)}>
        {row.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={clsx(css.slot, css.chevron)}>
        <IconTriangleRightFill14 className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
      </span>
      <span className={css.projectText}>
        <span className={css.title}>{row.label}</span>
      </span>
      <span className={css.rowActions}>
        {actions !== undefined && (
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={workspaceMenuItems}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'pick') actions.pick()
              else if (id === 'default') actions.setDefault()
              else if (id === 'forget') actions.forget()
            }}
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={`工作区「${row.label}」的更多操作`}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={`在「${row.label}」新建会话`}
          onClick={(e) => { e.stopPropagation(); onCreate() }}
        >
          <IconPlusOutline16 />
        </button>
      </span>
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      content={<WorkspaceHoverContent label={row.label} cwd={shortenCwd(row.cwd, home)} />}
      disabled={menuOpen}
      copyText={row.cwd}
      copyLabel="复制"
      copiedLabel="已复制"
    />
  )
}

/** Small check glyph for the default-workspace menu row (kept inline: no 16px check-with-star in the set). */
function IconCheckMarker() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.5l1.9 3.85 4.25.62-3.07 3 .72 4.24L8 11.29l-3.8 2-1.48 4.24.72-4.24L3 5.97l4.25-.62L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Pushpin glyph (kept inline: the vendored icon set has no pin). */
/* ------------------------------------------------------------- session row */

/** Hover-card body: full title, relative time, and every relevant live status. */
function SessionHoverContent({ node, now }: { node: SessionNode; now: number }) {
  const statuses = sessionStatuses(node)
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{node.title}</div>
      <div className={css.hoverTime}>{hoverTimeLabel(node.updatedAt, now)}</div>
      {statuses.map(status => (
        <div className={css.hoverStatus} key={status.label}>
          <StateDot state={status.state} />
          <span>{status.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * One top-level 32px session row: status slot, title, relative time, and the
 * row actions menu. Both kinds carry the same three verbs — rename, fork,
 * archive (see `sessionMenuItems`); opening a row switches to a live session or
 * resumes the stored transcript it stands for.
 *
 * The leading slot paints a dot only when the row has something to say — running,
 * waiting on the reader, or finished while the reader was elsewhere. An idle row
 * leaves the 16px slot empty (dsh's `showStatus`), and the flat list drops the
 * empty slot rather than indenting its titles for a mark that is not there.
 */
export function SessionNodeItem({
  node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false,
}: {
  node: SessionNode
  currentId: string | undefined
  now: number
  onOpen: (node: SessionNode) => void
  /** Open the browser-owned session rename dialog (row menu action). */
  onRename: (id: string, currentTitle: string) => void
  /**
   * Copy the session into a new transcript and open it — dsh's `分叉会话`. Offered
   * for a live session and a stored one alike, because both have a transcript to
   * copy; that is why the menu no longer branches on the row's kind.
   */
  onFork: (node: SessionNode) => void
  /** Hide the row from every list surface (dsh's `归档会话`). */
  onArchive: (node: SessionNode) => void
  /** Scroll this row into view after search navigation, then acknowledge it. */
  onReveal?: (() => void) | undefined
  /** Present only on draggable rows (grouped sessions outside search). */
  drag?: RowDragProps | undefined
  /** The row is rendered without a parent workspace header ("In one list"). */
  flat?: boolean | undefined
}) {
  const row = node
  const selected = node.kind === 'live' && node.id === currentId
  const statuses = sessionStatuses(node)
  const showStatus = sessionShowsDot(node)
  const [menuOpen, setMenuOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (onReveal === undefined) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
    onReveal()
  }, [onReveal])
  // dsh's row menu, verb for verb: rename, fork, archive. There is no delete and
  // no pin — a session's place in the list is its recency, and its transcript
  // outlives its membership in the list.
  const sessionMenuItems = [
    { id: 'rename', label: '重命名', icon: <IconEditOutline16 /> },
    { id: 'fork', label: '分叉会话', icon: <IconBranchOutline16 /> },
    { id: 'archive', label: '归档会话', icon: <IconArchiveOutline20 size={16} /> },
  ]
  const ownRow = (
    <div
      ref={rowRef}
      className={clsx(
        css.sessionRow, selected && css.selected, menuOpen && css.menuOpen,
        flat && !showStatus && css.flatSessionRowWithoutStatus,
        drag?.marker === 'before' && css.dropBefore, drag?.marker === 'after' && css.dropAfter,
      )}
      role="treeitem"
      aria-selected={selected}
      data-kind={node.kind}
      onClick={() => { onOpen(node) }}
      draggable={drag !== undefined}
      onDragStart={drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.id)
          drag.start()
        }}
      onDragEnd={drag?.end}
      onDragOver={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          drag.hover(rowHalf(e))
        }}
      onDrop={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          drag.drop(rowHalf(e))
        }}
    >
      {(!flat || showStatus) && (
        <span className={css.slot}>
          {showStatus && <StateDot state={statuses[0]?.state ?? 'idle'} />}
          {showStatus && statuses.map(status => (
            <span className={css.visuallyHidden} key={status.label}>{status.label}</span>
          ))}
        </span>
      )}
      <span className={css.title}>
        {node.title}
      </span>
      <span className={css.time}>{timeLabel(row.updatedAt, now)}</span>
      <span className={css.rowActions}>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={sessionMenuItems}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'rename') onRename(node.id, node.title)
            else if (id === 'fork') onFork(node)
            else if (id === 'archive') onArchive(node)
          }}
          portal
          closeOnPointerLeave
          anchor={(
            <button
              type="button"
              className={css.iconButton}
              aria-label={`会话「${node.title}」的更多操作`}
              onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
            >
              <IconEllipsisOutline16 />
            </button>
          )}
        />
      </span>
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      content={<SessionHoverContent node={node} now={now} />}
      disabled={menuOpen || drag?.active === true}
      copyText={node.title}
      copyLabel="复制"
      copiedLabel="已复制"
    />
  )
}

/* ------------------------------------------------------------- search row */

/** One flat search result: title plus its workspace context. */
export function SearchResultItem({ result, currentId, onOpen }: {
  result: SearchResultNode
  currentId: string | undefined
  onOpen: (result: SearchResultNode) => void
}) {
  const selected = result.kind === 'live' && result.id === currentId
  const statuses = sessionStatuses(result)
  const showStatus = sessionShowsDot(result)
  return (
    <button
      type="button"
      className={clsx(css.searchResultRow, selected && css.selected)}
      role="treeitem"
      aria-selected={selected}
      onClick={() => { onOpen(result) }}
    >
      <span className={css.searchResultHeading}>
        <span className={css.slot}>
          {/* Same rule as the tree row: a hit only carries a dot when it is
              running, waiting on the reader, or finished unread. */}
          {showStatus && <StateDot state={statuses[0]?.state ?? 'idle'} />}
          {showStatus && statuses.map(status => (
            <span className={css.visuallyHidden} key={status.label}>{status.label}</span>
          ))}
        </span>
        <span className={css.searchResultTitle}>{result.title}</span>
      </span>
      <span className={css.searchResultMeta}>
        <span className={css.searchResultWorkspace}>{result.workspace}</span>
      </span>
    </button>
  )
}
