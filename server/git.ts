/**
 * Reading and switching the git branch of a workspace.
 *
 * `git` runs as a child process with an argument array — never a shell — so a
 * branch name can only ever be read as an argument. A name is additionally
 * checked against the repository's own local branches before it is passed to
 * `checkout`, which is what keeps `-`, `--orphan` and ref expressions out of
 * the argument position entirely.
 *
 * pi's own `FooterDataProvider` reports a branch (`getGitBranch()`, and it
 * handles worktrees and reftable), but it is built for the TUI footer's live
 * watch loop: one instance per cwd, holding fs watchers and a refresh timer. A
 * request-scoped read does not want that lifecycle, and the two questions this
 * feature asks — "which branch?" and "which branches exist?" — are one `git`
 * call each.
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';

import type { GitBranchView } from '../src/shared/git';

/** A git call that outlives this is hung, not slow: every one should be local. */
const GIT_TIMEOUT_MS = 15_000;
/** Branch lists are small; a runaway output is a bug, not a directory of refs. */
const GIT_MAX_OUTPUT = 1_000_000;

/** A request that cannot be answered; `status` is what the route answers with. */
export class GitError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitError';
    this.status = status;
  }
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        // A non-zero exit is git answering "no" (not a repo, no such branch,
        // dirty tree); a spawn failure is the bridge failing. Only the first
        // is an answer.
        const failure = error as NodeJS.ErrnoException & { code?: string | number };
        if (typeof failure.code === 'string' && failure.code !== 'ENOENT') {
          resolve({ ok: false, stdout, stderr });
          return;
        }
        if (typeof failure.code === 'number') {
          resolve({ ok: false, stdout, stderr });
          return;
        }
        reject(
          failure.code === 'ENOENT'
            ? new GitError(500, '找不到 git 可执行文件')
            : new GitError(500, stderr.trim() || error.message),
        );
      },
    );
  });
}

/** git's own first line of complaint, which is the useful half of stderr. */
function gitMessage(result: GitResult, fallback: string): string {
  const text = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(error|fatal|warning):\s*/u, ''));
  return text[0] ?? fallback;
}

/**
 * Validate the workspace path every git call is anchored to.
 *
 * The bridge is a local single-user tool, so this is not a containment rule —
 * it is the check that the path names a directory at all, which turns a typo
 * into "not found" instead of a confusing git error.
 */
async function assertWorkspace(cwd: string): Promise<string> {
  const target = cwd.trim();
  if (target.length === 0) throw new GitError(400, 'cwd 不能为空');
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new GitError(404, `目录不存在：${target}`);
  }
  if (!info.isDirectory()) throw new GitError(400, `不是目录：${target}`);
  return target;
}

/** Local branch names, current one first, the rest in git's own order. */
export async function readGitBranches(cwd: string): Promise<GitBranchView> {
  const workspace = await assertWorkspace(cwd);

  const inside = await git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { cwd: workspace, repo: false, branch: null, branches: [] };
  }

  // `symbolic-ref` fails on a detached HEAD, which is exactly when the short
  // sha is the answer the footer would print.
  const symbolic = await git(workspace, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = symbolic.ok ? symbolic.stdout.trim() || null : null;
  let head: string | undefined;
  if (branch === null) {
    const sha = await git(workspace, ['rev-parse', '--short', 'HEAD']);
    if (sha.ok) head = sha.stdout.trim() || undefined;
  }

  const refs = await git(workspace, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const names = refs.ok
    ? refs.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
  const ordered = branch !== null && names.includes(branch)
    ? [branch, ...names.filter((name) => name !== branch)]
    : names;

  return {
    cwd: workspace,
    repo: true,
    branch,
    ...(head === undefined ? {} : { head }),
    branches: ordered,
  };
}

/**
 * Switch the workspace to one of its local branches.
 *
 * The name is matched against the repository's branches first, so the argument
 * handed to `checkout` is always a name git itself just printed. A checkout git
 * refuses (uncommitted changes, a branch checked out in another worktree) comes
 * back as the 409 the user needs to read rather than a silent no-op.
 */
export async function checkoutBranch(cwd: string, branch: string): Promise<GitBranchView> {
  const workspace = await assertWorkspace(cwd);
  const wanted = branch.trim();
  if (wanted.length === 0) throw new GitError(400, 'branch 不能为空');

  const before = await readGitBranches(workspace);
  if (!before.repo) throw new GitError(409, `不是 git 仓库：${workspace}`);
  if (before.branch === wanted) return before;
  if (!before.branches.includes(wanted)) {
    throw new GitError(404, `本地没有分支：${wanted}`);
  }

  const result = await git(workspace, ['checkout', wanted]);
  if (!result.ok) {
    throw new GitError(409, gitMessage(result, `切换分支失败：${wanted}`));
  }
  return readGitBranches(workspace);
}
