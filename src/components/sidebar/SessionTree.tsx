/**
 * The grouped session tree body of the workspace browser: one section per
 * workspace, its rows folded behind the local overflow control, and the
 * manual drag order persisted into the view store.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { deriveGroups } from './tree.ts'
import { viewActions } from './stores.ts'
import { ProjectRowItem, SessionNodeItem } from './Rows.tsx'
import { useNativeDragAcceptance } from './WorkspaceBrowserParts.tsx'
import type { DragState, TreeBodyProps, WorkspaceDragState } from './workspace-browser-utils.ts'
import { collapsedSessionRows, rowSections, toggled, workspaceGroupHalf } from './workspace-browser-utils.ts'
import css from './WorkspaceBrowser.module.css'

/** The scrolling session tree; manual drag order persists into the view store. */
export function SessionTree(props: TreeBodyProps) {
  const {
    workspaces, live, stored, currentId, home, orderBy, groupExpansion, sessionOrderByAccount,
    completed, revealSessionId, onSessionRevealed, openNode,
    onSessionRename, onSessionFork, onSessionArchive,
    onWorkspacePick, onWorkspaceDefault, onWorkspaceForget, onNewSession,
  } = props
  const orderAccounts = orderBy === 'manual' ? sessionOrderByAccount : {}
  const groups = useMemo(
    () => deriveGroups(workspaces, live, stored, currentId, groupExpansion, orderAccounts, completed),
    [workspaces, live, stored, currentId, groupExpansion, orderAccounts, completed],
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
