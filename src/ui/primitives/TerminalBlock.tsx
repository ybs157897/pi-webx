// Vendored from deepseek-harness's `@deepseek-ai/dsh-client-ui-primitives`
// (`TerminalBlock.tsx`), with two adaptations to this app:
//
// - The reference takes its display copy through a `labels` prop, because that
//   package is cordis-free and every string is localized upstream. This app has
//   no locale layer — its UI copy is Chinese and written inline (see ToolCard) —
//   so the strings live here, taken from dsh's own zh dictionary (`terminal.*`).
// - `signal` is gone. pi's bash reports a non-zero exit, a timeout and an abort
//   as thrown result text (`Command exited with code N`, `Command aborted`, …),
//   never a terminating signal name, so a signal branch would be a surface for
//   data nothing supplies.

import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { parseAnsiLines, type AnsiLine } from './ansi.ts'
import { headTailCap } from './head-tail-cap.ts'
import { useCopyFeedback } from './use-copy-feedback.ts'
import { Pill } from './Pill.tsx'
import { StateDot, type StateDotState } from './StateDot.tsx'
import css from './TerminalBlock.module.css'

/** Output lines shown before the height cap collapses the middle. */
export const DEFAULT_TERMINAL_MAX_LINES = 16

/** Display copy for the terminal surface, per dsh's zh dictionary. */
const COPY = {
  /** Status pill text for a non-zero exit code. */
  exitCode: (exitCode: number) => `退出码 ${exitCode}`,
  /** Status pill text for a command that settled without a readable exit code. */
  noExitCode: '未正常退出',
  /** Run-state text while the command is still running. */
  running: '运行中',
  /** Run-state text for a non-zero-exit settle. */
  failed: '失败',
  /** Run-state text for a clean settle. */
  done: '已完成',
  /** Copy-button idle label. */
  copy: '复制',
  /** Copy-button label during the post-copy confirmation window. */
  copied: '已复制',
  /** Placeholder when a settled command produced no visible output. */
  noOutput: '无输出',
  /** Collapse-toggle aria label while expanded. */
  collapseAria: '收起输出',
  /** Collapse-toggle text while expanded. */
  collapse: '收起',
  /** Expand-toggle aria label while capped, given the hidden line count. */
  expandAria: (hidden: number) => `展开其余 ${hidden} 行输出`,
  /** Expand-toggle text while capped, given the hidden line count. */
  expand: (hidden: number) => `… 其余 ${hidden} 行`,
}

export interface TerminalBlockProps {
  /** The command line, rendered verbatim after the prompt label. */
  command: string
  /** Working directory for the prompt label; absent renders a plain `$`. */
  cwd?: string | undefined
  /** Absolute home directory, so a cwd equal to it collapses to `~`; absent disables that collapse. */
  home?: string | undefined
  /** The command's output text; may contain ANSI escape sequences. */
  output?: string | undefined
  /** Settled exit code; a non-zero value renders the status pill, and null (settled without one) the no-exit-code pill. */
  exitCode?: number | null | undefined
  /**
   * The command is still running: the block shows the prompt line, and the
   * output printed so far when there is any, with no copy control until it settles.
   */
  running?: boolean | undefined
  /** Height cap in output lines before the middle collapses (default {@link DEFAULT_TERMINAL_MAX_LINES}); Infinity disables the cap. */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/**
 * Prompt label for a working directory: `~` for the home directory itself,
 * otherwise the path's last segment (both separators accepted, trailing
 * separators ignored), falling back to the path itself when it has no
 * segment.
 * @param cwd - the working directory path.
 * @param home - absolute home directory, when the caller knows it.
 * @returns the prompt label.
 */
function promptLabel(cwd: string, home: string | undefined): string {
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (home !== undefined && trimmed === home.replace(/[/\\]+$/, '')) return '~'
  const segment = trimmed.split(/[/\\]/).pop()
  return segment === undefined || segment === '' ? cwd : segment
}

/**
 * Status pill text for a settled command, or undefined when the command
 * settled cleanly (exit 0) and needs no pill.
 * @param exitCode - settled exit code, when known; null when the command settled without one.
 * @returns the pill text, or undefined for a clean exit.
 */
function statusText(exitCode: number | null | undefined): string | undefined {
  if (exitCode === null) return COPY.noExitCode
  if (exitCode !== undefined && exitCode !== 0) return COPY.exitCode(exitCode)
  return undefined
}

/**
 * Run-state indicator for the command, shown at the head of the prompt line so
 * the card states whether the command is still running without the reader
 * having to infer it from the presence of output. Three of {@link StateDotState}'s
 * five states are reachable: the running chase (the same indicator a running
 * tool row's leading icon uses, so the row and its card never disagree), green
 * for a clean settle, red for a non-zero exit — the same status distinction
 * {@link statusText} draws for the pill. A settled command whose exit status
 * never reached the view counts as a clean settle: the view says it finished
 * and says nothing went wrong.
 * @param running - the command has not settled.
 * @param exitCode - settled exit code, when known; null when the command settled without one.
 * @returns the dot's state and its text label, since the dot is aria-hidden.
 */
function runState(
  running: boolean,
  exitCode: number | null | undefined,
): { state: StateDotState; label: string } {
  if (running) return { state: 'ongoing', label: COPY.running }
  if (statusText(exitCode) !== undefined) return { state: 'error', label: COPY.failed }
  return { state: 'done', label: COPY.done }
}

/**
 * Render one parsed output line. Runs without SGR state render as bare text,
 * so uncolored output carries no span wrappers.
 * @param line - the line's styled runs.
 * @returns the line's children.
 */
function renderLine(line: AnsiLine) {
  return line.map((span, index) => span.style === undefined
    ? span.text
    : <span key={index} style={span.style}>{span.text}</span>)
}

/**
 * Render a shell command as a terminal surface.
 * @param props - see {@link TerminalBlockProps}.
 * @returns the terminal block element.
 */
export function TerminalBlock({
  command,
  cwd,
  home,
  output,
  exitCode,
  running = false,
  maxLines = DEFAULT_TERMINAL_MAX_LINES,
  className,
}: TerminalBlockProps) {
  const text = output ?? ''
  // A command's output ends with a newline; that terminator is not an extra
  // blank line to draw or to count against the height cap. The check runs on the
  // PARSED lines rather than on the raw text, because a reset after the final
  // newline (`line\n\x1b[0m`) leaves the string not ending in one while still
  // producing a last line with nothing visible in it. A genuinely blank final
  // line — the double newline — survives, since it has a real empty line before
  // the terminator. The copy control still copies `text` untouched.
  const lines = useMemo(() => {
    const parsed = parseAnsiLines(text)
    const last = parsed[parsed.length - 1]
    const terminated = parsed.length > 1 && last !== undefined
      && last.every(span => span.text === '')
    return terminated ? parsed.slice(0, -1) : parsed
  }, [text])
  const [expanded, setExpanded] = useState(false)
  // The raw output, never the rendered tree: the prompt line and the status pill
  // are chrome the user did not run.
  const { copied, onCopy } = useCopyFeedback(text)

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  const status = statusText(exitCode)
  const state = runState(running, exitCode)
  // A multi-line command gets one prompt row per line, so a two-command shell
  // snippet reads as the two commands it is instead of collapsing into one
  // ellipsized row. A trailing newline is a terminator, not an empty command.
  const commandLines = useMemo(() => {
    const body = command.endsWith('\n') ? command.slice(0, -1) : command
    return body.split('\n')
  }, [command])
  // Read from the parsed lines the card actually renders, not from the raw text:
  // output that is only escapes or control bytes (a lone reset, an OSC title, an
  // erase) survives `text.trim()` yet parses to nothing visible. Judging it on
  // the raw text would draw an output box of blank rows plus a copy control
  // for invisible bytes, and hide the placeholder that belongs there.
  const empty = lines.every(line => line.every(span => span.text.trim() === ''))
  const { hidden, capped, headLines, tailLines } = headTailCap(lines.length, maxLines, expanded)
  // A running command with nothing printed yet is banner-only; once it has
  // printed, the output streams in under the banner as it would in a terminal.
  const body = !running || !empty

  return (
    <div
      className={clsx(css.block, className)}
      data-terminal=""
      data-running={running ? '' : undefined}
      data-body={body ? '' : undefined}
    >
      <div className={css.header}>
        <div className={css.prompt}>
          <span className={css.runStateLabel}>{state.label}</span>
          {commandLines.map((line, index) => (
            <div key={index} className={css.promptLine}>
              {/* One dot for the card, on the first row: the exit status the
                  view carries is the whole call's, and bash reports no
                  per-command status, so a dot per row would assert a
                  per-line outcome nothing here knows. */}
              {index === 0 && <StateDot state={state.state} className={css.runState} />}
              {/* The cwd labels the CALL, so only its first row carries it. The
                  view knows one working directory — where the call started —
                  and a later line may well run somewhere else (a `cd` in the
                  command is enough), so repeating the label down the rows would
                  assert a directory per line that nothing here knows. Later
                  rows keep a bare `$` to stay aligned as prompts. */}
              <span className={css.cwd}>
                {index > 0 || cwd === undefined ? '$' : promptLabel(cwd, home)}
              </span>
              <span className={css.command}>{line}</span>
            </div>
          ))}
        </div>
        {status !== undefined && <Pill className={css.status}>{status}</Pill>}
        {!running && !empty && (
          <button type="button" className={css.copyButton} onClick={onCopy}>
            {copied ? COPY.copied : COPY.copy}
          </button>
        )}
      </div>
      {body && (empty
        ? <div className={css.empty}>{COPY.noOutput}</div>
        : (
          <div className={css.output}>
            {(capped ? lines.slice(0, headLines) : lines).map((line, index) => (
              <div key={index} className={css.line}>{renderLine(line)}</div>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                className={css.expand}
                aria-expanded={expanded}
                aria-label={expanded ? COPY.collapseAria : COPY.expandAria(hidden)}
                onClick={onToggle}
              >
                {expanded ? COPY.collapse : COPY.expand(hidden)}
              </button>
            )}
            {capped && lines.slice(lines.length - tailLines).map((line, index) => (
              <div key={index} className={css.line}>{renderLine(line)}</div>
            ))}
          </div>
        ))}
    </div>
  )
}
