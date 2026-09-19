/**
 * 附件的持久化：按内容去重、跨进程仍在、内容被动过就拒。
 *
 * 这三条各自都有一个具体的失败模式，所以分开钉：
 * - 同一张图存两遍 → 必须只有一个对象（否则历史里每轮都是一份新拷贝，盘会一直涨）；
 * - 存完之后**换一个进程**去读 → 必须读得到（"重启后仍在"不能只靠内存里的索引）；
 * - 对象字节被改过 → 必须拒绝（不能把损坏的内容当成"模型收到了那张图"）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

// 附件根目录按 PI_WEBX_HOME 解析，先把它指到临时目录，别碰用户真实的家目录。
const home = await mkdtemp(join(tmpdir(), 'piwebx-attachments-'));
process.env['PI_WEBX_HOME'] = home;

const { corruptForTest, listObjects, objectPath, prepareIncomingImages, readImage, resolveAttachmentRoot, saveImage } =
  await import('../server/attachment/store');

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** 一张纯色 PNG。 */
function solid(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

try {
  const root = resolveAttachmentRoot();
  assert.ok(root.startsWith(home), `附件根目录应当落在 PI_WEBX_HOME 下：${root}`);

  const source = await solid(320, 240, { r: 12, g: 90, b: 200 });
  const first = await saveImage(source, 'image/png', undefined, 'shot.png');

  // ---- 引用形状：规范化后的字节 + 内容寻址 --------------------------------
  assert.match(first.ref.id, /^sha256:[a-f0-9]{64}$/, 'id 是 sha256: 前缀的摘要');
  assert.equal(first.ref.mediaType, 'image/jpeg', '不透明图规范化为 JPEG');
  assert.equal(first.ref.bytes, first.data.length);
  assert.equal(sha256(first.data), first.ref.id.slice('sha256:'.length), 'id 就是产物字节的摘要');

  // ---- 对象落在内容寻址的路径上，且就是产物字节 --------------------------
  const sha = first.ref.id.slice('sha256:'.length);
  const path = objectPath(root, sha);
  assert.equal(path, join(root, 'objects', sha.slice(0, 2), sha), '对象路径按摘要分片');
  const onDisk = await readFile(path);
  assert.deepEqual(onDisk, first.data, '盘上的对象就是返回的产物字节');

  const afterFirst = await listObjects();
  assert.equal(afterFirst.length, 1, `第一次保存应当只有一个对象，实际 ${afterFirst.length}`);

  // ---- 去重：同一张图再存一遍，不多一个对象 ------------------------------
  const again = await saveImage(source, 'image/png');
  assert.equal(again.ref.id, first.ref.id, '同一张图必须得到同一个 id');
  assert.deepEqual(again.data, first.data, '复用时产物字节一致');
  assert.equal(
    (await listObjects()).length,
    1,
    '重复保存不该多出对象——去重靠内容寻址，不靠索引表',
  );

  // ---- 不同内容 → 不同对象 ----------------------------------------------
  const other = await saveImage(await solid(320, 240, { r: 200, g: 20, b: 20 }), 'image/png');
  assert.notEqual(other.ref.id, first.ref.id, '不同内容必须是不同对象');
  assert.equal((await listObjects()).length, 2, '第二张图应当新增一个对象');

  // ---- 跨进程读回：换一个进程照样读得到（"重启后仍在"） ------------------
  const probe = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readFile } from 'node:fs/promises';
       import { createHash } from 'node:crypto';
       const b = await readFile(${JSON.stringify(path)});
       process.stdout.write(createHash('sha256').update(b).digest('hex'));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(probe, sha, '另一个进程读到的字节摘要必须与引用一致');

  // ---- 读路径：复核摘要，内容被动过就拒 ----------------------------------
  const readBack = await readImage(first.ref.id);
  assert.deepEqual(readBack.data, first.data, '读回的就是存进去的字节');
  assert.equal(readBack.mediaType, 'image/jpeg', '媒体类型从字节头部认得出来');

  await corruptForTest(first.ref.id);
  let rejected = false;
  try {
    await readImage(first.ref.id);
  } catch {
    rejected = true;
  }
  assert.ok(rejected, '对象被改过之后读必须失败，不能降级返回');

  // 形状不合法的引用也直接拒。
  let badRef = false;
  try {
    await readImage('not-a-ref');
  } catch {
    badRef = true;
  }
  assert.ok(badRef, '不合法的引用要被拒');

  // ---- 入站入口：base64 进 → 规范化后的 base64 出 + 引用 ------------------
  const beforeInbound = (await listObjects()).length;
  const prepared = await prepareIncomingImages([
    { type: 'image', data: source.toString('base64'), mimeType: 'image/png' },
  ]);
  assert.equal(prepared.images.length, 1, '每张入站图都要有对应的产物');
  assert.equal(prepared.refs.length, 1, '每张入站图都要有引用');
  assert.equal(prepared.images[0]!.mimeType, 'image/jpeg', '交给 pi 的媒体类型是规范化后的');
  assert.equal(prepared.refs[0]!.id, first.ref.id, '同一张图复用同一个对象');
  assert.equal(
    (await listObjects()).length,
    beforeInbound,
    '入站再存一遍也不该多出对象（内容寻址去重）',
  );
  // 交给 pi 的字节就是盘上那份，别的模块不需要再读一次。
  assert.deepEqual(Buffer.from(prepared.images[0]!.data, 'base64'), first.data);
  // 空输入是合法的：没有图的消息不该因此报错。
  const none = await prepareIncomingImages(undefined);
  assert.deepEqual(none, { images: [], refs: [] }, '没有图片时应当安静地返回空');

  // ---- 临时目录不留垃圾 --------------------------------------------------
  const leftover = await readdir(join(root, 'tmp')).catch(() => []);
  assert.equal(leftover.length, 0, `临时目录应当清空，实际留下 ${leftover.length} 个文件`);

  console.log(
    'PASS 附件持久化：内容寻址去重、跨进程可读、摘要不符即拒、入站入口规范化后交给 pi、临时文件不留残余',
  );
} finally {
  await rm(home, { recursive: true, force: true });
}
