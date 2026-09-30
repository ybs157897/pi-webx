/**
 * 工作台界面验收（v2，2026-09 重塑版）：把九个模块 + AI 面板正文渲染钉在 SSR 产物上。
 *
 * 写法照 `scripts/check-task-panel.ts`：真实组件进 `renderToStaticMarkup`，喂构造好的假数据，
 * 断言只认 DOM 证据。与 v1 的差别：模块们各自 `import './X.css'`（模块样式私有化），
 * 所以本脚本必须走 `scripts/check-bootstrap.mjs`（CSS 被短路成回显 Proxy）。
 * 跑法：`npm run check:workbench-ui`（已带引导）。
 *
 * 覆盖（对应 docs/workbench-redesign.md 第 4 节逐模块规格）：
 *   1. 我的主页是指挥台 widget 板：`data-widget` 六件套 + 空库引导只走 `welcome`；
 *   2. 我的待办：无默认截止日的捕获 + 全量/未安排/到期/完成筛选；时间轴与认知分组另有门禁；
 *   3. 我的助理：今天 / 待办两页签 + 常驻独立 Agent，待办按紧迫度分组（已逾期/今天/稍后/已完成）；
 *   4. 问题修复是列表（用户定调）：密集表格 + 行内状态 + 关联回链；
 *   5. 日志查询是对话优先（2026-09 定调，与需求管理同形态）：默认 logs Agent 对话（输入框带
 *      图片/附件入口），记录页签保留密集结果表，查询/记录弹窗默认关闭；
 *   6. 需求管理默认中央对话，历史记录保留两栏列表和 markdown 阅读区；
 *   7. 代码开发是编辑器工作区（用户定调）：文件树 + tab + 行号编辑区 + 状态栏；
 *   8. AI 对话兜底正文与 /chat 一致：AssistantMarkdown 渲染出真实元素，无 markdown 残留；
 *   9. 知识库两态（首页搜索卡片 / 目录+阅读）：首页 / 选中 / 预览 / 旧数据 / 空库都有 DOM 证据；
 *  10. AI 对话浮层（全屏居中）：展开占据整屏、正文复用 /chat 的 TranscriptView
 *      （简洁模式规范见 docs/workbench-ai-chat-compact-mode.md）；「问小台」失败路径：
 *      pi 不可用时 pending 用户气泡保留笔记内容、错误条是人话，钉在输入框上方的兜底条；
 *      pending 气泡的留存/撤销走 nextAskState 状态机（发送在途 ≠ 面板被清空）。
 *
 * 交互分支（拖拽、弹窗内提交、⌘S、勾选）SSR 不可达，按 `check-task-panel.ts` 的做法
 * 读源码钉结构；真实浏览器验收由 ego 截图阶段完成。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Dashboard from '../src/workbench-app/modules/Dashboard.jsx';
import Tasks from '../src/workbench-app/modules/tasks/index.jsx';
import AssistantWorkspace from '../src/workbench-app/modules/assistant/index.jsx';
import AssistantChat from '../src/workbench-app/modules/assistant/AssistantChat.jsx';
import Fixes from '../src/workbench-app/modules/Fixes.jsx';
import Logs from '../src/workbench-app/modules/Logs.jsx';
import Requirements from '../src/workbench-app/modules/Requirements.jsx';
import RequirementRecords from '../src/workbench-app/modules/requirements/Records.jsx';
import { RequirementsNewConversation, RequirementsStarterActions, RequirementsWelcome } from '../src/workbench-app/modules/requirements/Landing.jsx';
import { LogsNewConversation, LogsStarterActions, LogsWelcome } from '../src/workbench-app/modules/logs/Landing.jsx';
import Codes from '../src/workbench-app/modules/Codes.jsx';
import CodeRecords from '../src/workbench-app/modules/codes/Records.jsx';
import CodeChat from '../src/workbench-app/modules/codes/CodeChat.jsx';
import { readIdeState } from '../src/workbench-app/modules/codes/ide-state.mjs';
import Knowledge from '../src/workbench-app/modules/Knowledge.jsx';
import { moduleAgentPanelDefinition } from '../src/workbench-app/agents/definitions.js';
import AIPanel, { nextAskState } from '../src/workbench-app/shell/AIPanel.jsx';
import AgentCapabilities from '../src/workbench-app/agents/AgentCapabilities.jsx';
import SettingsSheet from '../src/workbench-app/shell/SettingsSheet.jsx';
import AssistantMarkdown from '../src/workbench-app/pi-webx/AssistantMarkdown.jsx';
import { AssistantMessageItem } from '../src/components/MessageItem';
import { TranscriptView } from '../src/components/TranscriptView';
import { todayISO } from '../src/workbench-app/util.mjs';
import './check-capability-tools';
import './check-module-agent-settings-ui';
import './check-requirements-ui';
import './check-assistant-ui.tsx';
import './check-chatroom-ui.tsx';

/* ------------------------------------------------------------ 渲染与比对小工具 */

/** 假 mutate：SSR 不会触发写操作，给个恒真实现即可。 */
const mutate = async (): Promise<boolean> => true;
const notify = (): void => {};
const navigate = (): void => {};
const setPref = async (): Promise<void> => {};

const TODAY = todayISO();
// 假数据的相对日期必须和 todayISO 同走本地时钟：用 UTC toISOString 偏移 24h，
// 会在本地已过午夜、UTC 未过的窗口里算出 TOMORROW === TODAY，明天的任务漏进今天档。
const YESTERDAY = todayISO(new Date(Date.now() - 86400000));
const TOMORROW = todayISO(new Date(Date.now() + 86400000));

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
    plans: [],
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
    tasks: [], plans: [], fixes: [], logs: [], requirements: [], codes: [],
  };
  const emptyMarkup = render(Dashboard, blank, { empty: true, onLoadDemo: async () => {} });
  assert.ok(emptyMarkup.includes('data-widget="welcome"'), '空库应只出引导 widget');
  assert.ok(!emptyMarkup.includes('data-widget="progress"'), '空库时不该渲染 widget 板');
  // empty 标志误报为 true 但库里有记录时，不许把用户数据藏起来。
  assert.ok(render(Dashboard, data, { empty: true }).includes('data-widget="progress"'), '有记录时即使 empty=true 也该渲染 widget 板');

  assert.ok(sourceOf('../src/workbench-app/modules/dashboard/index.jsx').includes('onLoadDemo()'), '主页演示数据按钮未接线');
}

/* ================================================== 2. 我的待办：快速捕获 + 分组 */

{
  const markup = render(Tasks, data);
  assert.ok(markup.includes('data-module="tasks"'), '待办缺 data-module');
  assert.ok(markup.includes('data-testid="tasks-capture"'), '待办缺快速捕获条');
  assert.equal(occurrences(markup, 'data-testid="task-row"'), 4, '我的待办默认应包含全部日期的 4 条事项');
  assert.ok(markup.includes('未安排') && markup.includes('即将到期') && markup.includes('已完成'), '待办缺范围筛选');
  assert.ok(markup.includes('is-done'), '完成行缺划线态');
  assertNoLeaks(markup, '规划');

  const allMarkup = render(Tasks, data, { prefs: { tasksScope: 'all' } });
  assert.equal(occurrences(allMarkup, 'data-testid="task-row"'), 4, '全部档应有 4 行');
  const doneMarkup = render(Tasks, data, { prefs: { tasksScope: 'done' } });
  assert.equal(occurrences(doneMarkup, 'data-testid="task-row"'), 1, '已完成档只显示 1 条完成事项');

  assert.ok(sourceOf('../src/workbench-app/modules/tasks/index.jsx').includes('parseQuickAdd')
    && sourceOf('../src/workbench-app/modules/tasks/model.jsx').includes('function parseQuickAdd'),
    '快速捕获语法解析未落地');
}

/* ================================================== 3. 我的助理：今天 / 待办两页签 + 常驻对话 */

{
  // 对话列由 App 以 `chat` 节点注入，这里把真实 AssistantChat 塞进去，钉住 App 的接线方式。
  const chat = h(AssistantChat, { data, themeMode: 'light', stepsMode: 'compact', refresh: async () => {}, mutate, notify });
  const today = render(AssistantWorkspace, data, { chat });
  assert.ok(today.includes('data-testid="assistant-workspace"'), '助理缺工作区根');
  assert.ok(today.includes('data-testid="assistant-agent-chat"') && today.includes('data-agent-id="assistant"'), '我的助理应直接打开独立 Agent');
  assert.ok(today.includes('data-testid="assistant-tab-today"') && today.includes('data-testid="assistant-tab-tasks"') && today.includes('data-testid="assistant-panel"'), '助理缺今天 / 待办页签或内容面板');
  assert.ok(today.includes('data-testid="assistant-tab-today" aria-selected="true"'), '默认页签应是今天的安排');
  assert.ok(today.includes('data-testid="today-planner"') && today.includes('data-testid="today-date"'), '今天页签缺今日安排与日期切换');
  assertNoLeaks(today, '我的助理');

  const tasks = render(AssistantWorkspace, data, { chat, navigationTarget: { view: 'tasks' } });
  assert.ok(tasks.includes('data-testid="assistant-tab-tasks" aria-selected="true"'), 'navigationTarget 应落到待办页签');
  assert.ok(tasks.includes('data-testid="tasks-capture"'), '待办页签缺快速捕获条');
  assert.equal(occurrences(tasks, 'data-testid="task-row"'), 4, '待办页签应显示全部 4 条事项');
  assert.equal(occurrences(tasks, 'data-testid="task-row" data-done="true"'), 1, '完成行应带 data-done');
  for (const group of ['已逾期', '今天', '稍后', '已完成']) assert.ok(tasks.includes(group), `待办缺分组：「${group}」`);

  const tasksSource = sourceOf('../src/workbench-app/modules/tasks/index.jsx')
    + sourceOf('../src/workbench-app/modules/tasks/model.jsx');
  assert.ok(tasksSource.includes('parseQuickAdd'), '快速捕获语法解析未落地');
  assert.ok(tasksSource.includes("api.patchRecord('tasks'"), '待办行内写入未接后端');
  const assistantSource = sourceOf('../src/workbench-app/modules/assistant/index.jsx')
    + sourceOf('../src/workbench-app/modules/assistant/AssistantChat.jsx');
  assert.ok(assistantSource.includes("useModuleAgentChat('assistant')"), '助理对话必须使用 assistant 模块 Agent');
  assert.ok(assistantSource.includes('PlanReview'), '方案确认卡未挂进对话列');
}

/* ================================================== 4. 问题修复：列表（用户定调） */

{
  const markup = render(Fixes, data);
  assert.ok(markup.includes('data-module="fixes"'), '修复缺 data-module');
  assert.equal(occurrences(markup, 'data-testid="fix-row"'), 3, '修复应是列表且行数正确');
  assert.ok(markup.includes('data-testid="fixes-quick-add"'), '修复缺快速捕获');
  assert.ok(!markup.includes('kanban') && !markup.includes('work-card'), '修复模块不许出现看板痕迹（用户定调：列表）');
  assertNoLeaks(markup, '修复');

  const fixesSource = sourceOf('../src/workbench-app/modules/fixes/index.jsx');
  assert.ok(fixesSource.includes("api.addRecord('logs'"), '修复详情应能回记日志');
  assert.ok(fixesSource.includes("type: 'fixes'"), '回记日志应带 fix 关联');

  const emptyFixes = render(Fixes, { ...fakeData(), fixes: [] }, { empty: true });
  assert.ok(emptyFixes.includes('data-testid="fixes-load-demo"'), '空库缺演示数据入口');
  assert.ok(emptyFixes.includes('data-testid="fixes-empty"'), '空库缺空态');
}

/* ================================================== 5. 日志查询：对话优先（与需求管理同形态，2026-09 定调） */

{
  // 默认视图是日志对话：logs Agent 会话 + 输入框附件入口；结果表只在记录页签出现。
  const markup = render(Logs, data);
  assert.ok(markup.includes('data-module="logs"'), '日志缺 data-module');
  assert.ok(markup.includes('data-testid="logs-conversation"') && markup.includes('data-agent-id="logs"'), '日志默认应是对话（logs Agent）');
  assert.ok(markup.includes('data-testid="logs-chat-tab"') && markup.includes('data-testid="logs-records-tab"'), '日志缺「日志对话 / 日志记录」页签');
  assert.ok(markup.includes('data-empty="false"'), '服务端首屏仍在恢复会话，不应提前显示空闲首页');
  assert.ok(markup.includes('data-testid="logs-query-open"'), '日志缺「查询日志」入口');
  assert.ok(markup.includes('data-testid="logs-record-open"'), '日志缺「记录日志」入口');
  assert.ok(!markup.includes('data-testid="logs-agent-open"'), '「问日志 Agent」侧挂入口应随对话化退役');
  assert.ok(!markup.includes('data-testid="logs-list"'), '对话视图不该渲染结果表');

  // 记录视图：navigationTarget.selectedId 直落，表格与条件断言都钉在这里。
  const records = render(Logs, data, { navigationTarget: { selectedId: 'x' } });
  assert.ok(records.includes('data-testid="logs-list"'), '记录视图缺结果表');
  assert.equal(occurrences(records, 'data-testid="log-row"'), 3, '日志行数应等于记录数');
  assert.ok(!records.includes('logs-query-form') && !records.includes('logs-record-form'), '弹窗默认必须关闭（用户定调：对话框形式）');
  assert.ok(!records.includes('logs-filter-bar'), '无筛选时不该画条件条');
  assertNoLeaks(records, '日志');

  const logsSource = sourceOf('../src/workbench-app/modules/logs/index.jsx');
  assert.ok(logsSource.includes("api.addRecord('logs'"), '记录日志未接线');
  assert.ok(logsSource.includes('queryOpen') && logsSource.includes('recordOpen'), '查询/记录弹窗状态未落地');
  assert.ok(logsSource.includes("setView('records')"), '查询提交后应落回记录视图');
  const logsChatSource = sourceOf('../src/workbench-app/modules/logs/LogsChat.jsx');
  assert.ok(logsChatSource.includes("useModuleAgentChat('logs')"), '日志对话必须使用 logs 模块 Agent');
  assert.ok(logsChatSource.includes('supportsImages'), '日志对话应声明附件能力');

  const emptyLogs = render(Logs, { ...fakeData(), logs: [] }, { empty: true, navigationTarget: { selectedId: 'x' } });
  assert.ok(emptyLogs.includes('data-testid="logs-load-demo"'), '空库缺演示数据入口');
}

/* ================================================== 6. 需求管理：对话首页与历史记录 */

{
  const conversation = render(Requirements, data);
  assert.ok(conversation.includes('data-testid="req-conversation"'), '需求菜单应直接显示中央对话');
  assert.ok(conversation.includes('data-agent-id="requirements"'), '需求对话必须使用独立 Agent');
  assert.ok(conversation.includes('data-testid="req-records-tab"'), '历史记录入口应保留');
  assert.ok(conversation.includes('data-testid="req-open-tasks"'), '待办列表入口应保留');
  assert.ok(!conversation.includes('data-testid="req-split"'), '默认入口应为对话');
  assert.ok(conversation.includes('data-testid="req-new-conversation"'), '需求输入框应保留新对话入口');
  assert.ok(conversation.includes('data-empty="false"'), '服务端首屏仍在恢复会话，不应提前显示空闲首页');
  const markup = render(RequirementRecords, data);
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
  const selected = render(RequirementRecords, withBlank);
  assert.ok(selected.includes('data-testid="req-reader-title"'), '选中态缺标题');
  assert.ok(selected.includes('data-testid="req-reader-body"'), '选中态缺正文');
  assert.ok(selected.includes('<strong>'), '阅读区应渲染 markdown 加粗');
  assert.ok(!textOf(selected).includes('**'), '阅读区不应残留 markdown 标记');
  assert.ok(selected.includes('data-testid="req-task"'), '关联任务缺失（任务引用需求的假数据）');
  // done 是终态：推进按钮必须禁用，防止推出未知状态。
  const advanceIndex = selected.indexOf('data-testid="req-advance"');
  assert.ok(advanceIndex >= 0 && selected.slice(advanceIndex, advanceIndex + 200).includes('disabled'), '终态需求的推进按钮应禁用');

  const emptyReq = render(RequirementRecords, { ...fakeData(), requirements: [] }, { empty: true });
  assert.ok(emptyReq.includes('data-testid="req-load-demo"'), '空库缺演示数据入口');
}

/* ================================================== 7. 代码开发：编辑器工作区（用户定调） */

{
  const workspace = render(Codes, data);
  for (const id of ['codes-workspace', 'codes-ide-panel', 'codes-chat-panel', 'codes-records-toggle', 'codes-show-editor', 'codes-show-chat']) {
    assert.ok(workspace.includes(`data-testid="${id}"`), `代码开发缺 ${id}`);
  }
  assert.ok(workspace.includes('data-testid="codes-chat-awaiting-project"'), '未打开项目时应提示项目绑定');
  const chat = renderToStaticMarkup(h(CodeChat, { root: '/tmp/codes-ui-fixture' }));
  assert.ok(chat.includes('data-agent-id="codes"') && chat.includes('agent-panel-embedded'), '项目对话必须是嵌入的 codes Agent');
  assert.ok(chat.includes('role="region"') && !chat.includes('aria-modal="true"'), '固定对话不能声明为模态弹窗');
  assert.ok(!chat.includes('收起对话（Esc）'), '固定对话不应有关闭按钮或 Esc 退出');
  assert.equal(readIdeState({ type: 'wrong', payload: {} }), null);
  assert.equal(readIdeState({ type: 'web-idea:state', payload: { root: 'relative' } }), null);
  const state = { root: '/tmp/project', path: 'README.md', dirty: false, saving: true, workspaceId: 'fixture' };
  assert.deepEqual(readIdeState({ type: 'web-idea:state', payload: state }), state);

  // 原开发事项入口保留：其记录与真实磁盘文件分别持有。
  const markup = render(CodeRecords, data);
  assert.ok(markup.includes('data-module="codes"'), '代码模块缺 data-module');
  assert.ok(markup.includes('data-testid="codes-tree-panel"'), '代码模块缺文件树面板');
  assert.equal(occurrences(markup, 'data-testid="code-item"'), 3, '树项数应等于记录数');
  assert.ok(markup.includes('data-testid="codes-tree-group"'), '文件树应按 project 分组');
  assert.ok(markup.includes('data-testid="codes-editor-empty"'), '未打开事项时应是空编辑器');
  assert.ok(markup.includes('data-testid="codes-new"'), '代码模块缺新建入口');
  assertNoLeaks(markup, '代码');

  const codesSource = sourceOf('../src/workbench-app/modules/codes/Records.jsx')
    + sourceOf('../src/workbench-app/modules/codes/View.jsx');
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
  assert.ok(documents.includes('我的待办') && documents.includes('知识库'), '来源筛选应由文档 refs 动态生成');
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
  assert.ok(selected.includes('data-testid="kb-sources"') && selected.includes('我的待办「给知识库补反链断言」'), '跨模块来源没有保留');
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

  const kbSource = sourceOf('../src/workbench-app/modules/knowledge/index.jsx')
    + sourceOf('../src/workbench-app/modules/knowledge/model.jsx')
    + sourceOf('../src/workbench-app/modules/knowledge/actions.jsx')
    + sourceOf('../src/workbench-app/modules/knowledge/View.jsx');
  assert.ok(kbSource.includes("api.addRecord('knowledgeBases'") && kbSource.includes("api.addRecord('knowledgeFolders'"), '库或目录创建未接后端');
  assert.ok(kbSource.includes("api.patchRecord('knowledge'") && kbSource.includes("api.addRecord('knowledge'"), '文档写入未接后端');
  assert.ok(kbSource.includes('WIKI_PATTERN') && kbSource.includes('buildRefs'), '[[双链]] 解析未落地');
  assert.ok(kbSource.includes('metaKey') && kbSource.includes("'s'") && kbSource.includes('preventDefault'), '编辑器缺 ⌘S 保存');
  assert.ok(kbSource.includes('AssistantMarkdown') && kbSource.includes('api.links'), '阅读预览或链接图谱缺失');
  assert.ok(kbSource.includes('onClick={() => openLink(source)}') && kbSource.includes('askAI'), '来源回跳或问小台缺失');
  assert.ok(kbSource.includes('typeof window'), '渲染期浏览器访问未加守卫');
}

console.log('workbench UI: knowledge bases, folders, document list, reading and links passed')
console.log('workbench UI: 9 modules (widget board, assistant todos+today, fix list, log conversation-first, knowledge split, editor) + assistant markdown passed');

/* ================================================== 10. AI 对话浮层：全屏居中 + 正文同源 + 「问小台」失败兜底 */

{
  // 空转录：浮层应渲染全屏壳（ai-overlay）与空态建议，兜底条钉住 pending 气泡与人话错误。
  // pi 接口不可用时 send() 只往面板丢一条底层 destructure 报错，笔记标题 / 正文整段消失。
  // App 把文本落成 pending 用户气泡（带「未送达」脚标），错误条换成人话——面板必须看得到内容。
  const emptyTranscript = {
    entries: [], streamingEntryId: null, running: false, compacting: false,
    retrying: null, queued: { steering: [], followUp: [], pending: [] },
    lastError: null, title: null, turnSeq: 0, activeTurn: null, turnProcesses: {},
  };
  const askText = '【知识库笔记】工作台双链设计\n\n正文引用 [[知识库字段约定]]。';
  const panelProps = {
    transcript: emptyTranscript,
    assistRows: [
      { id: 'ask-pending', role: 'user', text: askText, at: Date.now(), pending: true },
      { id: 'pi-error', role: 'error', text: '小台暂时连不上，这条内容没有发出去。已保留在面板里，点右上角「重试连接」恢复后再发一次。', at: Date.now() },
    ],
    busy: false,
    status: 'error',
    modelName: 'pi-webx',
    themeMode: 'light',
    onSend: () => {},
    onNew: () => {},
    onRetry: () => {},
    onRefreshData: () => {},
    onAction: () => {},
    onClose: () => {},
  };
  const markup = renderToStaticMarkup(h(AIPanel, panelProps));
  assert.ok(markup.includes('data-testid="ai-overlay"'), 'AI 对话应是全屏浮层（ai-overlay）');
  assert.ok(markup.includes('role="dialog"'), '浮层应是对话框语义（role=dialog）');
  assert.ok(markup.includes('data-testid="chat-scroll"'), 'AI 对话缺正文容器');
  assert.ok(markup.includes('data-testid="chat-fallback"'), '本地兜底条缺失（pending/错误应钉在输入框上方）');
  assert.ok(markup.includes('data-pending="true"'), '问小台失败后应保留 pending 用户气泡');
  assert.ok(textOf(markup).includes('【知识库笔记】工作台双链设计'), 'pending 气泡应原样保留笔记标题/正文');
  assert.ok(textOf(markup).includes('未送达'), 'pending 气泡应标注未送达');
  assert.ok(textOf(markup).includes('小台暂时连不上'), '失败路径应给友好错误文案');
  const pendingAt = markup.indexOf('data-pending="true"');
  const errorAt = markup.indexOf('data-testid="chat-msg-error"');
  assert.ok(pendingAt >= 0 && errorAt > pendingAt, 'pending 气泡应排在错误条之前');
  assert.ok(textOf(markup).includes('帮我拟一份今日计划'), '空态应保留建议入口');

  // 有转录时正文走 /chat 的 TranscriptView：同一实现，保证「与正文输出一致」。
  const withTurns = renderToStaticMarkup(h(AIPanel, {
    ...panelProps,
    assistRows: [],
    status: 'live',
    transcript: {
      ...emptyTranscript,
      entries: [{ kind: 'user', id: 'u1', at: 1_700_000_000_000, text: '帮我拟一份今日计划', imageCount: 0 }],
    },
  }));
  assert.ok(withTurns.includes('pi-message-item'), '正文应复用 /chat 的 TranscriptView（pi-message-item）');
  assert.ok(textOf(withTurns).includes('帮我拟一份今日计划'), '转录用户消息应渲染在正文里');
  assert.ok(!withTurns.includes('data-testid="chat-fallback"'), '无本地状态时不应渲染兜底条');

  const waiting = renderToStaticMarkup(h(AIPanel, {
    ...panelProps, assistRows: [], status: 'live', busy: true, stepsMode: 'compact',
    transcript: { ...emptyTranscript, running: true },
  }));
  assert.ok(waiting.includes('data-testid="live-process-row"') && waiting.includes('正在分析请求'),
    '首条消息到达前，工作台也应显示正在分析而非停在欢迎面');
  assert.ok(!waiting.includes('小台已就位'), '运行中空转录不应回到欢迎面');

  // 提问形态钉 dsh：问题占据输入框座位（与 /chat 同一 QuestionComposer，内嵌作答），
  // 不得回到弹窗（PiDialog 已删——回归成 modal 是本次改动的反例）。
  const pendingQuestion = {
    request: { id: 'q1', method: 'select', title: '选择部署方式', options: ['Docker', '本地进程'] },
    at: 1_700_000_000_000,
  };
  const withQuestion = renderToStaticMarkup(h(AIPanel, {
    ...panelProps, assistRows: [], status: 'live', busy: true,
    transcript: { ...emptyTranscript, running: true },
    dialog: pendingQuestion,
    onRespondDialog: () => {},
  }));
  assert.ok(withQuestion.includes('data-testid="question-composer"'), '有提问时浮层应内嵌 QuestionComposer（输入框座位）');
  assert.ok(textOf(withQuestion).includes('选择部署方式'), '问题标题应出现在浮层里');
  assert.ok(withQuestion.includes('Docker') && withQuestion.includes('本地进程'), '问题选项应出现在浮层里');
  assert.ok(withQuestion.includes('composer-input'), '提问作答期间原输入框应保持挂载（隐藏，草稿存活）');

  // 需求页实际组件通过共享面板插槽组成首页；SSR 初始 hook 在恢复中，这里喂恢复后的空会话。
  const landingSlots = {
    emptyState: h(RequirementsWelcome, {}),
    composerLeading: h(RequirementsNewConversation, { busy: false, onNew: () => {} }),
    composerFooter: h(RequirementsStarterActions, { busy: false, status: 'live', modelName: 'fixture', onChoose: () => {} }),
  };
  const landing = renderToStaticMarkup(h(AIPanel, { ...panelProps, assistRows: [], ...landingSlots }));
  assert.ok(landing.includes('data-empty="true"'), '空闲空会话应展示首页');
  for (const id of ['req-landing', 'req-landing-title', 'req-new-conversation', 'req-starter-footer', 'req-starter-toolbar', 'req-starter-suggestions',
    'req-starter-idea', 'req-starter-document', 'req-starter-tasks', 'req-starter-acceptance']) {
    assert.ok(landing.includes(`data-testid="${id}"`), `需求对话首页缺 ${id}`);
  }
  assert.ok(landing.indexOf('data-testid="req-landing-title"') < landing.indexOf('<textarea')
    && landing.indexOf('<textarea') < landing.indexOf('data-testid="req-starter-toolbar"')
    && landing.indexOf('data-testid="req-starter-toolbar"') < landing.indexOf('data-testid="req-starter-suggestions"'),
  '需求首页应按标题、输入框、工具栏和快捷入口排序');
  assert.equal(occurrences(landing, '<textarea'), 1, '需求首页不能复制输入框');

  // 日志对话首页与需求同构；输入框经 supportsImages 带附件入口（截图/日志文件直接丢进来）。
  const logsLanding = renderToStaticMarkup(h(AIPanel, {
    ...panelProps, assistRows: [], supportsImages: true,
    emptyState: h(LogsWelcome, {}),
    composerLeading: h(LogsNewConversation, { busy: false, onNew: () => {} }),
    composerFooter: h(LogsStarterActions, { busy: false, status: 'live', modelName: 'fixture', onChoose: () => {} }),
  }));
  assert.ok(logsLanding.includes('data-empty="true"'), '空闲空会话应展示首页（日志）');
  for (const id of ['logs-landing', 'logs-landing-title', 'logs-new-conversation', 'logs-starter-footer', 'logs-starter-toolbar', 'logs-starter-suggestions',
    'logs-starter-errors', 'logs-starter-analysis', 'logs-starter-summary', 'logs-starter-open']) {
    assert.ok(logsLanding.includes(`data-testid="${id}"`), `日志对话首页缺 ${id}`);
  }
  assert.ok(logsLanding.includes('data-testid="module-attach"') && logsLanding.includes('data-testid="module-attach-input"'), '日志输入框缺附件入口');

  // 附件能力是显式开关：默认关（问小台浮层等旧使用方 DOM 不变），模块对话逐个打开。
  const plainPanel = renderToStaticMarkup(h(AIPanel, { ...panelProps, assistRows: [] }));
  assert.ok(!plainPanel.includes('module-attach'), '未开启 supportsImages 不应出现附件入口');
  const attachPanel = renderToStaticMarkup(h(AIPanel, { ...panelProps, assistRows: [], supportsImages: true }));
  assert.ok(attachPanel.includes('data-testid="module-attach"') && attachPanel.includes('data-testid="module-attach-input"'), '开启 supportsImages 应有附件入口与文件选择');
  // 发送链路钉在源码：附件走准入（与 /chat 同一份图片限额），文本内联、图片进 prompt 信封。
  const composerAttachSource = sourceOf('../src/workbench-app/shell/composer-attachments.mjs');
  assert.ok(composerAttachSource.includes('imageAdmissionError'), '附件准入必须复用 shared 的图片限额');
  assert.ok(composerAttachSource.includes('formatAttachmentBlocks'), '文本附件内联格式缺失');
  // 文件卡片元数据（角标 / 分类色 / 类型标签）是纯函数，直接单测映射。
  const { attachmentBadge } = await import('../src/workbench-app/shell/composer-attachments.mjs');
  assert.deepEqual(attachmentBadge({ name: 'CHANGELOG.md' }), { glyph: 'M', tone: 'blue', label: 'MD' });
  assert.equal(attachmentBadge({ name: 'data.csv' }).tone, 'amber');
  assert.equal(attachmentBadge({ name: 'src/index.ts' }).tone, 'green');
  assert.equal(attachmentBadge({ name: 'run-2026-09-29.log' }).tone, 'slate');
  assert.deepEqual(attachmentBadge({ name: '无扩展名' }).label, 'FILE');
  // 拖拽是交互分支，SSR 不可达：落点/悬浮层/取文件钉在源码上。
  const aipanelDropSource = sourceOf('../src/workbench-app/shell/AIPanel.jsx');
  assert.ok(aipanelDropSource.includes('composer-drop') && aipanelDropSource.includes('onDrop='), '输入区缺拖拽落点');
  assert.ok(aipanelDropSource.includes('dataTransfer?.files'), '拖拽未取 dataTransfer 文件');
  assert.ok(aipanelDropSource.includes('attach-drag-overlay') && aipanelDropSource.includes('attach-file-icon'), '拖拽悬浮层或文件卡片未落地');
  const moduleChatSource = sourceOf('../src/workbench-app/agents/useModuleAgentChat.jsx');
  assert.ok(moduleChatSource.includes('attachments?.images') && moduleChatSource.includes('attachments?.files'), '模块 Agent send 未接附件参数');
  assert.ok(moduleChatSource.includes("type: 'prompt'") && moduleChatSource.includes('images'), 'prompt 信封未带图片');
  const modulePanelSource = sourceOf('../src/workbench-app/agents/ModuleAgentPanel.jsx')
    + sourceOf('../src/workbench-app/modules/requirements/RequirementsChat.jsx');
  assert.ok(modulePanelSource.includes('supportsImages'), '模块 Agent 面板与需求对话应打开附件能力');

  const withLandingTurns = renderToStaticMarkup(h(AIPanel, {
    ...panelProps, ...landingSlots, assistRows: [],
    transcript: { ...emptyTranscript, entries: [{ kind: 'user', id: 'u2', at: 1_700_000_000_000, text: '已有消息', imageCount: 0 }] },
  }));
  assert.ok(withLandingTurns.includes('data-empty="false"') && withLandingTurns.includes('pi-message-item'), '有消息应恢复原有转录布局');
  assert.ok(!withLandingTurns.includes('req-landing') && !withLandingTurns.includes('req-starter-footer'), '有消息不应展示首页或快捷入口');

  const runningLanding = renderToStaticMarkup(h(AIPanel, {
    ...panelProps, ...landingSlots, assistRows: [], busy: false, transcript: { ...emptyTranscript, running: true },
  }));
  assert.ok(runningLanding.includes('data-empty="false"'), '运行中的空转录不应算空闲首页');
  assert.ok(!runningLanding.includes('req-landing') && !runningLanding.includes('req-starter-footer'), '运行中不应闪回首页');

  const busyLanding = renderToStaticMarkup(h(AIPanel, {
    ...panelProps, ...landingSlots, assistRows: [], busy: true, onStop: () => {},
  }));
  assert.ok(busyLanding.includes('data-empty="false"') && busyLanding.includes('data-testid="module-agent-stop"'), '发送在途应保留停止按钮');
  assert.ok(!busyLanding.includes('req-landing') && !busyLanding.includes('req-starter-footer'), '发送在途不应展示首页');

  const questionLanding = renderToStaticMarkup(h(AIPanel, {
    ...panelProps, ...landingSlots, assistRows: [], dialog: pendingQuestion, onRespondDialog: () => {},
  }));
  assert.ok(questionLanding.includes('data-empty="false"') && questionLanding.includes('data-testid="question-composer"'), '待回答问题应占据输入框座位');
  assert.ok(!questionLanding.includes('req-landing') && !questionLanding.includes('req-starter-footer'), '待回答问题不应展示首页');

  // 接线钉在 App 源码上（错误路径依赖 send 内部吞异常，SSR 不可达）。
  const appSource = sourceOf('../src/workbench-app/App.jsx');
  assert.ok(appSource.includes('{panelOpen && agentPanel === null && ('), '浮层应按开合条件挂载（与模块 Agent 面板互斥）');
  assert.ok(appSource.includes('transcript={transcript}'), '浮层正文未接 transcript');
  assert.ok(appSource.includes('assistRows={assistRows}'), '浮层未接本地兜底行');
  assert.ok(appSource.includes('themeMode={theme}'), '浮层未随工作台主题切换');
  assert.ok(appSource.includes('useState(false)'), '全屏浮层默认应收起');
  assert.ok(!appSource.includes("prefs.panelOpen"), '全屏浮层不应再读写 panelOpen 偏好');
  assert.ok(appSource.includes('setAsk({ pending:'), 'askAI 失败路径的本地草稿未接线');
  assert.ok(appSource.includes('nextAskState(current, { chat, busy })'), 'pending 状态机未按 nextAskState 派生');
  assert.ok(appSource.includes('AI_TEXT.askFailed'), '失败路径的友好错误文案未接线');

  // 正文同源 + 简洁模式规范钉在源码与文档上：改 AIPanel 前先读 docs/workbench-ai-chat-compact-mode.md。
  const panelSource = sourceOf('../src/workbench-app/shell/AIPanel.jsx');
  assert.ok(panelSource.includes("from '../../components/TranscriptView'"), '正文必须复用 /chat 的 TranscriptView，不得自绘');
  assert.ok(panelSource.includes("from '../../components/QuestionComposer'"), '提问必须复用 /chat 的 QuestionComposer（输入框座位），不得自绘');
  assert.ok(!panelSource.includes('PiDialog') && !appSource.includes('PiDialog'), '提问不得回到弹窗（PiDialog 已删）');
  assert.ok(appSource.includes('dialog={dialog}') && appSource.includes('onRespondDialog={respondToDialog}'), 'App 应把 pending dialog 与作答回调接进浮层');
  assert.ok(panelSource.includes('ThemeProvider'), '正文令牌需随工作台主题（ThemeProvider）');
  assert.ok(existsSync(new URL('../docs/workbench-ai-chat-compact-mode.md', import.meta.url)), '简洁模式输出规范文档缺失');
  const styleSource = sourceOf('../src/workbench-app/styles.css');
  assert.ok(styleSource.includes('.ai-overlay') && styleSource.includes('inset: 0'), '全屏浮层样式缺失');
  assert.ok(styleSource.includes('max-width: 900px'), '输入区应与正文列同宽居中（900px）');
  assert.ok(!styleSource.includes('.aside {') && !styleSource.includes('.aside,'), '右侧 aside 样式应随旧形态移除');

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

console.log('workbench UI: AI overlay (fullscreen centered + transcript reuse + compact mode) + ask-ai fallback passed');

/* ================================================== 11. 工作步骤展示：四档模式（dsh 策略表移植） */

{
  // 策略表在 src/lib/transcript/presentation.ts；渲染层只读策略字段、不比模式枚举。
  // 夹具：一轮已完成（u1 → a1 过程步 → a2 答案，fold 已算进 turnProcesses）
  // + 一轮进行中（u2 → a3 流式思考 + running 的 bash）。
  const emptyTranscript = {
    entries: [], streamingEntryId: null, running: false, compacting: false,
    retrying: null, queued: { steering: [], followUp: [], pending: [] },
    lastError: null, title: null, turnSeq: 0, activeTurn: null, turnProcesses: {},
  };
  const transcript = {
    ...emptyTranscript,
    entries: [
      { kind: 'user', id: 'u1', at: 1, text: '帮我查', imageCount: 0 },
      {
        kind: 'assistant', id: 'a1', at: 2, text: '中间叙述', thinking: '先想一下', streaming: false,
        tools: [{ toolCallId: 't1', toolName: 'bash', args: { command: 'npm run build' }, output: '', status: 'success', startedAt: 2 }],
      },
      { kind: 'assistant', id: 'a2', at: 3, text: '答案是 42', thinking: '', streaming: false, tools: [] },
      { kind: 'user', id: 'u2', at: 4, text: '再跑一遍', imageCount: 0 },
      {
        kind: 'assistant', id: 'a3', at: 5, text: '', thinking: '盘算中', streaming: true,
        tools: [{ toolCallId: 't2', toolName: 'bash', args: { command: 'npm run check' }, output: '', status: 'running', startedAt: 5 }],
      },
    ],
    streamingEntryId: 'a3',
    running: true,
    turnSeq: 2,
    activeTurn: { id: 2, startId: 'u2' },
    turnProcesses: {
      1: { hiddenIds: ['a1'], anchorId: 'a2', messages: 1, toolCalls: 1, thought: true, anchorThought: false },
    },
  };
  const renderMode = (mode: string): string =>
    renderToStaticMarkup(h(ConfigProvider, { motion }, h(TranscriptView, { transcript, mode })));
  /** The live header row's own markup (ends at its closing </div>; it holds only spans/svg). */
  const liveRowOf = (markup: string): string => {
    const at = markup.indexOf('data-testid="live-process-row"');
    assert.ok(at >= 0, `mode 渲染应包含 live-process-row（检查 ${markup.length} 字符产物）`);
    const end = markup.indexOf('</div>', at);
    return markup.slice(at, end);
  };

  // verbose 完全展开：不折任何轮次——没有摘要行，也没有折叠体。
  const verbose = renderMode('verbose');
  assert.ok(!verbose.includes('turn-process-row'), 'verbose 不应渲染已完成轮的摘要行');
  assert.ok(!verbose.includes('pi-turn-process-collapsed'), 'verbose 不应有任何折叠体');

  // detailed 详细：pi-webx 引入模式前的原行为——已完成轮折叠、进行中轮平铺。
  const detailed = renderMode('detailed');
  assert.ok(detailed.includes('data-testid="turn-process-row"'), 'detailed 应保留已完成轮摘要行');
  assert.ok(!detailed.includes('live-process-row'), 'detailed 的进行中轮应平铺（无活动头）');

  // standard 标准（默认）：进行中轮折成活动头，且 liveProcessDetail 带命令细节。
  const standard = renderMode('standard');
  assert.ok(standard.includes('data-testid="turn-process-row"'), 'standard 的已完成轮仍折叠');
  const standardLiveRow = liveRowOf(standard);
  assert.ok(standardLiveRow.includes('正在运行命令'), 'standard 活动头应显示活动类型');
  assert.ok(standardLiveRow.includes('npm run check'), 'standard 活动头应带命令细节（liveProcessDetail）');

  // compact 简洁：活动头只留活动类型，命令细节不进标题。
  const compact = renderMode('compact');
  const compactLiveRow = liveRowOf(compact);
  assert.ok(compactLiveRow.includes('正在运行命令'), 'compact 活动头应显示活动类型');
  assert.ok(!compactLiveRow.includes('npm run check'), 'compact 活动头不应带命令细节');
  assert.ok(compact.includes('执行了命令'), '已完成的命令过程应显示类别摘要');
  // 折叠体仍在 DOM（浏览器端 ref 挂 hidden=until-found 供页内搜索，SSR 只能钉类名）。
  assert.ok(compact.includes('pi-turn-process-collapsed'), 'compact 的过程行应收进折叠体');

  const waitingTranscript = {
    ...emptyTranscript, running: true, turnSeq: 1,
    entries: [{ kind: 'user', id: 'u-wait', at: 1, text: '请分析', imageCount: 0 }],
  };
  const waitingMarkup = renderToStaticMarkup(h(ConfigProvider, { motion },
    h(TranscriptView, { transcript: waitingTranscript, mode: 'compact' })));
  assert.ok(liveRowOf(waitingMarkup).includes('正在分析请求'),
    'agent_start 与首个过程消息之间必须有活动头');

  // 叙述窗口：一步先流思考、文字已开始而工具调用未落地——该步自己的思考不得从
  // 折叠体弹出（输出期间自己展开的回归点），也不得拿空过程合成假的完成摘要。
  const narratingWindow = {
    ...emptyTranscript,
    entries: [
      { kind: 'user', id: 'u-n', at: 1, text: '查一下', imageCount: 0 },
      { kind: 'assistant', id: 'a-n', at: 2, text: '先说结论前的叙述', thinking: 'SECRET思考内容', streaming: true, tools: [] },
    ],
    streamingEntryId: 'a-n',
    running: true,
    turnSeq: 1,
    activeTurn: { id: 1, startId: 'u-n' },
  };
  const narratingMarkup = renderToStaticMarkup(h(ConfigProvider, { motion },
    h(TranscriptView, { transcript: narratingWindow, mode: 'compact' })));
  assert.ok(liveRowOf(narratingMarkup).includes('正在分析请求'),
    '叙述窗口（尚无过程）应保持分析提示，不得合成完成摘要');
  assert.ok(!narratingMarkup.includes('SECRET思考内容'),
    '叙述窗口不得把该步自己的思考行平铺出来');
  assert.ok(narratingMarkup.includes('先说结论前的叙述'),
    '正在书写的叙述文本保持可见');

  const afterTool = {
    ...transcript,
    entries: transcript.entries.map((entry) => entry.id === 'a3'
      ? { ...entry, tools: entry.tools.map((run) => ({ ...run, status: 'success' })) }
      : entry),
  };
  const afterToolMarkup = renderToStaticMarkup(h(ConfigProvider, { motion },
    h(TranscriptView, { transcript: afterTool, mode: 'compact' })));
  assert.ok(liveRowOf(afterToolMarkup).includes('正在分析请求'),
    '命令已结束、模型继续工作时不应仍显示正在运行命令');

  const answering = {
    ...afterTool,
    entries: [...afterTool.entries, {
      kind: 'assistant', id: 'a4', at: 6, text: '这是正在输出的答案', thinking: '', streaming: true, tools: [],
    }],
  };
  const answeringMarkup = renderToStaticMarkup(h(ConfigProvider, { motion },
    h(TranscriptView, { transcript: answering, mode: 'compact' })));
  assert.ok(liveRowOf(answeringMarkup).includes('执行了命令'),
    '开始输出答案后，过程头应立即切换成完成摘要');
  assert.ok(answeringMarkup.includes('这是正在输出的答案'), '流式答案正文必须可见');

  const analysisDone = {
    ...emptyTranscript,
    entries: [
      { kind: 'user', id: 'u-analysis', at: 1, text: '分析一下', imageCount: 0 },
      { kind: 'assistant', id: 'a-analysis', at: 2, text: '结论', thinking: '推理内容', streaming: false, tools: [] },
    ],
    turnProcesses: {
      1: { hiddenIds: [], anchorId: 'a-analysis', messages: 0, toolCalls: 0, thought: true, anchorThought: true },
    },
  };
  const analysisMarkup = renderToStaticMarkup(h(ConfigProvider, { motion },
    h(TranscriptView, { transcript: analysisDone, mode: 'compact' })));
  assert.ok(analysisMarkup.includes('已完成分析') && analysisMarkup.includes('结论'),
    '纯推理的已完成轮次应同时显示完成摘要与答案');

  // settledReasoningPreview：已结算思考行的首行预览只在开关打开时出现；流式中的预览不受开关影响。
  const settledEntry = {
    kind: 'assistant', id: 's1', at: 1, text: '正文', thinking: '首行预览应当出现的思考内容', streaming: false, tools: [],
  };
  const previewOn = renderToStaticMarkup(
    h(ConfigProvider, { motion }, h(AssistantMessageItem, { entry: settledEntry, thinkingPreview: true })),
  );
  const previewOff = renderToStaticMarkup(
    h(ConfigProvider, { motion }, h(AssistantMessageItem, { entry: settledEntry, thinkingPreview: false })),
  );
  const previewStreaming = renderToStaticMarkup(
    h(ConfigProvider, { motion }, h(AssistantMessageItem, { entry: { ...settledEntry, streaming: true }, thinkingPreview: false })),
  );
  assert.ok(previewOn.includes('首行预览应当出现的思考内容'), '开关打开时已结算思考行应有首行预览');
  assert.ok(!previewOff.includes('首行预览应当出现的思考内容'), 'compact 下已结算思考行不应有首行预览');
  assert.ok(previewStreaming.includes('首行预览应当出现的思考内容'), '流式中的思考行预览不受开关影响');

  // 设置入口：设置弹窗「外观」区有工作步骤展示四档，默认停在「标准」，prefs 回显当前档。
  const renderSheet = (prefs: Record<string, unknown>): string =>
    renderToStaticMarkup(h(SettingsSheet, {
      open: true, prefs, setPref: () => {}, onExport: () => {}, onImport: () => {},
      onLoadDemo: () => {}, onClearAll: () => {}, onClose: () => {},
    }));
  const sheetDefault = renderSheet({});
  assert.ok(sheetDefault.includes('data-testid="settings-steps-mode"'), '设置弹窗应有工作步骤展示设置项');
  assert.ok(!sheetDefault.includes('settings-open-agent-settings'), '模块 Agent 配置应从全局设置移到左侧模块');
  for (const label of ['工作步骤展示', '简洁', '标准', '详细', '完全展开']) {
    assert.ok(sheetDefault.includes(label), `设置项应含「${label}」选项`);
  }
  assert.ok(sheetDefault.includes('aria-pressed="true"') && sheetDefault.includes('is-active'), '设置项应有选中态');
  const sheetVerbose = renderSheet({ transcriptView: 'verbose' });
  // is-active 在「主题/密度」选择器里也有，必须从本设置项区域里找选中态。
  const stepsRegion = sheetVerbose.slice(sheetVerbose.indexOf('data-testid="settings-steps-mode"'));
  const activeAt = stepsRegion.indexOf('is-active');
  assert.ok(activeAt >= 0 && stepsRegion.slice(activeAt, activeAt + 80).includes('完全展开'), 'prefs.transcriptView=verbose 时应选中「完全展开」');

  // 接线钉在源码上：App 解析 prefs 并透传，AIPanel 把模式交给 TranscriptView。
  const appSource = sourceOf('../src/workbench-app/App.jsx');
  assert.ok(appSource.includes("id: 'agent-settings'") && appSource.includes('onNavigateConfirmed={activateModule}'), 'App 应注册配置模块和离页确认接线');
  assert.ok(appSource.includes('parseTranscriptViewMode(prefs.transcriptView)'), 'App 应从 prefs 解析工作步骤展示模式');
  assert.ok(appSource.includes('stepsMode={stepsMode}'), 'App 应把模式传给 AI 浮层');
  const panelSource2 = sourceOf('../src/workbench-app/shell/AIPanel.jsx');
  assert.ok(panelSource2.includes('mode={stepsMode}'), 'AIPanel 应把模式透传给 TranscriptView');
  const policySource = sourceOf('../src/lib/transcript/presentation.ts');
  assert.ok(policySource.includes("mode: 'compact'") && policySource.includes("mode: 'verbose'"), '策略表应保留 dsh 四档定义');
}

console.log('workbench UI: transcript work-details modes (compact/standard/detailed/verbose) + settings entry passed');

/* ================================================== 11. 模块 Agent 面板：能力卡脱敏 + 外壳可选 props */

{
  // AgentCapabilities：fixture 故意带 headerRefs 名，断言脱敏（绝不进 DOM）。
  const capability = {
    id: 'logs', enabled: true, ok: true,
    profileRevision: 'abcdef0123456789ff',
    tools: ['logs.search', 'logs.read', 'knowledge.search'],
    skills: [{ name: 'log-analysis', path: '/tmp/skills/log-analysis/SKILL.md' }],
    mcp: [{
      id: 'logs-mcp', enabled: false, transport: 'stdio', command: 'logs-mcp',
      headerRefs: { authorization: 'LOGS_MCP_AUTHORIZATION' },
    }],
    knowledge: { homeBinding: 'logs', homeBaseId: 'kb-logs-01' },
  };
  const caps = renderToStaticMarkup(h(AgentCapabilities, { capability, error: '' }));
  assert.ok(caps.includes('data-testid="module-agent-capabilities"'), '能力卡缺根 testid');
  assert.ok(caps.includes('logs.search'), '能力卡应列出工具名');
  assert.ok(caps.includes('log-analysis'), '能力卡应列出 Skill 名');
  assert.ok(caps.includes('logs-mcp') && caps.includes('stdio'), '能力卡应列出 MCP id 与 transport');
  assert.ok(caps.includes('abcdef012345'), '能力卡应展示 profileRevision 前 12 位');
  assert.ok(caps.includes('kb-logs-01'), '能力卡应展示知识库 homeBaseId');
  assert.ok(!caps.includes('LOGS_MCP_AUTHORIZATION'), '能力卡不得泄漏 headerRefs 值/环境变量名');
  assert.ok(!caps.includes('authorization'), '能力卡不得泄漏 headerRefs 键名');

  const capsError = renderToStaticMarkup(h(AgentCapabilities, { capability: null, error: '配置读取失败' }));
  assert.ok(capsError.includes('data-testid="module-agent-capabilities-error"'), '能力卡错误态缺 testid');
  assert.ok(capsError.includes('配置读取失败'), '能力卡应原样透出错误文案');

  // AIPanel 可选 props：title 换名、emptyExtra 渲染在空态欢迎语下方，原 testid 不动。
  const emptyTranscript = {
    entries: [], streamingEntryId: null, running: false, compacting: false,
    retrying: null, queued: { steering: [], followUp: [], pending: [] },
    lastError: null, title: null, turnSeq: 0, activeTurn: null, turnProcesses: {},
  };
  const moduleMarkup = renderToStaticMarkup(h(AIPanel, {
    transcript: emptyTranscript,
    assistRows: [],
    busy: false,
    status: 'idle',
    modelName: 'pi-webx',
    themeMode: 'light',
    title: '日志 Agent',
    emptyExtra: h('div', { 'data-testid': 'module-agent-capabilities' }, '能力占位'),
    onSend: () => {},
    onNew: () => {},
    onRetry: () => {},
    onRefreshData: () => {},
    onAction: () => {},
    onClose: () => {},
  }));
  assert.ok(moduleMarkup.includes('日志 Agent'), 'title prop 未生效');
  assert.ok(moduleMarkup.includes('能力占位'), 'emptyExtra 未渲染在空态下方');
  assert.ok(moduleMarkup.includes('data-testid="ai-overlay"'), 'ai-overlay testid 不得移除');
  assert.ok(moduleMarkup.includes('data-testid="chat-scroll"'), 'chat-scroll testid 不得移除');

  // App 接线：模块面板与通用浮层互斥，openAgent 经 ModuleView 下传。
  const appSource = sourceOf('../src/workbench-app/App.jsx');
  assert.ok(appSource.includes('ModuleAgentPanel'), 'App 未接 ModuleAgentPanel');
  assert.ok(appSource.includes('openAgent='), 'App 未把 openAgent 传给模块');
  const logsPanel = moduleAgentPanelDefinition('logs');
  assert.equal(logsPanel.id, 'logs', '日志 Agent 定义未注册');
  assert.ok(logsPanel.welcomeText?.includes('日志和问题清单') && logsPanel.suggestions?.length === 3, '日志面板文案未从模块定义提供');
  assert.ok(!sourceOf('../src/workbench-app/agents/ModuleAgentPanel.jsx').includes('查询已接入的日志'), '通用面板仍硬编码日志欢迎语');
}

console.log('workbench UI: module agent panel (capabilities redaction, AIPanel optional props, App wiring) passed');

{
  const stopped = renderToStaticMarkup(h(AIPanel, {
    transcript: { entries: [] }, assistRows: [], busy: true, status: 'live', modelName: 'fixture',
    onStop: () => {}, stopping: false, draft: '尚未发送的草稿', onDraftChange: () => {},
    title: '日志 Agent', welcomeText: '查询已接入的日志和问题清单', suggestions: ['查询错误'], inputPlaceholder: '查询日志',
  }));
  assert.ok(stopped.includes('data-testid="module-agent-stop"'));
  assert.ok(stopped.includes('aria-label="停止当前回答"'));
  assert.ok(stopped.includes('尚未发送的草稿'));
  assert.ok(stopped.includes('查询已接入的日志和问题清单'), '无首页插槽的日志面板应保留原有欢迎文案');
  assert.ok(!stopped.includes('如何安排一周运动'));
  assert.ok(stopped.includes('placeholder="查询日志"'));
}
