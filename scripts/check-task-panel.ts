/**
 * 任务面板：把 dsh 的 `TodoPanel` 搬到 composer 上方的验收（SSR + 断言）。
 *
 * 参考实现是 `deepseek-harness/packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx`
 * 与同目录的 `TodoPanel.module.css`；这个脚本钉的是「搬过来之后还对得上」的那几件事：
 *
 *   1. 头部同时出现「任务」与 `src/lib/todos.ts` 的 `progressLabel` 原文（含 U+2002
 *      EN SPACE）—— 段序/分隔符/零计数省略都是与 dsh 的对齐点，组件不许自己拼；
 *   2. 三项各自的 `data-status` 与三态字形（14×14、虚线 `2.4 2.4`、渐变 stopOpacity=0）；
 *   3. 列表是自滚容器（180px），行距 8px、13px/20px 行高、字形格子 16×16
 *      —— 这些只在样式表里看得见，所以读 CSS 断言；
 *   4. 空表渲染为空（清空任务 = 面板消失）；
 *   5. 默认**展开**（对 dsh 默认折叠的有意偏离，见组件文件头）与折叠所需的 CSS 键。
 *      **交互没测**：这条工具链里没有 DOM（没有 jsdom/happy-dom），SSR 不能点按钮，
 *      所以只钉 `aria-expanded` 初值与源码级的闸门接线，见文件末尾的说明；
 *   6. `WidgetStrip` 不再把 `pi-webx-todo` / `pi-deck-todo` 的原始行当代码块画出来，
 *      其他 widget 与 placement 过滤照旧；
 *   7. 面板数据来源的次序（`todosForPanel`）：结构化 `todo` 记录优先，widget 文本行兜底。
 *      该判定从 `TaskPanel.tsx` 导出而不是 `App.tsx`：App 的模块图在模块级就摸
 *      `window`（`src/lib/connection.ts` 的 `sharedConnection`），Node 里 import 不起来。
 *
 * 跑法：`node --import ./scripts/check-bootstrap.mjs scripts/check-task-panel.ts`
 * （引导模块把 `.css` 导入短路成回显键名的 Proxy，见 `scripts/check-bootstrap.mjs`）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskPanel, todosForPanel } from '../src/components/TaskPanel';
import { WidgetStrip } from '../src/components/StatusStrip';
import { progressLabel, type TodoItem } from '../src/lib/todos';
import type { WidgetState } from '../src/lib/usePiSession';
import type { ToolRun, TranscriptEntry } from '../src/shared/transcript';

/** 面板只吃 plain DOM，不需要 lobehub 的 provider。 */
const renderPanel = (todos: readonly TodoItem[]): string =>
  renderToStaticMarkup(h(TaskPanel, { todos }));

/** 标记文本的纯文本形态：Highlighter 会把一行拆进 Shiki 的 token span 里。 */
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, '');

/* ------------------------------------------------------------ 头部：标题 + 摘要 */

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
];

const panel = renderPanel(LIST);

assert.ok(panel.includes('data-testid="todo-panel"'), `面板要有 dsh 的 testid 钩子：${panel.slice(0, 200)}`);
assert.match(panel, /aria-label="任务"/, '整卡的无障碍名是「任务」');
assert.match(panel, /class="title">任务<\/span>/, '头部要有「任务」标题');

// 摘要必须是 `progressLabel` 的**原文**：用字面量拼出来比对，等于把 U+2002、
// 段序、`·` 两侧的空格一起钉住。EN SPACE 不是 &nbsp;，SSR 也不该把它变成别的字。
const summary = progressLabel(LIST);
assert.equal(summary, '1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理');
assert.ok(
  panel.includes(`<span class="progress">${summary}</span>`),
  `头部摘要不是 progressLabel 的原文（U+2002 分隔）：${JSON.stringify(summary)}`,
);
assert.ok(panel.includes('\u2002·\u2002'), '分隔符必须是 U+2002 EN SPACE（半角空格会被 HTML 折叠）');
assert.ok(!panel.includes('&nbsp;'), '摘要是真的 EN SPACE，不是 &nbsp; 实体');

// 头部左侧是清单字形（IconChecklistOutline14 的其中一条 path，逐字来自本仓库图标集），
// 展开态的 chevron 是向下那个：两条 path 都是「用的是哪个字形」的证据。
assert.match(panel, /class="lead" aria-hidden="true"><svg/, '头部左首是清单字形');
assert.ok(
  panel.includes('d="M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z"'),
  '左侧字形不是 IconChecklistOutline14（path 与 icons/index.tsx 里的不一致）',
);
assert.ok(
  panel.includes('d="M11.8486 5.5L11.4238 5.92383'),
  '展开态的 chevron 应该是 IconChevronDownOutline14',
);

/* ---------------------------------------------------------- 列表：状态与三态字形 */

assert.match(panel, /<ul class="list">/, '列表容器的类名要挂在 CSS module 的 .list 上（滚动容器）');

const statuses = [...panel.matchAll(/data-status="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(statuses, ['completed', 'in_progress', 'pending'], '三项的 data-status 必须各归其位');
assert.equal((panel.match(/<li /g) ?? []).length, 3, '一项一行');
assert.equal((panel.match(/<svg /g) ?? []).length, 5, '三项各一个字形 svg，加上头部两个字形');

// 三态字形各自的关键笔画：完成的对勾 path、进行中的渐变（stopOpacity=0）与
// 渐变引用、待处理的虚线 2.4 2.4。这些数字改一个，字形就不是 figma 那个了。
assert.ok(panel.includes('class="glyphCompleted"'), 'completed 行要有自己的字形类');
assert.ok(panel.includes('d="M10.9631 5.71411'), 'completed 字形的对勾 path 变了');
assert.ok(panel.includes('class="glyphProgress"'), 'in_progress 行要有自己的字形类');
assert.match(
  panel,
  /<linearGradient id="([^"]+)" x1="2\.5" y1="12" x2="10\.5" y2="3\.5" gradientUnits="userSpaceOnUse">/,
  '进行中字形的渐变几何变了（x1/y1/x2/y2 必须与参考实现一致）',
);
const gradientId = /<linearGradient id="([^"]+)"/.exec(panel)?.[1];
assert.ok(gradientId, '进行中字形要有渐变定义');
assert.ok(panel.includes('stop-color="currentColor"'), '渐变起点用 currentColor（business 色随主题）');
assert.ok(panel.includes('stop-opacity="0"'), '渐变尾端 stopOpacity=0（圆环渐隐）');
assert.ok(panel.includes(`stroke="url(#${gradientId})"`), '圆环要引用它自己的渐变');
assert.ok(panel.includes('class="glyphPending"'), 'pending 行要有自己的字形类');
assert.ok(panel.includes('stroke-dasharray="2.4 2.4"'), '待处理字形是 figma 的虚线 2.4 2.4');
assert.equal((panel.match(/viewBox="0 0 14 14"/g) ?? []).length, 5, '字形画在 14×14 画板上');
assert.ok(panel.includes('aria-hidden="true"'), '字形是装饰，不进无障碍树');
assert.ok(textOf(panel).includes('写组件'), '任务内容要原文出现');

/* ------------------------------------------------------------- 空表：什么都不画 */

assert.equal(renderPanel([]), '', '空表必须渲染为空（清空任务 = 面板消失）');

// 两行同样措辞是合法的模型输出：参考实现只拿 content 当 key，那样会撞，
// 这里带上位置（见 TaskPanel.tsx 里的注释）。
const duplicateContent = renderPanel([
  { content: '同样的措辞', status: 'pending' },
  { content: '同样的措辞', status: 'completed' },
]);
assert.deepEqual(
  [...duplicateContent.matchAll(/data-status="([^"]+)"/g)].map((match) => match[1]),
  ['pending', 'completed'],
  '两行同样措辞也要各占一行（key 不能只拿 content）',
);

/* ------------------------------------------------------------------- 折叠态 */

// 有意偏离 dsh：dsh `useState(true)`（默认折叠），本仓库默认展开，因为用户给的
// 参考图就是展开态、要看得到条目。
assert.match(
  panel,
  /<button type="button" class="header" aria-expanded="true">/,
  '默认必须是展开态：aria-expanded 初值为 true',
);
assert.ok(panel.includes('<ul class="list">'), '展开态要看得见条目');

/* ------------------------------------------------------ 样式表里的几何（样式契约） */

const rawCss = readFileSync(new URL('../src/components/TaskPanel.module.css', import.meta.url), 'utf8');
/** 规则断言只看声明本身：注释里提到 dsh 的变量名是说明性的，不是引用。 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (name: string): string => {
  const found = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(found, `TaskPanel.module.css 里要有 .${name} 规则`);
  return found[1]!;
};

const list = rule('list');
assert.match(list, /max-height:\s*180px/, '.list 的高度上限 180px（对齐 dsh TodoPanel）');
assert.match(list, /overflow-y:\s*auto/, '.list 要自己滚动（长清单不把正文顶下去）');
assert.match(list, /gap:\s*8px/, '.list 行距 8px');
assert.match(list, /list-style:\s*none/, '列表不带项目符号（字形就是符号）');

const item = rule('item');
assert.match(item, /font-size:\s*13px/, '.item 13px（对齐 dsh）');
assert.match(item, /line-height:\s*20px/, '.item 行高 20px（对齐 dsh）');

const glyph = rule('glyph');
assert.match(glyph, /width:\s*16px/, '字形格 16×16');
assert.match(glyph, /height:\s*16px/, '字形格 16×16');

const root = rule('root');
assert.match(root, /border:\s*0\.5px solid/, '卡片是 0.5px 发丝描边');
assert.match(root, /border-radius:\s*12px/, '卡片圆角 12px');
assert.match(root, /background:\s*var\(--dsw-specific-tip\)/, '卡片底色用本仓库主题令牌');

const body = rule('body');
assert.match(body, /padding:\s*6px 12px/, '卡身内边距 6px 12px（对齐 dsh）');
assert.match(body, /gap:\s*8px/, '头部与列表之间 8px');

assert.match(rule('glyphProgress'), /animation:\s*todo-progress-spin 1s linear infinite/, '进行中字形靠 CSS 旋转');
assert.match(css, /@keyframes todo-progress-spin\s*\{/, '旋转的 keyframes 要在（CSS module 会一起改作用域）');
// 本仓库的主题令牌来自 src/ui/theme/design-platform.css；dsh 自己的 composer 布局
// 变量在这里根本不存在，引用它们会把尺寸算成 0。
assert.ok(!css.includes('--dsh-composer'), '不要引用 dsh 的 composer 布局变量（本仓库没有这些变量）');

/**
 * 交互（点头部折叠）**没有**被执行：SSR 出来的标记不带事件处理器，而这条工具链里
 * 没有 DOM（无 jsdom/happy-dom，且不新增依赖）。所以这里只钉两件事：折叠态的闸门
 * 在源码里是同一个 state，以及折叠所需的 CSS 键存在。
 *
 * 这是**源码级**的接线钉子，不是行为证据 —— 真实浏览器里的点击/观感仍需人工过一眼，
 * 报告里已注明这一项未验证。
 */
const source = readFileSync(new URL('../src/components/TaskPanel.tsx', import.meta.url), 'utf8');
assert.match(source, /aria-expanded=\{!collapsed\}/, 'aria-expanded 要报折叠态');
assert.match(
  source,
  /onClick=\{\(\) => \{ setCollapsed\(\(v\) => !v\); \}\}/,
  '头部点击要翻转控制列表的那个 state',
);
assert.match(source, /\{!collapsed && \(\s*\n\s*<ul className=\{css\.list\}>/, '列表由 !collapsed 闸门控制');
assert.ok(css.includes('.chevron'), '折叠/展开的 chevron 位要有样式');
assert.ok(css.includes('.progress'), '折叠后头部只剩摘要，摘要位要有样式');

/* ------------------------------------------- WidgetStrip：任务 widget 不再画成代码块 */

const widgets: Record<string, WidgetState> = {
  // 面板自己的数据通道：图2 那张「待办事项 3/3」的原文。
  'pi-webx-todo': { lines: ['任务 1/3', '☑ 画面板', '◐ 接数据', '☐ 补测试'], placement: 'aboveEditor' },
  'pi-deck-todo': { lines: ['待办事项 1/2', '☑ 旧扩展', '☐ 旧扩展二'], placement: 'aboveEditor' },
  // 别的 widget 必须照旧渲染。
  'pi-webx-status': { lines: ['模型 deepseek-chat'], placement: 'aboveEditor' },
  'pi-webx-below': { lines: ['下面是另一个位置'], placement: 'belowEditor' },
};

const strip = renderToStaticMarkup(
  h(ConfigProvider, { motion, children: h(WidgetStrip, { widgets, placement: 'aboveEditor' }) }),
);
const stripText = textOf(strip);

assert.ok(
  !stripText.includes('任务 1/3') && !stripText.includes('☑ 画面板'),
  `pi-webx-todo 的原始行仍在 WidgetStrip 里渲染：${stripText.slice(0, 200)}`,
);
assert.ok(
  !stripText.includes('待办事项 1/2') && !stripText.includes('☑ 旧扩展'),
  `pi-deck-todo 的原始行仍在 WidgetStrip 里渲染：${stripText.slice(0, 200)}`,
);
assert.ok(stripText.includes('模型 deepseek-chat'), '其他 widget 必须照旧渲染');
assert.ok(!stripText.includes('下面是另一个位置'), 'placement 过滤照旧（belowEditor 不画在 aboveEditor 上）');

const belowStrip = renderToStaticMarkup(
  h(ConfigProvider, { motion, children: h(WidgetStrip, { widgets, placement: 'belowEditor' }) }),
);
assert.ok(textOf(belowStrip).includes('下面是另一个位置'), 'belowEditor 的 widget 在它自己的位置上仍要渲染');
assert.ok(!textOf(belowStrip).includes('模型 deepseek-chat'), '位置过滤是双向的');

/* -------------------------------------- 面板数据来源：结构化记录优先、widget 兜底 */

const widgetOnly: Record<string, WidgetState> = {
  'pi-deck-todo': { lines: ['待办事项 1/2', '☑ 甲', '☐ 乙'], placement: 'aboveEditor' },
};
assert.deepEqual(
  todosForPanel([], widgetOnly),
  [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'pending' },
  ],
  '拿不到结构化记录时，旧会话的 widget 文本行要兜底（否则面板空白）',
);
// 兜底不是只把数组算对：同一张表喂给面板，渲染出来才有得看。
const fallbackPanel = renderPanel(todosForPanel([], widgetOnly));
assert.ok(fallbackPanel.includes('data-testid="todo-panel"'), '兜底路径要真的把面板画出来');
assert.match(fallbackPanel, /class="progress">1 已完成\u2002·\u20021 待处理<\/span>/, '兜底路径的摘要由同一张表算出');
assert.deepEqual(
  [...fallbackPanel.matchAll(/data-status="([^"]+)"/g)].map((match) => match[1]),
  ['completed', 'pending'],
  '兜底路径的三态也要落到行上',
);

// 只剩任务 widget 时，WidgetStrip 那一层应该什么都不画（不是画一个空壳）。
assert.equal(
  renderToStaticMarkup(
    h(ConfigProvider, {
      motion,
      children: h(WidgetStrip, { widgets: { 'pi-webx-todo': widgets['pi-webx-todo']! }, placement: 'aboveEditor' }),
    }),
  ),
  '',
  '只有任务 widget 时 WidgetStrip 必须渲染为空（状态只出一个地方）',
);

/** 一次 `todo` 调用：整表替换是主路径。 */
function todoRun(todos: TodoItem[], over: Partial<ToolRun> = {}): ToolRun {
  return {
    toolCallId: 'todo-1',
    toolName: 'todo',
    args: {},
    output: '',
    status: 'success',
    startedAt: 0,
    details: { todos },
    ...over,
  };
}

function assistant(id: string, tools: ToolRun[]): TranscriptEntry {
  return { kind: 'assistant', id, at: 0, text: '', thinking: '', streaming: false, tools };
}

const STRUCTURED: TodoItem[] = [
  { content: '结构化甲', status: 'in_progress' },
  { content: '结构化乙', status: 'pending' },
];
const entries = [assistant('a1', [todoRun(STRUCTURED)])];
assert.deepEqual(
  todosForPanel(entries, widgetOnly),
  STRUCTURED,
  '有结构化记录时 widget 兜底不得改写面板（否则同一状态两个来源打架）',
);
assert.deepEqual(
  todosForPanel([assistant('a2', [todoRun([], { toolCallId: 'todo-2' })])], {}),
  [],
  '清空任务（{todos:[]}）后面板必须空掉',
);
assert.deepEqual(
  todosForPanel([], { 'pi-webx-todo': { lines: ['任务 3/3', '☑ 只有一行'], placement: 'aboveEditor' } }),
  [],
  'widget 行数与表头对不上就不猜（宁可没有面板，也不显示缺项的假快照）',
);
// 已知的兜底窗口，写出来让 review 看得见：结构化快照为空、widget 还在时用 widget。
// 只会出现在「扩展清了结构化列表却没清 widget」这种不同步的情况下。
assert.deepEqual(
  todosForPanel([assistant('a3', [todoRun([], { toolCallId: 'todo-3' })])], widgetOnly),
  [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'pending' },
  ],
  '兜底的取舍变了：结构化清空 + widget 未清时，当前实现仍显示 widget（唯一复活窗口）',
);

console.log(
  'PASS 任务面板：头部「任务」+ progressLabel 原文（U+2002）、三态字形（14×14 画板 / 虚线 2.4 2.4 / 渐变 stopOpacity=0）、'
  + '列表 180px 自滚 + 8px 行距 + 13px 行高、空表不渲染、默认展开（aria-expanded=true，对 dsh 的有意偏离）、'
  + 'WidgetStrip 不再输出 todo widget 的原始行而其他 widget 照旧、todosForPanel 结构化优先 + widget 兜底；'
  + '未验证：真实浏览器里的点击折叠与观感（无 DOM 环境，交互只做了源码级接线钉子）',
);
