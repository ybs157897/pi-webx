/**
 * The green "done" reminder: which sessions finished a run while the reader was
 * looking somewhere else.
 *
 * deepseek-harness models this as `completionUnread` in its session-status
 * service: `running` going true → false while the session is *not* the main view
 * leaves the row's green dot, and the dot goes away when the session is viewed
 * or started again. pi-webx has no status service and no push, so the equivalent
 * observation is made here, from the polled session list — the one place that
 * sees every live session rather than only the open one.
 *
 * Two rules keep this from repeating the bug it replaces (every row painted the
 * same green dot forever):
 *
 *   - a first sighting is *seeded*, never reported as a completion — otherwise
 *     a page load would mark every non-selected session as just finished;
 *   - the row being the open session clears its own reminder, which is exactly
 *     the click the reader makes to go look at it.
 *
 * The list is polled every few seconds, so a run that both starts and finishes
 * between two polls is not observed. That errs towards no dot, which is the
 * honest answer for a signal that means "there is something here you have not
 * seen": silence beats a decoration nobody can clear.
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../../shared/protocol'

/** Outcome of one pass over the live list. */
export interface CompletionPass {
  /** `streaming` per session as of this pass, to seed the next one. */
  running: ReadonlyMap<string, boolean>
  /** The reminder set after this pass. */
  unread: ReadonlySet<string>
  /** Whether `unread` differs from the set that came in. */
  changed: boolean
}

/**
 * Advance the reminder set by one observation of the live list.
 *
 * Pure, so the transition rules can be read (and tested) without React: the
 * caller keeps `running` between passes and passes the current `unread` in.
 *
 * @param running - `streaming` as of the previous pass; missing means unseen.
 * @param unread - the reminder set as it stands.
 * @param live - every live session the bridge reports, selected or not.
 * @param currentId - the open session, whose reminder is always clear.
 * @returns the next running snapshot and reminder set.
 */
export function observeCompletions(
  running: ReadonlyMap<string, boolean>,
  unread: ReadonlySet<string>,
  live: readonly SessionSummary[],
  currentId: string | null,
): CompletionPass {
  const nextRunning = new Map(running)
  const next = new Set(unread)
  const seen = new Set<string>()
  let changed = false

  for (const session of live) {
    seen.add(session.id)
    const previous = nextRunning.get(session.id)
    nextRunning.set(session.id, session.streaming)
    // Only an observed true → false is a completion; a first sighting is seeded.
    if (previous !== true || session.streaming || session.id === currentId) continue
    if (next.has(session.id)) continue
    next.add(session.id)
    changed = true
  }

  // Viewing the row is what clears the reminder.
  if (currentId !== null && next.delete(currentId)) changed = true
  // A session running again is not a finished reminder.
  for (const session of live) {
    if (session.streaming && next.delete(session.id)) changed = true
  }
  // Ids the bridge no longer reports must not keep a reminder alive.
  for (const id of [...next]) {
    if (seen.has(id)) continue
    next.delete(id)
    changed = true
  }

  return { running: nextRunning, unread: next, changed }
}

/**
 * Track the sessions whose last run finished away from the reader.
 *
 * @param live - every live session the bridge reports, selected or not.
 * @param currentId - the open session, whose reminder is always clear.
 * @returns the ids of the sessions that carry the finished-but-unread reminder.
 */
export function useCompletionUnread(
  live: readonly SessionSummary[],
  currentId: string | null,
): ReadonlySet<string> {
  /** `streaming` as of the previous pass; absent until a session is first seen. */
  const running = useRef<ReadonlyMap<string, boolean>>(new Map())
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const pass = observeCompletions(running.current, unread, live, currentId)
    running.current = pass.running
    // Re-entering with the already-advanced set reports no change, so this
    // settles in one extra pass instead of looping.
    if (pass.changed) setUnread(pass.unread)
  }, [currentId, live, unread])

  return unread
}
