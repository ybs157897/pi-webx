/**
 * Content-block parsing: pi's message `content` is a bag of `text` /
 * `thinking` / `image` / `toolCall` blocks, and this module turns it into the
 * transcript's flat shapes (text, thinking, image list, tool calls, usage).
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point,
 * so nothing here is exported to consumers.
 */

import { IMAGE_LIMITS } from '../../shared/attachments';
import type { PiImage, PiToolCallBlock } from '../../shared/protocol';
import type { TranscriptUsage } from '../../shared/transcript';

import { asNumber, asRecord, asString } from './guards';

/** Text of a `text` content block, or `null` when the block is a different type. */
function textBlockText(block: unknown): string | null {
  const rec = asRecord(block);
  if (!rec || rec.type !== 'text') return null;
  return asString(rec.text) ?? '';
}

/** Text of a `thinking` content block, or `null` when the block is a different type. */
function thinkingBlockText(block: unknown): string | null {
  const rec = asRecord(block);
  if (!rec || rec.type !== 'thinking') return null;
  return asString(rec.thinking) ?? '';
}

function isImageBlock(block: unknown): boolean {
  return asRecord(block)?.type === 'image';
}

/** Normalised `toolCall` block, or `null` when the block is a different type. */
export function toolCallBlock(block: unknown): PiToolCallBlock | null {
  const rec = asRecord(block);
  if (!rec || rec.type !== 'toolCall') return null;
  const args = asRecord(rec.arguments);
  return {
    type: 'toolCall',
    id: asString(rec.id) ?? '',
    name: asString(rec.name) ?? 'unknown',
    // Copy so the entry never aliases caller-owned JSON.
    arguments: args ? { ...args } : {},
  };
}

/** Concatenate `text` blocks (join with "\n"); a plain string content is used as-is. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const text = textBlockText(block);
    if (text !== null) parts.push(text);
  }
  return parts.join('\n');
}

/** Concatenate `thinking` blocks (join with "\n"). */
export function contentThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const thinking = thinkingBlockText(block);
    if (thinking !== null) parts.push(thinking);
  }
  return parts.join('\n');
}

export function contentImageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (isImageBlock(block)) count += 1;
  }
  return count;
}

/** Media types the transcript will render; anything else is left alone. */
const RENDERABLE_IMAGE = /^image\/(png|jpeg|webp|gif)$/;
/** Ceiling on one embedded image, so a hostile payload cannot wedge the view. */
const MAX_IMAGE_CHARS = Math.ceil(IMAGE_LIMITS.maxImageBytes / 3) * 4;
/** History must retain every image accepted by the composer and host. */
const MAX_IMAGES = IMAGE_LIMITS.maxImagesPerMessage;

/**
 * The image blocks of a message, normalised to `PiImage`.
 *
 * Blocks are validated rather than trusted: content arrives from a model or a
 * tool, and an unsupported media type or an oversized payload must be dropped
 * instead of reaching an `<img>`.
 */
export function contentImages(content: unknown): PiImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .flatMap((block): PiImage[] => {
      const item = asRecord(block);
      if (
        item?.type !== 'image' ||
        typeof item.data !== 'string' ||
        item.data.length > MAX_IMAGE_CHARS ||
        typeof item.mimeType !== 'string' ||
        !RENDERABLE_IMAGE.test(item.mimeType)
      ) {
        return [];
      }
      return [{ type: 'image', data: item.data, mimeType: item.mimeType }];
    })
    .slice(0, MAX_IMAGES);
}

export function contentToolCalls(content: unknown): PiToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: PiToolCallBlock[] = [];
  for (const block of content) {
    const call = toolCallBlock(block);
    if (call) calls.push(call);
  }
  return calls;
}

/** Map pi's provider usage onto the transcript's usage shape. */
export function toUsage(usage: unknown): TranscriptUsage | undefined {
  const rec = asRecord(usage);
  if (!rec) return undefined;
  const input = asNumber(rec.input) ?? 0;
  const output = asNumber(rec.output) ?? 0;
  const cacheRead = asNumber(rec.cacheRead) ?? 0;
  const cacheWrite = asNumber(rec.cacheWrite) ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: asNumber(rec.totalTokens) ?? input + output,
    cost: asNumber(asRecord(rec.cost)?.total) ?? 0,
  };
}
