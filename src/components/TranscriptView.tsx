import { Alert, Flexbox, Text } from '@lobehub/ui';
import { theme } from 'antd';
import { ArrowDown, Eraser } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { formatTokens } from '../lib/format';
import { answerIndexOf } from '../lib/transcript';
import {
  DEFAULT_TRANSCRIPT_VIEW_MODE,
  activeRegion,
  completedProcessSpec,
  isLiveFoldMember,
  liveProcessSpec,
  presentationPolicyFor,
} from '../lib/transcript/presentation';
import type { LiveProcessSpec, TranscriptViewMode } from '../lib/transcript/presentation';
import type { TranscriptEntry, TranscriptState } from '../shared/transcript';
import { AssistantMessageItem, CustomMessageItem, UserMessageItem } from './MessageItem';
import { ToolCard } from './ToolCard';
import { ToolRunView } from './ToolRunView';
import { LiveProcessRow, TurnProcessRow } from './TranscriptProcessRow';

type NoticeLevel = 'info' | 'warning' | 'error';

function levelToAlert(level: NoticeLevel): 'info' | 'warning' | 'error' {
  return level;
}

function EntryView({
  entry,
  onAction,
  renderStyle,
  thinkingPreview = true,
  suppressThinking = false,
  suppressActions = false,
}: {
  entry: TranscriptEntry;
  onAction?: ((action: string) => void) | undefined;
  renderStyle?: 'ours' | 'tokui';
  thinkingPreview?: boolean;
  suppressThinking?: boolean;
  suppressActions?: boolean;
}) {
  const { token } = theme.useToken();

  switch (entry.kind) {
    case 'custom':
      return <CustomMessageItem entry={entry} />;

    case 'user':
      return <UserMessageItem entry={entry} />;

    case 'assistant':
      return (
        <AssistantMessageItem
          entry={entry}
          onAction={onAction}
          renderStyle={renderStyle}
          thinkingPreview={thinkingPreview}
          hideThinking={suppressThinking}
          hideActions={suppressActions}
        />
      );

    case 'toolResult':
      return <ToolRunView run={entry.run} />;

    case 'bash':
      // pi's own shell execution, replayed from a session snapshot. The command
      // now lives in the terminal card's prompt line, so the separate `$ …`
      // line that used to sit above the card is gone — printing the command
      // twice is the duplication dsh's bash row exists to avoid. This path has a
      // real exit code where the tool path has only pi's thrown status text, so
      // it rides the run's `details` (see terminalCard).
      return (
        <ToolCard
          run={{
            toolCallId: entry.id,
            toolName: 'bash',
            args: { command: entry.command },
            output: entry.output,
            details: { exitCode: entry.exitCode },
            status: entry.streaming ? 'running' : entry.exitCode === 0 ? 'success' : 'error',
            startedAt: entry.at,
          }}
        />
      );

    case 'notice':
      return (
        <Alert
          type={levelToAlert(entry.level)}
          variant="borderless"
          showIcon
          message={entry.text}
          {...(entry.detail === undefined ? {} : { description: entry.detail })}
        />
      );

    case 'compaction':
      return (
        <Flexbox horizontal align="center" gap={8} justify="center" paddingBlock={4}>
          <Eraser size={13} style={{ color: token.colorTextQuaternary }} />
          <Text fontSize={11.5} type="secondary">
            {entry.phase === 'start'
              ? '正在压缩上下文…'
              : entry.aborted
                ? '上下文压缩已取消'
                : `上下文已压缩${
                    entry.tokensBefore !== undefined && entry.tokensAfter !== undefined
                      ? `（${formatTokens(entry.tokensBefore)} → ${formatTokens(entry.tokensAfter)}）`
                      : ''
                  }`}
          </Text>
          <div style={{ flex: 1, height: 1, background: token.colorSplit }} />
        </Flexbox>
      );

    default:
      return null;
  }
}

export function TranscriptView({
  transcript,
  onAction,
  renderStyle,
  mode,
}: {
  transcript: TranscriptState;
  onAction?: ((action: string) => void) | undefined;
  renderStyle?: 'ours' | 'tokui';
  /**
   * Work-details mode (工作步骤展示). Renderers below read single fields of
   * the derived policy — never the mode enum — so a new mode changes only the
   * policy table in `lib/transcript/presentation.ts`.
   */
  mode?: TranscriptViewMode;
}) {
  const { token } = theme.useToken();
  const policy = presentationPolicyFor(mode ?? DEFAULT_TRANSCRIPT_VIEW_MODE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [stick, setStick] = useState(true);
  /** turns the reader opened by hand; cleared when the session remounts */
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<number>>(() => new Set());

  const toggleTurn = useCallback((turnId: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  /**
   * The entry each finished turn's answer lives in — the only rows that offer to
   * be copied.
   *
   * A turn is a process: narration, tool calls, more narration. Each of those
   * steps is its own assistant message, so a copy button under every message
   * scatters them through the middle of the answer being written. The copy
   * belongs to what the reader asked for: the turn's last prose step — the same
   * entry the fold keeps as its anchor, from the same rule.
   *
   * A turn still in flight contributes nothing. Until it ends there is no answer,
   * only a process, and a button on whichever step happens to be last would move
   * as the turn went on and then vanish into the fold.
   */
  const answerIds = useMemo(() => {
    const ids = new Set<string>();
    let segment: TranscriptEntry[] = [];
    const flush = (open: boolean): void => {
      const index = answerIndexOf(segment);
      const answer = index >= 0 ? segment[index] : undefined;
      if (answer !== undefined && !open) ids.add(answer.id);
      segment = [];
    };
    for (const entry of transcript.entries) {
      // A user message opens the next turn, so it ends the current one.
      if (entry.kind === 'user') flush(false);
      segment.push(entry);
    }
    flush(transcript.activeTurn !== null);
    return ids;
  }, [transcript.entries, transcript.activeTurn]);

  /**
   * Everything a collapsed turn hides, mapped back to its turn, plus the rows
   * to render: the summary row sits where the process began. Under the policy
   * table (lib/transcript/presentation.ts): verbose folds nothing; 'history'
   * groups settled turns only (live output streams inline — the mode pi-webx
   * had before modes existed); 'collapsed' groups the live turn behind an
   * activity header too, the answer being written excepted. An answer whose own
   * reasoning folded renders without its thinking row until the turn is expanded.
   *
   * A collapsed turn's rows go into ONE wrapper rather than one wrapper each:
   * zero-height flex children still charge a gap apiece, so eight folded rows
   * would leave sixty-odd pixels of blank between the summary and the answer.
   */
  const rows = useMemo(() => {
    // Policy fields only — no renderer below compares the mode enum.
    const foldCompleted = policy.foldCompletedTurns;
    const liveGrouped = policy.stepGrouping === 'collapsed';
    const active = transcript.activeTurn;
    // agent_start precedes pi's first turn_start. Keep a visible analysis row
    // during that gap, using the id the forthcoming turn_start will assign.
    const activeId = active?.id ?? (transcript.running ? transcript.turnSeq + 1 : undefined);

    const ownerOf = new Map<string, number>();
    const anchorTurns = new Map<string, number>();
    const entryById = new Map(transcript.entries.map((entry) => [entry.id, entry]));
    const hiddenByTurn = new Map<number, TranscriptEntry[]>();
    if (foldCompleted) {
      for (const [key, process] of Object.entries(transcript.turnProcesses)) {
        const turnId = Number(key);
        const hidden = process.hiddenIds
          .map((entryId) => entryById.get(entryId))
          .filter((entry): entry is TranscriptEntry => entry !== undefined);
        hiddenByTurn.set(turnId, hidden);
        for (const entry of hidden) ownerOf.set(entry.id, turnId);
        anchorTurns.set(process.anchorId, turnId);
      }
    }

    // The live turn under 'collapsed': which of its rows hide behind the
    // activity header, and what the header shows. The header's expansion key is
    // the turn id itself, so a group the reader opened stays open when the
    // turn settles and the header swaps to the counts summary.
    const liveMembers: TranscriptEntry[] = [];
    let liveSpec: LiveProcessSpec | null = null;
    let liveClosed = false;
    let liveStartIndex = transcript.entries.length;
    let liveInsertIndex = transcript.entries.length;
    if (liveGrouped && activeId !== undefined) {
      const region = active === null ? [] : activeRegion(transcript.entries, active) ?? [];
      if (active !== null && active.startId !== null) {
        const markerIndex = transcript.entries.findIndex((entry) => entry.id === active.startId);
        liveStartIndex = markerIndex < 0 ? transcript.entries.length : markerIndex + 1;
      } else if (active !== null) {
        liveStartIndex = 0;
      }
      let latestUserIndex = -1;
      for (let index = transcript.entries.length - 1; index >= liveStartIndex; index -= 1) {
        if (transcript.entries[index]?.kind === 'user') {
          latestUserIndex = index;
          break;
        }
      }
      liveInsertIndex = latestUserIndex < 0 ? transcript.entries.length : latestUserIndex + 1;
      if (region.length > 0) {
        liveMembers.push(...region.filter(isLiveFoldMember));
      }
      const hasReasoning = region.some((entry) => entry.kind === 'assistant' && entry.thinking.trim() !== '');
      let lastProcessIndex = -1;
      let lastReplyIndex = -1;
      for (let index = 0; index < region.length; index += 1) {
        const entry = region[index];
        if (entry === undefined) continue;
        if (isLiveFoldMember(entry)) lastProcessIndex = index;
        if (entry.kind === 'assistant' && entry.tools.length === 0 && entry.text.trim() !== '') {
          lastReplyIndex = index;
        }
      }
      const hasProcess = liveMembers.length > 0 || hasReasoning;
      // Closing needs a real collapsible process to summarize. The streaming
      // step's own reasoning counts as process for the header's existence, but
      // it is not a member while its text streams — closing on it synthesized
      // a fake “已完成分析” and popped the thinking row out of the fold every
      // time a narration window opened (the expand-during-output report).
      liveClosed = liveMembers.length > 0 && lastReplyIndex > lastProcessIndex;
      if (lastReplyIndex < 0 || hasProcess) {
        liveSpec = liveClosed
          ? { ...completedProcessSpec(liveMembers), detail: '' }
          : liveProcessSpec(region, transcript.streamingEntryId);
      }
    }
    const liveHidden = liveMembers.length === 0 ? null : new Set(liveMembers.map((entry) => entry.id));

    const out: ReactNode[] = [];
    const announced = new Set<number>();
    let liveAnnounced = false;
    const pushSummary = (turnId: number): void => {
      const process = transcript.turnProcesses[turnId];
      if (process === undefined || announced.has(turnId)) return;
      announced.add(turnId);
      out.push(
        <TurnProcessRow
          key={`turn-process-${turnId}`}
          summary={completedProcessSpec(hiddenByTurn.get(turnId) ?? [])}
          expanded={expandedTurns.has(turnId)}
          onToggle={() => toggleTurn(turnId)}
        />,
      );
    };
    const pushBody = (keyId: string, expanded: boolean, body: readonly TranscriptEntry[]): void => {
      out.push(
        <div
          key={`turn-process-body-${keyId}`}
          className={
            expanded ? 'pi-turn-process' : 'pi-turn-process pi-turn-process-collapsed'
          }
          // Kept in the DOM, hidden with `until-found`, so in-page search
          // can still surface folded text (the browser reveals it on a
          // match). Set as an attribute rather than a prop: React's types
          // only accept a boolean `hidden` and would coerce the value.
          ref={(node) => {
            if (!node) return;
            if (expanded) node.removeAttribute('hidden');
            else node.setAttribute('hidden', 'until-found');
          }}
        >
          {body.map((hiddenEntry) => (
            <EntryView
              key={hiddenEntry.id}
              entry={hiddenEntry}
              onAction={onAction}
              renderStyle={renderStyle}
              thinkingPreview={policy.settledReasoningPreview}
              suppressActions={!answerIds.has(hiddenEntry.id)}
            />
          ))}
        </div>,
      );
    };
    const pushLive = (): void => {
      if (liveAnnounced || liveSpec === null || activeId === undefined) return;
      liveAnnounced = true;
      const expanded = expandedTurns.has(activeId);
      out.push(
        <LiveProcessRow
          key={`live-process-${activeId}`}
          spec={liveSpec}
          detail={!liveClosed && policy.liveProcessDetail ? liveSpec.detail : ''}
          closed={liveClosed}
          expanded={expanded}
          onToggle={() => toggleTurn(activeId)}
        />,
      );
      if (liveMembers.length > 0) pushBody(`live-${activeId}`, expanded, liveMembers);
    };

    for (let index = 0; index < transcript.entries.length; index += 1) {
      const entry = transcript.entries[index];
      if (entry === undefined) continue;

      // No stream chunk yet: show the activity row immediately after the
      // submitted prompt instead of waiting for a foldable process entry.
      if (liveHidden === null && index === liveInsertIndex) pushLive();

      // Rows of the live group render once, behind the activity header.
      if (liveHidden !== null && liveHidden.has(entry.id)) {
        pushLive();
        // Every entry of the live group's folded set renders inside that wrapper.
        continue;
      }

      const turnId = ownerOf.get(entry.id);
      if (turnId !== undefined) {
        if (!announced.has(turnId)) {
          pushSummary(turnId);
          pushBody(String(turnId), expandedTurns.has(turnId), hiddenByTurn.get(turnId) ?? []);
        }
        // Every entry of this turn's folded set renders inside that wrapper.
        continue;
      }

      // A fold whose only member is the answer's own reasoning hides no
      // entries; the summary still appears, right above the answer.
      const anchorTurn = anchorTurns.get(entry.id);
      const anchorProcess = anchorTurn === undefined ? undefined : transcript.turnProcesses[anchorTurn];
      if (anchorTurn !== undefined && anchorProcess) pushSummary(anchorTurn);
      const settledSuppress =
        anchorTurn !== undefined &&
        !expandedTurns.has(anchorTurn) &&
        anchorProcess?.anchorThought === true;
      // While the live group owns the turn, every in-region row's thinking
      // hides behind the activity header — including the streaming step's own
      // (it left the members set the moment its text started, and must not
      // reappear as a visible row for that). The settled fold does the same
      // to the answer via `anchorThought` once the turn ends.
      const liveSuppress =
        policy.stepGrouping === 'collapsed' && activeId !== undefined && index >= liveStartIndex
          ? !expandedTurns.has(activeId)
          : false;
      out.push(
        <EntryView
          key={entry.id}
          entry={entry}
          onAction={onAction}
          renderStyle={renderStyle}
          thinkingPreview={policy.settledReasoningPreview}
          suppressThinking={settledSuppress || liveSuppress}
          suppressActions={!answerIds.has(entry.id)}
        />,
      );
    }
    if (liveHidden === null) pushLive();
    return out;
  }, [transcript.entries, transcript.turnProcesses, transcript.activeTurn, transcript.streamingEntryId, transcript.running, transcript.turnSeq, expandedTurns, toggleTurn, onAction, renderStyle, answerIds, policy]);

  const onScroll = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setStick(distance < 120);
  }, []);

  /**
   * Follow new output only while the user is already at the bottom, so reading
   * back through history is not yanked away by streaming deltas.
   *
   * Batched to one scroll per animation frame: a streaming turn rebuilds
   * `entries` on every delta, and reading `scrollHeight` forces a synchronous
   * layout, so the naive effect did one forced reflow per token. Scroll position
   * is applied at the end of the frame instead of mid-commit.
   */
  const scrollFrame = useRef<number | null>(null);
  useEffect(() => {
    if (!stick) return;
    const node = containerRef.current;
    if (!node) return;
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      // Reading scrollHeight is unavoidable to compose the position; this is
      // once per frame rather than once per delta.
      node.scrollTop = node.scrollHeight;
    });
  }, [transcript.entries, stick]);

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    },
    [],
  );

  const scrollToBottom = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    setStick(true);
  }, []);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <div
        ref={containerRef}
        onScroll={onScroll}
        style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}
      >
        <Flexbox
          className="pi-transcript"
          gap={8}
          paddingInline={20}
          paddingBlock={20}
          style={{ maxWidth: 900, margin: '0 auto' }}
        >
          {rows}
          {transcript.entries.length === 0 && !transcript.running && (
            <Flexbox align="center" justify="center" gap={8} paddingBlock={80}>
              <Text type="secondary">还没有对话</Text>
              <Text fontSize={12} type="secondary">
                在下方输入，pi 会在这个工作目录里执行任务
              </Text>
            </Flexbox>
          )}
        </Flexbox>
      </div>

      {!stick && (
        <div style={{ position: 'absolute', right: 24, bottom: 16 }}>
          <button
            type="button"
            onClick={scrollToBottom}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
              color: token.colorText,
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusLG,
              boxShadow: token.boxShadowSecondary,
            }}
          >
            <ArrowDown size={13} />
            回到最新
          </button>
        </div>
      )}
    </div>
  );
}
