/**
 * 附件的持久化：内容寻址、按字节去重、重启后仍在。
 *
 * 参考 deepseek-harness 的 `dsh-attachment-local`，保留它三个承重的决定：
 *
 * 1. **按内容寻址**。id 是规范化后字节的 `sha256:`，路径由这个摘要分片得到
 *    （`objects/<前两位>/<完整摘要>`）。于是「同一张图存几遍」在文件系统层面就是同一个
 *    文件，去重不需要索引表，也不会出现两份内容互相漂移。
 * 2. **先落临时文件再独占发布**。同目录下写临时文件、fsync、再用 `link()` 原子发布：
 *    `link` 在目标已存在时失败（EEXIST），这既是崩不坏的保证，也正好是去重的判据——
 *    谁先发布谁赢，后到的直接复用。用 `rename` 会静默覆盖，把一个正在被读的对象换掉。
 * 3. **看得到的目录项才算数**。文件 fsync 之后还要 fsync 它所在的目录，否则崩溃后
 *    文件内容在、目录项没落盘，引用就指向空气。
 *
 * 摘要算的是**规范化之后**的字节：两个不同格式但内容相同的上传会规范化成同一种编码，
 * 从而落成同一个对象；这正是「去重」应该有的一层。
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AttachmentError,
  DEFAULT_ATTACHMENT_LIMITS,
  normalizeImage,
  type AttachmentLimits,
} from './normalize';

/** 已落盘的图片引用：只带元数据，不带字节。 */
export interface ImageRef {
  /** `sha256:<hex>`，规范化后字节的摘要。 */
  id: string;
  mediaType: 'image/webp' | 'image/jpeg';
  bytes: number;
  width: number;
  height: number;
  /** 客户端给的显示名；从来不当作路径解释。 */
  name?: string;
}

/** 保存结果：引用 + 规范化后的字节（调用方要拿去发给模型，避免再读一次盘）。 */
export interface SavedImage {
  ref: ImageRef;
  data: Buffer;
}

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

/**
 * 附件根目录。
 *
 * 与参考实现的 `<DSH_HOME>` 对应：pi-webx 自己的家目录，`PI_WEBX_HOME` 可覆盖。
 * 刻意**不放在项目目录**里——同一张图属于用户，不属于某个工作区，按仓库各存一份
 * 既费空间又让「换个工作区还能看到那张图」不成立。
 */
export function resolveAttachmentRoot(): string {
  const override = process.env['PI_WEBX_HOME']?.trim();
  const home = override !== undefined && override.length > 0 ? override : join(homedir(), '.pi-webx');
  return join(home, 'attachments', 'v1');
}

/** 摘要 → 分片对象路径。 */
export function objectPath(root: string, digest: string): string {
  return join(root, 'objects', digest.slice(0, 2), digest);
}

/** 校验并拆出一个 id 的摘要；形状不对就是调用方的 bug，直接拒。 */
export function digestOf(id: string): string {
  const match = ID_PATTERN.exec(id);
  if (match?.[1] === undefined) {
    throw new AttachmentError('附件引用不合法。', 'INVALID_IMAGE');
  }
  return match[1];
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 从字节头部判断媒体类型。
 *
 * 读路径刻意不用编解码器：发一张图给浏览器只需要正确的 `Content-Type`，而魔数足够
 * 可靠，也顺带证明这个对象不是随便什么东西。
 */
export function sniffMediaType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp';
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  return null;
}

/** fsync 一个目录句柄：只 fsync 文件不足以保证目录项本身落盘。 */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 规范化并存下一张入站图片。
 *
 * @param data 入站的原样字节。
 * @param declaredMediaType 调用方声明的媒体类型，与字节实际格式不符时拒绝。
 * @param limits 准入门槛与规范化预算。
 * @param name 可选的显示名。
 * @returns 引用与规范化后的字节；同字节重复保存返回同一个 id。
 */
export async function saveImage(
  data: Uint8Array,
  declaredMediaType: string,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
  name?: string,
): Promise<SavedImage> {
  const normalized = await normalizeImage(data, declaredMediaType, limits);
  const root = resolveAttachmentRoot();
  const sha = digest(normalized.data);
  const id = `sha256:${sha}`;
  const ref: ImageRef = {
    id,
    mediaType: normalized.mediaType,
    bytes: normalized.data.length,
    width: normalized.width,
    height: normalized.height,
    ...(name === undefined ? {} : { name }),
  };

  const target = objectPath(root, sha);
  const shard = join(root, 'objects', sha.slice(0, 2));

  // 已经在盘上了：同字节只存一份，直接复用（这正是内容寻址的意义）。
  if (await exists(target)) return { ref, data: normalized.data };

  await mkdir(shard, { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });

  // 临时文件与最终对象同分区，`link` 才能是原子操作。
  const staging = join(root, 'tmp', randomUUID());
  const handle = await open(staging, 'wx', 0o600);
  try {
    await handle.writeFile(normalized.data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    // 独占发布：目标已存在说明另一个写者（或上一轮）先到了，直接采用它。
    await link(staging, target);
    await chmod(target, 0o600);
    await syncDirectory(shard);
    await syncDirectory(join(root, 'objects'));
  } catch (error) {
    if (!(await exists(target))) {
      await unlink(staging).catch(() => undefined);
      throw error;
    }
  } finally {
    await unlink(staging).catch(() => undefined);
  }

  return { ref, data: normalized.data };
}

/**
 * 按引用读回字节，并在返回前复核摘要。
 *
 * 复核是刻意的：对象目录是对外可见的一块持久状态，磁盘损坏或外部误改都不该被当成
 * 「模型收到了那张图」。摘要不符即拒绝，不做降级。
 *
 * @param id `sha256:<hex>` 引用。
 * @returns 字节与由字节重新推出的媒体类型。
 */
export async function readImage(id: string): Promise<{ data: Buffer; mediaType: string }> {
  const sha = digestOf(id);
  const data = await readFile(objectPath(resolveAttachmentRoot(), sha)).catch(() => {
    throw new AttachmentError('附件不存在。', 'INVALID_IMAGE');
  });
  if (digest(data) !== sha) {
    throw new AttachmentError('附件内容与引用不一致。', 'INVALID_IMAGE');
  }
  const mediaType = sniffMediaType(data);
  if (mediaType === null) throw new AttachmentError('附件内容不是可识别的图片。', 'INVALID_IMAGE');
  return { data, mediaType };
}

/** 对象是否已经在盘上。 */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, { flag: constants.O_RDONLY });
    return true;
  } catch {
    return false;
  }
}

/** 已存对象的摘要列表（诊断与去重验证用；顺序不保证）。 */
export async function listObjects(): Promise<string[]> {
  const root = join(resolveAttachmentRoot(), 'objects');
  const shards = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    for (const entry of await readdir(join(root, shard.name))) out.push(entry);
  }
  return out;
}

/** 测试与诊断用：把一个对象直接写坏，验证读路径确实会拒绝。 */
export async function corruptForTest(id: string): Promise<void> {
  const sha = digestOf(id);
  await writeFile(objectPath(resolveAttachmentRoot(), sha), Buffer.from('corrupted'));
}

/** 入站图片的线上形状（与 `src/shared/protocol.ts` 的 `PiImage` 一致）。 */
export interface IncomingImage {
  type: 'image';
  /** base64，不带 `data:` 前缀。 */
  data: string;
  mimeType: string;
}

/** 规范化 + 落盘一批入站图片，返回可以直接交给 pi 的那份。 */
export interface PreparedImages {
  /** 规范化后的图片，调用方拿它去发给模型。 */
  images: IncomingImage[];
  /** 对应的引用（内容寻址 id 与真实尺寸），用于回显与日志。 */
  refs: ImageRef[];
}

/**
 * 把客户端附上的一批图变成能发的那种。
 *
 * 这是入站图片的唯一入口：先按单张与单条消息的门槛校验，再逐张规范化、落盘、换回
 * 规范化后的字节。调用方拿到的就已经是网关收得下的格式，不需要知道存储的存在。
 *
 * @param images 客户端给的图片，缺省视为没有。
 * @param limits 门槛与预算。
 * @returns 规范化后的图片与引用。
 * @throws AttachmentError 任一张不合规时（整条消息失败，不做部分投递）。
 */
export async function prepareIncomingImages(
  images: readonly IncomingImage[] | undefined,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): Promise<PreparedImages> {
  const list = images ?? [];
  if (list.length === 0) return { images: [], refs: [] };
  if (list.length > limits.maxImagesPerMessage) {
    throw new AttachmentError('一条消息里的图片太多了。', 'IMAGE_TOO_LARGE');
  }
  const total = list.reduce((sum, image) => sum + image.data.length, 0);
  if (total > limits.maxMessageImageBytes) {
    throw new AttachmentError('这条消息的图片总量超过上限。', 'IMAGE_TOO_LARGE');
  }

  const out: IncomingImage[] = [];
  const refs: ImageRef[] = [];
  for (const image of list) {
    const raw = Buffer.from(image.data, 'base64');
    const saved = await saveImage(raw, image.mimeType, limits);
    refs.push(saved.ref);
    out.push({
      type: 'image',
      data: saved.data.toString('base64'),
      mimeType: saved.ref.mediaType,
    });
  }
  return { images: out, refs };
}
