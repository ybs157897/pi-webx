/**
 * 失败轮次在界面上怎么说。
 *
 * 用户不需要读 `520: {"message":"Upstream model provider is temporarily
 * unavailable..."}`。但也不能什么都归成「断网」——「证据不足」「评分不可用」是
 * 教学结论，不是网络故障。所以先归因，再给一句人话，原始错误留在可展开的详情里
 * 备查。
 */

export type FailureKind = 'offline' | 'upstream' | 'timeout' | 'too-large' | 'unknown';

export interface FailureCopy {
  kind: FailureKind;
  /** 提示条上的主文案。 */
  title: string;
  /** 一句可操作的说明。 */
  detail: string;
}

/** 网关通不到后端：Vite 代理连不上本地服务时报的 502/503/504，以及浏览器的网络错误。 */
const GATEWAY = /\b50[234]\b/i;
/** 网络层面的失败：浏览器离线、连接被拒/重置、fetch 直接失败。 */
const OFFLINE = /failed to fetch|networkerror|network error|econnrefused|econnreset|socket hang up|fetch failed|连接失败|无法连接/i;
/**
 * 上游模型服务自己挂了。
 *
 * 注意这里**不含 5xx 数字本身**：本地的 502 是网关问题（上面已归到 offline），
 * 而上游的 520/500 通常带 `upstream` 或 `server_error` 字样。
 */
const UPSTREAM = /upstream|server_error|bad gateway from|temporarily unavailable|rate limit|429|overloaded/i;
const TIMEOUT = /timed?\s*out|etimeout|timeout|超时/i;
/**
 * 单次请求体超限。
 *
 * 这句人话是**服务端**写的（`server/http-errors.ts` 的
 * `PAYLOAD_TOO_LARGE_MESSAGE`）：express 在 JSON 解析阶段就把请求丢了，还没进任何
 * 路由，所以原文只有 `request entity too large` 这种英文短语，用户看不出超的是
 * 图片还是别的。两个模式都认——管线自己的拒绝说明里也会带「上限」字样。
 */
const TOO_LARGE = /超过了单次上限|payload too large|entity too large|request entity too large/i;

/** 先看网络层，再看上游，再看超时——顺序决定归因，越靠前的越具体。 */
export function classifyFailure(error: unknown): FailureKind {
  const text = typeof error === 'string' ? error : error === undefined || error === null ? '' : String(error);
  if (text.trim().length === 0) return 'unknown';
  if (GATEWAY.test(text) || OFFLINE.test(text)) return 'offline';
  if (TOO_LARGE.test(text)) return 'too-large';
  if (TIMEOUT.test(text)) return 'timeout';
  if (UPSTREAM.test(text)) return 'upstream';
  return 'upstream';
}

/**
 * 归因对应的人话。
 *
 * 标题里不出现状态码、`upstream`、`ECONN` 这些词：那是详情里的东西。
 */
export function failureCopy(error: unknown): FailureCopy {
  switch (classifyFailure(error)) {
    case 'offline':
      return {
        kind: 'offline',
        title: '连接断开了',
        detail: '检查网络或本地服务是否还在运行，然后重新发送。',
      };
    case 'upstream':
      return {
        kind: 'upstream',
        title: '模型服务暂时答不上来',
        detail: '这次不是你的问题，稍等片刻再发一次通常就好了。',
      };
    case 'timeout':
      return {
        kind: 'timeout',
        title: '这次等太久了',
        detail: '换个说法或把问题拆小一点再发一次。',
      };
    case 'too-large':
      return {
        kind: 'too-large',
        title: '这次发得太大了',
        detail: '换一张小一点的图片，或者分几次发。',
      };
    default:
      return {
        kind: 'unknown',
        title: '这次没讲完',
        detail: '重新发送一次；如果一直如此，请展开详情看看原始错误。',
      };
  }
}
