/**
 * 发送路径上的一个真实竞态。
 *
 * 客户端的「正在执行」是**派生状态**（来自 transcript 与快照），而 pi 的
 * `isStreaming` 是它自己的运行标志；两者在轮次收尾的瞬间会不一致。此时界面以为
 * 空闲，就把 prompt 裸发出去，SDK 直接抛
 * `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') ...`
 * ——用户看到的是一条红色「pi 进程错误」，而他只是点了板书上的一个选项。
 *
 * 正确做法不是去猜客户端的 running 准不准，而是让发送**自愈**：知道对方正在忙，
 * 就用 steer 把它排进当前这一轮。用户的本意本来就是「接着说这句」。
 */
import type { PiRpcResponse } from '../shared/protocol';

/** SDK 在「正在处理」时抛出的原文（agent-session.js）。 */
const ALREADY_PROCESSING = /already processing/i;

/**
 * 这次失败要不要换成 steer 重发一次。
 *
 * @param response 发送结果；pi 的 preflight 拒绝是 `success: true` +
 *   `data.accepted === false`，不是错误响应——只看 `success` 会漏掉这条路径。
 * @param behavior 调用方原本指定的投递方式；已经指定过就不再重发。
 */
export function shouldRetryAsSteer(
  response: Pick<PiRpcResponse, 'success' | 'data' | 'error'>,
  behavior: 'steer' | 'followUp' | undefined,
): boolean {
  if (behavior !== undefined) return false;
  const accepted =
    response.data && typeof response.data === 'object' && 'accepted' in response.data
      ? (response.data as { accepted?: unknown }).accepted
      : undefined;
  if (response.success && accepted === true) return false;
  const detail = `${response.error ?? ''} ${
    response.data === undefined ? '' : JSON.stringify(response.data)
  }`;
  return ALREADY_PROCESSING.test(detail);
}
