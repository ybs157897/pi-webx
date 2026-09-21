/**
 * 侧栏排序：会话按「最后一次说话」排，不按「桥接什么时候把它捡起来」排。
 *
 * 参考 deepseek-harness：
 *
 * ```ts
 * function updatedAt(header, metadata) { return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0) }
 * ```
 *
 * 列表由这个键排序（`orderByRecency`：新的在前，id 兜底）。pi-webx 之前用的是两个
 * 「开始」时间：
 *
 *   - 活会话：桥接进程对象的 `createdAt`；
 *   - 历史会话：转写文件头的 `startedAt`。
 *
 * 后果就是本条要钉住的回归——点开一条几个月前的旧会话，桥接为它铸一个**新的**会话
 * 对象，那一行立刻跳到列表顶部、挂着「刚刚」，把真正最近的会话挤到「展开其余 N 条」
 * 后面；磁盘上按 `startedAt` 排的历史会话同样把「很久以前开始、今天还在用」的会话
 * 当成旧的。
 *
 * 现在两种行共用一个时钟：转写里最后一条 `role: "user"` 的时间（`lastPromptAt`），
 * 活会话宿主的转写就借它自己的时间，没有转写可读时才退回 `createdAt`。
 */
import assert from 'node:assert/strict';

import {
  deriveFlat,
  deriveGroups,
  deriveSearchResults,
  storedNode,
  type WorkspaceItem,
} from '../src/components/sidebar/tree';
import type { SessionSummary, StoredSession } from '../src/shared/protocol';
import { lastPromptAtFromTail } from '../server/stored-sessions';

const DAY = 24 * 60 * 60 * 1000;
/** A fixed "now" so the numbers below read as dates, not as arithmetic. */
const NOW = Date.parse('2026-09-21T14:00:00.000Z');
const OLD = NOW - 30 * DAY;

const WORKSPACE = '/Users/x/work/api';
const workspace: WorkspaceItem = {
  key: WORKSPACE,
  title: 'api',
  isCurrent: true,
  isDefault: true,
};

/* ---------------------------------------------- 转写尾部 → 最后一次提问 */

const line = (value: unknown): string => JSON.stringify(value);

// 最后一条 user 消息胜出；assistant / toolResult / 记账条目都不算数。
const tail = [
  line({ type: 'session', timestamp: '2026-08-01T00:00:00.000Z' }),
  line({ type: 'custom', customType: 'pi-webx:tool-selection', timestamp: '2026-09-21T13:59:00.000Z' }),
  line({ type: 'message', timestamp: '2026-09-21T10:00:00.000Z', message: { role: 'user', content: '早上好' } }),
  line({ type: 'message', timestamp: '2026-09-21T10:00:05.000Z', message: { role: 'assistant', content: '早' } }),
  line({ type: 'message', timestamp: '2026-09-21T10:00:06.000Z', message: { role: 'toolResult', content: 'ok' } }),
].join('\n');

assert.equal(
  lastPromptAtFromTail(tail),
  Date.parse('2026-09-21T10:00:00.000Z'),
  '最后一次提问 = 最后一条 user 消息的时间；记账条目与 assistant/toolResult 都不是提问',
);

// 写到一半的最后一行要跳过，而不是把整个尾部判成损坏。
const half = '{"type":"message","timestamp":"2026-09-21T11:00:00.000Z","message":{"role":"use';
assert.equal(
  lastPromptAtFromTail(`${tail}\n${half}`),
  Date.parse('2026-09-21T10:00:00.000Z'),
  '写入中的半行必须跳过，取上一条完整提问',
);

// 从窗口中段开始的半行（尾部窗口切在一条消息中间）同样要跳过。
const cut = line({ type: 'message', timestamp: '2026-09-21T12:00:00.000Z', message: { role: 'user', content: 'x' } });
assert.equal(
  lastPromptAtFromTail(`"...image":"AAAA"}\n${cut}`),
  Date.parse('2026-09-21T12:00:00.000Z'),
  '被窗口切掉的半行不能影响结果',
);

// 一条提问都没有的转写：没有可用的 lastPromptAt。
assert.equal(lastPromptAtFromTail(line({ type: 'session', timestamp: '2026-08-01T00:00:00.000Z' })), null);
assert.equal(lastPromptAtFromTail(''), null);

/* ------------------------------------------------- 历史转写：用 updatedAt */

const stored = (over: Partial<StoredSession> = {}): StoredSession => ({
  path: `${WORKSPACE}/.pi/session-a.jsonl`,
  id: 'a',
  cwd: WORKSPACE,
  startedAt: new Date(OLD).toISOString(),
  updatedAt: NOW,
  sizeBytes: 1,
  preview: '很久以前开始、今天还在用',
  ...over,
});

assert.equal(
  storedNode(stored()).updatedAt,
  NOW,
  '历史会话的排序键是"最后活动"，不是文件头的"开始时间"',
);
assert.equal(
  storedNode(stored({ updatedAt: Number.NaN })).updatedAt,
  OLD,
  '缺 updatedAt 的旧载荷退回 startedAt，不能变成 0（那会让它掉到列表最底）',
);

/* ------------------------------------- 点开旧会话：不能跳到"刚刚" */

const live = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'a',
  cwd: WORKSPACE,
  pid: null,
  // 桥接刚刚为这条旧会话铸的对象 —— 曾经的排序键就是这个值。
  createdAt: NOW,
  alive: true,
  sessionFile: `${WORKSPACE}/.pi/session-a.jsonl`,
  sessionName: null,
  provider: 'cmdc',
  model: 'deepseek/deepseek-v4.1-chat',
  streaming: false,
  pendingDialogs: 0,
  clients: 0,
  ...over,
});

const resumedOld = stored({ id: 'a', updatedAt: OLD, preview: '旧会话' });
const freshStored = stored({
  id: 'b',
  path: `${WORKSPACE}/.pi/session-b.jsonl`,
  startedAt: new Date(NOW - DAY).toISOString(),
  updatedAt: NOW,
  preview: '刚刚用过的会话',
});

const groups = deriveGroups(
  [workspace],
  [live({ id: 'a' })],
  [resumedOld, freshStored],
  'a',
  { [WORKSPACE]: true },
  {},
  new Set(),
);
const rows = groups[0]?.sessions ?? [];

assert.equal(rows.length, 2, '宿主的转写只留活行，不该出现两条代表同一场对话');
assert.equal(
  rows[0]?.id,
  `stored:${freshStored.path}`,
  '点开旧会话之后，顶部必须是真正最近的那一条 —— 桥接的 createdAt 不是排序依据',
);
assert.equal(rows[1]?.updatedAt, OLD, '旧会话留在它自己的时间上（借它转写的最后提问时间）');
assert.equal(rows[1]?.kind, 'live', '这一行仍然是活会话的行（同一场对话只有一个身份）');

// 没有转写可读的新会话（第一条消息还在路上）：退回 createdAt，仍然排在最前。
const brandNew = live({ id: 'c', sessionFile: null, createdAt: NOW });
const withNew = deriveGroups(
  [workspace],
  [brandNew],
  [freshStored],
  'c',
  { [WORKSPACE]: true },
  {},
  new Set(),
);
assert.equal(
  withNew[0]?.sessions[0]?.id,
  'c',
  '没有转写的新会话按桥接创建时间排在最前：它确实是最新的',
);

/* --------------------------------------------------- 扁平表与搜索结果 */

const flat = deriveFlat([live({ id: 'a' })], [resumedOld, freshStored], {}, new Set());
assert.deepEqual(
  flat.map(row => row.id),
  [`stored:${freshStored.path}`, 'a'],
  '扁平列表用同一个时钟：历史行与活行按同一个 recency 交错',
);

const results = deriveSearchResults([workspace], [live({ id: 'a' })], [resumedOld, freshStored], '', new Set());
assert.deepEqual(results, [], '空查询没有结果');

const found = deriveSearchResults(
  [workspace],
  [live({ id: 'a' })],
  [resumedOld, freshStored],
  '会话',
  new Set(),
);
assert.deepEqual(
  found.map(row => row.id),
  [`stored:${freshStored.path}`, 'a'],
  '搜索结果也必须按同一个 recency 排在最前，而不是"先活行后历史行"',
);

console.log('PASS 侧栏排序：活行/历史行共用一个 recency（最后提问时间），点开旧会话不再跳到顶部');
