/**
 * 图片规范化：上传的原样字节必须变成模型收得下的那张图。
 *
 * 这条链子上的每一环都有一个具体的失败模式，所以每环单独钉一条断言：
 * - 一张合法的 PNG 曾被网关以 `unsupported image` 挡回来 → 产物必须是 WebP/JPEG；
 * - 手机竖拍的照片带 EXIF 方向 → 像素要按方向摆正，而不是发一张躺倒的图；
 * - 原图带 EXIF/ICC → 产物不该把元数据和色彩配置继续带着走；
 * - 4000px 的截图 → 要压进总像素预算；
 * - 带透明的图 → 走 WebP，不能被 JPEG 抹平；
 * - 声明类型与字节不符 / 空图 / 超像素 → 在入站就拒掉，不要等到模型那边报错。
 */
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  AttachmentError,
  DEFAULT_ATTACHMENT_LIMITS,
  normalizeImage,
  type AttachmentLimits,
} from '../server/attachment/normalize';

/** 一张纯色图，可指定尺寸与是否带透明通道。 */
function solid(
  width: number,
  height: number,
  alpha = false,
): Promise<Buffer> {
  const channels = alpha ? 4 : 3
  return sharp({
    create: {
      width,
      height,
      channels,
      background: alpha
        ? { r: 10, g: 120, b: 220, alpha: 0.5 }
        : { r: 10, g: 120, b: 220 },
    },
  })
    .png()
    .toBuffer()
}

/** 断言这次调用因 `code` 被拒。 */
async function rejects(code: AttachmentError['code'], run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof AttachmentError, `期望 AttachmentError，实际是 ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`期望以 ${code} 被拒，但它通过了`)
}

// ---- 产物格式：网关只收 WebP/JPEG，PNG 原样发会被挡回来 ----------------------
const opaquePng = await solid(800, 600)
const opaque = await normalizeImage(opaquePng, 'image/png')
assert.equal(opaque.mediaType, 'image/jpeg', '不透明图走 JPEG')
assert.equal(opaque.sourceMediaType, 'image/png')
assert.equal((await sharp(opaque.data).metadata()).format, 'jpeg')

// ---- 透明保留：有 alpha 就必须走 WebP --------------------------------------
const alphaPng = await solid(400, 400, true)
const alpha = await normalizeImage(alphaPng, 'image/png')
assert.equal(alpha.mediaType, 'image/webp', '带透明的图走 WebP，JPEG 会抹掉透明')
assert.equal((await sharp(alpha.data).metadata()).format, 'webp')

// ---- EXIF 方向：竖拍的照片要摆正，而不是发一张躺倒的图 ----------------------
// orientation=6 表示「顺时针转 90 度才是正确方向」；产物尺寸应当互换。
const rotatedSource = await sharp({
  create: { width: 1200, height: 600, channels: 3, background: { r: 5, g: 5, b: 5 } },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer()
const rotated = await normalizeImage(rotatedSource, 'image/jpeg')
assert.equal(rotated.width, 600, `EXIF 方向没应用：宽应为 600，实际 ${rotated.width}`)
assert.equal(rotated.height, 1200, `EXIF 方向没应用：高应为 1200，实际 ${rotated.height}`)

// ---- 大图 + EXIF 方向：摆正之后还要缩，别把竖的压成横的 ----------------------
// 上面那张小图不进缩放（1200×600 在预算里），所以它测不到「缩放框是按摆正前还是
// 摆正后的尺寸算的」。真实踩到的坑正是这个组合：手机竖拍的照片既有 EXIF 方向、又
// 大到必须缩，缩放框按摆正前的横尺寸算 + `fill` 套框，结果像素被横向拉伸一倍。
const bigRotated = await sharp({
  create: { width: 2600, height: 1800, channels: 3, background: { r: 10, g: 20, b: 30 } },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer()
const bigOut = await normalizeImage(bigRotated, 'image/jpeg')
assert.equal(bigOut.mediaType, 'image/jpeg', '不透明的图仍走 JPEG');
assert.ok(
  bigOut.width < bigOut.height,
  `竖拍的照片摆正后应当是竖的，实际 ${bigOut.width}x${bigOut.height}`,
);
assert.ok(
  bigOut.width * bigOut.height <= 2048 * 2048,
  `缩放后要进像素预算，实际 ${bigOut.width * bigOut.height}`,
);
// 比例必须跟「摆正后」的原图一致（1800:2600），差一点是取整，差一倍就是被压扁了。
const aspect = bigOut.width / bigOut.height;
const wanted = 1800 / 2600;
assert.ok(
  Math.abs(aspect - wanted) < 0.01,
  `长宽比走样：产物 ${bigOut.width}x${bigOut.height}（${aspect.toFixed(3)}），摆正后应为 ${wanted.toFixed(3)}`,
);

// ---- 元数据剥离：产物不再携带 EXIF/ICC ------------------------------------
const outMeta = await sharp(rotated.data).metadata()
assert.equal(outMeta.exif, undefined, 'EXIF 不该出现在产物里')
assert.equal(outMeta.icc, undefined, 'ICC 色彩配置不该出现在产物里')

// ---- 缩放：4000px 的图要压进总像素预算 ------------------------------------
const huge = await solid(4000, 3000)
const shrunk = await normalizeImage(huge, 'image/png')
assert.ok(
  shrunk.width * shrunk.height <= DEFAULT_ATTACHMENT_LIMITS.normalizedImageMaxPixels,
  `像素总量没进预算：${shrunk.width}x${shrunk.height}`,
)
assert.ok(
  shrunk.width < 4000 && shrunk.height < 3000,
  `没有缩小：${shrunk.width}x${shrunk.height}`,
)
assert.ok(
  Math.max(shrunk.width, shrunk.height) <= DEFAULT_ATTACHMENT_LIMITS.normalizedImageMaxDimension,
  '长边超过了长边上限',
)
// 默认值下**绑定的是总像素预算**（2048²），长边上限 8192 不是这一档的约束：
// 4000x3000 按预算缩到约 2365x1774，长边大于 2048 是正确的。
assert.ok(
  Math.max(shrunk.width, shrunk.height) > 2048,
  '总像素预算绑定时长边会大于 2048 —— 若这里不成立，说明缩放规则被改了',
)
// 长边上限自己绑定时才夹到它。
const edgeCapped = await normalizeImage(huge, 'image/png', {
  ...DEFAULT_ATTACHMENT_LIMITS,
  normalizedImageMaxPixels: Number.MAX_SAFE_INTEGER,
  normalizedImageMaxDimension: 1000,
})
assert.equal(Math.max(edgeCapped.width, edgeCapped.height), 1000, '长边上限绑定时要夹到上限')
// 只缩不放：小图保持原尺寸。
const small = await normalizeImage(await solid(120, 90), 'image/png')
assert.equal(small.width, 120)
assert.equal(small.height, 90)

// ---- 字节目标：一个很小的目标会逼出阶梯里更低的一档 ------------------------
const tight: AttachmentLimits = { ...DEFAULT_ATTACHMENT_LIMITS, normalizedImageMaxBytes: 3_000 }
const noisy = await sharp({
  create: { width: 900, height: 900, channels: 3, background: { r: 128, g: 128, b: 128 } },
})
  .png()
  .toBuffer()
const squeezed = await normalizeImage(noisy, 'image/png', tight)
const squeezedMeta = await sharp(squeezed.data).metadata()
assert.ok(squeezedMeta.format === 'jpeg')
// 阶梯走到底也进不了目标时保留最小的一版，而不是报错。
assert.ok(squeezed.data.length > 0)

// ---- 准入：入站就把坏输入挡住 ---------------------------------------------
await rejects('IMAGE_TYPE_MISMATCH', () => normalizeImage(opaquePng, 'image/jpeg'))
await rejects('INVALID_IMAGE', () => normalizeImage(Buffer.alloc(0), 'image/png'))
await rejects('INVALID_IMAGE', () => normalizeImage(Buffer.from('not an image'), 'image/png'))
await rejects('IMAGE_TOO_LARGE', () =>
  normalizeImage(opaquePng, 'image/png', { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 10 }),
)
await rejects('IMAGE_TOO_MANY_PIXELS', () =>
  normalizeImage(huge, 'image/png', { ...DEFAULT_ATTACHMENT_LIMITS, maxImagePixels: 100 }),
)
await rejects('IMAGE_TOO_LARGE_DIMENSION', () =>
  normalizeImage(huge, 'image/png', { ...DEFAULT_ATTACHMENT_LIMITS, maxImageDimension: 100 }),
)

console.log(
  'PASS 图片规范化：不透明→JPEG、透明→WebP、EXIF 方向已应用、元数据已剥、像素进预算、坏输入在入站被拒',
)
