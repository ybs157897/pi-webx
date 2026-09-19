/**
 * 请求出错时回给客户端什么。
 *
 * 这里只有一件事需要判断：这个错误要不要给人话。绝大多数错误照原样回
 * `error.message` 就够了——界面把原文放在可展开的详情里备查。但**超长请求体**要
 * 单独说：那是 express 在 JSON 解析阶段抛的，还没进任何路由，客户端拿到的原文是
 * `request entity too large`（英文、且没说是哪一类内容超了），而用户真正需要知道的
 * 是「图片太大或一次发得太多，换小一点或分几次」。
 *
 * 那句人话也是客户端归因的依据（见 `src/lib/failure.ts`），所以两个地方改一处要
 * 一起改——`scripts/check-image-transport.ts` 钉住了这一点。
 */

/** 超长请求体的主文案；客户端的失败归因按它识别。 */
export const PAYLOAD_TOO_LARGE_MESSAGE = '这次发送的内容超过了单次上限（图片太大或一次发得太多）。';

/**
 * 从任意错误里取 HTTP 状态码。
 * @param error - 路由或中间件抛出的错误。
 * @returns 4xx/5xx 状态码；判不出来按 500。
 */
export function statusFromError(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { status?: unknown; statusCode?: unknown });
    for (const value of [candidate.status, candidate.statusCode]) {
      if (typeof value === 'number' && value >= 400 && value <= 599) return value;
    }
  }
  return 500;
}

/**
 * 错误的原始文本。
 * @param error - 任意错误。
 * @returns `Error.message`，其它值转成字符串。
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一个错误在响应体里该写成什么。
 *
 * @param error - 路由或中间件抛出的错误。
 * @param production - 生产环境是否要把 5xx 的原文换成一句通用的话。
 * @returns 回给客户端的 `error` 字段。
 */
export function responseErrorMessage(error: unknown, production: boolean): string {
  if (statusFromError(error) === 413) return PAYLOAD_TOO_LARGE_MESSAGE;
  if (production && statusFromError(error) >= 500) return 'internal server error';
  return errorMessage(error);
}
