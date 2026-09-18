import { ActionIcon, Flexbox, Icon, Markdown, Text, Tooltip } from '@lobehub/ui';
import { ChatItem } from '@lobehub/ui/chat';
import { theme } from 'antd';
import { Bot, CircleAlert, Copy, User } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useThemeMode } from 'antd-style';

import { specToTokDsl } from '../lib/tokui-dsl';
import type { AssistantEntry, UserEntry } from '../shared/transcript';
import {
  extractA2uiBlocks,
  parseA2uiBlock,
  specFromToolRun,
  stripA2uiBlocks,
  type UiSpec,
} from '../shared/uikit';
import { IconThinkOutline14 } from '../ui/primitives/index.ts';
import { LeadingGlyph } from './LeadingGlyph';
import { ToolCard } from './ToolCard';
import { TokUIView } from './tokui/TokUIView';
import { UiRenderer } from './uikit/UiRenderer';

/** Fired when a rendered component's button/form sends an action back to pi. */
export type UiActionHandler = (action: string) => void;
type RenderStyle = 'ours' | 'tokui';

/**
 * Collapsible chain-of-thought row shown above an assistant message.
 *
 * Flat, like dsh's `ReasoningRow`: no card, no fill — a 24px row whose glyph
 * carries the affordance and whose body, when open, indents under the title.
 */
function ThinkingBlock({ thinking, streaming }: { thinking: string; streaming: boolean }) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Flexbox
        horizontal
        align="center"
        gap={6}
        style={{ height: 24, cursor: 'pointer' }}
        onClick={() => setOpen((prev) => !prev)}
        onMouseEnter={() => { setHovered(true); }}
        onMouseLeave={() => { setHovered(false); }}
      >
        {/* dsh's reasoning row prefix, glyph for glyph: the harness's own think
            mark at rest, and the chevron only while hovered or open. */}
        <LeadingGlyph icon={<IconThinkOutline14 />} swap={hovered || open} />
        <Text fontSize={13} type="secondary" style={{ flexShrink: 0 }}>
          {streaming ? '思考中…' : '思考过程'}
        </Text>
        {!open && (
          <>
            <Text fontSize={13} type="secondary" style={{ flexShrink: 0, opacity: 0.45 }}>
              ·
            </Text>
            <Text fontSize={13} type="secondary" ellipsis style={{ flex: 1, minWidth: 0, opacity: 0.75 }}>
              {thinking.replace(/\s+/g, ' ').slice(0, 120)}
            </Text>
          </>
        )}
      </Flexbox>
      {open && (
        <div
          style={{
            // Indented under the title (leading box 16 + gap 6), dsh's
            // `.thinkBody` geometry.
            padding: '4px 0 4px 22px',
            maxHeight: 360,
            overflow: 'auto',
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: token.colorTextTertiary,
          }}
        >
          {thinking}
        </div>
      )}
    </div>
  );
}

export function UserMessageItem({ entry }: { entry: UserEntry }) {
  return (
    <ChatItem
      className="pi-message-item"
      avatar={{ title: '你', avatar: <User size={18} /> }}
      placement="right"
      variant="bubble"
      showTitle={false}
      // No `time` prop: LobeHub renders its timestamp row at opacity 0 (hover
      // only), and the row's 12px + 6px reserves a visible blank line.
      message={entry.text || undefined}
      renderMessage={() => (
        <Markdown variant="chat" fontSize={14}>
          {entry.text}
        </Markdown>
      )}
      belowMessage={
        entry.imageCount > 0 ? (
          <Text fontSize={11} type="secondary">
            {entry.imageCount} 张图片
          </Text>
        ) : undefined
      }
    />
  );
}

/**
 * One assistant message: markdown body, its reasoning row, and the tool rows it
 * produced. dsh's transcript carries no per-message usage footer, so neither
 * does this one — the model and ↑↓/cache figures are bookkeeping, not
 * conversation, and the live ones already sit in the status strip.
 */
export function AssistantMessageItem({
  entry,
  onAction,
  renderStyle = 'ours',
  hideThinking = false,
}: {
  entry: AssistantEntry;
  onAction?: UiActionHandler | undefined;
  renderStyle?: RenderStyle;
  /** folded turn: the answer's own reasoning row is hidden with the process */
  hideThinking?: boolean;
}) {
  const { token } = theme.useToken();
  const { isDarkMode } = useThemeMode();
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(entry.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }, [entry.text]);

  // Auto-render agent UI in place: from the render_ui tool, and from ```a2ui
  // fenced blocks in the message text (blocks are stripped so the JSON is not
  // shown twice).
  const { displayText, uiSpecs, toolCards } = useMemo(() => {
    const specs: UiSpec[] = [];
    for (const body of extractA2uiBlocks(entry.text)) {
      const spec = parseA2uiBlock(body);
      if (spec) specs.push(spec);
    }
    const cards: AssistantEntry['tools'] = [];
    for (const run of entry.tools) {
      if (run.toolName === 'render_ui') {
        const spec = specFromToolRun(run);
        if (spec) {
          specs.push(spec);
          continue;
        }
      }
      cards.push(run);
    }
    return { displayText: stripA2uiBlocks(entry.text), uiSpecs: specs, toolCards: cards };
  }, [entry.text, entry.tools]);

  const isEmpty = displayText.trim().length === 0;

  return (
    <ChatItem
      // The avatar prop must stay: the lib reads avatar.title unconditionally.
      // showAvatar={false} drops the whole leading column on desktop, so the
      // body takes the full width and no empty avatar row can appear.
      className="pi-message-item"
      avatar={{ title: 'pi', avatar: <Bot size={18} /> }}
      showAvatar={false}
      placement="left"
      variant="docs"
      showTitle={false}
      // No `time` prop: LobeHub renders its timestamp row at opacity 0 (hover
      // only), and the row's 12px + 6px reserves a visible blank line.
      message={displayText || undefined}
      renderMessage={() =>
        displayText ? (
          <Markdown variant="chat" fontSize={14} enableStream fullFeaturedCodeBlock>
            {displayText}
          </Markdown>
        ) : undefined
      }
      aboveMessage={
        !hideThinking && entry.thinking.trim().length > 0 ? (
          <ThinkingBlock thinking={entry.thinking} streaming={entry.streaming} />
        ) : undefined
      }
      error={
        entry.error
          ? { type: 'error', message: entry.error, variant: 'borderless' }
          : entry.stopReason === 'aborted'
            ? { type: 'warning', message: '已中断', variant: 'borderless' }
            : undefined
      }
      belowMessage={
        toolCards.length > 0 || uiSpecs.length > 0 || (isEmpty && entry.streaming) || displayText.length > 0 ? (
          <Flexbox gap={8} width="100%">
            {toolCards.length > 0 && (
              <Flexbox gap={8}>
                {toolCards.map((run) => (
                  <ToolCard key={run.toolCallId} run={run} />
                ))}
              </Flexbox>
            )}
            {uiSpecs.map((spec, index) =>
              renderStyle === 'tokui' ? (
                <div
                  key={String(index)}
                  style={{
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadiusLG,
                    padding: 12,
                    background: token.colorBgContainer,
                  }}
                >
                  <TokUIView
                    dsl={specToTokDsl(spec)}
                    theme={isDarkMode ? 'dark' : 'light'}
                    onAction={onAction}
                  />
                </div>
              ) : (
                <UiRenderer key={String(index)} spec={spec} onAction={onAction} />
              ),
            )}
            {isEmpty && entry.streaming && (
              <Flexbox horizontal align="center" gap={8} style={{ color: token.colorTextTertiary }}>
                <Icon icon={Bot} size={14} />
                <Text fontSize={12} type="secondary">
                  正在生成…
                </Text>
              </Flexbox>
            )}
            {displayText.length > 0 && (
              <Flexbox horizontal align="center" gap={4}>
                <Tooltip title={copied ? '已复制' : '复制'}>
                  <ActionIcon icon={Copy} size="small" onClick={onCopy} />
                </Tooltip>
                {entry.stopReason === 'length' && (
                  <Tooltip title="达到输出长度上限">
                    <Icon icon={CircleAlert} size={14} style={{ color: token.colorWarning }} />
                  </Tooltip>
                )}
              </Flexbox>
            )}
          </Flexbox>
        ) : undefined
      }
    />
  );
}
