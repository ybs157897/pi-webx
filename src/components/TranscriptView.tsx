import { Alert, Flexbox, Highlighter, Icon, Text } from '@lobehub/ui';
import { theme } from 'antd';
import { ArrowDown, ChevronDown, ChevronRight, Eraser } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { formatTokens } from '../lib/format';
import type { TranscriptEntry, TranscriptState, TurnProcess } from '../shared/transcript';
import { AssistantMessageItem, UserMessageItem } from './MessageItem';
import { ToolCard } from './ToolCard';

type NoticeLevel = 'info' | 'warning' | 'error';

function levelToAlert(level: NoticeLevel): 'info' | 'warning' | 'error' {
  return level;
}

/**
 * The collapsed process of one finished turn: what dsh shows in place of the
 * reasoning rows and tool executions, with its counts.
 */
function TurnProcessRow({
  process,
  expanded,
  onToggle,
}: {
  process: TurnProcess;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { token } = theme.useToken();
  const parts: string[] = [];
  if (process.thought) parts.push('已思考');
  if (process.toolCalls > 0) parts.push(`${process.toolCalls} 次工具调用`);
  if (process.messages > 0) parts.push(`${process.messages} 条消息`);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
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
      <Text fontSize={13} type="secondary">
        {parts.join(' · ')}
      </Text>
    </div>
  );
}

function EntryView({
  entry,
  onAction,
  renderStyle,
  suppressThinking = false,
}: {
  entry: TranscriptEntry;
  onAction?: ((action: string) => void) | undefined;
  renderStyle?: 'ours' | 'tokui';
  suppressThinking?: boolean;
}) {
  const { token } = theme.useToken();

  switch (entry.kind) {
    case 'user':
      return <UserMessageItem entry={entry} />;

    case 'assistant':
      return (
        <AssistantMessageItem
          entry={entry}
          onAction={onAction}
          renderStyle={renderStyle}
          hideThinking={suppressThinking}
        />
      );

    case 'toolResult':
      return <ToolCard run={entry.run} />;

    case 'bash':
      return (
        <Flexbox gap={6}>
          {/* The command line is the one piece of a shell entry that is code, so
              it is drawn by the same highlighter the markdown blocks use. The
              card below then reports only what the command produced — its
              arguments stay empty, so the command is not printed twice (prompt
              line and card summary) on top of the JSON that wrapped it. */}
          <Highlighter language="bash" variant="borderless" wrap showLanguage={false}>
            {`$ ${entry.command}`}
          </Highlighter>
          <ToolCard
            run={{
              toolCallId: entry.id,
              toolName: 'bash',
              args: {},
              output: entry.output,
              status: entry.streaming ? 'running' : entry.exitCode === 0 ? 'success' : 'error',
              startedAt: entry.at,
            }}
          />
        </Flexbox>
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
}: {
  transcript: TranscriptState;
  onAction?: ((action: string) => void) | undefined;
  renderStyle?: 'ours' | 'tokui';
}) {
  const { token } = theme.useToken();
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
   * Everything a collapsed turn hides, mapped back to its turn, plus the rows
   * to render: the summary row sits where the process began. While a turn is
   * running nothing is folded (folds are computed at turn end), so live
   * output always streams inline. An answer whose own reasoning folded renders
   * without its thinking row until the turn is expanded.
   *
   * A collapsed turn's rows go into ONE wrapper rather than one wrapper each:
   * zero-height flex children still charge a gap apiece, so eight folded rows
   * would leave sixty-odd pixels of blank between the summary and the answer.
   */
  const rows = useMemo(() => {
    const ownerOf = new Map<string, number>();
    const anchorTurns = new Map<string, number>();
    const entryById = new Map(transcript.entries.map((entry) => [entry.id, entry]));
    const hiddenByTurn = new Map<number, TranscriptEntry[]>();
    for (const [key, process] of Object.entries(transcript.turnProcesses)) {
      const turnId = Number(key);
      const hidden = process.hiddenIds
        .map((entryId) => entryById.get(entryId))
        .filter((entry): entry is TranscriptEntry => entry !== undefined);
      hiddenByTurn.set(turnId, hidden);
      for (const entry of hidden) ownerOf.set(entry.id, turnId);
      anchorTurns.set(process.anchorId, turnId);
    }

    const out: ReactNode[] = [];
    const announced = new Set<number>();
    const pushSummary = (turnId: number, process: TurnProcess): void => {
      if (announced.has(turnId)) return;
      announced.add(turnId);
      out.push(
        <TurnProcessRow
          key={`turn-process-${turnId}`}
          process={process}
          expanded={expandedTurns.has(turnId)}
          onToggle={() => toggleTurn(turnId)}
        />,
      );
    };

    for (const entry of transcript.entries) {
      const turnId = ownerOf.get(entry.id);
      if (turnId !== undefined) {
        const process = transcript.turnProcesses[turnId];
        if (process !== undefined && !announced.has(turnId)) {
          pushSummary(turnId, process);
          const expanded = expandedTurns.has(turnId);
          const body = hiddenByTurn.get(turnId) ?? [];
          out.push(
            <div
              key={`turn-process-body-${turnId}`}
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
                />
              ))}
            </div>,
          );
        }
        // Every entry of this turn's folded set renders inside that wrapper.
        continue;
      }

      // A fold whose only member is the answer's own reasoning hides no
      // entries; the summary still appears, right above the answer.
      const anchorTurn = anchorTurns.get(entry.id);
      const anchorProcess = anchorTurn === undefined ? undefined : transcript.turnProcesses[anchorTurn];
      if (anchorTurn !== undefined && anchorProcess) pushSummary(anchorTurn, anchorProcess);
      const suppressThinking =
        anchorTurn !== undefined &&
        !expandedTurns.has(anchorTurn) &&
        anchorProcess?.anchorThought === true;
      out.push(
        <EntryView
          key={entry.id}
          entry={entry}
          onAction={onAction}
          renderStyle={renderStyle}
          suppressThinking={suppressThinking}
        />,
      );
    }
    return out;
  }, [transcript.entries, transcript.turnProcesses, expandedTurns, toggleTurn, onAction, renderStyle]);

  const onScroll = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setStick(distance < 120);
  }, []);

  // Follow new output only while the user is already at the bottom, so reading
  // back through history is not yanked away by streaming deltas.
  useEffect(() => {
    const node = containerRef.current;
    if (!node || !stick) return;
    node.scrollTop = node.scrollHeight;
  }, [transcript.entries, stick]);

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
          {transcript.entries.length === 0 && (
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
