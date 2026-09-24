/**
 * The flat "one list" body of the workspace browser: every session is one
 * draggable top-level row, and manual drag order persists into the view store
 * under the flat order account.
 */
import { useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { FLAT_SESSION_ORDER_KEY, deriveFlat } from './tree.ts'
import { viewActions } from './stores.ts'
import { SessionNodeItem } from './Rows.tsx'
import { useNativeDragAcceptance } from './WorkspaceBrowserParts.tsx'
import type { DragState, TreeBodyProps } from './workspace-browser-utils.ts'
import { rowSections } from './workspace-browser-utils.ts'
import css from './WorkspaceBrowser.module.css'

/** The flat "In one list" body: every session is one draggable top-level row. */
export function SessionFlatList(props: TreeBodyProps) {
  const {
    live, stored, currentId, orderBy, sessionOrderByAccount, completed,
    revealSessionId, onSessionRevealed, openNode,
    onSessionRename, onSessionFork, onSessionArchive,
  } = props
  const orderAccounts = orderBy === 'manual' ? sessionOrderByAccount : {}
  const rows = useMemo(
    () => deriveFlat(live, stored, orderAccounts, completed),
    [live, stored, orderAccounts, completed],
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
