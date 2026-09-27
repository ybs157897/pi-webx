# 工作台重塑：从「半成品模块清单」到「个人 AI 指挥台」

> 产品设计 + 架构调整方案。2026-09-24，基于 ego 浏览器对当前分支 `codex/ai-workbench-migration` 的实测取证 + GitHub 开源产品调研。
> 取证截图：`/tmp/pi-webx-audit/`（7 个模块现状 + 5 个参考项目 README 实录）。

---

## 0. 一句话定位

**当前**：一个装了 7 个模块的个人记录 SPA，AI 是旁边一个还没连上的聊天框。
**目标**：**个人 AI 指挥台（Desk）** —— 左边导航、中间工作区、右边常驻 AI 副驾、顶部统一命令入口；所有记录互相可溯源，AI 能读能写，首启即有数据。

产品叙事从「我有什么功能」换成「今天我要指挥什么」：主页是作战仪表盘，模块是工位，AI 副驾是现场参谋。

---

## 1. 现状审计（2026-09-24 ego 实测 + 源码核对）

七个模块都能打开，视觉是统一的玻璃拟态 + Apple 色板。但按产品标准有七处硬伤：

| # | 问题 | 证据 | 严重度 |
|---|------|------|--------|
| 1 | **AI 面板断连**：红条「上一段 Pi 会话未能恢复」+「待连接」常驻 | 截图 `dashboard.png`；根因 `useWorkbenchPiChat.jsx:56`——localStorage 里的旧 session id 服务端已不存在，失败后只清 key 不重建会话 | P0 |
| 2 | **品牌区拼接异常**：侧栏显示「AI 个人工作台老 Yin」 | 截图；`App.jsx:349-353` brand-name 与 brand-sub 之间缺分隔 | P0 |
| 3 | **首启即空壳**：7 个模块全是手写空态，用户第一个 30 秒只看到「没有记录」 | 6 张模块截图 | P0 |
| 4 | **模块孤岛**：fixes / logs / requirements / codes 与 tasks 零关联，无法回答「这个需求现在到哪了」 | `schema.mjs` 无任何关联字段；模块间无跳转（除 dashboard 的「去安排」） | P1 |
| 5 | **运维感外露**：每个页面右上角都有「数据导入/导出」 | `App.jsx:388` | P1 |
| 6 | **无产品化外壳**：没有全局搜索、命令面板、快捷键、设置页、暗色模式 | 全仓无 CommandPalette / 设置组件；`styles.css` 单主题 | P1 |
| 7 | **架构笨重**：`App.jsx` 614 行持有全部状态；任何一次写操作都全量重拉；7 个模块各自实现一套筛选 UI | `App.jsx:144-161`；`modules/*.jsx` | P2 |

**诊断结论**：这不是"功能不够"，而是"产品结构没长全"——门面（AI 面板）是坏的、骨架（导航/搜索/设置）是缺的、血肉（数据关联）是断的。

---

## 2. 灵感来源（ego 浏览 GitHub 实录）

每个项目只取**概念**，不搬实现——本工作台是 React SPA + 本机 SQLite，重写成本必须可控。

| 参考项目 | 实录 | 取用的概念 | 落到本工作台 |
|----------|------|-----------|-------------|
| **makeplane/plane**（59.8k★） | README 产品图 | 工作项（work item）+ 视图切换（列表/看板/日历/时间线）+ 过滤器 + 周期（cycle） | tasks/works/fixes/requirements 统一为"记录集 + 多视图"范式：模块切换的是**视图**不是**形态** |
| **glanceapp/glance** | README 产品图 | 主页 = 多列 widget 板（日历 / RSS / 监控 / 行情） | 「我的主页」从单栏卡片流改为**指挥台 widget 板**：今日进度、待办、问题、日志、开发事项各占一格 |
| **amir20/dozzle** | README 产品图 | 日志 = 深色密集表格、级别色条、源侧栏、实时检索 | 「日志查询」以检索为中心：级别色条 + 时间分组 + 源标签，保留用户已定的「查询/记录」对话框 |
| **coder/code-server**（70k★） | README 产品图 | IDE 工作区 = 活动栏 + 资源管理器 + 编辑器 tab + 状态栏 | 「代码开发」确立 IDE 外壳：文件树 tab、编辑器多 tab、底部状态栏；事项=可打开的"开发卡" |
| **lobehub/lobe-chat** | README 产品图 | 「Your Chief Agent Operator」：AI 副驾组织 agent 与任务 | 右栏从"聊天框"升级为**AI 副驾**：能引用当前模块上下文提问、能把对话结果一键落库（建任务/记日志） |

另从通用产品概念吸收：**快速捕获（Quick Capture）**（随时 `⌘+K` 记一条，不管类型）、**每日简报（Daily Briefing）**（AI 早报汇总昨日）、**个人工作可观测性**（问题/日志/任务的热力与趋势）。

---

## 3. 目标信息架构

```
┌────────────────────────────────────────────────────────────────┐
│ 顶栏  [◧ 工作台名]   [ ⌘K 全局搜索… ]         [🌙 主题] [⚙ 设置] │
├────────┬───────────────────────────────┬───────────────────────┤
│        │                               │                       │
│ 导航    │        工作区 Workspace        │    AI 副驾 Copilot    │
│ (7模块) │   （每个模块自带：视图切换 +     │  · 常驻可折叠         │
│         │    过滤器 + 主操作按钮）        │  · 注入当前模块上下文   │
│  · 主页 │                               │  · 结果一键落库       │
│  · 规划 │                               │  · 断线自愈           │
│  · 助理 │                               │                       │
│  · 修复 │                               │                       │
│  · 日志 │                               │                       │
│  · 需求 │                               │                       │
│  · 开发 │                               │                       │
├────────┴───────────────────────────────┴───────────────────────┤
│ ⌘K 命令面板（浮层）：搜索全部记录 · 跳转模块 · 快捷操作 · 帮助     │
└────────────────────────────────────────────────────────────────┘
```

三条核心交互路径（产品必须保证 10 秒内可达）：
1. **捕获**：任意页面 `⌘+K` → 输入"记：周五前修好登录页 bug" → 回车落库到对应模块。
2. **溯源**：需求详情 → 看它派生的任务/问题/日志，一键跳转。
3. **AI 闭环**：AI 副驾回答 → "存为今日任务" → 落库 → toast 确认 → 模块即时出现。

---

## 4. 模块重设计规格（逐模块）

### 4.1 我的主页 → 指挥台（Dashboard）

- **布局**：多列 widget 板（≥1080px 3 列；640–1080px 2 列；<640px 单列）。参考 glance。
- **widget 清单**：问候 + AI 早报（首条消息由 AI 生成，含昨日完成/今日重点）；今日进度环（tasks 完成率）；今日待办（top 5，勾选即完成）；进行中的问题（todo/doing 计数 + 链接）；最近日志（最近 3 条，按级别着色）；开发事项待办。
- **首启**：检测空库 → 一键「灌入演示数据」引导条（可随时在设置里清除）。

### 4.2 今日规划 → 日视图（Tasks）

- 顶部快速捕获输入框（回车即建，默认 due=today）。
- 「今日 / 全部」分段切换；优先级徽章（高/中/低三色）；点击标题行内编辑；完成动画。
- 与 fixes/requirements 联动：显示"关联问题数"角标。

### 4.3 工作助理 → 看板 + 列表双视图（Works）

- Plane 概念：同一数据两种视图（看板/列表），视图偏好记忆在 localStorage。
- 看板列：todo / doing / done；卡片拖拽改状态；卡片显示标题 + 备注摘要 + 关联计数。
- 列表视图：密集表格，适合批量浏览。

### 4.4 问题修复 → 问题列表（Fixes）

- 保留用户已定的**列表**形态（不用看板）。
- 行 = 优先级色点 + 标题 + 状态分段（待处理/修复中/已修复）+ 更新时间。
- 详情展开：备注、**关联日志**（该问题的 log 列表）、**关联任务**；支持从问题一键「记一条日志」。

### 4.5 日志查询 → 检索中心（Logs）

- 保留「查询日志 / 记录日志」两个对话框。
- 结果 = 密集表格（dozzle 概念）：级别色条（info/warn/error）、时间列（相对时间）、源标签、正文。
- 查询对话框支持：关键词 + 级别多选 + 日期范围 + 源过滤。
- 「记录日志」对话框支持联动当前选中问题（若有）。

### 4.6 需求管理 → 知识库（Requirements）

- 保留左右两栏（左列表搜索、右阅读）。
- 状态机升级：想法 → 评审中 → 开发中 → 已交付（原 todo/doing/done 映射过来，旧数据兼容）。
- 右栏阅读区渲染 markdown 正文；底部显示关联任务/问题时间线。
- 标签（tags）沉淀为知识库分类。

### 4.7 代码开发 → IDE 工作区（Codes）

- code-server 概念：活动栏（事项 / 文件 / 终端态占位）+ 事项列表 tab + 编辑器区。
- 事项 = 开发卡：标题 = 事项名，note = 描述；点开进入编辑器 tab（等宽区 + 行号 + ⌘S 保存已有基础保留）。
- 底部状态栏：当前事项状态、项目名、保存状态。

---

## 5. 数据模型与关联（架构调整 · 服务端）

原则：**向后兼容、渐进增强**。SQLite 里记录是 JSON payload，加字段不破坏旧数据；导入校验放开新字段。

1. **统一通用字段**（所有 array 模块）：
   - `tags: string[]`（默认 `[]`）：跨模块分类与检索。
   - `refs: { type, id }[]`（默认 `[]`）：轻关联（task→requirement、fix→task、log→fix、codes→project）。
   - `starred: boolean`（默认 `false`）：置顶。
   - 既有 `createdAt/updatedAt` 时间戳扩展到全部模块（现只有 4 个模块有）。
2. **关联端点**：`GET /api/workbench/links/:module/:id` 返回某记录的关联图谱（一度）。
3. **全局搜索端点**：`GET /api/workbench/search?q=` 服务端 SQLite `LIKE`，返回带模块与摘要的结果（命令面板数据源）。
4. **设置持久化**：`workbench_meta` 增加 `ui_prefs`（主题 / 密度 / AI 面板默认开合 / 各模块视图偏好），`GET/PUT /api/workbench/prefs`。
5. **种子数据**：`WorkbenchStore.seed()` —— first-run（库为空）时写入一组演示记录并打 `seeded: true`，设置页可「清除全部数据并重新播种」。

> 注意：上一轮 UI 改造有"schema.mjs 不动"的约束；本方案显式解除该约束——用户本次授权的是"架构调整"。扩展全部是新增可选字段，`validateFields` 对旧数据走默认值路径，`scripts/check-workbench-sqlite.ts` 门禁同步补用例。

---

## 6. 设计系统升级

`styles.css` 已有令牌但只有一个主题、无色阶。升级为：

1. **令牌分层**：颜色分 `surface-0..3 / text-1..3 / border-1..2 / accent + 语义色 ok/warn/danger/info`；间距 4 的倍数标尺（`--sp-1..8`）；字号标尺（12/13/14/16/20/28）；圆角三档；阴影三档；`z-index` 标尺（drawer/modal/toast/palette）。
2. **暗色模式**：`<html data-theme="dark|light|auto">`，token 双份值，跟随 `prefers-color-scheme`；顶栏一键切换。
3. **密度切换**：紧凑 / 舒适（改 `--sp-*` 与行高），看板/表格类默认紧凑。
4. **动效规范**：微交互 150ms `ease-out`；模态/抽屉 200ms；尊重 `prefers-reduced-motion`；去掉 aura 漂移动画的默认开启（改为可关）。
5. **组件库补齐**（`ui.jsx` 扩展，保持现有 props 风格）：`DataTable`（密集表格）、`FilterBar`（搜索 + 分段 + 过滤 chips）、`TagInput`、`Timeline`、`RelativeTime`、`CommandPalette`、`SettingsSheet`、`EmptyState`（统一首启引导文案 + 行动按钮）。

---

## 7. 前端架构调整

```
src/workbench-app/
├── WorkbenchRoot.jsx          # 挂载 + theme/prefs 初始化（保持入口不变）
├── App.jsx                    # 瘦身为 shell：路由 + provider，不再持有全量 state
├── shell/
│   ├── TopBar.jsx             # 品牌 + ⌘K + 主题 + 设置
│   ├── SideNav.jsx            # 7 模块导航（含徽章计数）
│   ├── Workspace.jsx          # 模块容器：page-head + 视图切换挂载点
│   ├── AIPanel.jsx            # 副驾面板（原 App.jsx chatPanel 抽出）
│   └── CommandPalette.jsx     # ⌘K：搜索 / 跳转 / 快捷操作
├── modules/                   # 每个模块自管 state + 视图（组件契约不变）
├── state/
│   ├── useWorkbenchData.js    # 按模块缓存 + 局部更新（替代全量 refresh）
│   └── prefs.js               # 主题/密度/视图偏好持久化
├── pi-webx/                   # 现有 hook 增强：断线自愈 + 上下文注入
└── ui.jsx / icons.jsx / ...   # 组件库扩充
```

关键变化：

1. **状态拆分**：`App.jsx` 不再持有 `data` 全量；改为 `state/useWorkbenchData.js` 统一管理记录集缓存，写操作走**模块级局部更新 + 乐观落库失败回滚**，消灭"改一条刷新全库"。
2. **AI 副驾可靠性**：`useWorkbenchPiChat` 状态机化（`idle → connecting → live → error`）；session 恢复失败**自动新建会话**并提示一句（不再弹红条）；面板头部显示重试按钮；副驾接收"当前模块 + 当前记录"上下文，支持「存为任务 / 记为日志」动作按钮。
3. **命令面板**：数据源走新搜索端点；支持 `跳转模块 / 新建记录 / 切换主题 / 打开设置 / 帮助`。
4. **模块注册表增强**：`MODULES` 增加 `shortcut`（⌘1..7）、`badge`（计数来源），导航与命令面板共用同一份注册表。

---

## 8. 路线图（每阶段独立可验收）

| 阶段 | 内容 | 验收口径 |
|------|------|---------|
| **P0 止血**（1–2 天） | AI 副驾自愈 + 品牌 bug + 种子数据 + 导入导出收进设置 + ⌘K/⌘1-7 快捷键 | AI 面板断线 5s 内自愈或可一键重试；首启主页有演示数据；三条命令门禁全绿 |
| **P1 骨架**（3–5 天） | shell 拆分（TopBar/SideNav/Workspace/AIPanel）、命令面板 + 全局搜索、设计令牌 + 暗色、统一 EmptyState/FilterBar | ego 逐模块截图：亮/暗两主题、两档密度无对比度问题；⌘K 能搜到任意记录并跳转 |
| **P2 模块重塑**（1–2 周） | 主页 widget 板；tasks 快速捕获；works 双视图；fixes 关联日志；logs 密集表；requirements 状态机 + markdown；codes IDE 外壳 | 每模块一份规格验收（见 §4 的逐条）；SSR 断言结构 + ego 截图 |
| **P3 关联与自动化** | tags/refs schema + 关联端点 + 溯源视图 + AI 早报 + AI 工具直接读写工作台 | 「需求→任务→问题→日志」四跳全通；AI 说"存为任务"真能落库 |

---

## 9. 实施约定

- 沿用仓库既有纪律：模块 props 契约（`data/profile/mutate/refresh/notify/navigate/modules`）在 P2 期间保持兼容，新契约（数据缓存）在 P1 落地后切换；写路径仍走 `mutate(action, okText)` 语义。
- 验证通路边（来自既有经验）：`npm run typecheck` / `npm run build` / `npm run check:workbench` 三条命令门禁 → SSR 断言（`renderToStaticMarkup`）→ ego 轻服务 + chromium 截图（每模块亮/暗各一张）。
- 提交策略：P0 一个提交、P1 按 shell 拆分逐个提交、P2 每模块一个提交、P3 按 schema 迁移/端点/UI 三个提交；每个提交跑门禁。

---

## 附：本轮设计取舍记录

1. **不做**多用户/云同步——本机 SQLite 是产品前提，AI 写入走本机服务端即可。
2. **不做**完整 IDE——codes 模块是"开发事项工作区"，编辑器是形态载体，不接 LSP。
3. **保留**用户上一轮五条交互定调：fixes 列表、logs 对话框、requirements 左右栏、codes 编辑器态、AI 面板渲染一致——本方案是在这些形态上补产品结构，不推倒重来。
4. **移除**生活模块（行业热点/运动打卡/饮食记录/收支/宠物/亲密关系/复盘）保持现状不动；服务端 schema 已保留，将来可以 widget 形式加回主页。

---

## 附录 B：实施记录（2026-09-24 落地）

P0–P2 已实现并通过全部门禁（`npm run typecheck` / `npm run build` / `npm run check:workbench` / `npm run check:workbench-ui`），ego 亮/暗/移动三态截图验收通过（取证在 `/tmp/pi-webx-audit/v2-*`，重启后清空）。

**已落地**

- **后端**（`server/workbench/`）：`schema.mjs` 新增通用字段 `tags/refs/starred` 并注入全部数组模块；时间戳扩展到全部模块（旧数据导入自动补齐）；新增 `demoState()` 演示数据（任务↔需求、问题↔任务互相引用）；`store.ts` 增加 `search()`（LIKE 转义）、`readPrefs/writePrefs`（workbench_meta 白名单）、`loadDemo/resetAll/isEmpty`；`router.ts` 增加 `GET /search`、`GET/PUT /prefs`、`POST/DELETE /demo-data`，`/state` 附带 `prefs` 与 `empty`。
- **设计系统**（`styles.css` 重写）：分层令牌（surface/text/line 三档 + 语义色 + `*-strong` chip 文字变体，亮色对比度过 AA）、`data-theme="dark"` 整组覆盖、`data-density="compact"`、z 轴标尺、列表/表格原语、命令面板样式；去掉漂移光斑。
- **外壳**（`shell/` 新增 + `App.jsx` 瘦身）：TopBar（品牌 bug 修复、⌘K 入口、主题快切、设置）、SideNav（待办徽章）、AIPanel（抽出 + 三档状态 + 断线自愈 + 重试）、CommandPalette（⌘K 全局搜索/跳转/操作）、SettingsSheet（外观/数据/快捷键，导入导出从每页右上角收回）；快捷键 ⌘K/⌘1–7/Esc。
- **AI 副驾自愈**（`useWorkbenchPiChat.jsx`）：旧 session 失效自动开新会话 + 软提示；idle 状态诚实显示「待命」（不给不聊天的用户白开会话）。
- **七个模块重塑**（每个模块 `.jsx` + 私有 `.css`，样式不再单文件互踩）：主页 widget 板（问候/AI 早报/进度环/待办/问题/日志/开发 + 空库引导）、今日规划（快速捕获小语法 `#标签/@日期!优先级` + 逾期分组 + 行内编辑）、工作助理（看板 HTML5 拖拽 + 列表双视图，偏好落库）、问题修复（密集表 + 过滤 + 详情关联任务/回记日志）、日志查询（级别色条密集表 + 查询/记录对话框）、需求管理（左右两栏 + markdown 阅读区 + 关联任务）、代码开发（IDE 外壳：活动栏/文件树/多 tab/行号编辑区/⌘S/未保存拦截）。
- **门禁同步**：`check-workbench-sqlite.ts` 增加新字段/时间戳/搜索/偏好/演示数据断言；`check-workbench-ui.ts` 重写为七模块 SSR 断言 + Markdown 渲染一致性；两个脚本走 `check-bootstrap.mjs` CSS 引导（`package.json` 已更新）。

**与原方案的偏差**

1. 主页栅格用 `minmax(min(260px,100%),1fr))` 而非固定 280px（1080–1624px 视口都能排满）。
2. 空库判定用双条件（服务端 `empty` 标志 + 确无记录），标志误报时不藏用户数据。
3. 偏好持久化走服务端 `/prefs`（与记录同库），而非 localStorage。
4. 模块视图偏好（tasksScope/worksView）只存服务端白名单键，模块内另有本地兜底。

**P3 未做（下一步）**：AI 副驾直接读写工作台（对话结果一键落库）、需求↔任务双向关联入口、AI 早报定时生成、tasks 的 doneAt 语义补全、`GET /links/:module/:id` 关联图谱端点。
