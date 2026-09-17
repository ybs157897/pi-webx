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
  IconClockOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  IconTriangleRightFill14,
  Menu,
  StateDot,
  relativeTime,
} from '../../ui/primitives/index.ts'
import type { StateDotState } from '../../ui/primitives/index.ts'
import type { GroupNode, SearchResultNode, SessionNode } from './tree.ts'
import { shortenCwd } from './tree.ts'
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
    { id: 'forget', label: '从列表移除', icon: <IconTrashOutline16 />, danger: true },
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
function IconPinMarker({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.8 1.8l4.4 4.4-2 .8-2.2 2.2.5 3.2-1.3 1.3-2.7-2.7-3.2 3.2-.9-.9 3.2-3.2-2.7-2.7L4.6 6l3.2.5 2.2-2.2.8-2z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* ------------------------------------------------------------- session row */

interface SessionStatus {
  state: StateDotState
  label: string
}

/**
 * Session status presentation, adapted to pi-webx's facts: a streaming run is
 * primary; a dead process reads as exited; an idle live session and any stored
 * transcript carry no dot (their labels live in the hover card).
 */
function sessionStatuses(node: SessionNode): readonly SessionStatus[] {
  if (node.kind === 'stored') return [{ state: 'idle', label: '历史会话' }]
  if (node.running) return [{ state: 'ongoing', label: '正在执行' }]
  if (!node.alive) return [{ state: 'idle', label: '已结束' }]
  return [{ state: 'done', label: '空闲' }]
}

/** Whether the leading slot paints a status dot for this node. */
function showsStatusDot(node: SessionNode, statuses: readonly SessionStatus[]): boolean {
  if (node.kind === 'stored') return false
  if (node.running || !node.alive) return true
  return statuses[0]?.state === 'ongoing'
}

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
 * row actions menu. Live rows offer rename/kill; stored rows (a persisted
 * transcript, marked with a clock glyph) offer resume/delete.
 */
export function SessionNodeItem({
  node, currentId, now, onOpen, onRename, onKill, onResume, onDeleteStored, onReveal,
  pinned = false, onTogglePinned, drag, flat = false,
}: {
  node: SessionNode
  currentId: string | undefined
  now: number
  onOpen: (node: SessionNode) => void
  /** Open the browser-owned session rename dialog (row menu action). */
  onRename: (id: string, currentTitle: string) => void
  /** End a live session (row menu action; the confirm dialog is browser-owned). */
  onKill: (id: string, title: string) => void
  /** Resume a stored transcript (row menu action; same as opening it). */
  onResume: (node: SessionNode) => void
  /** Delete a stored transcript from disk (confirm dialog is browser-owned). */
  onDeleteStored: (node: SessionNode) => void
  /** Scroll this row into view after search navigation, then acknowledge it. */
  onReveal?: (() => void) | undefined
  /** The row is pinned and floats at the top of its list. */
  pinned?: boolean | undefined
  /** Toggle the pin (row menu action); absent rows hide the entry. */
  onTogglePinned?: (() => void) | undefined
  /** Present only on draggable rows (grouped sessions outside search). */
  drag?: RowDragProps | undefined
  /** The row is rendered without a parent Workspace header. */
  flat?: boolean | undefined
}) {
  const row = node
  const selected = node.kind === 'live' && node.id === currentId
  const statuses = sessionStatuses(node)
  const showStatus = showsStatusDot(node, statuses)
  const [menuOpen, setMenuOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (onReveal === undefined) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
    onReveal()
  }, [onReveal])
  const sessionMenuItems = [
    ...(onTogglePinned === undefined ? [] : [{
      id: 'pin',
      label: pinned ? '取消置顶' : '置顶',
      icon: <IconPinMarker size={16} />,
    }]),
    ...(node.kind === 'live'
      ? [
        { id: 'rename', label: '重命名', icon: <IconEditOutline16 /> },
        { id: 'kill', label: '结束会话', icon: <IconTrashOutline16 />, danger: true },
      ]
      : [
        { id: 'resume', label: '恢复会话', icon: <IconRefreshOutline16 /> },
        { id: 'delete', label: '从磁盘删除', icon: <IconTrashOutline16 />, danger: true },
      ]),
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
      <span className={css.slot}>
        {node.kind === 'stored'
          ? <IconClockOutline16 />
          : showStatus && <StateDot state={statuses[0]?.state ?? 'idle'} />}
      </span>
      <span className={css.title}>
        {node.title}
        {pinned && (
          <span
            aria-label="已置顶"
            style={{ display: 'inline-flex', flex: 'none', marginLeft: 6, color: 'var(--dsw-alias-label-tertiary)' }}
          >
            <IconPinMarker />
          </span>
        )}
      </span>
      <span className={css.time}>{timeLabel(row.updatedAt, now)}</span>
      <span className={css.rowActions}>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={sessionMenuItems}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'pin') onTogglePinned?.()
            else if (id === 'rename') onRename(node.id, node.title)
            else if (id === 'kill') onKill(node.id, node.title)
            else if (id === 'resume') onResume(node)
            else if (id === 'delete') onDeleteStored(node)
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
          {result.kind === 'stored'
            ? <IconClockOutline16 />
            : result.running && <StateDot state="ongoing" />}
        </span>
        <span className={css.searchResultTitle}>{result.title}</span>
      </span>
      <span className={css.searchResultMeta}>
        <span className={css.searchResultWorkspace}>{result.workspace}</span>
      </span>
    </button>
  )
}
