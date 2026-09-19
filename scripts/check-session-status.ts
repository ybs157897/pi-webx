/**
 * 侧栏前导状态点：三种状态必须分得开，且优先级固定。
 *
 * 参考 deepseek-harness 的 `sessionStatuses`：一个**卡在等用户回答**的会话
 * 必须比「正在跑」更醒目——没人回答的弹窗会让这一轮无限期停住；两者又都比
 * 「什么都没发生」重要。前导 slot 永远画一个点，不存在"没有点"的第四种情况：
 * 不画点与"状态没读出来"在界面上无法区分。
 *
 * 这条曾经反着来：磁盘上的历史会话挂的是闹钟图标，而且空闲的会话干脆不画点，
 * 于是"等确认"和"已完成"在侧栏长得一样。
 */
import assert from 'node:assert/strict';

import { sessionStatuses, type SessionNode } from '../src/components/sidebar/tree';

/** A live session node with every fact defaulted to "nothing is happening". */
function node(over: Partial<SessionNode> = {}): SessionNode {
  return {
    id: 's1',
    kind: 'live',
    title: '会话',
    running: false,
    alive: true,
    pendingInteraction: false,
    updatedAt: 0,
    ...over,
  };
}

const only = (over: Partial<SessionNode>): { state: string; label: string } => {
  const statuses = sessionStatuses(node(over));
  assert.equal(statuses.length, 1, `expected exactly one status, got ${statuses.length}`);
  return statuses[0]!;
};

// 三种状态各不相同——这就是前导图标要区分的东西。
const waiting = only({ pendingInteraction: true, running: true });
const running = only({ running: true });
const finished = only({});

assert.equal(waiting.state, 'warning', '等待用户确认 = warning');
assert.equal(running.state, 'ongoing', '正在执行 = ongoing');
assert.equal(finished.state, 'done', '空闲/已完成 = done');
assert.notEqual(waiting.state, running.state, '等待确认必须与正在执行不同');
assert.notEqual(running.state, finished.state, '正在执行必须与已完成不同');
assert.notEqual(waiting.state, finished.state, '等待确认必须与已完成不同');

// 优先级：等用户回答压过"正在跑"（两者可能同时为真）。
assert.equal(
  only({ pendingInteraction: true, running: true }).state,
  'warning',
  '等用户回答必须压过正在执行',
);

// 历史会话（磁盘上、未运行）也该是"完成"的点，而不是另一个图标。
assert.equal(only({ kind: 'stored', alive: false }).state, 'done', '历史会话 = done');

// 进程已结束是唯一保留的灰色状态：它既不是"在做"也不是"做完了"。
assert.equal(only({ alive: false }).state, 'idle', '进程已结束 = idle');

// 每个分支都必须给出一个状态：slot 永远有点。
for (const over of [
  {},
  { running: true },
  { pendingInteraction: true },
  { kind: 'stored' as const, alive: false },
  { alive: false },
]) {
  const status = only(over);
  assert.ok(
    ['done', 'warning', 'ongoing', 'error', 'idle'].includes(status.state),
    `未知状态：${status.state}`,
  );
  assert.ok(status.label.length > 0, '每个状态都要有可读标签（悬停卡与读屏用）');
}

console.log('PASS 侧栏状态点：待确认/进行中/已完成三态可分且优先级固定，slot 永远有点');
