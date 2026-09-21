/**
 * 侧栏前导状态点：只有"有话说"的时候才画点。
 *
 * 参考 deepseek-harness 的 `Rows.tsx`（见 `ui-workspace`）：
 *
 * ```ts
 * const showStatus = primaryStatus.state !== 'done' || row.completed
 * ```
 *
 * 一个**卡在等用户回答**的会话必须比「正在跑」更醒目——没人回答的弹窗会让这一轮
 * 无限期停住；两者又都比"结束"重要。而结束分成两种：`已完成` 是这一轮在你没看着它
 * 的时候跑完（dsh 的 `completionUnread`，绿点，点开这一行就清掉），`空闲`/`历史会话`
 * 是压根没事发生的行——它们的前导 slot 是**空的**。
 *
 * 这条曾经反着来：slot 永远画一个点，于是磁盘上的每条历史会话、每个空闲会话都顶着
 * 一个永不消失的绿点。恒亮的标记说不出任何东西，"你离开时它跑完了"和"什么都不在跑"
 * 长得一模一样。
 */
import assert from 'node:assert/strict';

import {
  sessionShowsDot,
  sessionStatuses,
  type SessionNode,
} from '../src/components/sidebar/tree';
import { observeCompletions } from '../src/components/sidebar/completion';
import type { SessionSummary } from '../src/shared/protocol';

/** A live session node with every fact defaulted to "nothing is happening". */
function node(over: Partial<SessionNode> = {}): SessionNode {
  return {
    id: 's1',
    kind: 'live',
    title: '会话',
    running: false,
    alive: true,
    pendingInteraction: false,
    completed: false,
    updatedAt: 0,
    ...over,
  };
}

const only = (over: Partial<SessionNode>): { state: string; label: string } => {
  const statuses = sessionStatuses(node(over));
  assert.equal(statuses.length, 1, `expected exactly one status, got ${statuses.length}`);
  return statuses[0]!;
};

// 四态各不相同——悬停卡与读屏都靠它们区分。
const waiting = only({ pendingInteraction: true, running: true });
const running = only({ running: true });
const finished = only({ completed: true });
const idle = only({});

assert.equal(waiting.state, 'warning', '等待用户确认 = warning');
assert.equal(running.state, 'ongoing', '正在执行 = ongoing');
assert.equal(finished.state, 'done', '跑完了但没看过 = done（绿点）');
assert.equal(idle.state, 'done', '空闲 = done，但不画点');
assert.notEqual(waiting.state, running.state, '等待确认必须与正在执行不同');
assert.equal(idle.label, '空闲', '空闲的行没有任何要做的事');
assert.equal(finished.label, '已完成', '跑完没看过的行必须与"空闲"分开说');
assert.notEqual(finished.label, idle.label, '绿点必须有一个只有它才有的标签');

// 优先级：等用户回答压过"正在跑"（两者可能同时为真）。
assert.equal(
  only({ pendingInteraction: true, running: true }).state,
  'warning',
  '等用户回答必须压过正在执行',
);

// 历史会话（磁盘上、未运行）与进程已结束都不该画点，但标签要说得清。
assert.equal(only({ kind: 'stored', alive: false }).label, '历史会话');
assert.equal(only({ alive: false }).label, '已结束');

// 画不画点：dsh 的 showStatus。
assert.equal(sessionShowsDot(node({ running: true })), true, '在跑 = 有点');
assert.equal(sessionShowsDot(node({ pendingInteraction: true })), true, '等你回答 = 有点');
assert.equal(
  sessionShowsDot(node({ completed: true })),
  true,
  '跑完没看过 = 绿点，这是唯一会画绿的"结束"',
);
assert.equal(sessionShowsDot(node({})), false, '空闲 = 空的 slot');
assert.equal(sessionShowsDot(node({ kind: 'stored', alive: false })), false, '历史会话 = 空的 slot');
assert.equal(sessionShowsDot(node({ alive: false })), false, '进程已结束 = 空的 slot');
assert.equal(
  sessionShowsDot(node({ completed: true, running: true })),
  true,
  '正在跑的行仍然有点（哪怕上一轮还没看过）',
);

// 每个分支都必须给出一个状态：悬停卡永远说得清这一行怎么了。
for (const over of [
  {},
  { running: true },
  { pendingInteraction: true },
  { completed: true },
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

console.log('PASS 侧栏状态点：仅在待确认/进行中/已完成时画点，空闲与历史留空 slot');

/* ------------------------------------- 绿点什么时候出现、什么时候消失 */

/** One live session as the polled list reports it. */
function live(id: string, streaming: boolean): SessionSummary {
  return {
    id,
    cwd: '/Users/x/work/api',
    pid: null,
    createdAt: 0,
    alive: true,
    sessionFile: null,
    sessionName: null,
    provider: null,
    model: null,
    streaming,
    pendingDialogs: 0,
    clients: 0,
  };
}

/** Run one observation pass the way the hook does: keep `running`, replace `unread`. */
let runningMap: ReadonlyMap<string, boolean> = new Map();
let unreadSet: ReadonlySet<string> = new Set();
const observe = (list: readonly SessionSummary[], current: string | null): readonly string[] => {
  const pass = observeCompletions(runningMap, unreadSet, list, current);
  runningMap = pass.running;
  unreadSet = pass.unread;
  return [...unreadSet].sort();
};

// 第一次看到列表只做基准：那一刻没有任何"刚刚跑完"可言，
// 否则每次刷新页面都会把整个侧栏点绿。
assert.deepEqual(observe([live('a', false), live('b', true)], null), [], '首次观察不产生绿点');

// b 在没被打开的时候跑完了 —— 这一个才有绿点。
assert.deepEqual(observe([live('a', false), live('b', false)], null), ['b'], '离开时跑完 = 绿点');

// 点开那一行（currentId 指向它）就把它清掉：这就是"点击事件"要做的第二件事。
assert.deepEqual(observe([live('a', false), live('b', false)], 'b'), [], '点开这一行 = 绿点消失');

// 再跑一轮又开始：绿点消失；跑完再看（哪怕没点开）也算看过。
assert.deepEqual(observe([live('a', false), live('b', true)], null), [], '重新跑起来 = 绿点消失');
assert.deepEqual(observe([live('a', false), live('b', true)], 'b'), [], '正在跑的行不画绿点');
assert.deepEqual(observe([live('a', false), live('b', false)], null), ['b'], '跑完且没看 = 绿点回来');

// 桥接重启（列表里没有它了）不能留下一个永远点不掉的绿点。
assert.deepEqual(observe([live('a', false)], null), [], '会话从列表消失 = 绿点一起走');

// 打开的就是正在跑的那一条：跑完不给绿点（dsh 的 `!isMain`）。
runningMap = new Map();
unreadSet = new Set();
assert.deepEqual(observe([live('c', true)], 'c'), [], '开始就在看它：没有"离开时跑完"');
assert.deepEqual(observe([live('c', false)], 'c'), [], '看着它跑完 = 不给绿点');

console.log('PASS 绿点生命周期：离开时跑完才出现，点开/再跑/会话消失都清掉');
