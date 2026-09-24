/**
 * 工作台界面验收（v2，2026-09 重塑版）：把七个模块 + AI 面板正文渲染钉在 SSR 产物上。
 *
 * 写法照 `scripts/check-task-panel.ts`：真实组件进 `renderToStaticMarkup`，喂构造好的假数据，
 * 断言只认 DOM 证据。与 v1 的差别：模块们各自 `import './X.css'`（模块样式私有化），
 * 所以本脚本必须走 `scripts/check-bootstrap.mjs`（CSS 被短路成回显 Proxy）。
 * 跑法：`npm run check:workbench-ui`（已带引导）。
 *
 * 覆盖（对应 docs/workbench-redesign.md 第 4 节逐模块规格）：
 *   1. 我的主页是指挥台 widget 板：`data-widget` 六件套 + 空库引导只走 `welcome`；
 *   2. 今日规划：快速捕获条 + 今天/全部两档 + 逾期优先分组；
 *   3. 工作助理：看板（三列 + 可拖卡）与列表双视图，视图偏好来自 prefs；
 *   4. 问题修复是列表（用户定调）：密集表格 + 行内状态 + 关联回链；
 *   5. 日志查询是对话框（用户定调）：主界面只有表，查询/记录弹窗默认关闭；
 *   6. 需求管理是知识列表（用户定调）：左右两栏 + 右栏 markdown 阅读区；
 *   7. 代码开发是编辑器工作区（用户定调）：文件树 + tab + 行号编辑区 + 状态栏；
 *   8. AI 面板正文与 /chat 一致：AssistantMarkdown 渲染出真实元素，无 markdown 残留；
 *   9. 知识库两态（首页搜索卡片 / 目录+阅读）：首页 / 选中 / 预览 / 旧数据 / 空库都有 DOM 证据；
 *   10. 「问小台」失败路径：pi 不可用时 pending 用户气泡保留笔记内容、错误条是人话；
 *       pending 气泡的留存/撤销走 nextAskState 状态机（发送在途 ≠ 面板被清空）。
 *
 * 交互分支（拖拽、弹窗内提交、⌘S、勾选）SSR 不可达，按 `check-task-panel.ts` 的做法
 * 读源码钉结构；真实浏览器验收由 ego 截图阶段完成。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Dashboard from '../src/workbench-app/modules/Dashboard.jsx';
import Tasks from '../src/workbench-app/modules/Tasks.jsx';
import Works from '../src/workbench-app/modules/Works.jsx';
import Fixes from '../src/workbench-app/modules/Fixes.jsx';
import Logs from '../src/workbench-app/modules/Logs.jsx';
import Requirements from '../src/workbench-app/modules/Requirements.jsx';
import Codes from '../src/workbench-app/modules/Codes.jsx';
import Knowledge from '../src/workbench-app/modules/Knowledge.jsx';
import AIPanel, { nextAskState } from '../src/workbench-app/shell/AIPanel.jsx';
import AssistantMarkdown from '../src/workbench-app/pi-webx/AssistantMarkdown.jsx';
import { todayISO } from '../src/workbench-app/util.mjs';

/* ------------------------------------------------------------ 渲染与比对小工具 */

/** 假 mutate：SSR 不会触发写操作，给个恒真实现即可。 */
const mutate = async (): Promise<boolean> => true;
const notify = (): void => {};
const navigate = (): void => {};
const setPref = async (): Promise<void> => {};

const TODAY = todayISO();
const YESTERDAY = String(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
const TOMORROW = String(new Date(Date.now() + 86400000).toISOString().slice(0, 10));

/** 纯文本形态：把标签剥掉。 */
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, '');

/** 字面量出现次数。 */
const occurrences = (markup: string, fragment: string): number => markup.split(fragment).length - 1;

/** 渲染一个模块。 */
function render(Component: (props: Record<string, unknown>) => JSX.Element, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(h(Component, {
    data,
    profile: { name: 'Yin', motto: '把日子过成想要的样子' },
    mutate,
    refresh: async () => {},
    notify,
    navigate,
    modules: [],
    prefs: {},
    setPref,
    empty: false,
    onLoadDemo: async () => {},
    ...extra,
  }));
}

/** 读一个源码文件。 */
function sourceOf(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** 任何渲染物都不许泄漏 undefined / NaN（脏数据兜底的底线）。 */
function assertNoLeaks(markup: string, label: string): void {
  assert.ok(!markup.includes('undefined'), `${label} 泄漏了 undefined`);
  assert.ok(!markup.includes('NaN'), `${label} 泄漏了 NaN`);
}

/* ---------------------------------------------------------------------- 假数据 */

const REQ_A = '11111111-1111-4111-8111-111111111111';
const REQ_B = '22222222-2222-4222-8222-222222222222';
const TASK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIX_A = 'aaaaaaaa-aaaa-4aaa-8aaa-ffffffffffff';

function fakeData(): Record<string, unknown> {
  return {
    tasks: [
      { id: TASK_A, title: '把暗色模式的令牌补全', done: false, due: TODAY, priority: 'high', tag: '设计', tags: ['设计'], refs: [{ type: 'requirements', id: REQ_A }], createdAt: `${YESTERDAY}T09:00:00.000Z` },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '写周报', done: false, due: YESTERDAY, priority: 'high', tag: '汇报', tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z` },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: '评审交互稿', done: false, due: TOMORROW, priority: 'normal', tag: 'AI', tags: ['AI'], refs: [{ type: 'requirements', id: REQ_B }], createdAt: `${YESTERDAY}T09:00:00.000Z` },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: '清理 dist', done: true, due: TODAY, priority: 'low', tag: '杂务', tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z` },
    ],
    works: [
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: '指挥台外壳重构', note: '顶栏 + 左导航 + AI 副驾 + 命令面板', status: 'doing', tags: ['前端'], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T10:00:00.000Z` },
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', title: 'SQLite 关联字段落地', note: 'tags / refs / starred 与搜索端点', status: 'done', tags: ['后端'], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:30:00.000Z` },
      { id: '12121212-1212-4212-8212-121212121212', title: '模块逐个重塑验收', note: '7 个模块过一遍 ego 截图', status: 'todo', tags: ['验收'], refs: [{ type: 'fixes', id: FIX_A }], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
    ],
    fixes: [
      { id: FIX_A, title: 'AI 面板断线后不会自愈', priority: 'high', status: 'doing', note: '旧 session 失效后自动开新会话', tags: ['bug', 'AI'], refs: [{ type: 'tasks', id: TASK_A }], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${TODAY}T08:00:00.000Z` },
      { id: '13131313-1313-4313-8313-131313131313', title: '侧栏品牌名连写', priority: 'normal', status: 'done', note: '', tags: ['界面'], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
      { id: '14141414-1414-4414-8414-141414141414', title: '导入旧 JSON 时间戳丢失', priority: 'low', status: 'todo', note: '补 createdAt/updatedAt', tags: ['数据'], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
    ],
    logs: [
      { id: '15151515-1515-4515-8515-151515151515', text: '指挥台外壳写完，⌘K 可用', level: 'info', source: 'workbench', date: TODAY, tags: [], refs: [], createdAt: `${TODAY}T09:00:00.000Z` },
      { id: '16161616-1616-4616-8616-161616161616', text: '暗色令牌对比度不达标，已加深文本三档', level: 'warn', source: 'design', date: TODAY, tags: [], refs: [], createdAt: `${TODAY}T09:30:00.000Z` },
      { id: '17171717-1717-4717-8717-171717171717', text: '旧版 JSON 导入回滚正常', level: 'error', source: 'server', date: YESTERDAY, tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z` },
    ],
    requirements: [
      { id: REQ_A, title: '工作台支持暗色模式', priority: 'high', status: 'doing', note: '## 动机\n深夜刺眼。\n\n- 跟随系统\n- 记住选择', tags: ['体验', '设计'], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${TODAY}T08:00:00.000Z` },
      { id: REQ_B, title: 'AI 副驾可以帮记一条任务', priority: 'normal', status: 'todo', note: '说「存为今日任务」就落库。', tags: ['AI'], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
      { id: '18181818-1818-4818-8818-181818181818', title: '日志支持按来源过滤', priority: 'low', status: 'done', note: '', tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
    ],
    codes: [
      { id: '19191919-1919-4919-8919-191919191919', title: '命令面板组件', project: 'pi-webx', status: 'doing', note: 'shell/CommandPalette.jsx\n\n- 全局搜索\n- 快捷操作', tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
      { id: '20202020-2020-4020-8020-202020202020', title: '搜索端点', project: 'pi-webx', status: 'done', note: 'GET /search?q=', tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
      { id: '21212121-2121-4121-8121-212121212121', title: '主页 widget 板', project: '', status: 'todo', note: '三列网格', tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z` },
    ],
  };
}

/* ---------------------------------------------------------------------- 假数据 */

const data = fakeData();

/* ================================================== 1. 我的主页：指挥台 widget 板 */

{
  const markup = render(Dashboard, data);
  assert.ok(markup.includes('data-module="dashboard"'), '主页缺 data-module');
  for (const widget of ['greeting', 'progress', 'todos', 'fixes', 'logs', 'codes']) {
    assert.ok(markup.includes(`data-widget="${widget}"`), `主页缺 widget：${widget}`);
  }
  assert.ok(!markup.includes('data-widget="welcome"'), '有数据时不该出现空库引导');
  assert.ok(markup.includes('完成：把暗色模式的令牌补全'), '待办 widget 缺行内完成按钮');
  assert.ok(markup.includes('%'), '进度 widget 缺百分比');
  assert.ok(textOf(markup).includes('把日子过成想要的样子'), '主页缺座右铭');
  assertNoLeaks(markup, '主页');

  // 空库判定是双条件（empty 标志 + 确无记录），传真空数据才该出引导。
  const blank: Record<string, unknown> = {
    tasks: [], works: [], fixes: [], logs: [], requirements: [], codes: [],
  };
  const emptyMarkup = render(Dashboard, blank, { empty: true, onLoadDemo: async () => {} });
  assert.ok(emptyMarkup.includes('data-widget="welcome"'), '空库应只出引导 widget');
  assert.ok(!emptyMarkup.includes('data-widget="progress"'), '空库时不该渲染 widget 板');
  // empty 标志误报为 true 但库里有记录时，不许把用户数据藏起来。
  assert.ok(render(Dashboard, data, { empty: true }).includes('data-widget="progress"'), '有记录时即使 empty=true 也该渲染 widget 板');

  assert.ok(sourceOf('../src/workbench-app/modules/Dashboard.jsx').includes('onLoadDemo()'), '主页演示数据按钮未接线');
}

/* ================================================== 2. 今日规划：快速捕获 + 分组 */

{
  const markup = render(Tasks, data);
  assert.ok(markup.includes('data-module="tasks"'), '规划缺 data-module');
  assert.ok(markup.includes('data-testid="tasks-capture"'), '规划缺快速捕获条');
  assert.equal(occurrences(markup, 'data-testid="task-row"'), 3, '今天档应有 3 行（逾期+今天+今天已勾）');
  assert.ok(markup.includes('今天') && markup.includes('已完成'), '规划缺分组');
  assert.ok(markup.includes('is-done'), '完成行缺划线态');
  assertNoLeaks(markup, '规划');

  const allMarkup = render(Tasks, data, { prefs: { tasksScope: 'all' } });
  assert.equal(occurrences(allMarkup, 'data-testid="task-row"'), 4, '全部档应有 4 行');

  assert.ok(sourceOf('../src/workbench-app/modules/Tasks.jsx').includes('parseQuickAdd'), '快速捕获语法解析未落地');
}

/* ================================================== 3. 工作助理：看板 / 列表双视图 */

{
  const kanban = render(Works, data);
  assert.ok(kanban.includes('data-module="works"'), '助理缺 data-module');
  assert.ok(kanban.includes('data-testid="works-board"'), '默认应是看板');
  assert.equal(occurrences(kanban, 'data-testid="works-col"'), 3, '看板应三列');
  assert.equal(occurrences(kanban, 'data-testid="work-card"'), 3, '看板卡数应等于记录数');
  assert.ok(kanban.includes('draggable="true"'), '卡片应可拖动改状态');
  assertNoLeaks(kanban, '助理看板');

  const list = render(Works, data, { prefs: { worksView: 'list' } });
  assert.ok(list.includes('data-testid="works-table"'), 'list 偏好应是表格视图');
  assert.ok(!list.includes('data-testid="works-board"'), 'list 视图不该渲染看板');
  assert.equal(occurrences(list, 'data-testid="work-row"'), 3, '列表行数应等于记录数');

  const worksSource = sourceOf('../src/workbench-app/modules/Works.jsx');
  assert.ok(worksSource.includes('onDragStart') && worksSource.includes('onDrop'), '看板缺拖拽接线');
  assert.ok(worksSource.includes("api.patchRecord('works'"), '拖拽落库未接线');

  const emptyWorks = render(Works, { ...fakeData(), works: [] }, { empty: true });
  assert.ok(emptyWorks.includes('data-testid="works-load-demo"'), '空库缺演示数据入口');
}

/* ================================================== 4. 问题修复：列表（用户定调） */

{
  const markup = render(Fixes, data);
  assert.ok(markup.includes('data-module="fixes"'), '修复缺 data-module');
  assert.equal(occurrences(markup, 'data-testid="fix-row"'), 3, '修复应是列表且行数正确');
  assert.ok(markup.includes('data-testid="fixes-quick-add"'), '修复缺快速捕获');
  assert.ok(!markup.includes('kanban') && !markup.includes('work-card'), '修复模块不许出现看板痕迹（用户定调：列表）');
  assertNoLeaks(markup, '修复');

  const fixesSource = sourceOf('../src/workbench-app/modules/Fixes.jsx');
  assert.ok(fixesSource.includes("api.addRecord('logs'"), '修复详情应能回记日志');
  assert.ok(fixesSource.includes("type: 'fixes'"), '回记日志应带 fix 关联');

  const emptyFixes = render(Fixes, { ...fakeData(), fixes: [] }, { empty: true });
  assert.ok(emptyFixes.includes('data-testid="fixes-load-demo"'), '空库缺演示数据入口');
  assert.ok(emptyFixes.includes('data-testid="fixes-empty"'), '空库缺空态');
}

/* ================================================== 5. 日志查询：对话框（用户定调） */

{
  const markup = render(Logs, data);
  assert.ok(markup.includes('data-module="logs"'), '日志缺 data-module');
  assert.ok(markup.includes('data-testid="logs-list"'), '日志主界面缺结果表');
  assert.equal(occurrences(markup, 'data-testid="log-row"'), 3, '日志行数应等于记录数');
  assert.ok(markup.includes('data-testid="logs-query-open"'), '日志缺「查询日志」入口');
  assert.ok(markup.includes('data-testid="logs-record-open"'), '日志缺「记录日志」入口');
  assert.ok(!markup.includes('logs-query-form') && !markup.includes('logs-record-form'), '弹窗默认必须关闭（用户定调：对话框形式）');
  assert.ok(!markup.includes('logs-filter-bar'), '无筛选时不该画条件条');
  assertNoLeaks(markup, '日志');

  const logsSource = sourceOf('../src/workbench-app/modules/Logs.jsx');
  assert.ok(logsSource.includes("api.addRecord('logs'"), '记录日志未接线');
  assert.ok(logsSource.includes('queryOpen') && logsSource.includes('recordOpen'), '查询/记录弹窗状态未落地');

  const emptyLogs = render(Logs, { ...fakeData(), logs: [] }, { empty: true });
  assert.ok(emptyLogs.includes('data-testid="logs-load-demo"'), '空库缺演示数据入口');
}

/* ================================================== 6. 需求管理：知识列表（用户定调） */

{
  const markup = render(Requirements, data);
  assert.ok(markup.includes('data-module="requirements"'), '需求缺 data-module');
  assert.ok(markup.includes('data-testid="req-split"'), '需求应是左右两栏');
  assert.equal(occurrences(markup, 'data-testid="req-item"'), 3, '左栏条目数应等于记录数');
  assert.ok(markup.includes('data-testid="req-search"'), '左栏缺搜索');
  assert.ok(markup.includes('data-testid="req-reader"'), '右栏阅读区容器应常驻');
  assert.ok(markup.includes('data-testid="req-reader-empty"'), '未选中时应是阅读区空态');
  assertNoLeaks(markup, '需求');

  // 选中态：旧契约塞一条 id:'' 的假记录驱动 SSR 选中分支。
  const withBlank = fakeData();
  // 让第一条任务引用这条 id 为空的占位需求，选中态阅读区才会渲染关联任务。
  ((withBlank.tasks as Array<Record<string, unknown>>)[0]).refs = [{ type: 'requirements', id: '' }];
  (withBlank.requirements as Array<Record<string, unknown>>).unshift({
    id: '', title: '占位选中', priority: 'normal', status: 'done', note: '**加粗**与`代码`', tags: [], refs: [], createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z`,
  });
  const selected = render(Requirements, withBlank);
  assert.ok(selected.includes('data-testid="req-reader-title"'), '选中态缺标题');
  assert.ok(selected.includes('data-testid="req-reader-body"'), '选中态缺正文');
  assert.ok(selected.includes('<strong>'), '阅读区应渲染 markdown 加粗');
  assert.ok(!textOf(selected).includes('**'), '阅读区不应残留 markdown 标记');
  assert.ok(selected.includes('data-testid="req-task"'), '关联任务缺失（任务引用需求的假数据）');
  // done 是终态：推进按钮必须禁用，防止推出未知状态。
  const advanceIndex = selected.indexOf('data-testid="req-advance"');
  assert.ok(advanceIndex >= 0 && selected.slice(advanceIndex, advanceIndex + 200).includes('disabled'), '终态需求的推进按钮应禁用');

  const emptyReq = render(Requirements, { ...fakeData(), requirements: [] }, { empty: true });
  assert.ok(emptyReq.includes('data-testid="req-load-demo"'), '空库缺演示数据入口');
}

/* ================================================== 7. 代码开发：编辑器工作区（用户定调） */

{
  const markup = render(Codes, data);
  assert.ok(markup.includes('data-module="codes"'), '代码模块缺 data-module');
  assert.ok(markup.includes('data-testid="codes-tree-panel"'), '代码模块缺文件树面板');
  assert.equal(occurrences(markup, 'data-testid="code-item"'), 3, '树项数应等于记录数');
  assert.ok(markup.includes('data-testid="codes-tree-group"'), '文件树应按 project 分组');
  assert.ok(markup.includes('data-testid="codes-editor-empty"'), '未打开事项时应是空编辑器');
  assert.ok(markup.includes('data-testid="codes-new"'), '代码模块缺新建入口');
  assertNoLeaks(markup, '代码');

  const codesSource = sourceOf('../src/workbench-app/modules/Codes.jsx');
  assert.ok(codesSource.includes("'s'") && codesSource.includes('metaKey'), '编辑器缺 ⌘S 保存');
  assert.ok(codesSource.includes('codes-gutter'), '编辑器缺行号槽');
  assert.ok(codesSource.includes('preventDefault'), '⌘S 未阻止浏览器默认保存');
}

/* ================================================== 8. AI 面板正文：与 /chat 渲染一致 */

{
  const markup = renderToStaticMarkup(
    h(ConfigProvider, { motion },
      h(AssistantMarkdown, { text: '标题\n\n**加粗**与`代码`\n\n- 甲\n- 乙\n\n```js\nconst a = 1\n```' })),
  );
  assert.ok(markup.includes('<strong>'), 'AssistantMarkdown 缺加粗渲染');
  assert.ok(markup.includes('<code'), 'AssistantMarkdown 缺行内代码渲染');
  assert.ok(markup.includes('<li'), 'AssistantMarkdown 缺列表渲染');
  assert.ok(markup.includes('<pre'), 'AssistantMarkdown 缺代码块渲染');
  assert.ok(!textOf(markup).includes('**') && !textOf(markup).includes('```'), 'AssistantMarkdown 残留 markdown 标记');
}

/* ================================================== 9. 知识库：库 / 目录 / 文档 / 阅读 */

{
  const KB_BASE = '9000000e-0000-4000-8000-00000000000e';
  const KB_FOLDER = '9000000f-0000-4000-8000-00000000000f';
  const KB_A = '9000000a-0000-4000-8000-00000000000a';
  const KB_B = '9000000b-0000-4000-8000-00000000000b';
  const KB_C = '9000000c-0000-4000-8000-00000000000c';
  const TASK_KB = '9000000d-0000-4000-8000-00000000000d';
  const base = { id: KB_BASE, title: '工作台知识库', description: '开发结论', createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${TODAY}T08:00:00.000Z` };
  const folder = { id: KB_FOLDER, title: '规范', knowledgeBaseId: KB_BASE, parentId: '' };
  const kbData: Record<string, unknown> = {
    ...fakeData(),
    knowledgeBases: [base],
    knowledgeFolders: [folder],
    knowledge: [
      {
        id: KB_A, title: '工作台双链设计', body: '正文引用 [[知识库字段约定]]，还有 **加粗** 与 `代码`。',
        knowledgeBaseId: KB_BASE, folderId: KB_FOLDER,
        tags: ['设计', '知识库'], refs: [{ type: 'knowledge', id: KB_B }, { type: 'tasks', id: TASK_KB }],
        starred: true, createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${TODAY}T08:00:00.000Z`,
      },
      {
        id: KB_B, title: '知识库字段约定', body: 'title 必填，body 长文本。', knowledgeBaseId: KB_BASE, folderId: '',
        tags: ['约定'], refs: [], starred: false, createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:30:00.000Z`,
      },
      {
        id: KB_C, title: '链接面板验收清单', body: '检查 [[工作台双链设计]] 的反链。', knowledgeBaseId: KB_BASE, folderId: '',
        tags: ['验收'], refs: [{ type: 'knowledge', id: KB_A }], starred: false, createdAt: `${YESTERDAY}T09:00:00.000Z`, updatedAt: `${YESTERDAY}T09:00:00.000Z`,
      },
    ],
    tasks: [
      ...(fakeData().tasks as Array<Record<string, unknown>>),
      {
        id: TASK_KB, title: '给知识库补反链断言', done: false, due: TODAY, priority: 'normal', tag: '验收',
        tags: ['验收'], refs: [{ type: 'knowledge', id: KB_A }], createdAt: `${TODAY}T09:00:00.000Z`,
      },
    ],
  };

  const list = render(Knowledge, kbData);
  assert.ok(list.includes('data-testid="kb-bases"'), '入口应先展示知识库列表');
  assert.equal(occurrences(list, 'data-testid="kb-base-item"'), 1, '知识库卡片数错误');
  assert.ok(list.includes('工作台知识库') && list.includes('3 篇文档') && list.includes('1 个目录'), '知识库卡片缺名称或内容计数');
  assert.ok(list.includes('data-testid="kb-new-base"'), '缺创建知识库入口');
  assert.ok(!list.includes('data-testid="kb-editor"'), '库列表不应提前打开文档');
  assertNoLeaks(list, '知识库列表');

  const documents = render(Knowledge, kbData, { prefs: { kbStage: 'documents', kbBaseId: KB_BASE } });
  assert.ok(documents.includes('data-testid="kb-documents"'), '进入知识库后缺文档页');
  assert.ok(documents.includes('文档目录') && documents.includes('规范'), '文档页缺目录树');
  assert.equal(occurrences(documents, 'data-testid="kb-item"'), 3, '库内文档数错误');
  assert.ok(documents.includes('data-testid="kb-search"'), '缺库内搜索');
  assert.ok(documents.includes('data-testid="kb-tag-filter"') && documents.includes('data-testid="kb-source-filter"'), '缺标签或来源筛选');
  assert.ok(documents.includes('今日规划') && documents.includes('知识库'), '来源筛选应由文档 refs 动态生成');
  assert.ok(documents.includes('data-testid="kb-new"'), '缺新建文档入口');
  assert.ok(!documents.includes('data-testid="kb-backlinks"'), '文档列表不应显示阅读关联');
  assertNoLeaks(documents, '知识库文档列表');

  const readingPrefs = { kbStage: 'reading', kbBaseId: KB_BASE, kbSelectedId: KB_A };
  const selected = render(Knowledge, kbData, { prefs: { ...readingPrefs, kbView: 'edit' } });
  assert.ok(selected.includes('data-testid="kb-split"'), '阅读态应是目录 + 正文两栏');
  assert.equal(occurrences(selected, 'data-testid="kb-toc-item"'), 3, '阅读目录应覆盖本库所有文档');
  assert.ok(selected.includes('data-testid="kb-back-home"'), '缺返回文档列表入口');
  assert.ok(selected.includes('data-testid="kb-title-input"') && selected.includes('data-testid="kb-body-input"'), '编辑态缺标题或正文');
  assert.ok(selected.includes('data-testid="kb-save"') && selected.includes('data-testid="kb-preview"'), '编辑态缺保存或预览');
  assert.ok(selected.includes('aria-label="移动文档到目录"') && selected.includes('规范'), '阅读态缺目录归属');
  assert.ok(selected.includes('data-testid="kb-sources"') && selected.includes('今日规划「给知识库补反链断言」'), '跨模块来源没有保留');
  const outgoingAt = selected.indexOf('data-testid="kb-outgoing"');
  const incomingAt = selected.indexOf('data-testid="kb-incoming"');
  assert.ok(outgoingAt >= 0 && incomingAt > outgoingAt, '双向链接分区缺失');
  assert.ok(selected.slice(outgoingAt, incomingAt).includes('知识库字段约定'), '出链缺 [[标题]] 关联');
  assert.ok(selected.slice(incomingAt).includes('链接面板验收清单'), '反链缺引用本篇的文档');
  assertNoLeaks(selected, '知识库阅读');

  const preview = render(Knowledge, kbData, { prefs: readingPrefs });
  assert.ok(preview.includes('data-testid="kb-preview-body"') && preview.includes('<strong>'), '阅读应渲染 markdown');
  assert.ok(!preview.includes('data-testid="kb-body-input"'), '预览态不应有正文输入框');
  const withAI = render(Knowledge, kbData, { prefs: readingPrefs, askAI: async () => {} });
  assert.ok(withAI.includes('data-testid="kb-ask-ai"'), '问小台入口缺失');
  assertNoLeaks(preview, '知识库预览');

  const legacy = render(Knowledge, { ...fakeData(), knowledgeBases: [base], knowledgeFolders: [], knowledge: [{ id: KB_B, title: '旧笔记', knowledgeBaseId: KB_BASE }] }, { prefs: { kbStage: 'reading', kbBaseId: KB_BASE, kbSelectedId: KB_B } });
  assert.ok(legacy.includes('data-testid="kb-preview-body"'), '旧文档缺字段时应能阅读');
  assertNoLeaks(legacy, '知识库旧文档');

  const blank = render(Knowledge, { ...fakeData(), knowledge: [], knowledgeBases: [], knowledgeFolders: [] }, { empty: true, onLoadDemo: async () => {} });
  assert.ok(blank.includes('data-testid="kb-bases"') && blank.includes('还没有知识库'), '空库应有创建引导');
  assert.ok(blank.includes('data-testid="kb-load-demo"'), '首启演示数据入口丢失');
  assertNoLeaks(blank, '知识库空库');

  const kbSource = sourceOf('../src/workbench-app/modules/Knowledge.jsx');
  assert.ok(kbSource.includes("api.addRecord('knowledgeBases'") && kbSource.includes("api.addRecord('knowledgeFolders'"), '库或目录创建未接后端');
  assert.ok(kbSource.includes("api.patchRecord('knowledge'") && kbSource.includes("api.addRecord('knowledge'"), '文档写入未接后端');
  assert.ok(kbSource.includes('WIKI_PATTERN') && kbSource.includes('buildRefs'), '[[双链]] 解析未落地');
  assert.ok(kbSource.includes('metaKey') && kbSource.includes("'s'") && kbSource.includes('preventDefault'), '编辑器缺 ⌘S 保存');
  assert.ok(kbSource.includes('AssistantMarkdown') && kbSource.includes('api.links'), '阅读预览或链接图谱缺失');
  assert.ok(kbSource.includes('onClick={() => openLink(source)}') && kbSource.includes('askAI'), '来源回跳或问小台缺失');
  assert.ok(kbSource.includes('typeof window'), '渲染期浏览器访问未加守卫');
}

console.log('workbench UI: knowledge bases, folders, document list, reading and links passed')
console.log('workbench UI: 7 modules (widget board, capture, dual views, fix list, log dialogs, knowledge split, editor) + assistant markdown passed');

/* ================================================== 10. AI 面板：「问小台」失败路径的本地兜底 */

{
  // pi 接口不可用时 send() 只往面板丢一条底层 destructure 报错，笔记标题 / 正文整段消失。
  // App 把文本落成 pending 用户气泡（带「未送达」脚标），错误条换成人话——面板必须看得到内容。
  const askText = '【知识库笔记】工作台双链设计\n\n正文引用 [[知识库字段约定]]。';
  const markup = renderToStaticMarkup(h(AIPanel, {
    chat: [
      { id: 'ask-pending', role: 'user', text: askText, at: Date.now(), pending: true },
      { id: 'pi-error', role: 'error', text: '小台暂时连不上，这条内容没有发出去。已保留在面板里，点右上角「重试连接」恢复后再发一次。', at: Date.now() },
    ],
    busy: false,
    status: 'error',
    modelName: 'pi-webx',
    onSend: () => {},
    onNew: () => {},
    onRetry: () => {},
    onRefreshData: () => {},
    isMobile: false,
    onClose: () => {},
  }));
  assert.ok(markup.includes('data-testid="chat-scroll"'), 'AI 面板缺对话容器');
  assert.ok(markup.includes('data-pending="true"'), '问小台失败后应保留 pending 用户气泡');
  assert.ok(textOf(markup).includes('【知识库笔记】工作台双链设计'), 'pending 气泡应原样保留笔记标题/正文');
  assert.ok(textOf(markup).includes('未送达'), 'pending 气泡应标注未送达');
  assert.ok(textOf(markup).includes('小台暂时连不上'), '失败路径应给友好错误文案');
  const pendingAt = markup.indexOf('data-pending="true"');
  const errorAt = markup.indexOf('data-testid="chat-msg-error"');
  assert.ok(pendingAt >= 0 && errorAt > pendingAt, 'pending 气泡应排在错误条之前');

  // 接线钉在 App 源码上（错误路径依赖 send 内部吞异常，SSR 不可达）。
  const appSource = sourceOf('../src/workbench-app/App.jsx');
  assert.ok(appSource.includes("setAsk({ pending:"), 'askAI 失败路径的本地草稿未接线');
  assert.ok(appSource.includes('nextAskState(current, { chat, busy })'), 'pending 状态机未按 nextAskState 派生');
  assert.ok(appSource.includes('AI_TEXT.askFailed'), '失败路径的友好错误文案未接线');
  assert.ok(appSource.includes('chat={panelChat}'), '面板应渲染带兜底的消息列表');

  // pending 气泡状态机：decision 是纯函数，逐场景直测（浏览器验收回归点）——
  // pi 不可用时 send 先在途空跑一截（chat 空、busy=true）才把错误落进 chat，
  // 早前版本把在途空态当成「面板被清空」，气泡 ~150ms 被自己撤掉、askFailed 置不上。
  const pendingNote = { text: '【知识库笔记】工作台双链设计', at: 1_700_000_000_000 };
  const echo = [{ id: 'u1', role: 'user', text: pendingNote.text, at: 1_700_000_000_100 }];
  const failure = [{ id: 'pi-error', role: 'error', text: '底层报错', at: 1_700_000_000_200 }];

  // 1. 发送在途 + transcript 还空着：正常空态，草稿必须留着。
  const inFlight = nextAskState({ pending: pendingNote, failed: false }, { chat: [], busy: true });
  assert.deepEqual(inFlight, { pending: pendingNote, failed: false }, '发送在途的空 chat 不是面板被清空，不能撤 pending');

  // 2. 完整失败时间线：在途空态 → 错误落进 chat，草稿一直在、失败标记置上。
  let ask = { pending: pendingNote, failed: false };
  ask = nextAskState(ask, { chat: [], busy: true });
  ask = nextAskState(ask, { chat: [], busy: true });
  assert.deepEqual(ask, { pending: pendingNote, failed: false }, '在途期每次重算都不该动草稿');
  ask = nextAskState(ask, { chat: failure, busy: false });
  assert.deepEqual(ask, { pending: pendingNote, failed: true }, 'send 失败落错误后：草稿保留 + 失败标记置上');

  // 3. 回显成功（同文本 user 消息）：撤草稿、清失败标记。
  assert.deepEqual(
    nextAskState({ pending: pendingNote, failed: true }, { chat: [...echo, ...failure], busy: false }),
    { pending: null, failed: false },
    'transcript 回显后应撤掉本地草稿',
  );

  // 4. 显式新对话：空闲 + 面板空才撤销（clearChat 也会直接置 IDLE，这里兜底）。
  assert.deepEqual(
    nextAskState({ pending: pendingNote, failed: true }, { chat: [], busy: false }),
    { pending: null, failed: false },
    '空闲且面板空（新对话清空 transcript）才撤 pending',
  );

  // 5. 没有草稿时永远是 IDLE；在途且面板有其他内容（助手回复中）时继续等。
  assert.deepEqual(nextAskState({ pending: null, failed: true }, { chat: [], busy: true }), { pending: null, failed: false });
  assert.deepEqual(
    nextAskState({ pending: pendingNote, failed: false }, { chat: [{ id: 'a1', role: 'assistant', text: '在想' }], busy: true }),
    { pending: pendingNote, failed: false },
    '在途且无回显无错误时应继续等',
  );
}

console.log('workbench UI: AI panel ask-ai fallback (pending user bubble + friendly error + nextAskState) passed');
