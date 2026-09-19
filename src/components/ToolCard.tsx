import { CodeDiff, Flexbox, Highlighter, PatchDiff, Text } from '@lobehub/ui';
import { theme } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import {
  baseName,
  formatArgs,
  formatRelativeTime,
  languageFromPath,
  summarizeToolCall,
  toolOutputLanguage,
} from '../lib/format';
import {
  IconApiOutline14,
  IconBrowseOutline16,
  IconCodeOutline16,
  IconEditOutline16,
  IconFolderClose16,
  IconSearchOutline16,
  IconSparkle16,
  StateDot,
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

/* ------------------------------------------------------------------- helpers */

/** Plain object view of a wire value; `null` for everything else. */
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Non-empty string, or `null`. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Any string, including the empty one (an edit may insert where nothing was). */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface Fragment {
  oldText: string;
  newText: string;
}

/**
 * The `{oldText, newText}` pairs an `edit` call carried, if any.
 *
 * pi normalises its legacy top-level `oldText`/`newText` into `edits[]` before
 * the tool runs, but a transcript restored from an older log can still hold the
 * un-normalised form, so both shapes are read.
 */
function editFragments(run: ToolRun): Fragment[] | null {
  if (run.toolName !== 'edit') return null;
  const legacyOld = str(run.args['oldText']);
  const legacyNew = str(run.args['newText']);
  if (legacyOld !== null && legacyNew !== null) {
    return [{ oldText: legacyOld, newText: legacyNew }];
  }
  const edits = run.args['edits'];
  if (!Array.isArray(edits)) return null;
  const fragments = edits.flatMap((entry): Fragment[] => {
    const edit = record(entry);
    const oldText = str(edit?.['oldText']);
    const newText = str(edit?.['newText']);
    if (oldText === null || newText === null) return [];
    return [{ oldText, newText }];
  });
  return fragments.length > 0 ? fragments : null;
}

/**
 * What a file-mutating call changed, drawn by the app's own diff components.
 *
 * pi reports the artefact, not the intention: an `edit` result carries its
 * `{patch, diff}` in `details`, and a `write` carries nothing but the content it
 * was handed. The unified patch is the most faithful view, so it wins; then the
 * display diff; then a diff rebuilt from the call's own arguments, which is all
 * a still-streaming run or an old transcript has.
 */
function changeView(run: ToolRun): ReactNode | null {
  const details = record(run.details);
  const file = text(run.args['path']) ?? text(run.args['file_path']) ?? text(run.args['filePath']) ?? '';
  const language = languageFromPath(file);
  const fileName = baseName(file);
  const named = fileName.length > 0 ? { fileName } : {};

  const patch = text(details?.['patch']);
  if (patch !== null) {
    return <PatchDiff patch={patch} variant="outlined" {...named} />;
  }

  const recorded = text(details?.['diff']);
  if (recorded !== null) {
    return (
      <Highlighter language="diff" variant="outlined" wrap showLanguage={false}>
        {recorded}
      </Highlighter>
    );
  }

  const fragments = editFragments(run);
  if (fragments !== null) {
    return (
      <Flexbox gap={6}>
        {fragments.map((fragment, index) => (
          <CodeDiff
            // Edits are positional and carry no id of their own; the index is the
            // only stable key a call's own argument list can offer.
            key={String(index)}
            oldContent={fragment.oldText}
            newContent={fragment.newText}
            language={language}
            variant="outlined"
            {...named}
          />
        ))}
      </Flexbox>
    );
  }

  const written = run.toolName === 'write' ? str(run.args['content']) : null;
  if (written !== null) {
    return (
      <CodeDiff
        oldContent=""
        newContent={written}
        language={language}
        variant="outlined"
        {...named}
      />
    );
  }

  return null;
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
 */
function Section({
  label,
  children,
  scroll = true,
}: {
  label: string;
  children: ReactNode;
  /**
   * A diff or a set of thumbnails opts out of the cap: those are the result
   * itself, read or looked at directly, and dsh draws them as their own card
   * rather than as an IN/OUT section. The caption gutter still applies.
   */
  scroll?: boolean;
}) {
  return (
    <div className={scroll ? css['section'] : css['sectionPlain']}>
      <span className={css['sectionLabel']}>{label}</span>
      <div className={css['sectionBody']}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ component */

/** Tools whose row summary already spells out everything worth saying about the call. */
const RESULT_ONLY_TOOLS = new Set(['bash', 'powershell', 'read', 'write', 'edit']);

export function ToolCard({ run }: { run: ToolRun }) {
  const { token } = theme.useToken();
  const [manual, setManual] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);

  // Running and failed calls open themselves; a successful one folds to its
  // header line unless the user has explicitly toggled it. Collapsed means the
  // header and nothing else — an output preview under it made the card look
  // unfolded however many times it was clicked.
  const open = manual ?? (run.status === 'running' || run.status === 'error');
  const summary = summarizeToolCall(run.toolName, run.args);
  const failed = run.status === 'error';

  // A tool whose arguments the row summary already spells out shows only its
  // result when expanded. dsh draws its single-file tools this way — the row is
  // the only args interaction — because repeating the command or the path as an
  // input block pushed the output, the thing the caller actually wants, down the
  // card. Shell calls carry their whole command in the summary; read/write/edit
  // carry the path (and, for a mutation, the byte count).
  const resultOnly = RESULT_ONLY_TOOLS.has(run.toolName);
  const change = useMemo(() => changeView(run), [run]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Flexbox
        horizontal
        align="center"
        gap={6}
        style={{ height: 24, cursor: 'pointer' }}
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
        <Text fontSize={13} style={{ fontFamily: token.fontFamilyCode, flexShrink: 0 }}>
          {run.toolName}
        </Text>
        {summary.length > 0 && (
          <>
            <Text fontSize={13} type="secondary" style={{ flexShrink: 0, opacity: 0.45 }}>
              ·
            </Text>
            <Text
              fontSize={13}
              type="secondary"
              ellipsis
              style={{
                fontFamily: token.fontFamilyCode,
                flex: 1,
                minWidth: 0,
                // dsh paints a failed row's summary in the error colour
                // (`.errorSummary`); with no trailing status mark left, that
                // colour is what says "this one broke". It has to be inline: the
                // secondary colour arrives as a generated class of equal
                // specificity that lands later in the sheet.
                ...(failed ? { color: 'var(--dsw-alias-state-error-primary)' } : {}),
              }}
            >
              {summary}
            </Text>
          </>
        )}
        {summary.length === 0 && <div style={{ flex: 1 }} />}
      </Flexbox>

      {open && (
        <Flexbox
          gap={8}
          // dsh indents the expanded body under the row and boxes only the
          // blocks inside it (`margin: 4px 0 4px 4px`), so the row itself stays
          // a flat line in the flow.
          style={{ margin: '4px 0 4px 4px' }}
        >
          {change !== null ? (
            <Section label="变更" scroll={false}>{change}</Section>
          ) : (
            <>
              {!resultOnly && Object.keys(run.args).length > 0 && (
                <Section label="参数">
                  <Highlighter language="json" variant="outlined" wrap showLanguage={false}>
                    {formatArgs(run.args)}
                  </Highlighter>
                </Section>
              )}

              {run.output.length > 0 && (
                <Section label="输出">
                  {/* dsh colours the expanded OUT text of a failed call
                      (`.ioText[data-error]`); the class carries that override,
                      since Shiki writes its palette as inline styles. */}
                  <div className={failed ? css.errorOutput : undefined}>
                    <Highlighter
                      language={toolOutputLanguage(run.toolName, run.args)}
                      variant="outlined"
                      wrap
                      showLanguage={false}
                    >
                      {run.output}
                    </Highlighter>
                  </div>
                </Section>
              )}

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
            </>
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
