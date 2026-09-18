/**
 * The workspace browser's persisted viewing state: grouping mode, ordering
 * mode, per-group expansion, and the manual drag orders — kept in localStorage
 * exactly like deepseek-harness's `dsh.workspace.view.*` store, but backed by
 * a tiny module-level observable so the browser stays self-contained.
 */
import { useSyncExternalStore } from 'react'

export interface WorkspaceViewState {
  /** grouped by workspace, or one flat list */
  groupBy: 'workspace' | 'flat'
  /** manual = drag order; updated = recency */
  orderBy: 'manual' | 'updated'
  /** workspace path → expanded; absent means "follow isCurrent" */
  groupExpansion: Record<string, boolean>
  /** account key (workspace path, or FLAT_SESSION_ORDER_KEY) → row ids in drag order */
  sessionOrderByAccount: Record<string, readonly string[]>
  /** workspace paths in manual drag order (unknown workspaces append by recency of arrival) */
  workspaceOrder: readonly string[]
  /**
   * Row ids hidden from every list surface — dsh's archive set, whose contract is
   * "a hidden session keeps its history and its place, but no unarchive action
   * exists yet". Non-destructive: the transcript on disk is never touched, which
   * is why archiving replaced the delete entry in the row menu.
   */
  archivedSessions: readonly string[]
}

const STORAGE_KEY = 'pi-webx.workspace.view.v1'

const DEFAULT_STATE: WorkspaceViewState = {
  groupBy: 'workspace',
  orderBy: 'manual',
  groupExpansion: {},
  sessionOrderByAccount: {},
  workspaceOrder: [],
  archivedSessions: [],
}

function loadState(): WorkspaceViewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_STATE
    const parsed = JSON.parse(raw) as Partial<WorkspaceViewState>
    return {
      groupBy: parsed.groupBy === 'flat' ? 'flat' : 'workspace',
      orderBy: parsed.orderBy === 'updated' ? 'updated' : 'manual',
      groupExpansion: isRecord(parsed.groupExpansion) ? parsed.groupExpansion : {},
      archivedSessions: Array.isArray(parsed.archivedSessions)
        ? parsed.archivedSessions.filter((id): id is string => typeof id === 'string')
        : [],
      sessionOrderByAccount: isRecord(parsed.sessionOrderByAccount)
        ? parsed.sessionOrderByAccount
        : {},
      workspaceOrder: Array.isArray(parsed.workspaceOrder) ? parsed.workspaceOrder : [],
    }
  } catch {
    return DEFAULT_STATE
  }
}

function isRecord(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let state: WorkspaceViewState = loadState()
const listeners = new Set<() => void>()

function setState(next: WorkspaceViewState): void {
  state = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // persistence is best-effort; the in-memory store still works
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The viewing-state hook: re-renders the subscriber on every action. */
export function useWorkspaceView<T>(select: (state: WorkspaceViewState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state))
}

/** Immutable updates, one per viewing concern (mirrors the dsh store's actions). */
export const viewActions = {
  setGroupBy(groupBy: WorkspaceViewState['groupBy']): void {
    setState({ ...state, groupBy })
  },
  setOrderBy(orderBy: WorkspaceViewState['orderBy']): void {
    setState({ ...state, orderBy })
  },
  setGroupExpanded(key: string, expanded: boolean): void {
    setState({ ...state, groupExpansion: { ...state.groupExpansion, [key]: expanded } })
  },
  setSessionOrder(accountKey: string, order: readonly string[]): void {
    setState({
      ...state,
      sessionOrderByAccount: { ...state.sessionOrderByAccount, [accountKey]: order },
    })
  },
  setWorkspaceOrder(order: readonly string[]): void {
    setState({ ...state, workspaceOrder: order })
  },
  archiveSession(id: string): void {
    if (state.archivedSessions.includes(id)) return
    setState({ ...state, archivedSessions: [...state.archivedSessions, id] })
  },
}
