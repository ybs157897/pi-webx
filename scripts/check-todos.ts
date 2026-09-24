/**
 * `src/lib/todos.ts` 的钉子：任务表投影的每一条判定都在这里钉死。
 *
 * 这层是面板与工具卡共用的唯一事实来源，它错了两个界面一起错。所以这里不测渲染，
 * 只测「一段会话记录，最后该显示哪张任务表」：
 *   - 新形态（整表替换 `{todos:[{content,status}]}`）是主路径；
 *   - 旧形态（`pi-deck-todo` 的 `{action,todos:[{id,text,done}]}`）必须仍能诚实回放；
 *   - 最后一次成功调用说了算（last-write-wins），失败的调用不得改写面板；
 *   - widget 文本行只在结构化数据缺失时兜底，且行数与表头不符就整张作废（不猜）。
 */
import assert from 'node:assert/strict';
import {
  latestTodos,
  parseTodoList,
  planCounts,
  planSummary,
  progressLabel,
  todoItemsFromArgs,
  todoItemsFromWidgetLines,
  TODO_STATUSES,
  TODO_TOOL_NAME,
  TODO_WIDGET_KEYS,
  type TodoItem,
} from '../src/lib/todos';
import type { ToolRun, TranscriptEntry } from '../src/shared/transcript';

/* ------------------------------------------------------------------ 词表 */

assert.deepEqual(
  [...TODO_STATUSES],
  ['pending', 'in_progress', 'completed'],
  '三态词表变了：dsh 的 todo 工具就是这三个状态，改名/改序都会让面板与模型对不上',
);
assert.equal(TODO_TOOL_NAME, 'todo', '工具名变了：扩展注册的名字与这里的投影必须同名');
assert.deepEqual(
  [...TODO_WIDGET_KEYS],
  ['pi-webx-todo', 'pi-deck-todo'],
  'widget key 表变了：新扩展的 key 与旧扩展的兜底 key 都必须被面板接管',
);

/* -------------------------------------------------------------- 快照归一 */

assert.deepEqual(
  parseTodoList({
    todos: [
      { content: '写第一个小故事', status: 'completed' },
      { content: ' 写第二个小故事 ', status: 'in_progress' },
      { content: '写第三个小故事', status: 'pending' },
    ],
  }),
  [
    { content: '写第一个小故事', status: 'completed' },
    { content: '写第二个小故事', status: 'in_progress' },
    { content: '写第三个小故事', status: 'pending' },
  ],
  '新形态整表归一失败：content 去空白、状态原样保留是最基本的契约',
);

// 空表是「清单被清空」这个事实，不是「没有快照」——两者不能混。
assert.deepEqual(parseTodoList({ todos: [] }), [], '空表被当成缺失了：清空任务后面板必须消失');

// 旧形态（pi-deck-todo）：done:boolean 要映射成三态，text 要映射成 content。
assert.deepEqual(
  parseTodoList({
    action: 'toggle',
    todos: [
      { id: 1, text: '写第一个小故事', done: true },
      { id: 2, text: '写第二个小故事', done: false },
    ],
    nextId: 3,
  }),
  [
    { content: '写第一个小故事', status: 'completed' },
    { content: '写第二个小故事', status: 'pending' },
  ],
  '旧 pi-deck-todo 的详情（{action,todos:[{id,text,done}]}）回放失败：旧会话的面板会凭空消失',
);

// 坏项只丢一项，不把整张快照作废：整表是模型给的完整状态，丢一项好过显示旧状态。
assert.deepEqual(
  parseTodoList({
    todos: [
      { content: '好的', status: 'pending' },
      { content: '   ', status: 'pending' },
      { content: '没有状态' },
      { content: '状态是假的', status: 'doing' },
      'not-an-object',
    ],
  }),
  [{ content: '好的', status: 'pending' }],
  '坏项处理变了：空内容/缺状态/未知状态的项要被丢掉，合格的项必须留下',
);

// 形态根本不对 = 没有快照。
for (const value of [null, undefined, 42, 'text', {}, { todos: 'nope' }, []]) {
  assert.equal(
    parseTodoList(value),
    null,
    `非快照载荷 ${JSON.stringify(value) ?? String(value)} 被当成了清单：面板会显示一张不存在的空表`,
  );
}

/* ---------------------------------------------------------- args 的容忍度 */

assert.deepEqual(
  todoItemsFromArgs('{"todos":[{"content":"甲","status":"pending"}]}'),
  [{ content: '甲', status: 'pending' }],
  'args 是 JSON 字符串时（流式写出的形态）解析失败：面板会在模型调用中途空一下',
);
assert.equal(todoItemsFromArgs('{"todos":[{"content":"甲"'), null, '半截 JSON 必须返回「还没有快照」');
assert.equal(todoItemsFromArgs({ action: 'add', text: '旧工具的一次项调用' }), null, '一次项的旧调用参数不该被当成整表');

/* ------------------------------------------------------------ last-write-wins */

function run(over: Partial<ToolRun> & { toolName: string }): ToolRun {
  return {
    toolCallId: over.toolCallId ?? 'call-1',
    toolName: over.toolName,
    args: over.args ?? {},
    output: over.output ?? '',
    status: over.status ?? 'success',
    startedAt: over.startedAt ?? 0,
    ...(over.details === undefined ? {} : { details: over.details }),
    ...(over.endedAt === undefined ? {} : { endedAt: over.endedAt }),
  };
}

function assistant(id: string, tools: ToolRun[]): TranscriptEntry {
  return {
    kind: 'assistant',
    id,
    at: 0,
    text: '',
    thinking: '',
    streaming: false,
    tools,
  };
}

function toolResult(id: string, entryRun: ToolRun): TranscriptEntry {
  return { kind: 'toolResult', id, at: 0, run: entryRun };
}

const first: TodoItem[] = [
  { content: '写第一个小故事', status: 'pending' },
  { content: '写第二个小故事', status: 'pending' },
  { content: '写第三个小故事', status: 'pending' },
];
const second: TodoItem[] = [
  { content: '写第一个小故事', status: 'completed' },
  { content: '写第二个小故事', status: 'completed' },
  { content: '写第三个小故事', status: 'completed' },
];

const entries: TranscriptEntry[] = [
  assistant('a1', [run({ toolName: 'todo', toolCallId: 't1', details: { todos: first } })]),
  toolResult('r1', run({ toolName: 'todo', toolCallId: 't1', details: { todos: first } })),
  assistant('a2', [
    run({ toolName: 'bash', toolCallId: 'b1', details: { todos: second } }),
    run({ toolName: 'todo', toolCallId: 't2', status: 'error', details: { todos: second } }),
  ]),
  assistant('a3', [run({ toolName: 'todo', toolCallId: 't3', details: { todos: second } })]),
];
assert.deepEqual(
  latestTodos(entries),
  second,
  'last-write-wins 判定变了：错误状态的 todo 调用改写了面板，或最后一次成功调用没生效',
);

// 一次替换成空表 = 清空。
assert.deepEqual(
  latestTodos([...entries, assistant('a4', [run({ toolName: 'todo', toolCallId: 't4', details: { todos: [] } })])]),
  [],
  '清空任务（{todos:[]}）没生效：面板会一直挂着已经清掉的旧任务',
);

// 与 todo 无关的会话 = 没有任务表。
assert.deepEqual(latestTodos([assistant('a1', [run({ toolName: 'bash', toolCallId: 'b9' })])]), [], '没有 todo 调用的会话不该长出任务表');

/* ----------------------------------------------------------------- 计数与文案 */

const mixed: TodoItem[] = [
  { content: '甲', status: 'completed' },
  { content: '乙', status: 'in_progress' },
  { content: '丙', status: 'in_progress' },
  { content: '丁', status: 'pending' },
];
assert.deepEqual(planCounts(mixed), { done: 1, active: 2, pending: 1, total: 4 }, '三态计数错了');
assert.equal(
  progressLabel(mixed),
  '1 已完成\u2002·\u20022 进行中\u2002·\u20021 待处理',
  '面板头部文案变了：段序、EN SPACE 分隔符（U+2002）、零计数不显示，三者都是与 dsh 的对齐点',
);
assert.equal(
  progressLabel([
    { content: '甲', status: 'pending' },
    { content: '乙', status: 'pending' },
  ]),
  '2 待处理',
  '零计数的段落必须省略：全待办时头部只该有「N 待处理」',
);
assert.equal(progressLabel([]), '', '空表不该给出任何进度文案');

assert.deepEqual(
  planSummary(mixed),
  { done: 1, total: 4, activeContent: '乙', activeExtra: 1 },
  '工具卡摘要的两半错了：第一个进行中的任务名 + 其余进行中数量，必须来自同一张快照',
);
assert.deepEqual(
  planSummary([{ content: '甲', status: 'pending' }]),
  { done: 0, total: 1, activeContent: null, activeExtra: 0 },
  '没有进行中项时 activeContent 必须是 null（摘要只报计数，不编名字）',
);

/* ------------------------------------------------------------- widget 兜底 */

assert.deepEqual(
  todoItemsFromWidgetLines(['任务 1/3', '☑ 甲', '◐ 乙', '☐ 丙']),
  [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'in_progress' },
    { content: '丙', status: 'pending' },
  ],
  'widget 文本行的兜底解析失败：拿不到结构化记录时面板会空白',
);
assert.deepEqual(
  todoItemsFromWidgetLines(['待办事项 0/2', '☐ 甲', '☐ 乙']),
  [
    { content: '甲', status: 'pending' },
    { content: '乙', status: 'pending' },
  ],
  '旧扩展（pi-deck-todo）的表头「待办事项 d/t」不认了：升级当口旧 widget 会解析不出来',
);
assert.equal(
  todoItemsFromWidgetLines(['任务 3/3', '☑ 甲', '☑ 乙']),
  null,
  '行数与表头不符时必须整张作废：宁可没有面板，也不能显示一张缺项的假快照',
);
assert.equal(todoItemsFromWidgetLines(['随便一行']), null, '不认识的文本行不该被解析成任务表');

console.log('check-todos: ok');
