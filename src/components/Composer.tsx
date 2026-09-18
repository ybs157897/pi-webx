import { ActionIcon, Flexbox, Text, Tooltip } from '@lobehub/ui';
import { ChatInputAreaInner } from '@lobehub/ui/chat';
import { Tag, theme } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { Eraser, ImagePlus } from 'lucide-react';
import type { ClipboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatTokens } from '../lib/format';
import { IconSendOutline16, IconStopFill16 } from '../ui/primitives/icons';
import {
  catalogDefaultSelection,
  catalogLabels,
  catalogModels,
  effectiveThinkingLevel,
  offeredThinkingLevels,
  rememberedThinkingLevel,
  thinkingLevelsForModel,
} from '../lib/modelCatalog';
import type { PiSessionApi } from '../lib/usePiSession';
import type { ModelCatalog } from '../shared/model-catalog';
import type { ToolPreset } from '../shared/tool-presets';
import type { PiImage, PiSlashCommand, PiThinkingLevel } from '../shared/protocol';
import { ModelSelect, ThinkingSelect, type ModelSelection } from './ModelPicker';
import { ToolPresetSelect } from './ToolPresetSelect';
import { SlashCommandMenu } from './SlashCommandMenu';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The composer's corner radius, in px.
 *
 * The rest of the app takes antd's `borderRadiusLG` (12px), which reads square
 * on a box this tall — and this box is the one surface the product wants soft.
 * The reference design rounds roughly 0.15 of the box's height (≈19px on 127px),
 * which on this box is 18px.
 */
const COMPOSER_RADIUS = 18;

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
  /**
   * The session-independent model catalog. Used whenever the live session has
   * no catalogue of its own — which is every moment before the first message
   * creates one — so the picker is never an empty list.
   */
  catalog?: ModelCatalog | null;
  /** The active session's tool preset, when it has recorded one. */
  toolPreset?: ToolPreset | null;
  /** Change it for the active session; absent leaves only the browser preference. */
  onToolPresetChange?: ((preset: ToolPreset) => void) | undefined;
  /** context-window usage, 0–100, shown beside the send button like LobeChat */
  contextPercent?: number | null;
  /**
   * Chips shown in the bar above the input: the workspace the run happens in and
   * its branch. The shell owns them — it is the only layer that knows how to
   * change a workspace — and the composer only gives them their place, so the
   * one decision a blank session needs sits with the message about to be written.
   */
  contextBar?: ReactNode;
}

export function Composer({
  api,
  disabled,
  catalog = null,
  toolPreset = null,
  onToolPresetChange,
  contextPercent = null,
  contextBar,
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

  /**
   * Insert a slash command at the caret.
   *
   * Nothing is dispatched here: pi itself runs an extension command and expands
   * skill and template commands when the text arrives as a prompt, so the menu's
   * whole job is to put the right text in the composer for the user to finish.
   */
  const insertCommand = useCallback((command: PiSlashCommand) => {
    const snippet = `/${command.name} `;
    setText((previous) => {
      const area = inputRef.current?.resizableTextArea?.textArea;
      const start = area?.selectionStart ?? previous.length;
      const end = area?.selectionEnd ?? previous.length;
      return `${previous.slice(0, start)}${snippet}${previous.slice(end)}`;
    });
    inputRef.current?.focus();
  }, []);

  // An extension can push text into the composer via `set_editor_text`.
  useEffect(() => {
    if (editorText === null) return;
    setText(editorText);
    consumeEditorText();
    inputRef.current?.focus();
  }, [editorText, consumeEditorText]);

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

  const submit = useCallback(async () => {    const value = text.trim();
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

  /**
   * Picker inputs, layered the way dsh layers its model directory: the shared
   * catalog supplies the list, the session's own state overrides the current
   * value when there is one, and the catalog default covers the blank session.
   */
  const models = useMemo(
    () => (api.models.length > 0 ? api.models : catalogModels(catalog)),
    [api.models, catalog],
  );

  const current: ModelSelection | null = useMemo(() => {
    const live = api.piState?.model;
    return live ? { provider: live.provider, id: live.id } : catalogDefaultSelection(catalog);
  }, [api.piState?.model, catalog]);

  const labels = useMemo(() => catalogLabels(catalog), [catalog]);

  const currentModel = useMemo(
    () => models.find((model) => model.provider === current?.provider && model.id === current.id),
    [current?.id, current?.provider, models],
  );

  /**
   * What the effort control may offer.
   *
   * A live session answers with the levels its model actually accepts — the
   * bridge mirrors pi's own `getSupportedThinkingLevels`, the same rule
   * `setThinkingLevel` clamps against — so that answer is the truth. Before a
   * session exists there is nobody to ask, and the selected model's declaration
   * in the catalogue is the same fact.
   */
  const thinkingLevels = useMemo(
    () => offeredThinkingLevels(
      api.thinkingLevels.length > 0 ? api.thinkingLevels : thinkingLevelsForModel(currentModel),
    ),
    [api.thinkingLevels, currentModel],
  );

  // The session's own level is both the choice and the truth while it runs; with
  // no session, the choice is the remembered one and the effective level may
  // fall back to pi's global default — the trigger reports the latter, the pane
  // marks the former.
  const thinkingLevel = useMemo(
    () =>
      (api.piState?.thinkingLevel as PiThinkingLevel | undefined) ??
      rememberedThinkingLevel(catalog, current, currentModel),
    [api.piState?.thinkingLevel, catalog, current, currentModel],
  );

  const effectiveLevel = useMemo(
    () =>
      (api.piState?.thinkingLevel as PiThinkingLevel | undefined) ??
      effectiveThinkingLevel(catalog, current, currentModel),
    [api.piState?.thinkingLevel, catalog, current, currentModel],
  );

  const queued =
    api.transcript.queued.steering.length + api.transcript.queued.followUp.length;

  return (
    <div style={{ padding: '0 20px 16px', maxWidth: 940, margin: '0 auto', width: '100%' }}>
      <div
        style={{
          border: `1px solid ${token.colorBorder}`,
          borderRadius: COMPOSER_RADIUS,
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

        {/* The chip bar rides the same card surface as the input — dsh's
            accessory slot (`padding: 10px 12px 0`, no fill of its own) — and the
            shell only supplies it before a conversation exists: once a run has
            started, the workspace is the session's own fact and the chips are
            gone rather than repeated above every message. */}
        {contextBar !== undefined && (
          <Flexbox horizontal align="center" gap={8} style={{ padding: '10px 12px 0' }}>
            {contextBar}
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
          // `outline: none`: antd's borderless variant paints a 1px focus
          // outline on :focus-visible (the active-border color). The input sits
          // at the top of the shell, so the outline's top/left/right edges hide
          // under the shell's own border while its bottom edge cuts across the
          // card — a stray divider line that appears the moment you click in.
          style={{ padding: '10px 12px', outline: 'none' }}
        />

        {/* dsh's composer row: the left carries the attach action and whatever
            mode controls exist, the right carries the model and the send button.
            The model chip therefore sits immediately beside send, the renderer
            preference lives in settings, and send is a circular icon control
            rather than a labelled button with a key hint beside it. It is the
            same card surface as the input — dsh draws no divider here, so the
            composer reads as one box rather than an input plus a toolbar. */}
        <Flexbox
          horizontal
          align="center"
          justify="space-between"
          gap={8}
          style={{
            paddingInline: 12,
            paddingBlock: 8,
          }}
        >
          <Flexbox horizontal align="center" gap={4} style={{ minWidth: 0 }}>
            {/* dsh's left group: commands, attach, access mode. */}
            <SlashCommandMenu commands={api.commands} disabled={disabled} onPick={insertCommand} />
            <Tooltip title="附加图片">
              <ActionIcon
                icon={ImagePlus}
                size="small"
                disabled={disabled || images.length >= MAX_IMAGES}
                onClick={() => fileRef.current?.click()}
              />
            </Tooltip>
            <ToolPresetSelect
              disabled={disabled}
              current={toolPreset}
              onApply={onToolPresetChange}
            />
            {queued > 0 && (
              <Tooltip title="清空排队中的消息">
                <ActionIcon icon={Eraser} size="small" onClick={() => void api.clearQueue()} />
              </Tooltip>
            )}
          </Flexbox>

          <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0 }}>
            {contextPercent !== null && (
              <Tooltip title={`上下文已用 ${contextPercent}%`}>
                <Text fontSize={11} type="secondary" style={{ flexShrink: 0 }}>
                  {formatTokens(api.stats?.contextUsage?.tokens)} · {contextPercent}%
                </Text>
              </Tooltip>
            )}
            <ModelSelect
              models={models}
              labels={labels}
              current={current}
              disabled={disabled}
              onPick={(selection) => void api.setModel(selection.provider, selection.id)}
            />
            <ThinkingSelect
              thinkingLevels={thinkingLevels}
              thinkingLevel={thinkingLevel}
              effectiveThinkingLevel={effectiveLevel}
              disabled={disabled}
              onPick={(level) => void api.setThinkingLevel(level)}
            />
            <Tooltip title={running ? '停止' : '发送'}>
              <button
                type="button"
                aria-label={running ? '停止' : '发送消息'}
                disabled={!running && !canSend}
                onClick={() => {
                  if (running) void api.abort();
                  else if (canSend) void submit();
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  padding: 0,
                  border: 'none',
                  borderRadius: '50%',
                  background: running || canSend ? token.colorPrimary : token.colorFillSecondary,
                  color: running || canSend ? token.colorTextLightSolid : token.colorTextQuaternary,
                  cursor: running || canSend ? 'pointer' : 'not-allowed',
                  transition: 'background 0.15s ease',
                }}
              >
                {running ? <IconStopFill16 size={14} /> : <IconSendOutline16 size={16} />}
              </button>
            </Tooltip>
          </Flexbox>
        </Flexbox>
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
