/**
 * The session's working directory, for the surfaces that label a call with it.
 *
 * The terminal card prints the directory a shell call ran in as its prompt
 * label (`pi-webx $ …`). That value belongs to the SESSION, not to a transcript
 * entry: pi's bash carries no `workdir` argument and always runs in the session
 * directory, and the transcript does not record one per call. It lives in
 * `App`'s state four components above the card, and the transcript's render path
 * branches (a step inside an assistant message, a standalone tool result, the
 * collapsed-turn body) would each have to forward an unrelated prop. So it
 * travels by context instead.
 */

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/** `null` until the host reports a directory; never the empty string. */
const SessionCwdContext = createContext<string | null>(null);

export function SessionCwdProvider({ cwd, children }: { cwd: string | null; children: ReactNode }) {
  return <SessionCwdContext.Provider value={cwd}>{children}</SessionCwdContext.Provider>;
}

/**
 * The session's working directory, or null when the host has not reported one.
 * @returns the absolute directory path, or null.
 */
export function useSessionCwd(): string | null {
  return useContext(SessionCwdContext);
}
