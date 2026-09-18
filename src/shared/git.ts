/**
 * The git surface: which branch a workspace is on, and switching it.
 *
 * pi itself only *reports* a branch — its TUI footer prints `cwd (branch)` from
 * `FooterDataProvider`, and nothing in the agent switches branches. Branch
 * switching is therefore a pi-webx capability, and it runs the user's own `git`
 * on the workspace the session is about to work in.
 *
 * The shape stays deliberately narrow: the current branch, the local branches
 * that can be switched to, and nothing else. No commits, no diffs, no remote
 * branches — the agent is the one that writes code, and this control exists so
 * the human can put it on the right branch first.
 */

export interface GitBranchView {
  /** absolute path this answer is about */
  cwd: string;
  /** false when the path is not inside a git work tree */
  repo: boolean;
  /** the checked-out branch, or `null` while detached (see `head`) */
  branch: string | null;
  /** short commit sha, present only when HEAD is detached */
  head?: string;
  /** local branches, the current one first; empty outside a repo */
  branches: string[];
}

export interface GitCheckoutRequest {
  cwd: string;
  branch: string;
}
