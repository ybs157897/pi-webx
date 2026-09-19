/**
 * 图片的**传输**能不能装下图片的**准入**。
 *
 * 这条断言是补上一个真实踩过的坑：管线的准入限制写着「单图 20MiB、单条消息几百
 * MiB」，而 `express.json` 的 body 上限是 `1mb`。于是超过约 750KB 的图片根本进不
 * 了管线——express 在 JSON 解析阶段就把请求扔了，`prepareIncomingImages` 一句
 * 「哪一类超了」都没机会说，客户端只看到一个英文的 `request entity too large`。
 * 限制写在常量里、边界却由另一个模块的数字决定，靠读代码看不出来，所以钉在这里。
 *
 * 另外钉住超限时**说的话**：服务端要回一句人话，客户端要能据此归因，两边靠同一句
 * 文案对接。
 */
import assert from 'node:assert/strict';

import { DEFAULT_ATTACHMENT_LIMITS } from '../server/attachment/normalize';
import { PAYLOAD_TOO_LARGE_MESSAGE, responseErrorMessage } from '../server/http-errors';
import { JSON_BODY_LIMIT } from '../server/routes';
import { classifyFailure, failureCopy } from '../src/lib/failure';

/** `'33mb'` → 字节数；express 只认这类字符串（也认纯数字，但这里只用 mb 形态）。 */
function bodyLimitBytes(limit: string): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i.exec(limit.trim());
  assert.ok(match, `JSON_BODY_LIMIT 得是 express 认的形态，现在是 ${limit}`);
  const scale: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Number(match[1]) * scale[match[2]!.toLowerCase()]!;
}

// base64 把 3 字节写成 4 个字符，JSON 再添一点引号和转义。
const needed = Math.ceil((DEFAULT_ATTACHMENT_LIMITS.maxMessageImageBytes * 4) / 3);
const limit = bodyLimitBytes(JSON_BODY_LIMIT);
assert.ok(
  limit >= needed,
  `传输上限装不下准入上限：消息最多 ${DEFAULT_ATTACHMENT_LIMITS.maxMessageImageBytes} 字节图片，`
    + `base64 之后要 ${needed} 字节，而 JSON_BODY_LIMIT=${JSON_BODY_LIMIT}（${limit} 字节）`,
);

// 单张图也必须进得去——那是准入限制里最硬的一条。
assert.ok(
  limit >= Math.ceil((DEFAULT_ATTACHMENT_LIMITS.maxImageBytes * 4) / 3),
  '单张图片的上限必须也能整体过线，否则那条限制是摆设',
);

// 一个真实发生过的组合：3.1MB 的 PNG（alpha，宽 2600）在旧上限下直接 413。
const REAL_PHOTO = 3_100_000;
assert.ok(
  limit >= Math.ceil((REAL_PHOTO * 4) / 3),
  `一张 ${REAL_PHOTO} 字节的普通照片必须能发出去`,
);

// 超限时服务端说的是人话，而不是 express 的 `request entity too large`。
const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' });
assert.equal(responseErrorMessage(tooLarge, true), PAYLOAD_TOO_LARGE_MESSAGE);
assert.equal(responseErrorMessage(tooLarge, false), PAYLOAD_TOO_LARGE_MESSAGE, '生产与否都该给人话');
assert.match(PAYLOAD_TOO_LARGE_MESSAGE, /图片|上限/, '这句话要说明超的是图片相关的上限');
assert.ok(
  !/entity too large|413/i.test(PAYLOAD_TOO_LARGE_MESSAGE),
  '给人看的文案里不该出现 express 的英文原文',
);

// 客户端认得出这句话（两边靠它对接），并给出一条可操作的说明。
assert.equal(classifyFailure(PAYLOAD_TOO_LARGE_MESSAGE), 'too-large');
assert.equal(classifyFailure('request entity too large'), 'too-large');
const copy = failureCopy(PAYLOAD_TOO_LARGE_MESSAGE);
assert.ok(copy.detail.includes('图片'), `超限的说明要指向图片：${copy.detail}`);
assert.ok(!/\b413\b|too large/i.test(copy.title), `主文案别泄漏技术细节：${copy.title}`);

// 别的错误照旧：普通 5xx 不会被这句文案吃掉。
assert.equal(responseErrorMessage(new Error('boom'), false), 'boom');
assert.equal(responseErrorMessage(new Error('boom'), true), 'internal server error');

console.log('PASS 图片传输：body 上限装得下准入的图片预算，超限时服务端与客户端说的是同一句人话');
