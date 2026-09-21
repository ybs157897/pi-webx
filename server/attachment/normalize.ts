/**
 * 图片规范化：把客户端附上的任何栅格变成模型路由收得下的那种。
 *
 * 参考 deepseek-harness 的附件管线（`dsh-attachment` / `dsh-attachment-local`）：
 * 上传的原样字节**不直接发**——先做准入校验，再应用 EXIF 方向、剥掉元数据与色彩
 * 配置、保留透明、把像素总量压到预算内，最后按有无 alpha 选 WebP 或 JPEG，并用一条
 * 质量阶梯取最小的那版。这既是为了体积，也是为了让网关别再拿
 * `unsupported image` 把用户合法的一张 PNG 挡回来。
 *
 * 与参考实现的两点取舍：
 * - 参考把附件当**持久对象**存起来（内容寻址、跨轮携带），本文件只管「怎么把图上
 *   传变成能发的图」这一半；存储那一半在别处，规范化先独立成可测的一块。
 * - 体积目标取不到时保留阶梯里最小的那版而不是报错：宁可发一张比目标大的图，也不
 *   因为一张图超预算就让整条消息失败。
 */
import sharp from 'sharp';
import { IMAGE_LIMITS } from '../../src/shared/attachments';
import type { Metadata, Sharp } from 'sharp';

/** 拒绝一张入站图片的原因。 */
export type AttachmentErrorCode =
  | 'INVALID_IMAGE'
  | 'IMAGE_TYPE_MISMATCH'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_TOO_MANY_PIXELS'
  | 'IMAGE_TOO_LARGE_DIMENSION';

/** 入站图片被拒。`code` 是稳定的判据，`message` 只给人看。 */
export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly code: AttachmentErrorCode,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** 准入门槛与规范化预算；默认值即参考实现的默认值。 */
export interface AttachmentLimits {
  /** 单张图片入站的编码字节上限。 */
  readonly maxImageBytes: number;
  /** 单条消息的图片张数上限。 */
  readonly maxImagesPerMessage: number;
  /** 单条消息所有图片编码字节之和的上限。 */
  readonly maxMessageImageBytes: number;
  /** 单张图解码后的像素总量上限。 */
  readonly maxImagePixels: number;
  /** 单张图任一边的上限（解码后）。 */
  readonly maxImageDimension: number;
  /** 规范化后允许的像素总量预算。 */
  readonly normalizedImageMaxPixels: number;
  /** 规范化后长边上限。 */
  readonly normalizedImageMaxDimension: number;
  /** 规范化后的编码字节目标。 */
  readonly normalizedImageMaxBytes: number;
}

/** 参考实现公布的默认门槛。 */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  ...IMAGE_LIMITS,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  normalizedImageMaxPixels: 2048 * 2048,
  normalizedImageMaxDimension: 8192,
  normalizedImageMaxBytes: 4 * 1024 * 1024,
};

/**
 * 质量阶梯：从高到低试，取第一个进得了字节目标的版本；都进不了就取最小的那版。
 * 阶梯本身来自参考实现（85/75/60），它换的是「肉眼几乎看不出」与「体积差一倍」。
 */
const QUALITY_LADDER = [85, 75, 60] as const;

/** 接受的入站格式 → 规范化的媒体类型。 */
const SUPPORTED = new Map<string, string>([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

/** 规范化产物：能直接发给模型的一张图。 */
export interface NormalizedImage {
  data: Buffer;
  /** 产物媒体类型：有 alpha 走 WebP，否则走 JPEG。 */
  mediaType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  /** 入站那张图的媒体类型，用于日志与去重键。 */
  sourceMediaType: string;
}

/**
 * EXIF 里 5–8 是「要转 90 度」的四种摆法（含镜像的那两种），摆正后宽高互换。
 * 1–4 只需不动或翻转，尺寸不变。
 */
const QUARTER_TURNS: ReadonlySet<number> = new Set([5, 6, 7, 8]);

/** 规范化后长边的像素上限：总像素预算与长边上限取小。 */
function targetSize(
  width: number,
  height: number,
  limits: AttachmentLimits,
): { width: number; height: number } | null {
  const { normalizedImageMaxPixels: budget, normalizedImageMaxDimension: maxEdge } = limits;
  if (width * height <= budget && Math.max(width, height) <= maxEdge) return null;
  // 先按总像素预算等比缩，再夹长边；两次都是「只缩不放」。
  const byBudget = Math.min(1, Math.sqrt(budget / (width * height)));
  const byEdge = Math.min(1, maxEdge / Math.max(width, height));
  const scale = Math.min(byBudget, byEdge);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * 校验并规范化一张入站图片。
 *
 * @param data 完整的编码字节。
 * @param declaredMediaType 调用方声明的媒体类型；与字节实际格式不一致时拒绝
 *   （声明与事实不符是调用方的 bug，不是可容忍的差异）。
 * @param limits 门槛与预算。
 * @returns 规范化后的图与它的真实尺寸。
 * @throws AttachmentError 准入失败时。
 */
export async function normalizeImage(
  data: Uint8Array,
  declaredMediaType: string,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): Promise<NormalizedImage> {
  if (data.byteLength === 0) throw new AttachmentError('图片是空的。', 'INVALID_IMAGE');
  if (data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('图片超过单张字节上限。', 'IMAGE_TOO_LARGE');
  }

  const input = sharp(data, { failOn: 'error', limitInputPixels: false });

  let meta: Metadata;
  try {
    meta = await input.metadata();
  } catch (cause) {
    throw new AttachmentError('图片数据无法解析。', 'INVALID_IMAGE');
  }
  const format = SUPPORTED.get(meta.format ?? '');
  if (format === undefined) {
    throw new AttachmentError('图片格式不受支持。', 'INVALID_IMAGE');
  }
  if (format !== declaredMediaType) {
    throw new AttachmentError('声明的图片类型与字节实际格式不一致。', 'IMAGE_TYPE_MISMATCH');
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) throw new AttachmentError('图片没有可用的尺寸。', 'INVALID_IMAGE');
  if (width * height > limits.maxImagePixels) {
    throw new AttachmentError('图片超过解码像素上限。', 'IMAGE_TOO_MANY_PIXELS');
  }
  if (Math.max(width, height) > limits.maxImageDimension) {
    throw new AttachmentError('图片超过单边上限。', 'IMAGE_TOO_LARGE_DIMENSION');
  }

  // 完整解码一次：头部看上去合法、像素流坏掉的图要在这里被挡住，而不是等到模型那边。
  try {
    await input.raw().toBuffer();
  } catch {
    throw new AttachmentError('图片像素数据无法解码。', 'INVALID_IMAGE');
  }

  /**
   * `rotate()` 不带参数即按 EXIF 方向摆正——这是「应用 EXIF 方向」的实现方式。
   * 不改写 `withMetadata()`，编码时就不会带 EXIF/ICC，元数据与色彩配置一并剥掉。
   *
   * 摆正之后宽高可能互换了（EXIF 5–8 就是那四种转 90 度的摆法），所以缩放框必须
   * 按**摆正后**的尺寸算：拿摆正前的尺寸去算框、再用 `fill` 去套，等于把竖着的像
   * 素硬按横框压扁——一张手机竖拍的照片会被横向拉伸一倍。`inside` 则让 sharp 自己
   * 保比例，框只当上界用。
   */
  const pipeline = sharp(data, { failOn: 'error', limitInputPixels: false }).rotate();
  const turned = meta.orientation !== undefined && QUARTER_TURNS.has(meta.orientation);
  const target = targetSize(turned ? height : width, turned ? width : height, limits);
  const resized = target === null ? pipeline : pipeline.resize({ ...target, fit: 'inside' });

  // alpha 决定编码格式：带透明的用 JPEG 会丢掉透明，那是内容损失，不是格式偏好。
  const useWebp = meta.hasAlpha === true;
  let smallest: Buffer | null = null;
  for (const quality of QUALITY_LADDER) {
    const candidate = await encode(resized, quality, useWebp);
    if (smallest === null || candidate.length < smallest.length) smallest = candidate;
    if (candidate.length <= limits.normalizedImageMaxBytes) {
      smallest = candidate;
      break;
    }
  }
  if (smallest === null) throw new AttachmentError('图片编码失败。', 'INVALID_IMAGE');

  const out = await sharp(smallest).metadata();
  return {
    data: smallest,
    mediaType: useWebp ? 'image/webp' : 'image/jpeg',
    width: out.width ?? width,
    height: out.height ?? height,
    sourceMediaType: format,
  };
}

/**
 * 用给定质量编码一版。
 *
 * 单开一条流水线而不是复用上面的 `resized`：sharp 的流水线是一次性的，多次取字节
 * 要先 `clone()`，而 clone 后各自 `toBuffer()` 才是稳定写法。
 * @param base 已完成缩放与方向处理的流水线。
 * @param quality 阶梯上这一档。
 * @param useWebp 目标格式。
 * @returns 编码后的字节。
 */
async function encode(base: Sharp, quality: number, useWebp: boolean): Promise<Buffer> {
  const clone = base.clone();
  return useWebp ? clone.webp({ quality }).toBuffer() : clone.jpeg({ quality }).toBuffer();
}
