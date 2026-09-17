import { ActionIcon, Flexbox, Text, Tooltip } from '@lobehub/ui';
import { ChatInputAreaInner, ChatSendButton } from '@lobehub/ui/chat';
import { Tag, theme } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { Eraser, ImagePlus } from 'lucide-react';
import type { ClipboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatTokens } from '../lib/format';
import type { PiSessionApi } from '../lib/usePiSession';
import type { PiImage, PiThinkingLevel } from '../shared/protocol';
import { ModelSelectV3, type ModelSelection } from './ModelSelectV3';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function fileToImage(file: File): Promise<PiImage | null> {
  if (!file.type.startsWith('image/')) return null;
  if (file.size > MAX_IMAGE_BYTES) return null;
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + CHUNK));
  }
  return { type: 'image', data: btoa(binary), mimeType: file.type };
}

export interface ComposerProps {
  api: PiSessionApi;
  disabled: boolean;
  /** context-window usage, 0–100, shown beside the send button like LobeChat */
  contextPercent?: number | null;
  /** text injected from outside (empty-state suggestions); consumed once */
  seedText?: string | null;
  onSeedConsumed?: () => void;
}

export function Composer({
  api,
  disabled,
  contextPercent = null,
  seedText = null,
  onSeedConsumed,
}: ComposerProps) {
  const { token } = theme.useToken();
  const [text, setText] = useState('');
  const [images, setImages] = useState<PiImage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<TextAreaRef | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const running = api.transcript.running;
  const canSend = !disabled && text.trim().length > 0;
  const { editorText, consumeEditorText } = api;

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 4_000);
  }, []);

  // An extension can push text into the composer via `set_editor_text`.
  useEffect(() => {
    if (editorText === null) return;
    setText(editorText);
    consumeEditorText();
    inputRef.current?.focus();
  }, [editorText, consumeEditorText]);

  // Suggestions from the empty state land in the composer for editing.
  useEffect(() => {
    if (seedText === null) return;
    setText(seedText);
    onSeedConsumed?.();
    inputRef.current?.focus();
  }, [seedText, onSeedConsumed]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const incoming = await Promise.all(Array.from(files).map(fileToImage));
      const accepted = incoming.filter((image): image is PiImage => image !== null);
      if (accepted.length === 0) {
        flash(`仅支持小于 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 的图片`);
        return;
      }
      setImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES));
    },
    [flash],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files);
    },
    [addFiles],
  );

  const submit = useCallback(async () => {
    const value = text.trim();
    if (value.length === 0 || disabled) return;
    // While a turn is running pi rejects a bare prompt; steer instead so the
    // message lands right after the current tool calls.
    const response = await api.prompt(value, {
      ...(images.length > 0 ? { images } : {}),
      ...(running ? { behavior: 'steer' as const } : {}),
    });
    if (!response.success) {
      flash(response.error ?? '发送失败');
      return;
    }
    setText('');
    setImages([]);
  }, [api, disabled, flash, images, running, text]);

  const current: ModelSelection | null = useMemo(() => {
    const model = api.piState?.model;
    return model ? { provider: model.provider, id: model.id } : null;
  }, [api.piState?.model]);

  const queued =
    api.transcript.queued.steering.length + api.transcript.queued.followUp.length;

  return (
    <div style={{ padding: '0 20px 16px', maxWidth: 940, margin: '0 auto', width: '100%' }}>
      <div
        style={{
          border: `1px solid ${token.colorBorder}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
          overflow: 'hidden',
        }}
      >
        {(images.length > 0 || notice !== null) && (
          <Flexbox horizontal align="center" gap={6} paddingInline={10} paddingBlock={6} wrap="wrap">
            {images.map((image, index) => (
              <Tag
                key={`${image.mimeType}-${String(index)}`}
                closable
                onClose={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                style={{ fontSize: 11 }}
              >
                图片 {index + 1}
              </Tag>
            ))}
            {notice !== null && (
              <Text fontSize={11} style={{ color: token.colorWarning }}>
                {notice}
              </Text>
            )}
          </Flexbox>
        )}

        <ChatInputAreaInner
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onSend={() => {
            if (canSend) void submit();
          }}
          onPaste={onPaste}
          disabled={disabled}
          placeholder={
            disabled
              ? '请先创建一个会话'
              : running
                ? '执行中 — 回车把消息排队（steer）'
                : '给 pi 派活…回车发送，Shift+回车换行'
          }
          autoSize={{ minRows: 2, maxRows: 14 }}
          style={{ padding: '10px 12px' }}
        />

        <ChatSendButton
          loading={running}
          onSend={() => {
            if (canSend) void submit();
          }}
          onStop={() => void api.abort()}
          texts={{ send: '发送', stop: '停止', warp: '换行' }}
          leftAddons={
            <ModelSelectV3
              models={api.models}
              current={current}
              thinkingLevels={api.thinkingLevels}
              thinkingLevel={(api.piState?.thinkingLevel ?? null) as PiThinkingLevel | null}
              disabled={disabled}
              onPick={(selection) => void api.setModel(selection.provider, selection.id)}
              onPickThinking={(level) => void api.setThinkingLevel(level)}
            />
          }
          rightAddons={
            <Flexbox horizontal align="center" gap={8}>
              <Tooltip title="附加图片">
                <ActionIcon
                  icon={ImagePlus}
                  size="small"
                  disabled={disabled || images.length >= MAX_IMAGES}
                  onClick={() => fileRef.current?.click()}
                />
              </Tooltip>
              {contextPercent !== null && (
                <Tooltip title={`上下文已用 ${contextPercent}%`}>
                  <Text fontSize={11} type="secondary" style={{ flexShrink: 0 }}>
                    {formatTokens(api.stats?.contextUsage?.tokens)} · {contextPercent}%
                  </Text>
                </Tooltip>
              )}
              {queued > 0 && (
                <Tooltip title="清空排队中的消息">
                  <ActionIcon icon={Eraser} size="small" onClick={() => void api.clearQueue()} />
                </Tooltip>
              )}
            </Flexbox>
          }
          style={{
            paddingInline: 12,
            paddingBlock: 8,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
          }}
        />
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) void addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {queued > 0 && (
        <Flexbox horizontal align="center" gap={6} paddingBlock={6} wrap="wrap">
          {api.transcript.queued.steering.map((message, index) => (
            <Tag key={`steer-${String(index)}`} color="processing" style={{ fontSize: 11 }}>
              排队：{message.slice(0, 40)}
            </Tag>
          ))}
          {api.transcript.queued.followUp.map((message, index) => (
            <Tag key={`follow-${String(index)}`} style={{ fontSize: 11 }}>
              稍后：{message.slice(0, 40)}
            </Tag>
          ))}
        </Flexbox>
      )}
    </div>
  );
}
