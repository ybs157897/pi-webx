/**
 * The two disclosure rows of a turn's folded process, dsh's ProcessGroupHeader
 * split by turn state:
 *   - `TurnProcessRow` — the settled activity (“已完成分析”, “执行了命令”)
 *   - `LiveProcessRow` — the in-flight activity (“正在分析请求”, “正在运行命令”)
 *
 * Both are 24px flat rows: chevron, glyph, one line of tertiary text. Neither
 * owns what is hidden behind it — `TranscriptView` decides membership; the rows
 * only toggle it.
 */

import { Icon, Text } from '@lobehub/ui';
import { theme } from 'antd';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Code,
  FileText,
  Globe,
  Image,
  ListTodo,
  Pencil,
  ScanSearch,
  Search,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { CompletedProcessSpec, LiveActivity, LiveProcessSpec } from '../lib/transcript/presentation';

const LIVE_ICONS: Record<LiveActivity, LucideIcon> = {
  think: Brain,
  read: FileText,
  readImage: Image,
  edit: Pencil,
  write: Pencil,
  search: Search,
  bash: Terminal,
  code: Code,
  webSearch: ScanSearch,
  web: Globe,
  subagents: Users,
  plan: ListTodo,
  questions: Wrench,
  tools: Wrench,
};

/** dsh's `PROCESS_TITLE_MINIMUM_MS`: a live title commits at most once per 150ms. */
const LIVE_TITLE_MINIMUM_MS = 150;
/** Joins label and detail inside one debounced value; NUL cannot occur in either vocabulary. */
const TITLE_PAIR_SEPARATOR = '\u0000';

/**
 * Keep the live title stable for at least 150ms per change, so a burst of quick
 * steps cannot flicker the header. The next desired title waits out the
 * remainder of the window, then commits (dsh's `useStableLiveProcessTitle`).
 */
function useStableLiveTitle(desired: string): string {
  const [displayed, setDisplayed] = useState(desired);
  const committedAt = useRef(0);
  useEffect(() => {
    if (desired === displayed) return;
    const remaining = LIVE_TITLE_MINIMUM_MS - (Date.now() - committedAt.current);
    if (remaining <= 0) {
      committedAt.current = Date.now();
      setDisplayed(desired);
      return;
    }
    const timer = setTimeout(() => {
      committedAt.current = Date.now();
      setDisplayed(desired);
    }, remaining);
    return () => clearTimeout(timer);
  }, [desired, displayed]);
  return displayed;
}

function DisclosureRow({
  expanded,
  onToggle,
  glyph,
  testId,
  activity,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  glyph: ReactNode;
  testId: string;
  activity?: string;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      data-testid={testId}
      {...(activity === undefined ? {} : { 'data-activity': activity })}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        cursor: 'pointer',
        color: token.colorTextTertiary,
        userSelect: 'none',
      }}
    >
      <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
      {glyph}
      {children}
    </div>
  );
}

/** The collapsed process of one finished turn: what replaced its reasoning rows and tool executions. */
export function TurnProcessRow({
  summary,
  expanded,
  onToggle,
}: {
  summary: CompletedProcessSpec;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Glyph = LIVE_ICONS[summary.activity];
  return (
    <DisclosureRow expanded={expanded} onToggle={onToggle} glyph={<Icon icon={Glyph} size={14} />} testId="turn-process-row" activity={summary.activity}>
      <Text fontSize={13} type="secondary">
        {summary.label}
      </Text>
    </DisclosureRow>
  );
}

/**
 * The in-flight turn's activity header. The label always names the activity
 * type; `detail` (the command / path itself) is decided by the policy's
 * `liveProcessDetail`. The title shimmers until the turn ends — dsh's
 * `TextShimmer active={!closed}` — and label+detail debounce as one unit so a
 * quick step never shows the new activity beside the old command.
 */
export function LiveProcessRow({
  spec,
  detail,
  closed = false,
  expanded,
  onToggle,
}: {
  spec: LiveProcessSpec;
  detail: string;
  closed?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const desired = `${spec.label}${TITLE_PAIR_SEPARATOR}${detail}`;
  const stableTitle = useStableLiveTitle(desired);
  const title = closed ? desired : stableTitle;
  const splitAt = title.indexOf(TITLE_PAIR_SEPARATOR);
  const label = splitAt < 0 ? title : title.slice(0, splitAt);
  const detailText = splitAt < 0 ? '' : title.slice(splitAt + TITLE_PAIR_SEPARATOR.length);
  const Glyph = LIVE_ICONS[spec.activity];
  return (
    <DisclosureRow
      expanded={expanded}
      onToggle={onToggle}
      glyph={<Icon icon={Glyph} size={14} />}
      testId="live-process-row"
      activity={spec.activity}
    >
      <span className={closed ? undefined : 'pi-live-shimmer'} style={{ flexShrink: 0, fontSize: 13 }}>
        {label}
      </span>
      {detailText !== '' && (
        <>
          <span style={{ opacity: 0.45, flexShrink: 0 }}>·</span>
          <Text fontSize={13} type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }}>
            {detailText}
          </Text>
        </>
      )}
    </DisclosureRow>
  );
}
