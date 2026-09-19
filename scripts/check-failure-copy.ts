/**
 * 失败归因：用户看到的必须是「连接断开了」这类人话，而不是 5xx 原文。
 *
 * 但也不能什么都归成断网——「证据不足」是教学结论，不是网络故障。这个脚本把
 * 真实出现过的错误串都钉住。
 */
import assert from 'node:assert/strict';
import { classifyFailure, failureCopy } from '../src/lib/failure';

/** 真实案例：上游模型服务自己挂了。 */
const REAL_UPSTREAM =
  '520: {"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"server_error"}';

assert.equal(classifyFailure(REAL_UPSTREAM), 'upstream');

// dev 环境里 Vite 代理连不上本地后端时的报错。
assert.equal(classifyFailure('502 Bad Gateway'), 'offline');
assert.equal(classifyFailure('Failed to fetch'), 'offline');
assert.equal(classifyFailure('connect ECONNREFUSED 127.0.0.1:8787'), 'offline');
assert.equal(failureCopy('502 Bad Gateway').title, '连接断开了');

assert.equal(classifyFailure('ETIMEDOUT'), 'timeout');
assert.equal(classifyFailure('Request timed out after 60000ms'), 'timeout');

// 判不出来就退回通用说法：不硬说成断网。
assert.equal(classifyFailure(''), 'unknown');
assert.equal(classifyFailure(null), 'unknown');

// 标题里不泄漏技术细节。
for (const error of [REAL_UPSTREAM, '502 Bad Gateway', 'ETIMEDOUT', 'mystery']) {
  const copy = failureCopy(error);
  assert.ok(copy.detail.length > 0, `${copy.kind} 缺少可操作说明`);
  assert.ok(
    !/\b\d{3}\b|upstream|ECONN/i.test(copy.title),
    `${copy.kind} 的主文案泄漏了技术细节：${copy.title}`,
  );
}

console.log('PASS 失败归因：断网/上游/超时/未知各有各的人话，标题不泄漏技术细节');
