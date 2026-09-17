import { Alert, Flexbox, Text } from '@lobehub/ui';
import { theme } from 'antd';
import { ArrowDown, Eraser } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { formatTokens } from '../lib/format';
import type { TranscriptEntry, TranscriptState } from '../shared/transcript';
import { AssistantMessageItem, UserMessageItem } from './MessageItem';
import { ToolCard } from './ToolCard';

type NoticeLevel = 'info' | 'warning' | 'error';

function levelToAlert(level: NoticeLevel): 'info' | 'warning' | 'error' {
  return level;
}

function EntryView({
  entry,
  onAction,
}: {
  entry: TranscriptEntry;
  onAction?: ((action: string) => void) | undefined;
}) {
  const { token } = theme.useToken();

  switch (entry.kind) {
    case 'user':
      return <UserMessageItem entry={entry} />;

    case 'assistant':
      return <AssistantMessageItem entry={entry} onAction={onAction} />;

    case 'toolResult':
      return <ToolCard run={entry.run} />;

    case 'bash':
      return (
        <Flexbox gap={6}>
          <Text fontSize={12} style={{ fontFamily: token.fontFamilyCode }} type="secondary">
            $ {entry.command}
          </Text>
          <ToolCard
            run={{
              toolCallId: entry.id,
              toolName: 'bash',
              args: { command: entry.command },
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
}: {
  transcript: TranscriptState;
  onAction?: ((action: string) => void) | undefined;
}) {
  const { token } = theme.useToken();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [stick, setStick] = useState(true);

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
        <Flexbox gap={20} paddingInline={20} paddingBlock={20} style={{ maxWidth: 900, margin: '0 auto' }}>
          {transcript.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} onAction={onAction} />
          ))}
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
