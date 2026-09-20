/**
 * A shell call as the terminal card's props — pi's own shape, not dsh's.
 *
 * dsh derives this card from a bash call whose args carry `description` and
 * `workdir`, and whose result ends in a `[exit code: N]` marker. pi's bash
 * carries neither arg and reports failures by THROWING: the tool result is an
 * error whose text is the command's output with pi's own status line appended
 * (`Command exited with code N`, `Command aborted`, `Command timed out after N
 * seconds` — see pi's `core/tools/bash.js` `appendStatus`). So the exit status
 * is parsed out of the error text instead of a result marker, and the two arg
 * fields have no counterpart: the command is the only arg, and the working
 * directory is the session's, since pi's bash always runs there.
 */

import type { ToolRun } from '../shared/transcript';

/** The tools whose expanded body is a terminal card. pi's Windows twin included. */
export const TERMINAL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell']);

/**
 * The card's row title, per dsh's localized `titleKey` — the row reads `Bash`,
 * not pi's lowercase tool id.
 * @param toolName - the pi tool id.
 * @returns the display title.
 */
export function terminalTitle(toolName: string): string {
  return toolName === 'powershell' ? 'PowerShell' : 'Bash';
}

/** The terminal card's props, derived from a run. */
export interface TerminalCard {
  /** The command line, rendered verbatim after the prompt label. */
  command: string;
  /** Working directory for the prompt label; the session's, when known. */
  cwd: string | undefined;
  /** The command's output, with pi's trailing status line removed. */
  output: string | undefined;
  /**
   * Settled exit code: `0` for a clean settle, the parsed code for a failure,
   * and `null` for a failure pi reported without one (aborted, timed out, or a
   * spawn error before any status line). `undefined` while the call is running.
   */
  exitCode: number | null | undefined;
  /** The command has not settled. */
  running: boolean;
}

/** pi's appended status line for a non-zero exit. */
const EXIT_MARKER = /(?:^|\n\n)Command exited with code (\d+)$/;

/** pi's appended status line for an abort or a timeout: a failure with no code. */
const STATUSLESS_FAILURE = /(?:^|\n\n)Command (?:aborted|timed out after \d+ seconds)$/;

/**
 * The shell command a call carries. pi's schema names it `command`; `script` is
 * the alias the row summary already accepts for the same field.
 * @param args - the call's arguments.
 * @returns the command, or null when the call carries none.
 */
function commandOf(args: Record<string, unknown>): string | null {
  const raw = args['command'] ?? args['script'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * Split pi's trailing status line off a failed call's output.
 *
 * A failed bash call's result text is `<output>\n\n<status line>`; the status
 * line is chrome pi wrote, not something the command printed, so it must not be
 * drawn as output (the status pill carries it instead). An error whose text
 * matches no known status line — a spawn failure, a bad argument — is returned
 * whole: it is the only explanation the reader gets.
 * @param output - the failed call's result text.
 * @returns the output without its status line, and the exit code when one was named.
 */
function splitFailure(output: string): { output: string; exitCode: number | null } {
  const exited = EXIT_MARKER.exec(output);
  if (exited !== null) {
    return { output: output.slice(0, exited.index), exitCode: Number(exited[1]) };
  }
  const statusless = STATUSLESS_FAILURE.exec(output);
  if (statusless !== null) {
    return { output: output.slice(0, statusless.index), exitCode: null };
  }
  return { output, exitCode: null };
}

/**
 * A settled exit status the host reported structurally, when it did.
 *
 * pi's bash TOOL reports a failure by throwing, so its exit status exists only
 * in the result text (see {@link splitFailure}). pi's own direct shell run — the
 * `bashExecution` record a session snapshot replays — instead carries `exitCode`
 * as a field, and the transcript keeps that record's structured fields on the
 * run's `details`, the same channel pi uses for a tool's own structured result.
 * A code found there wins: it is the executor's own number rather than one read
 * back out of prose. pi's bash tool never puts an `exitCode` in its details
 * (only truncation fields), so this cannot shadow the text path.
 * @param details - the run's structured details.
 * @returns the reported code, `null` when the host reported "no code", or
 *   `undefined` when the host reported nothing and the text must be read.
 */
function reportedExitCode(details: unknown): number | null | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const code = (details as Record<string, unknown>)['exitCode'];
  if (code === null) return null;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Derive the terminal card for a shell call, or null when the call is not one.
 *
 * Unlike the reference, this never falls back to a generic IN/OUT body: pi's
 * shell calls always carry a command, so a terminal card always exists for them,
 * and the generic path would only restate the command above the output.
 * @param run - the tool run to draw.
 * @param sessionCwd - the session's working directory, when the host reported one.
 * @returns the card's props, or null when the run is not a shell call.
 */
export function terminalCard(run: ToolRun, sessionCwd: string | null): TerminalCard | null {
  if (!TERMINAL_TOOLS.has(run.toolName)) return null;
  const command = commandOf(run.args);
  if (command === null) return null;

  const cwd = sessionCwd !== null && sessionCwd !== '' ? sessionCwd : undefined;
  if (run.status === 'running') {
    return { command, cwd, output: run.output === '' ? undefined : run.output, exitCode: undefined, running: true };
  }
  const output = run.output === '' ? undefined : run.output;
  const reported = reportedExitCode(run.details);
  if (reported !== undefined) {
    return { command, cwd, output, exitCode: reported, running: false };
  }
  if (run.status === 'error') {
    const failure = splitFailure(run.output);
    return {
      command,
      cwd,
      output: failure.output === '' ? undefined : failure.output,
      exitCode: failure.exitCode,
      running: false,
    };
  }
  return { command, cwd, output, exitCode: 0, running: false };
}
