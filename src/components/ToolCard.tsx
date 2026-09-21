import { Flexbox, Highlighter, Text } from '@lobehub/ui';
import { theme } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import {
  formatArgs,
  formatRelativeTime,
  summarizeToolCall,
} from '../lib/format';
import { useSessionCwd } from '../lib/session-cwd';
import { terminalCard, terminalTitle } from '../lib/terminal-card';
import {
  IconApiOutline14,
  IconBrowseOutline16,
  IconCodeOutline16,
  IconEditOutline16,
  IconFolderClose16,
  IconSearchOutline16,
  IconSparkle16,
  StateDot,
  TerminalBlock,
} from '../ui/primitives/index.ts';
import { LeadingGlyph } from './LeadingGlyph';
import { MessageImages } from './MessageImages';
import type { ToolRun } from '../shared/transcript';
import css from './ToolCard.module.css';

/**
 * dsh's own tool glyphs, taken verbatim from its `GenericToolCard` variant map
 * (`packages/client/ui-tool/.../GenericToolCard.tsx`) and read from the icon set
 * this app vendors from the same source: browse for reads, the prompt glyph for
 * shells, the pencil for mutations, the magnifier for searches, a sparkle for
 * anything unrecognised. `ls` has no dsh row of its own — it is the read family
 * there — so it borrows the folder glyph.
 */
function toolGlyph(toolName: string): ReactNode {
  switch (toolName) {
    case 'bash':
    case 'powershell':
      return <IconApiOutline14 />;
    case 'read':
      return <IconBrowseOutline16 size={14} />;
    case 'write':
    case 'edit':
      return <IconEditOutline16 size={14} />;
    case 'grep':
    case 'find':
      return <IconSearchOutline16 size={14} />;
    case 'ls':
      return <IconFolderClose16 size={14} />;
    case 'code':
      return <IconCodeOutline16 size={14} />;
    default:
      return <IconSparkle16 size={14} />;
  }
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * The row's leading mark for a run's state, following dsh's bash row
 * (`leadingFor`): a failure shows the error dot in the glyph's place, and a
 * live run dsh's animated ongoing dot — its own running signal is a row sweep
 * this app has no equivalent of, and the dot is the vocabulary the rest of the
 * app already uses for "in flight". Everything else keeps the tool's glyph.
 */
function leadingGlyph(status: ToolRun['status'], toolName: string): ReactNode {
  if (status === 'error') return <StateDot state="error" />;
  if (status === 'running') return <StateDot state="ongoing" />;
  return toolGlyph(toolName);
}

/**
 * One labelled block inside the expanded card body — the reference's IN/OUT shape.
 *
 * dsh lays a section out as a two-column grid (caption in the left gutter,
 * payload beside it) and caps the *section* at 150px with its own scrollport,
 * making the caption sticky inside it. A long output then scrolls underneath a
 * caption that stays put, instead of pushing the caption and the rest of the
 * transcript off screen. The caption owning its own column is also why
 * stickiness needs no background: the payload never passes beneath it.
 *
 * The caption used to sit above the payload, outside the scrollport. That also
 * kept it visible, but it charged a line per section and did not match the
 * reference's geometry.
 *
 * An uncaptioned block (`label === null`) is the same payload under the same
 * 150px cap, with no gutter at all. The result uses it: `输出` named the one
 * block the card's own shape already implies, and the gutter it charged read as
 * a stray word beside the content — the reference's gutter exists to separate an
 * IN from an OUT, and there is no IN here to separate it from.
 */
function Section({
  label,
  children,
  scroll = true,
}: {
  /** Caption for the left gutter, or null for a block that runs full width. */
  label: string | null;
  children: ReactNode;
  /**
   * A diff or a set of thumbnails opts out of the cap: those are the result
   * itself, read or looked at directly, and dsh draws them as their own card
   * rather than as an IN/OUT section.
   */
  scroll?: boolean;
}) {
  // The uncaptioned block is the capped scrollport unconditionally: the only
  // caller is the result, and an uncapped uncaptioned block has no use yet.
  if (label === null) return <div className={css['bare']} role="region" aria-label="工具输出" tabIndex={0}>{children}</div>;
  return (
    <div className={scroll ? css['section'] : css['sectionPlain']}>
      <span className={css['sectionLabel']}>{label}</span>
      <div className={css['sectionBody']}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ component */

/**
 * Tools whose expanded body is the result alone: every field of their arguments
 * is already on screen somewhere else.
 *
 * The rule is duplication, not brevity — a shell call's `command` is the row
 * summary verbatim, `read`'s path likewise, `write`/`edit` print the path and
 * byte count in the summary, so their args JSON repeats the call and pushes the
 * output down. The search family (`grep`/`find`/`ls`) keeps its args block
 * because its summary is an *abbreviation* of the call (the pattern clipped to
 * 90 chars, the scope to 50) while args carry fields the summary drops
 * entirely (`glob`, `ignoreCase`, `type`).
 *
 * `powershell` is pi's Windows twin of `bash` and shares its shape; the names
 * are pi's own builtins, per `src/shared/tool-presets.ts`.
 */
export const RESULT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'powershell',
  'read',
  'write',
  'edit',
]);

export function ToolCard({ run }: { run: ToolRun }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const cwd = useSessionCwd();

  // Running and failed calls open themselves; a successful one folds to its
  // header line unless the user has explicitly toggled it. Collapsed means the
  // header and nothing else — an output preview under it made the card look
  // unfolded however many times it was clicked.
  const open = manual ?? (run.status === 'running' || run.status === 'error');
  const summary = summarizeToolCall(run.toolName, run.args);
  const failed = run.status === 'error';
  // A failure REPLACES the summary rather than supplementing it — dsh's
  // collapsed line is `failureLine ?? summary`. A call that did not land has one
  // thing to say in one line, and the command or path it was asked to run is
  // restated in the expanded body anyway. A failure that carries no result text
  // keeps the ordinary summary, so the row never degrades to a bare title.
  const failureLine = failed ? firstLine(run.output) : '';
  const summaryText = failureLine !== '' ? failureLine : summary;

  // A tool whose arguments the row summary already spells out shows only its
  // result when expanded. dsh draws its single-file tools this way — the row is
  // the only args interaction — because repeating the command or the path as an
  // input block pushed the output, the thing the caller actually wants, down the
  // card. Shell calls carry their whole command in the summary; read/write/edit
  // carry the path (and, for a mutation, the byte count).
  const resultOnly = RESULT_ONLY_TOOLS.has(run.toolName);

  // A shell call is dsh's terminal card, not the generic IN/OUT body. Its own
  // shape is a prompt line — run-state dot, working directory, the command —
  // with the output under it, so the command belongs in the card rather than
  // being restated in the row summary AND again as an input section. `null` for
  // every other tool, which keeps the section stack below.
  const terminal = useMemo(() => terminalCard(run, cwd), [run, cwd]);
  // The row's leading word: dsh prints a localized title, so a shell row reads
  // `Bash · …` where pi's tool id is lowercase. Only the terminal card's tools
  // are titled here; the generic rows keep pi's own names, since re-titling them
  // is a separate change with its own reference rows.
  const title = terminal === null ? run.toolName : terminalTitle(run.toolName);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Flexbox
        horizontal
        align="center"
        gap={6}
        style={{ height: 24, cursor: 'pointer' }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${title} ${summaryText}`}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setManual(!open); } }}
        onClick={() => setManual(!open)}
        onMouseEnter={() => { setHovered(true); }}
        onMouseLeave={() => { setHovered(false); }}
      >
        {/* dsh's row prefix: the tool's own glyph at rest, the chevron only while
            the row is hovered or open (see LeadingGlyph). A run's state rides
            that same slot — a failure shows dsh's error dot where the glyph was,
            a live run its ongoing dot — so the row carries no trailing status
            mark, and nothing trails the summary either: dsh's row is one line of
            glyph · title · summary, with the numbers left to the expanded body. */}
        <LeadingGlyph icon={leadingGlyph(run.status, run.toolName)} swap={hovered || open} />
        {/* dsh's row is one line of [16 leading] gap 6 [title 13/24] gap 8
            [2x2 dot] gap 8 [summary filling and truncated] (figma 122:9479). The
            title and the summary are chrome, not code: they keep the body font
            and the label colours, and the code font stays in the payload. */}
        <Text fontSize={13} style={{ color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 }}>
          {title}
        </Text>
        {summaryText.length > 0 && (
          <>
            {/* The dot carries 2px of its own on each side because the row's flex
                gap is 6 and dsh's separator sits at 8. */}
            <span className={css.sep} aria-hidden />
            <Text
              fontSize={13}
              ellipsis
              style={{
                // dsh paints the failure line in the error colour
                // (`.errorSummary`); with no trailing status mark left, that
                // colour is what says "this one broke".
                color: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
                flex: 1,
                minWidth: 0,
              }}
            >
              {summaryText}
            </Text>
          </>
        )}
        {summaryText.length === 0 && <div style={{ flex: 1 }} />}
      </Flexbox>

      {/* The expanded terminal card: the command banner and its output on one
          surface, the output capped so a long log scrolls inside the card rather
          than pushing the transcript down. The line cap is off
          (`maxLines={Infinity}`) because the cap here IS the scrollport, exactly
          as in dsh's bash row. */}
      {open && terminal !== null && (
        <TerminalBlock
          command={terminal.command}
          cwd={terminal.cwd}
          output={terminal.output}
          exitCode={terminal.exitCode}
          running={terminal.running}
          maxLines={Infinity}
          className={css.terminal}
        />
      )}

      {open && terminal === null && (
        <Flexbox
          gap={8}
          // dsh indents the expanded body under the row and boxes only the
          // blocks inside it (`margin: 4px 0 4px 4px`), so the row itself stays
          // a flat line in the flow.
          style={{ margin: '4px 0 4px 4px' }}
        >
          {!resultOnly && Object.keys(run.args).length > 0 && (
            <Section label="参数">
              <Highlighter language="json" variant="outlined" wrap showLanguage={false}>
                {formatArgs(run.args)}
              </Highlighter>
            </Section>
          )}
          {run.output.length > 0 && (
            <Section label={null}>
              <div className={failed ? css.errorOutput : undefined}>
                <pre className={css.outputText}>{run.output}</pre>
              </div>
            </Section>
          )}

          {/* Tool-returned images remain visible beside the textual result. */}
          {run.images !== undefined && run.images.length > 0 && (
            // Thumbnails are content to look at, not text to scan: capping
            // them at the section scrollport would clip the picture itself.
            <Section label="图片" scroll={false}>
              <MessageImages images={run.images} label={`${run.toolName} 返回`} />
            </Section>
          )}

          {run.output.length === 0 && run.status === 'running' && (
            <Text fontSize={12} type="secondary">
              等待输出…
            </Text>
          )}
        </Flexbox>
      )}
    </div>
  );
}

/** Compact one-line rendering used for tool results without a matching call. */
export function ToolCardHeader({ run }: { run: ToolRun }) {
  const { token } = theme.useToken();
  const summary = summarizeToolCall(run.toolName, run.args);
  return (
    <Flexbox horizontal align="center" gap={8} style={{ color: token.colorTextSecondary }}>
      <LeadingGlyph icon={toolGlyph(run.toolName)} swap={false} />
      <Text fontSize={12} style={{ fontFamily: token.fontFamilyCode }}>
        {run.toolName}
      </Text>
      {summary.length > 0 && (
        <Text fontSize={12} type="secondary" ellipsis style={{ fontFamily: token.fontFamilyCode }}>
          {summary}
        </Text>
      )}
      <Text fontSize={11} type="secondary">
        {formatRelativeTime(run.startedAt)}
      </Text>
    </Flexbox>
  );
}
