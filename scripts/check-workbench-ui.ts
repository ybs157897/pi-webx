/**
 * 工作台界面验收：把「AI 个人工作台」这次改造的四个模块 + 对话面板渲染钉在 SSR 产物上。
 *
 * 写法照 `scripts/check-task-panel.ts`：真实组件进 `renderToStaticMarkup`，喂构造好的假数据，
 * 断言只认 DOM 证据。覆盖契约（docs 里的 CSS 契约与模块改造规格）第 8 节列的五条落点：
 *
 *   1. 问题修复是**列表**：单张 Card + `fixes-list > fixes-row`，卡头 Segmented 带数量，
 *      `fixes-quick-add` 同卡片；整段标记里不许出现看板列痕迹（`kanban*` / `work-card`）；
 *   2. 日志查询是**对话框查询**：页面只有一张 Card（`logs-list` 按日期倒序分组），
 *      卡头 `logs-query-open` / `logs-record-open` 是查询与记录弹窗的触发按钮；
 *   3. 需求管理是**知识列表**：`split` 两栏，左 `requirements-search` + `requirements-list >
 *      requirements-item`（`li.list-item` 有分隔线），右 `requirements-reader` 阅读区；
 *   4. 代码开发是**编辑器工作区**：`split` 两栏，左 `codes-tree-group > codes-tree-item`，
 *      右 `codes-editor`（tab / 工具条 / `codes-gutter` + `codes-editor-input` / 状态栏）；
 *   5. 对话面板正文与 /chat 一致：`AssistantMarkdown` 复用 `@lobehub/ui` 的 `Markdown`
 *      （`variant="chat"`、`fontSize=14`、`fullFeaturedCodeBlock`），渲染出 `<strong>` /
 *      `<code>` / `<li>` / `<pre>` 等真实元素，纯文本里不残留 `**` 与 ```。
 *
 * 跑法：`node --import tsx scripts/check-workbench-ui.ts`
 * （不需要 `check-bootstrap.mjs`：这几个组件的模块图不引 CSS；但 `AssistantMarkdown` 里的
 * `@lobehub/ui` Markdown 必须被 `ConfigProvider motion={motion}` 包着，否则抛
 * 「Please wrap your app with <ConfigProvider>…」——见 `node_modules/@lobehub/ui/src/MotionProvider/index.tsx`。）
 *
 * 交互分支怎么覆盖的（重要，评审要能看见边界）：
 * - **SSR 初始态**：模块挂载后还没任何 state 变化时的结构，全部真渲染。
 * - **喂进去的选中态**：需求阅读区由 `selectedId`（初值 ''）驱动，而 `selected` 是从
 *   `data.requirements` 现算的（不经 effect），所以塞一条 `id: ''` 的假记录就能让 SSR
 *   渲染出**真实**的阅读区分支（含选中态样式、`（没有备注）` 兜底、推进/退回的禁用边界）。
 * - **源码级钉子**：Codes 的编辑器打开态（`draft` 只能由 `useEffect` 播种，SSR 不跑
 *   effect）与 Logs 的查询/记录弹窗（`queryOpen`/`recordOpen` 初值 false，`Modal` 直接
 *   返回 null）渲染不到，按 `check-task-panel.ts` 的做法读源码钉结构。这不是行为证据，
 *   真实浏览器里的输入/点击仍需人工过一眼。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Fixes from '../src/workbench-app/modules/Fixes.jsx';
import Logs from '../src/workbench-app/modules/Logs.jsx';
import Requirements from '../src/workbench-app/modules/Requirements.jsx';
import Codes from '../src/workbench-app/modules/Codes.jsx';
import AssistantMarkdown from '../src/workbench-app/pi-webx/AssistantMarkdown.jsx';
import { addDays, formatDay, todayISO } from '../src/workbench-app/util.mjs';

/* ------------------------------------------------------------ 渲染与比对小工具 */

/** 假 mutate：SSR 不会触发写操作，给个恒真实现即可。 */
const mutate = async (): Promise<boolean> => true;
const notify = (): void => {};

/** 纯文本形态：把标签剥掉，Markdown 残留标记在文本里藏不住。 */
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, '');

/** 字面量出现次数。 */
const occurrences = (markup: string, fragment: string): number => markup.split(fragment).length - 1;

/** 取位置（比顺序用）；找不到直接失败，免得后面的比较静默拿到 -1。 */
const at = (markup: string, fragment: string): number => {
  const index = markup.indexOf(fragment);
  assert.ok(index >= 0, `标记里找不到 ${JSON.stringify(fragment)}：${markup.slice(0, 200)}`);
  return index;
};

/** 读一个源码文件。 */
const sourceOf = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/* ---------------------------------------------------------------------- 假数据 */

type Row = {
  id: string;
  title?: string;
  text?: string;
  priority?: string;
  status?: string;
  level?: string;
  source?: string;
  project?: string;
  note?: string;
  date?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** 日期用本仓库的本地时区口径（util.mjs）：`toISOString` 是 UTC，东八区会差一天。 */
const TODAY = todayISO();
const YESTERDAY = addDays(TODAY, -1);

const DATA = {
  fixes: [
    // updatedAt 倒序：最新复现的问题排最前。
    { id: 'f1', title: '登录页点击报错', priority: 'high', status: 'doing', note: '第二步复现', createdAt: '2026-09-20T01:00:00.000Z', updatedAt: '2026-09-24T01:00:00.000Z' },
    { id: 'f2', title: '导出按钮无响应', priority: 'normal', status: 'todo', note: '', createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-22T01:00:00.000Z' },
    // 缺 updatedAt：回落 createdAt（store 的 STAMPED_MODULES 一定给这两个字段）。
    { id: 'f3', title: '侧边栏样式错位', priority: 'low', status: 'done', note: '改成宽度自适应', createdAt: '2026-09-19T01:00:00.000Z' },
  ] as Row[],
  logs: [
    { id: 'l1', text: '把工作台搬进 pi-webx', level: 'info', source: 'pi-webx', date: TODAY },
    { id: 'l3', text: '样式契约待补', level: 'warn', source: '', date: TODAY },
    { id: 'l2', text: 'SQLite 写入超时', level: 'error', source: 'server', date: YESTERDAY },
  ] as Row[],
  requirements: [
    { id: 'r1', title: '工作台迁移进 pi-webx', priority: 'high', status: 'doing', note: '十个模块搬进来\n先钉结构', createdAt: '2026-09-18T01:00:00.000Z', updatedAt: '2026-09-24T01:00:00.000Z' },
    { id: 'r2', title: '界面契约定稿', priority: 'normal', status: 'todo', note: '', createdAt: '2026-09-19T01:00:00.000Z' },
    { id: 'r3', title: '补实施记录', priority: 'low', status: 'done', note: '写进 notes/implemented', createdAt: '2026-09-17T01:00:00.000Z' },
  ] as Row[],
  codes: [
    { id: 'c1', title: 'check-workbench-ui.ts', project: 'pi-webx', status: 'doing', note: '第一行\n第二行\n第三行', createdAt: '2026-09-20T01:00:00.000Z', updatedAt: '2026-09-24T01:00:00.000Z' },
    { id: 'c2', title: '样式契约落库', project: 'pi-webx', status: 'todo', note: '', createdAt: '2026-09-19T01:00:00.000Z' },
    // 空 project 归「未分组」组。
    { id: 'c3', title: 'README 补截图', project: '', status: 'done', note: '', createdAt: '2026-09-16T01:00:00.000Z' },
  ] as Row[],
};

const EMPTY_DATA = { fixes: [] as Row[], logs: [] as Row[], requirements: [] as Row[], codes: [] as Row[] };

/* ================================================== 要求 1：问题修复渲染成列表 */

const fixes = renderToStaticMarkup(h(Fixes, { data: DATA, mutate, notify }));

// 单张卡片：看板版是「添加表单卡 + 每列一张卡」，列表版只剩一张。
assert.equal(occurrences(fixes, '<section class="card ">'), 1, '问题修复应该只有一张卡片（不是每列一张）');
assert.ok(fixes.includes('<h3 class="card-title">问题修复</h3>'), '卡片标题是「问题修复」');

// 看板痕迹清零：Works 的看板列用这些类名（modules/Works.jsx:121-139），这里一个都不许有。
for (const marker of ['kanban', 'kanban-col', 'kanban-head', 'kanban-count', 'kanban-list', 'work-card']) {
  assert.ok(!fixes.includes(marker), `问题修复里不该再看板痕迹：${marker}`);
}
assert.equal(occurrences(fixes, '<ul class="list" data-testid="fixes-list">'), 1, '所有行都在同一个列表里（不是每列一个列表）');

// 快速添加与列表同卡片（契约 §3 目标 DOM）。
assert.ok(fixes.includes('data-testid="fixes-quick-add"'), '快速添加表单要在卡片里');
assert.ok(fixes.includes('placeholder="描述问题，回车确认"'), '快速添加输入框的占位文案');
assert.ok(fixes.includes('aria-label="描述问题，回车确认"'), '快速添加输入框的无障碍名（同一个文案）');

// 卡头 Segmented 带数量：全部 3 / 待处理 1 / 修复中 1 / 已修复 1。
assert.ok(fixes.includes('class="segmented" role="group" aria-label="状态筛选"'), '卡头状态筛选是 Segmented');
assert.ok(
  fixes.includes('<button type="button" class="segmented-item is-active" aria-pressed="true">全部 3</button>'),
  '筛选默认落在「全部 3」上（数量从 data.fixes 现算）',
);
for (const label of ['待处理 1', '修复中 1', '已修复 1']) {
  assert.ok(fixes.includes(`class="segmented-item " aria-pressed="false">${label}</button>`), `筛选项要有「${label}」`);
}

// 行：三行、按 updatedAt 倒序、都在 fixes-list 里。
assert.equal(occurrences(fixes, 'data-testid="fixes-row"'), 3, '三条问题记录三行');
assert.ok(at(fixes, '登录页点击报错') < at(fixes, '导出按钮无响应'), 'updatedAt 新的排前面');
assert.ok(at(fixes, '导出按钮无响应') < at(fixes, '侧边栏样式错位'), '缺 updatedAt 时回落 createdAt');
const listStart = at(fixes, 'data-testid="fixes-list"');
const listEnd = at(fixes, '</ul>', listStart);
for (const title of ['登录页点击报错', '导出按钮无响应', '侧边栏样式错位']) {
  const rowAt = at(fixes, title);
  assert.ok(rowAt > listStart && rowAt < listEnd, `「${title}」必须在 fixes-list 里（列表形态）`);
}

// 行内：状态/严重程度 chip 的 tone、行内状态下拉、编辑与删除入口。
assert.ok(fixes.includes('<span class="chip accent">修复中</span>'), 'doing 的 chip tone 是 accent');
assert.ok(fixes.includes('<span class="chip warn">待处理</span>'), 'todo 的 chip tone 是 warn');
assert.ok(fixes.includes('<span class="chip ok">已修复</span>'), 'done 的 chip tone 是 ok');
assert.ok(fixes.includes('<span class="chip danger">严重程度 高</span>'), 'high 优先级的 chip tone 是 danger');
assert.ok(fixes.includes('<span class="chip warn">严重程度 中</span>'), 'normal 优先级的 chip tone 是 warn');
assert.ok(fixes.includes('<span class="chip ok">严重程度 低</span>'), 'low 优先级的 chip tone 是 ok');
assert.ok(fixes.includes('data-testid="fixes-status-select" aria-label="状态：登录页点击报错"'), '行内状态下拉带无障碍名');
assert.ok(fixes.includes('<option value="doing" selected="">修复中</option>'), '状态下拉的当前值来自记录 status');
assert.ok(fixes.includes('<option value="todo">待处理</option><option value="doing"'), '状态下拉的三个选项顺序即流转顺序');
assert.equal(occurrences(fixes, 'class="time"'), 3, '每行一个时间戳');
// 备注预览只给有备注的行（第三条 note 为空的没有 note-preview）。
assert.equal(occurrences(fixes, 'note-preview'), 2, 'note-preview 只出现在有备注的行上');
assert.ok(fixes.includes('class="item-note note-preview">第二步复现<'), '有备注的行显示首行预览');
// 每行两个图标按钮（编辑/删除）；两者的无障碍名都必须在，编辑按钮的 label 来自 TEXT.edit。
assert.equal(occurrences(fixes, '<button type="button" class="icon-btn'), 6, '三行各两个图标按钮（编辑 + 删除）');
assert.equal(occurrences(fixes, 'aria-label="编辑问题" title="编辑问题"'), 3, '编辑按钮有无障碍名（TEXT.edit 存在）');
assert.equal(occurrences(fixes, 'class="icon-btn danger " aria-label="删除" title="删除"'), 3, '每行一个删除按钮');
assert.equal(occurrences(fixes, 'class="item-actions always"'), 3, '行内控件常显（always）');

// 空态：走规则 B 外包容器。
const fixesEmpty = renderToStaticMarkup(h(Fixes, { data: EMPTY_DATA, mutate, notify }));
assert.ok(fixesEmpty.includes('data-testid="fixes-empty"'), '零记录时是 fixes-empty');
assert.ok(fixesEmpty.includes('没有问题记录'), '空态标题');
assert.ok(fixesEmpty.includes('在上面的输入框里描述一个问题'), '空态提示');
assert.ok(!fixesEmpty.includes('data-testid="fixes-list"'), '空态不渲染列表');
assert.ok(fixesEmpty.includes('data-testid="fixes-quick-add"'), '空态也保留快速添加（可以在上面直接记一条）');

/* ============================================ 要求 2：日志查询是对话框式查询 */

const logs = renderToStaticMarkup(h(Logs, { data: DATA, mutate, notify }));

// 页面只有一张卡片，卡头两个触发按钮：查询弹窗 / 记录弹窗。
assert.equal(occurrences(logs, '<section class="card ">'), 1, '日志只有一张卡片（常驻表单/检索卡已删）');
assert.ok(logs.includes('<h3 class="card-title">日志记录</h3>'), '卡片标题是「日志记录」');
assert.ok(logs.includes('data-testid="logs-query-open"'), '卡头要有查询对话框的触发按钮');
assert.ok(logs.includes('data-testid="logs-record-open"'), '卡头要有记录对话框的触发按钮');
assert.match(logs, /data-testid="logs-query-open"><svg[\s\S]*?<\/svg> 查询日志<\/button>/, '查询按钮带图标与文案');

// 结果列表：按 date 倒序分组（logs 没有 createdAt/updatedAt，只能用 date）。
assert.equal(occurrences(logs, 'data-testid="logs-group"'), 2, '两个日期分组');
assert.equal(occurrences(logs, 'data-testid="logs-list"'), 2, '每组一个列表');
assert.equal(occurrences(logs, 'data-testid="logs-item"'), 3, '三条日志三行');
assert.ok(at(logs, '把工作台搬进 pi-webx') < at(logs, 'SQLite 写入超时'), '今天（新）的组排在昨天（旧）的组前面');
assert.ok(logs.includes('<span class="group-count">2</span>'), '今天那组两条');
assert.ok(logs.includes('<span class="group-count">1</span>'), '昨天那组一条');
assert.ok(
  logs.includes(`<div class="group-head"><span>${formatDay(TODAY)}</span><span class="chip accent">今天</span><span class="group-count">2</span></div>`),
  '今天的组头：日期 + 「今天」chip + 条数',
);
assert.ok(
  logs.includes(`<div class="group-head"><span>${formatDay(YESTERDAY)}</span><span class="group-count">1</span></div>`),
  '昨天的组头没有「今天」chip',
);

// 行内：级别 chip 的 tone、来源 chip 只给有来源的行、相对日期。
assert.ok(logs.includes('<span class="chip ">信息</span>'), 'info 的 chip 无 tone');
assert.ok(logs.includes('<span class="chip warn">警告</span>'), 'warn 的 chip tone 是 warn');
assert.ok(logs.includes('<span class="chip danger">错误</span>'), 'error 的 chip tone 是 danger');
assert.equal(occurrences(logs, 'class="chip ">#'), 2, '来源 chip 只出现在有 source 的行上');
assert.ok(logs.includes('class="chip ">#pi-webx<'), '来源 chip 形如 #pi-webx');
assert.ok(logs.includes('<span>今天</span>'), '今天的日志显示「今天」');
assert.ok(logs.includes('<span>昨天</span>'), '昨天的日志显示「昨天」');
assert.equal(occurrences(logs, 'class="icon-btn danger " aria-label="删除" title="删除"'), 3, '每行一个删除按钮');

// 初态没有条件条、没有弹窗（filter/查询/记录都还没触发）。
assert.ok(!logs.includes('data-testid="logs-filter-bar"'), '无筛选时不画条件条');
assert.ok(!logs.includes('modal-backdrop'), '查询/记录弹窗默认关闭（Modal open=false 返回 null）');
assert.ok(!logs.includes('data-testid="logs-query-form"'), '查询表单只在弹窗打开后才出现');

const logsEmpty = renderToStaticMarkup(h(Logs, { data: EMPTY_DATA, mutate, notify }));
assert.ok(logsEmpty.includes('data-testid="logs-empty"'), '零日志时是 logs-empty');
assert.ok(logsEmpty.includes('没有匹配的日志'), '空态标题');
assert.ok(!logsEmpty.includes('data-testid="logs-list"'), '空态不渲染列表');

/* ============================================ 要求 3：需求管理是知识列表 */

/** 左栏搜索 + 条目，右栏阅读区。 */
const requirements = renderToStaticMarkup(h(Requirements, { data: DATA, mutate, notify }));

assert.ok(requirements.includes('class="split" data-testid="requirements-split"'), '两栏布局的根');
assert.ok(requirements.includes('<section class="card split-list">'), '左栏卡片挂 split-list');
assert.ok(requirements.includes('<div class="card-body split-list-body">'), '左栏 body 挂 split-list-body');
assert.ok(requirements.includes('<section class="card split-main">'), '右栏卡片挂 split-main');
assert.ok(requirements.includes('<h3 class="card-title">需求清单</h3>'), '左栏标题「需求清单」');
assert.ok(requirements.includes('data-testid="requirements-search"'), '左栏顶部有搜索框');
assert.ok(requirements.includes('placeholder="搜索标题或备注"'), '搜索框占位文案（标题或备注）');
assert.ok(requirements.includes('aria-label="搜索标题或备注"'), '搜索框无障碍名');

// 列表：优先级排序（high → normal → low），同档 updatedAt 新的在前。
assert.equal(occurrences(requirements, 'data-testid="requirements-item"'), 3, '三条需求三个条目');
assert.ok(at(requirements, '工作台迁移进 pi-webx') < at(requirements, '界面契约定稿'), 'high 排最前');
assert.ok(at(requirements, '界面契约定稿') < at(requirements, '补实施记录'), 'low 排最后');
const listOpen = at(requirements, 'data-testid="requirements-list"');
const listClose = at(requirements, '</ul>', listOpen);
for (const title of ['工作台迁移进 pi-webx', '界面契约定稿', '补实施记录']) {
  const itemAt = at(requirements, title);
  assert.ok(itemAt > listOpen && itemAt < listClose, `「${title}」必须在 requirements-list 里`);
}
assert.equal(occurrences(requirements, '<li class="list-item">'), 3, '条目外包 li.list-item（分隔线 + flex 布局）');
assert.ok(requirements.includes('class="entry-btn " data-testid="requirements-item" aria-pressed="false"'), '条目是整行 button.entry-btn，未选中');
assert.ok(requirements.includes('<span class="chip danger">高</span>'), '优先级 chip tone：高 = danger');
assert.ok(requirements.includes('<span class="chip ">中</span>'), '优先级 chip tone：中 = 无 tone');
assert.ok(requirements.includes('<span class="chip ok">低</span>'), '优先级 chip tone：低 = ok');
assert.ok(requirements.includes('<span class="chip warn">待评审</span>'), '状态 chip tone：待评审 = warn');
assert.ok(requirements.includes('<span class="chip accent">开发中</span>'), '状态 chip tone：开发中 = accent');
assert.ok(requirements.includes('<span class="chip ok">已交付</span>'), '状态 chip tone：已交付 = ok');
assert.equal(occurrences(requirements, 'note-preview'), 2, 'note-preview 只出现在有备注的条目上');
assert.ok(requirements.includes('class="item-note note-preview">十个模块搬进来\n先钉结构<'), '备注预览保留原文');

// 未选中时右栏是阅读区空态（规则 B 外包容器）。
assert.ok(requirements.includes('data-testid="requirements-reader-empty"'), '未选中时右栏是 reader-empty');
assert.ok(requirements.includes('选一条需求开始阅读'), '空态标题');
assert.ok(!requirements.includes('data-testid="requirements-reader"'), '未选中不渲染阅读区本体');

/**
 * 阅读区由 `selectedId`（初值空串）驱动，而 `selected` 是从 `data.requirements` 现算的
 * （不经 effect）——塞一条 `id: ''` 的假记录，SSR 就能渲染出**真实**的阅读区分支。
 */
const readerRow = (over: Partial<Row> = {}): Row => ({
  id: '',
  title: '选中后的阅读区',
  priority: 'high',
  status: 'doing',
  note: '第一行背景\n第二行验收标准',
  createdAt: '2026-09-18T01:00:00.000Z',
  updatedAt: '2026-09-24T02:00:00.000Z',
  ...over,
});
const renderRequirements = (rows: Row[]): string =>
  renderToStaticMarkup(h(Requirements, { data: { ...DATA, requirements: rows }, mutate, notify }));

const reader = renderRequirements([readerRow()]);

assert.ok(reader.includes('data-testid="requirements-reader"'), '选中后渲染阅读区');
assert.ok(reader.includes('data-testid="requirements-reader-title"'), '阅读区大标题');
assert.ok(reader.includes('<h3 class="reader-title" data-testid="requirements-reader-title">选中后的阅读区</h3>'), '标题挂在 h3.reader-title 上');
assert.ok(reader.includes('data-testid="requirements-reader-meta"'), '阅读区 meta 行');
assert.ok(reader.includes('<span class="chip danger">优先级 高</span>'), '阅读区 meta 显示「优先级 高」');
assert.ok(reader.includes('<span class="chip accent">开发中</span>'), '阅读区 meta 显示状态 chip');
assert.ok(reader.includes('<span class="time">更新于 '), '阅读区 meta 显示更新时间');
assert.ok(reader.includes('data-testid="requirements-reader-body"'), '阅读区正文容器');
assert.ok(reader.includes('<div class="reader-body" data-testid="requirements-reader-body">第一行背景\n第二行验收标准</div>'), '正文保留换行（pre-wrap）');
for (const testid of ['requirements-back', 'requirements-advance', 'requirements-edit', 'requirements-delete']) {
  assert.ok(reader.includes(`data-testid="${testid}"`), `阅读区底部要有「${testid}」按钮`);
}
assert.ok(reader.includes('class="btn btn-danger" data-testid="requirements-delete"'), '删除是危险样式按钮');
// 选中态：左栏对应条目点亮。
assert.ok(reader.includes('class="entry-btn is-active" data-testid="requirements-item" aria-pressed="true"'), '选中条目有 is-active 与 aria-pressed');

// 阅读区正文兜底与推进/退回的禁用边界（两端禁用，中间两头都可点）。
const readerNoNote = renderRequirements([readerRow({ note: '' })]);
assert.ok(
  readerNoNote.includes('<div class="reader-body" data-testid="requirements-reader-body">（没有备注）</div>'),
  '没有备注时阅读区显示「（没有备注）」兜底',
);
const readerTodo = renderRequirements([readerRow({ status: 'todo' })]);
assert.ok(/data-testid="requirements-back"[^>]*disabled/.test(readerTodo), 'todo 是第一态，退回要禁用');
assert.ok(!/data-testid="requirements-advance"[^>]*disabled/.test(readerTodo), 'todo 还能推进');
const readerDone = renderRequirements([readerRow({ status: 'done' })]);
assert.ok(!/data-testid="requirements-back"[^>]*disabled/.test(readerDone), 'done 还能退回');
assert.ok(/data-testid="requirements-advance"[^>]*disabled/.test(readerDone), 'done 是末态，推进要禁用');

// 零数据：左栏空态（规则 B），右栏阅读区空态不变。
const reqsEmpty = renderToStaticMarkup(h(Requirements, { data: EMPTY_DATA, mutate, notify }));
assert.ok(reqsEmpty.includes('data-testid="requirements-list-empty"'), '零需求时左栏空态');
assert.ok(reqsEmpty.includes('还没有需求'), '左栏空态标题');
assert.ok(reqsEmpty.includes('data-testid="requirements-reader-empty"'), '零需求时右栏仍是阅读区空态');
assert.ok(!reqsEmpty.includes('data-testid="requirements-list"'), '空态不渲染列表');

// 导入来的记录可能缺 note（store.import 只校验必填项，server/workbench/store.ts:76-83）：
// 缺 note 不该让模块崩，条目照常渲染。
const sparse = renderRequirements([{ id: 's1', title: '导入来的老记录', priority: 'normal', status: 'todo', createdAt: '2026-09-01T01:00:00.000Z' }]);
assert.equal(occurrences(sparse, 'data-testid="requirements-item"'), 1, '缺 note 的导入记录照常出条目');
assert.ok(sparse.includes('导入来的老记录'), '缺 note 的导入记录标题要出现');

/* ============================================ 要求 4：代码开发是编辑器工作区 */

const codes = renderToStaticMarkup(h(Codes, { data: DATA, mutate, notify }));

assert.ok(codes.includes('class="split" data-testid="codes-split"'), '两栏布局的根');
assert.ok(codes.includes('<section class="card split-list">'), '左栏卡片挂 split-list');
assert.ok(codes.includes('<div class="card-body split-list-body">'), '左栏 body 挂 split-list-body');
assert.ok(codes.includes('<section class="card split-main">'), '右栏卡片挂 split-main');
assert.ok(codes.includes('<h3 class="card-title">文件</h3>'), '左栏标题「文件」');
assert.ok(codes.includes('data-testid="codes-new"'), '卡头有新建入口（codes-new）');
assert.ok(codes.includes('aria-label="新建开发事项"'), '新建按钮的无障碍名');

// 文件树：按 project 分组（空 project 归「未分组」），组内 updatedAt 倒序。
assert.equal(occurrences(codes, 'data-testid="codes-tree-group"'), 2, '两个分组（pi-webx / 未分组）');
assert.ok(at(codes, 'tree-group-head">pi-webx<') < at(codes, 'tree-group-head">未分组<'), '分组顺序沿用数据里的出现顺序');
assert.ok(codes.includes('<p class="tree-group-head">未分组</p>'), '空 project 归「未分组」组');
assert.equal(occurrences(codes, 'data-testid="codes-tree-item"'), 3, '三个文件条目');
assert.ok(at(codes, 'check-workbench-ui.ts') < at(codes, '样式契约落库'), '组内按 updatedAt 倒序');
assert.ok(codes.includes('data-testid="codes-tree-item" class="entry-btn tree-item " aria-pressed="false"'), '条目是 entry-btn tree-item');
assert.ok(codes.includes('<span class="tree-name">check-workbench-ui.ts</span>'), '等宽标题 tree-name');
assert.ok(codes.includes('<span class="chip accent">进行中</span>'), '进行中的状态 chip');
assert.ok(codes.includes('<span class="chip warn">待办</span>'), '待办的状态 chip');
assert.ok(codes.includes('<span class="chip ok">已完成</span>'), '已完成的状态 chip');
assert.equal(occurrences(codes, 'dot-dirty'), 0, '什么都没打开时不点亮脏圆点');

// 右栏初始是编辑器空态（active/draft 为 null）。
assert.ok(codes.includes('data-testid="codes-editor-empty"'), '没打开条目时右栏是编辑器空态');
assert.ok(codes.includes('从左侧打开一个事项'), '空态标题');
assert.ok(codes.includes('选中文件树里的一条，右侧就会打开编辑器'), '空态提示');

const codesEmpty = renderToStaticMarkup(h(Codes, { data: EMPTY_DATA, mutate, notify }));
assert.ok(codesEmpty.includes('data-testid="codes-tree-empty"'), '零记录时左栏空态');
assert.ok(codesEmpty.includes('还没有开发事项'), '空态标题');
assert.ok(codesEmpty.includes('data-testid="codes-editor-empty"'), '零记录时右栏仍是编辑器空态');

/**
 * Codes 的编辑器打开态**做不到 SSR**：`activeId` 初值是 ''，`draft` 只能由 `useEffect`
 * 播种（modules/Codes.jsx:82-91），而 SSR 不跑 effect。按 `check-task-panel.ts` 的做法
 * 读源码钉结构——这是源码级钉子，不是行为证据。
 */
const codesSource = sourceOf('../src/workbench-app/modules/Codes.jsx');
assert.ok(codesSource.includes('data-testid="codes-editor"'), '打开条目后渲染 codes-editor');
assert.ok(codesSource.includes('className="editor-tabs"'), '编辑器有 tab 栏');
assert.ok(codesSource.includes('<span className="editor-tab is-active" data-testid="codes-tab">'), '当前 tab 高亮');
assert.ok(codesSource.includes('data-testid="codes-tab-dirty"'), 'tab 上有脏标记圆点');
assert.ok(codesSource.includes('className="editor-toolbar"'), 'tab 下面是三列工具条');
for (const testid of ['codes-title-input', 'codes-project-input', 'codes-status-select']) {
  assert.ok(codesSource.includes(`data-testid="${testid}"`), `工具条要有「${testid}」控件`);
}
assert.ok(codesSource.includes('className="editor-area"'), '编辑区外壳 editor-area');
assert.ok(codesSource.includes('data-testid="codes-gutter"'), '编辑区有行号槽 codes-gutter');
assert.ok(codesSource.includes('className="editor-input"'), '编辑区有等宽编辑框');
assert.ok(codesSource.includes('data-testid="codes-editor-input"'), '编辑框 testid');
assert.ok(codesSource.includes('wrap="off"'), 'textarea 必须 wrap="off"（否则软换行使行号错位）');
assert.ok(codesSource.includes('maxLength={5000}'), 'note 上限 5000（服务端 schema 同值）');
assert.ok(codesSource.includes('className="editor-status"'), '编辑器有状态栏');
assert.ok(codesSource.includes('data-testid="codes-statusbar"'), '状态栏 testid');
assert.ok(codesSource.includes('data-testid="codes-line-count"'), '状态栏有行数');
assert.ok(codesSource.includes('data-testid="codes-save"'), '状态栏有保存按钮');
assert.ok(codesSource.includes('data-testid="codes-dirty-dot"'), '文件树当前项也有脏圆点');
assert.ok(
  codesSource.includes("if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's')"),
  '⌘S / Ctrl+S 走同一条保存路径',
);
assert.ok(codesSource.includes('<IconButton label={TEXT.delete} tone="danger" onClick={() => setPendingDelete(active)}>'), 'tab 行内有删除入口（removeRecord 的 UI 入口）');

/* ================================ 要求 5：对话面板正文与 /chat 渲染一致 */

const CHAT_TEXT = '**加粗** 与 `行内代码`\n\n- 列表甲\n- 列表乙\n\n> 引用一句\n\n```js\nconst answer = 42\n```\n';

/** Markdown 要 ConfigProvider + motion 包着，否则 MotionProvider 直接抛（见文件头）。 */
const renderMarkdown = (text: string): string =>
  renderToStaticMarkup(
    h(ConfigProvider, { motion, children: h(AssistantMarkdown, { text }) }),
  );

const chatMd = renderMarkdown(CHAT_TEXT);

assert.ok(chatMd.includes('class="chat-md" data-testid="chat-markdown"'), '正文容器是 div.chat-md + testid');
// 真实元素，不是转义后的字面量。
assert.ok(chatMd.includes('<strong>加粗</strong>'), '**加粗** 渲染成 <strong>');
assert.ok(chatMd.includes('<code>行内代码</code>'), '`行内代码` 渲染成 <code>');
assert.ok(chatMd.includes('<li>列表甲</li>') && chatMd.includes('<li>列表乙</li>'), '列表项渲染成 <li>');
assert.ok(chatMd.includes('<blockquote>'), '引用渲染成 <blockquote>');
assert.ok(chatMd.includes('<pre><code>'), '围栏代码块渲染成 <pre><code>');
// 与 /chat 同款 props：chat 变体、14px、全宽代码块。
assert.ok(chatMd.includes('--lobe-markdown-font-size:14px'), 'fontSize 与 /chat 一致（14）');
assert.ok(chatMd.includes('data-code-type="highlighter"'), 'fullFeaturedCodeBlock：代码块走高亮块');
// 纯文本里不许残留 Markdown 标记。
const chatText = textOf(chatMd);
assert.ok(!chatText.includes('**'), `纯文本里不该残留 **：${JSON.stringify(chatText.slice(0, 120))}`);
assert.ok(!chatText.includes('```'), `纯文本里不该残留 \`\`\`：${JSON.stringify(chatText.slice(0, 120))}`);
for (const body of ['加粗', '行内代码', '列表甲', '列表乙', '引用一句', 'const answer = 42']) {
  assert.ok(chatText.includes(body), `正文要出现「${body}」`);
}
// 空/空白文本不渲染容器（免得出现空壳）。
assert.equal(renderMarkdown(''), '', '空文本渲染为空');
assert.equal(renderMarkdown('   \n  '), '', '纯空白文本也渲染为空');

/* ------------------------------------------------ 对话面板外壳：源码级钉子 */

/**
 * `ChatMessage` / `ToolRows` 是 `App.jsx` 的模块作用域私有组件、没有导出，而 App 的模块图
 * 在模块级就摸 `window`（`src/lib/connection.ts` 的 `sharedConnection`），Node 里 import
 * 不起来（同 `check-task-panel.ts:19-20` 的说明），所以外壳结构只能读源码钉。
 */
const appSource = sourceOf('../src/workbench-app/App.jsx');
assert.ok(appSource.includes('import AssistantMarkdown from '), '面板正文复用 AssistantMarkdown（同一套 Markdown）');
assert.ok(appSource.includes('data-testid="chat-scroll"'), '滚动容器落 testid');
assert.ok(appSource.includes("if (message.role === 'tool') return <ToolRows tools={message.tools} />"), '独立的 role:tool 消息也走 ToolRows（完整输出在真实会话里才看得见）');
assert.ok(appSource.includes('<ToolRows tools={message.tools} />'), 'assistant 消息附属的 tools 同样渲染工具行');
assert.ok(appSource.includes('data-testid="chat-tool-row"'), '工具行容器 testid');
assert.ok(appSource.includes('data-testid="chat-tool-entry"'), '单条工具 testid');
assert.ok(appSource.includes('data-testid="chat-tool-details"'), '可展开完整输出 testid');
assert.ok(appSource.includes('<pre className="tool-output">{tool.output}</pre>'), '完整输出原样进 <pre>（截断挪到展示层 previewOf）');
assert.ok(appSource.includes('flat.length > 160 ? `${flat.slice(0, 160)}…` : flat'), '短预览取第一行、截到 160 字');
assert.ok(appSource.includes('<div className="bubble" data-testid="chat-msg-bubble">'), '用户气泡是 div.bubble 且正文过 Markdown（<p> 里塞块级元素是非法嵌套）');
assert.ok(appSource.includes('<div className="msg-body" data-testid="chat-msg-body">'), '助手正文走 msg-body + chat-md，不再用气泡');
// MODULES 四条描述：不再出现「看板」。
const modulesBlock = appSource.slice(appSource.indexOf('const MODULES = ['), appSource.indexOf(']', appSource.indexOf('const MODULES = [')));
for (const [id, label, desc] of [
  ['fixes', '问题修复', '问题清单、严重程度与状态流转'],
  ['logs', '日志查询', '对话框式检索与记录开发日志'],
  ['requirements', '需求管理', '需求知识库：搜索、列表与阅读视图'],
  ['codes', '代码开发', '文件树 + 编辑器工作区'],
] as const) {
  assert.ok(modulesBlock.includes(`id: '${id}'`), `MODULES 要有 ${id}`);
  assert.ok(modulesBlock.includes(`label: '${label}'`), `${id} 的菜单标签是「${label}」`);
  assert.ok(modulesBlock.includes(`desc: '${desc}'`), `${id} 的描述是「${desc}」`);
}
assert.ok(!modulesBlock.slice(modulesBlock.indexOf("id: 'fixes'")).includes('看板'), '这四个模块的描述里不该再出现「看板」');

// 工作台根组件也要 ConfigProvider（否则 /chat 那套主题与 motion 不生效）。
const mainSource = sourceOf('../src/main.tsx');
assert.ok(mainSource.includes(': <ConfigProvider motion={motion}><WorkbenchRoot /></ConfigProvider>'), 'main.tsx 给 WorkbenchRoot 包 ConfigProvider motion');

// 截断从数据源头挪走：hook 不再 slice，完整 output 直达展示层。
const hookSource = sourceOf('../src/workbench-app/pi-webx/useWorkbenchPiChat.jsx');
assert.ok(!hookSource.includes('.slice(0, 160)'), 'toChatMessages 不再截断输出');
assert.match(hookSource, /name: run\.toolName,\s*output: run\.output/, 'assistant 附属工具携带完整输出');
assert.ok(hookSource.includes('tools: [{ name: entry.run.toolName, output: entry.run.output }]'), '独立 toolResult 消息携带完整输出');

/* ------------------------------------------------------------------ 通过信息 */

console.log(
  'check-workbench-ui: ok — 问题修复单卡列表（无看板列、卡头 Segmented 带数量、快速添加同卡）、'
  + '日志查询卡头触发按钮 + 按日期倒序分组的结果列表、'
  + '需求管理 knowledge 列表（优先级排序、选中态、阅读区标题/meta/正文/底部四操作）与代码开发文件树 + 编辑器结构、'
  + '对话面板 Markdown 出 <strong>/<code>/<li>/<pre> 真实元素且纯文本无 ** 与 ``` 残留；'
  + '未验证：点击类交互（输入过滤、开/提交弹窗、切条目、脏标记、⌘S）无 DOM 环境跑不了，'
  + 'Codes 编辑器打开态与 Logs 查询/记录弹窗走源码级钉子',
);
