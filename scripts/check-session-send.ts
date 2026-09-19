/**
 * 发送竞态：界面以为空闲、pi 还在处理时，必须自愈成 steer，而不是甩一条红色报错。
 *
 * 判定用的是 pi 真实的拒绝形态：`success: true` + `data.accepted === false`，
 * 外加一条 `t: 'error'` 广播（agent-session.js 里那句 "Agent is already processing"）。
 */
import assert from 'node:assert/strict';
import { shouldRetryAsSteer } from '../src/lib/session-send';

const SDK_MESSAGE =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

/**
 * pi 的 preflight 拒绝：响应是成功的，只是没被接受；host 现在把原因一起带回来
 * （`data.reason`），客户端才分得清竞态与真正的拒绝。
 */
const REJECTED = {
  success: true,
  data: { accepted: false, reason: SDK_MESSAGE },
  error: undefined,
};

// 真实场景：用户点了板书上的选项，客户端以为空闲 → 裸 prompt 被拒 → 应当改 steer 重发。
assert.equal(shouldRetryAsSteer(REJECTED, undefined), true, '被拒的裸发送必须改成 steer');

// 错误响应里带 SDK 原文的形态（host 把它广播成 t:'error'，也回在 data 里）。
assert.equal(
  shouldRetryAsSteer({ success: false, data: undefined, error: SDK_MESSAGE }, undefined),
  true,
);

// 已经指定过投递方式：不再重发，避免重复入队。
assert.equal(shouldRetryAsSteer(REJECTED, 'steer'), false);
assert.equal(shouldRetryAsSteer(REJECTED, 'followUp'), false);

// 正常送达：不动。
assert.equal(
  shouldRetryAsSteer({ success: true, data: { accepted: true }, error: undefined }, undefined),
  false,
);

// 真正的拒绝（不是竞态）：不重发，让用户看到原因。
assert.equal(
  shouldRetryAsSteer(
    { success: true, data: { accepted: false, reason: 'no API key for model' }, error: undefined },
    undefined,
  ),
  false,
);

console.log('PASS 发送竞态自愈：被 preflight 拒绝的裸发送改用 steer 重发，真实拒绝不重发');
