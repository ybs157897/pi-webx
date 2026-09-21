/** Browser and host admission limits for inline image messages. */
export const IMAGE_LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 24 * 1024 * 1024,
} as const;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export function imageAdmissionError(
  files: readonly { size: number; type: string }[],
  existing: readonly { size: number }[] = [],
): string | null {
  if (files.some(file => !IMAGE_TYPES.some(type => type === file.type))) return '请选择 PNG、JPEG、WebP 或 GIF 图片。';
  if (files.some(file => file.size === 0)) return '图片为空，请重新选择。';
  if (files.some(file => file.size > IMAGE_LIMITS.maxImageBytes)) return '单张图片不能超过 20MB。';
  if (existing.length + files.length > IMAGE_LIMITS.maxImagesPerMessage) return '每条消息最多附加 20 张图片。';
  if ([...existing, ...files].reduce((sum, file) => sum + file.size, 0) > IMAGE_LIMITS.maxMessageImageBytes) return '每条消息的图片总量不能超过 24MB。';
  return null;
}
