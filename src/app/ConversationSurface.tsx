/**
 * 正文区：空转写时是居中的欢迎面（含单会话/Agent Team 切换），有转写时是正文本身。
 *
 * 空转写的那个「面的位置」是有讲究的：欢迎语紧贴 composer 上方，composer 落在屏幕
 * 中部，下面那块空白就是转写将要长成的空间 —— 两种布局共用同一个子槽位，首条消息
 * 才不会把 composer 重挂（草稿会丢）。
 */
import { Flexbox } from '@lobehub/ui';

import { EmptyState } from '../components/EmptyState';
import { TranscriptView } from '../components/TranscriptView';
import { SessionCwdProvider } from '../lib/session-cwd';
import type { TranscriptState } from '../shared/transcript';
import type { RenderStyle } from './preferences';

export interface ConversationSurfaceProps {
  /** 转写为空：走欢迎面而不是正文。 */
  empty: boolean;
  sessionId: string | null;
  /** 欢迎面上的模式（只在空转写时可见）。 */
  mode: 'chat' | 'team';
  /** 空会话才有得切：有会话时模式已由会话自己记录。 */
  onModeChange: ((mode: 'chat' | 'team') => void) | undefined;
  cwd: string;
  transcript: TranscriptState;
  onAction: (action: string) => void;
  renderStyle: RenderStyle;
}

export function ConversationSurface({
  empty,
  sessionId,
  mode,
  onModeChange,
  cwd,
  transcript,
  onAction,
  renderStyle,
}: ConversationSurfaceProps) {
  if (empty) {
    return (
      <Flexbox align="center" justify="flex-end" style={{ flex: 1, minHeight: 0 }}>
        <EmptyState mode={mode} onModeChange={onModeChange} />
      </Flexbox>
    );
  }

  return (
    <Flexbox style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Keyed by session: transcript-local UI state (fold expansion)
          must not leak from one session's turn numbering to another's. */}
      <SessionCwdProvider cwd={cwd === '' ? null : cwd}>
        <TranscriptView
          key={sessionId ?? 'pending'}
          transcript={transcript}
          onAction={onAction}
          renderStyle={renderStyle}
        />
      </SessionCwdProvider>
    </Flexbox>
  );
}
