/**
 * `extensions/pi-webx-todo.ts` 的钉子：整表替换这个契约不改回去。
 *
 * 根因回顾：旧扩展 `pi-deck-todo.ts` 的工具是「一次一项」的
 * `{action:'list'|'add'|'toggle'|'clear'}`，模型写 3 个任务要 3 次 add + 3 次 toggle，
 * 面板于是 6 行。这里把新契约钉死：
 *   - 参数只有 `todos`（数组，必填），**没有** `action`/`text`/`id` 这些逐项参数；
 *   - 一次调用交整张表，`details` 的形状就是 `{ todos: [{content,status}] }`（面板只认它）；
 *   - 校验照 dsh：空内容 / 同表重复 / 多个 in_progress 一律拒绝，且**改走 content 文本**
 *     （不抛异常、不改写面板）；
 *   - `{todos:[]}` 清空（widget 传 undefined）；
 *   - widget 行 `任务 d/t` + `☑|◐|☐ 内容`，必须能被 `src/lib/todos.ts` 的
 *     `todoItemsFromWidgetLines` 还原成同一张表；
 *   - session_start / session_tree 从会话里的 toolResult 快照重建（含旧形态兼容）。
 *
 * 不联网、不调模型：用一个假的 pi（记录 registerTool / registerCommand / on）加载扩展。
 * 跑法：`npx tsx scripts/check-todo-tool.ts`
 */
import assert from 'node:assert/strict';
import todoExtension from '../extensions/pi-webx-todo';
import { todoItemsFromWidgetLines, TODO_STATUSES, TODO_TOOL_NAME } from '../src/lib/todos';

/* --------------------------------------------------------------- 假 pi / 假 ctx */

/** 假的 ExtensionAPI：记录注册物，并把注册的 handler 暴露出来供调用。 */
function createPi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  return {
    tools,
    commands,
    handlers,
    pi: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    },
  };
}

/** 假的 ExtensionContext：捕获 setWidget / notify，sessionManager 返回给定 entries。 */
function createCtx(entries = []) {
  const widgets = new Map();
  const notices = [];
  return {
    widgets,
    notices,
    ctx: {
      ui: {
        setWidget(key, lines) {
          widgets.set(key, lines);
        },
        notify(message, type) {
          notices.push({ message, type });
        },
      },
      sessionManager: { getEntries: () => entries },
      hasUI: true,
      mode: 'tui',
    },
  };
}

/** 加载一次扩展（每个"进程"一份内存态），返回工具 / 命令 / 事件 handler / ctx。 */
function load(entries = []) {
  const host = createPi();
  todoExtension(host.pi);
  const view = createCtx(entries);
  return {
    ...host,
    ...view,
    tool: host.tools.get(TODO_TOOL_NAME),
    command: host.commands.get('todo'),
  };
}

const call = (tool, ctx, id, params) => tool.execute(id, params, undefined, undefined, ctx);

/* ------------------------------------------------------------------ 注册面 */

const app = load();
assert.ok(app.tool, `扩展没有注册名为 ${TODO_TOOL_NAME} 的工具`);
assert.equal(app.tool.label, '任务', 'label 变了：面板/CLI 都按这个标签显示');
assert.ok(
  app.tool.description.includes('REPLACES the previous list'),
  '工具描述丢了整表替换的原话：模型会退回一项一项地写（图4 的根因）',
);
assert.ok(app.tool.description.includes('ENTIRE'), '工具描述丢了 "ENTIRE list"');
assert.ok(app.tool.description.includes('AT MOST ONE'), '工具描述丢了「同时最多一项 in_progress」');
assert.equal(typeof app.tool.promptSnippet, 'string');
assert.ok(app.tool.promptSnippet.includes('整表'), 'promptSnippet 没有点出整表替换');
assert.ok(Array.isArray(app.tool.promptGuidelines) && app.tool.promptGuidelines.length >= 5, 'promptGuidelines 缺失');

// 参数面：只有整表 todos，旧的逐项参数必须彻底消失。
const schemaText = JSON.stringify(app.tool.parameters);
assert.ok(schemaText.includes('"todos"'), '参数里没有 todos');
assert.ok(!schemaText.includes('"action"'), '参数里还有 action：逐项 add/toggle 的入口没拔掉');
assert.ok(!schemaText.includes('"text"') && !schemaText.includes('"id"'), '参数里还有 text/id 这类逐项参数');
assert.deepEqual(
  app.tool.parameters.properties.todos.items.properties.status.enum,
  [...TODO_STATUSES],
  'status 枚举与 src/lib/todos.ts 的三态词表不一致',
);
assert.deepEqual(app.tool.parameters.required, ['todos'], 'todos 必须是必填参数');

assert.ok(app.command, '没有注册 /todo 命令');
assert.equal(typeof app.command.handler, 'function', '/todo 命令没有 handler');
assert.ok((app.handlers.get('session_start') ?? []).length > 0, 'session_start 没有重建 hook');
assert.ok((app.handlers.get('session_tree') ?? []).length > 0, 'session_tree 没有重建 hook');

/* ------------------------------------------------- 一次调用 = 整张表（核心验收） */

const WIDGET_KEY = 'pi-webx-todo';
const r1 = await call(app.tool, app.ctx, 'call-1', {
  todos: [
    { content: '写第一个小故事', status: 'completed' },
    { content: ' 写第二个小故事 ', status: 'in_progress' },
    { content: '写第三个小故事', status: 'pending' },
  ],
});
const table = [
  { content: '写第一个小故事', status: 'completed' },
  { content: '写第二个小故事', status: 'in_progress' },
  { content: '写第三个小故事', status: 'pending' },
];

assert.deepEqual(Object.keys(r1.details), ['todos'], 'details 的形状变了：面板只认 { todos }');
assert.deepEqual(r1.details.todos, table, '3 项一次调用没有被采纳为整张三态表（content 也未 trim）');
assert.equal(r1.content.length, 1);
assert.equal(r1.content[0].type, 'text');
const snapLines = r1.content[0].text.split('\n');
assert.equal(snapLines[0], '任务 1/3', '快照首行必须是 `任务 d/t`');
assert.deepEqual(
  snapLines.slice(1),
  ['[x] 写第一个小故事', '[ ] 写第二个小故事', '[ ] 写第三个小故事'],
  '快照逐行必须是 `[x] 内容` / `[ ] 内容`',
);

// widget 行：格式钉死 + 能被 src/lib/todos.ts 还原成同一张表
const widgetLines = app.widgets.get(WIDGET_KEY);
assert.deepEqual(
  widgetLines,
  ['任务 1/3', '☑ 写第一个小故事', '◐ 写第二个小故事', '☐ 写第三个小故事'],
  'widget 行格式变了：首行 `任务 d/t`、其后 `☑|◐|☐ 内容`',
);
assert.deepEqual(
  todoItemsFromWidgetLines(widgetLines),
  r1.details.todos,
  'widget 行还原不回同一张表：兜底解析会给出与面板不一致的清单',
);
assert.equal(widgetLines.filter((line) => line.startsWith('☑')).length, 1, 'widget 计数字形与实际状态不符');
assert.ok(
  snapLines.length - 1 === table.length && widgetLines.length - 1 === table.length,
  '一次调用的行数必须等于任务数（3 个任务 = 1 次调用，不再有 3 行 add）',
);

/* ------------------------------------------------------------------ 拒绝路径 */

// 拒绝后：content 文本报错、details 回填"未被采纳的当前表"、widget 不变、没有异常。
async function rejected(id, params, marker) {
  let result;
  await assert.doesNotReject(async () => {
    result = await call(app.tool, app.ctx, id, params);
  }, `${id} 抛异常了：校验必须走 content 文本`);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.startsWith('todo 调用被拒绝：'), `${id} 没有返回拒绝文本`);
  assert.ok(result.content[0].text.includes(marker), `${id} 的拒绝原因不对：${result.content[0].text}`);
  assert.deepEqual(result.details.todos, table, `${id} 改写了面板上的任务表（必须是上一次被采纳的快照）`);
  assert.deepEqual(app.widgets.get(WIDGET_KEY), widgetLines, `${id} 之后 widget 被改动了`);
  assert.ok(!result.details.error, '错误不该再塞进 details（面板只认 details.todos）');
  return result;
}

await rejected('dup', { todos: [{ content: '甲', status: 'pending' }, { content: ' 甲 ', status: 'pending' }] }, '重复');
await rejected('blank', { todos: [{ content: '   ', status: 'pending' }] }, '不能为空');
await rejected(
  'parallel',
  {
    todos: [
      { content: '甲', status: 'in_progress' },
      { content: '乙', status: 'in_progress' },
    ],
  },
  '最多 1 项',
);
await rejected('bad-status', { todos: [{ content: '甲', status: 'doing' }] }, 'status');
await rejected('not-array', {}, '必须是数组');
await rejected('string', { todos: '甲,乙' }, '必须是数组');
await rejected('legacy-item', { todos: [{ text: '旧形态', done: false }] }, '不能为空');
// 旧工具的一次项调用形态（图4 里那 3 行 add）必须走不通。
await rejected('legacy-call', { action: 'add', text: '一次一项的旧调用' }, '必须是数组');

/* -------------------------------------------------------------------- 清空 */

const cleared = await call(app.tool, app.ctx, 'clear', { todos: [] });
assert.deepEqual(cleared.details.todos, [], '{todos:[]} 没有清空任务表');
assert.equal(cleared.content[0].text, '任务 0/0', '清空后的快照文本不对');
assert.ok(app.widgets.has(WIDGET_KEY), '清空时也要调 setWidget（传 undefined 才能清掉）');
assert.equal(app.widgets.get(WIDGET_KEY), undefined, '空表必须把 widget 传 undefined 清掉');

/* ------------------------------------------------------------ /todo 命令快照 */

const restored = await call(app.tool, app.ctx, 'call-2', { todos: table });
assert.deepEqual(restored.details.todos, table);
await app.command.handler('', app.ctx);
assert.equal(app.notices.length, 1, '/todo 没有输出快照');
assert.equal(app.notices[0].message, '任务 1/3\n[x] 写第一个小故事\n[ ] 写第二个小故事\n[ ] 写第三个小故事', '/todo 的快照文本不对');
assert.equal(app.notices[0].type, 'info');

const emptyApp = load();
await emptyApp.command.handler('', emptyApp.ctx);
assert.equal(emptyApp.notices.length, 1, '空表时 /todo 没有提示');
assert.ok(emptyApp.notices[0].message.includes('还没有任务'), '空表时 /todo 的提示文案不对');

/* ------------------------------------------------- 会话重建（session_start / tree） */

const toolResult = (toolName, details, over = {}) => ({
  type: 'message',
  id: `e-${toolName}-${Math.random()}`,
  parentId: null,
  timestamp: '2026-01-01T00:00:00.000Z',
  message: {
    role: 'toolResult',
    toolCallId: 'x',
    toolName,
    content: [{ type: 'text', text: '' }],
    details,
    isError: false,
    timestamp: 0,
    ...over,
  },
});

const resumeEntries = [
  // 旧形态（pi-deck-todo）在前：升级当口恢复旧会话也要能画出来
  toolResult('todo', { action: 'add', todos: [{ id: 1, text: '旧会话的一项', done: true }], nextId: 2 }),
  // 非 todo 工具的 details.todos 不得被读
  toolResult('bash', { todos: [{ content: '不该被读的', status: 'pending' }] }),
  // 失败的 todo 调用不得改写（last-write-wins 只看成功的那次）
  toolResult('todo', { todos: [{ content: '失败调用的', status: 'pending' }] }, { isError: true }),
  // 最后一次成功的 todo 调用说了算
  toolResult('todo', { todos: table }),
];

const resumed = load(resumeEntries);
for (const handler of resumed.handlers.get('session_start')) {
  await handler({ type: 'session_start', reason: 'resume' }, resumed.ctx);
}
assert.deepEqual(
  resumed.widgets.get(WIDGET_KEY),
  ['任务 1/3', '☑ 写第一个小故事', '◐ 写第二个小故事', '☐ 写第三个小故事'],
  'session_start 没从会话快照重建出 widget',
);
assert.deepEqual(
  todoItemsFromWidgetLines(resumed.widgets.get(WIDGET_KEY)),
  table,
  '重建出来的 widget 行还原不回快照',
);

// 分支切换：session_tree 用同一套重建，entries 换成旧形态的那一张
const treeEntries = [toolResult('todo', { action: 'toggle', todos: [{ id: 7, text: '旧分支的任务', done: false }] })];
const branched = load(treeEntries);
for (const handler of branched.handlers.get('session_tree')) {
  await handler({ type: 'session_tree' }, branched.ctx);
}
assert.deepEqual(
  branched.widgets.get(WIDGET_KEY),
  ['任务 0/1', '☐ 旧分支的任务'],
  'session_tree 没有兼容旧形态（pi-deck-todo 的 {text,done}）重建 widget',
);

// 没有 todo 记录的会话：widget 被清掉
const blank = load([]);
for (const handler of blank.handlers.get('session_start')) {
  await handler({ type: 'session_start', reason: 'startup' }, blank.ctx);
}
assert.equal(blank.widgets.get(WIDGET_KEY), undefined, '没有任务的会话不该留下 widget');

console.log('check-todo-tool: ok');
console.log(`  widget 行: ${JSON.stringify(widgetLines)}`);
console.log(`  快照文本: ${JSON.stringify(r1.content[0].text)}`);
