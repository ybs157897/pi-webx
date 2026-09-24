# 代码地图（Code Map）

> 给人和 AI 的功能定位地图：想找某个功能的代码，先查这里。
> 维护纪律：**新增/移动功能时同步更新本文件**；它过期的那一刻就开始误导人。

更新日期：2026-09-24（对应 `codex/ai-workbench-migration` 分支的大拆分轮次：
七个上帝文件按职责拆成目录模块，原路径保留为 barrel，导出面不变）。

## 总体架构

```
浏览器
 ├─ /            工作台前端（src/workbench-app/，React，8 模块）
 └─ /chat        聊天前端（src/App.tsx → src/app/，LobeHub 风格）
        │ SSE + POST
        ▼
 本地桥 server/index.ts（Express，127.0.0.1:8787）
 ├─ server/routes.ts            HTTP 面（提交门禁冻结，尽量别动）
 ├─ server/ws.ts                WebSocket
 ├─ server/pi/                  pi 会话宿主（进程内 SDK）
 ├─ server/agent-team/          多智能体团队运行时
 ├─ server/agent-definitions/   用户子智能体定义存储
 └─ server/workbench/           工作台 SQLite（store + router）
```

## 按功能找代码

### 聊天界面（/chat）

| 功能 | 位置 |
| --- | --- |
| 入口组合根（40 行） | `src/App.tsx` |
| 外壳组合（hook 接线 + 布局） | `src/app/Shell.tsx` |
| 主题/渲染风格/侧栏偏好 | `src/app/preferences.ts`（读写在函数体内，模块级不碰 localStorage） |
| 连接状态/引导配置 | `src/app/connection.ts` |
| 会话打开/创建/发送/写模型 | `src/app/use-session-lifecycle.ts` |
| 会话列表加载、地址栏恢复 | `src/app/use-session-runtime.ts` |
| 5s 轮询、启动副作用 | `src/app/use-shell-effects.ts` |
| 顶栏 | `src/app/TopBar.tsx`；侧栏列 `SidebarColumn.tsx`；输入坞 `ComposerDock.tsx` |
| 其余 hooks/子视图 | `src/app/use-*.ts`、`src/app/*.tsx`（一文件一职责，文件头有注释） |

### 转写（transcript）渲染与归约

| 功能 | 位置 |
| --- | --- |
| UI 渲染 | `src/components/TranscriptView.tsx`、`MessageItem.tsx`、`ToolCard.tsx` |
| 归约器（reducer） | `src/lib/transcript/`，barrel 在 `index.ts`（公开面：`createTranscript` / `applySnapshot` / `applyPiEvent` / `answerIndexOf` / `addEcho` / `retireEcho`） |
| ├ 未知值守卫 | `guards.ts` |
| ├ content 块解析（文本/思考/图片/工具调用） | `blocks.ts` |
| ├ 条目追加/替换 | `entries.ts` |
| ├ ToolRun 生命周期（找/更新/挂结果/调和） | `tool-runs.ts` |
| ├ 回合状态机（startMessage/endMessage/…） | `turns.ts` |
| ├ 提示条（重试/延迟文案） | `notices.ts` |
| ├ 回合折叠与汇总 | `fold.ts` |
| ├ 快照重建 | `snapshot.ts` |
| ├ 事件分发（reduceEvent） | `events.ts` |
| └ 用户回声（echo） | `echo.ts` |
| 数据模型类型 | `src/shared/transcript.ts`（reducer 契约与 UI 渲染形状） |

### 排队消息 / 问答面 / 任务面板（dsh 三件套）

| 功能 | 位置 |
| --- | --- |
| 排队坞（插话/编辑/删除） | `src/components/QueueDock.tsx` |
| agent 提问卡 | `src/components/AskQuestionCard.tsx`、`QuestionComposer.tsx` |
| todo 面板 | `src/components/TaskPanel.tsx` + `src/lib/todos.ts`（投影）+ `extensions/pi-webx-todo.ts`（pi 侧 todo 工具） |

### a2ui 内联组件（agent 发 UI 进对话）

| 功能 | 位置 |
| --- | --- |
| spec schema + 归一化 | `src/shared/uikit.ts` |
| 渲染器 / 图表 | `src/components/uikit/UiRenderer.tsx`、`UiChart.tsx` |
| pi 侧 render_ui 工具 | `extensions/pi-webx-ui.ts` |

### 模型选择与配置

| 功能 | 位置 |
| --- | --- |
| composer 里的模型选择器 | `src/components/ModelPicker.tsx` |
| 设置页模型区 | `src/components/settings/`（`ModelsSection` / `ModelListEditor` / `ModelEditModal` / `CatalogProviders` / `ProviderEditor`） |
| models.json 原子 CRUD（服务端） | `server/models-config.ts` |
| 目录发现/建议/提供方 | `server/model-discovery.ts`、`server/model-catalog.ts`、`server/model-suggest.ts`、`server/providers.ts` |

### 侧栏工作区与会话浏览

| 功能 | 位置 |
| --- | --- |
| 容器组件 | `src/components/sidebar/WorkspaceBrowser.tsx` |
| 分组树 / 平铺列表 / 搜索结果体 | `sidebar/SessionTree.tsx` / `SessionFlatList.tsx` / `SessionSearchResults.tsx` |
| 小零件（视图菜单、重命名对话框、拖拽 hook） | `sidebar/WorkspaceBrowserParts.tsx`；纯函数与类型 `workspace-browser-utils.ts` |
| 数据派生（分组/平铺/搜索） | `sidebar/tree.ts`；行渲染 `sidebar/Rows.tsx` |

### 设置页与子智能体（用户可见面）

| 功能 | 位置 |
| --- | --- |
| 设置页分区清单 | `src/app/settings-sections.tsx` |
| 子智能体设置区（表单 + 列表） | `src/components/settings/AgentDefinitionsSection.tsx`（表单字段顺序被 UI 门禁按源码断言，改动前读 `scripts/check-agent-definitions-ui.ts`） |
| 编辑器状态机与写操作 | `settings/use-agent-form.ts`；目录加载 `use-agent-catalog.ts`；展示零件 `AgentDefinitionParts.tsx` |
| 表单校验（前后端共享逻辑入口） | `settings/agent-definitions-form.ts` |

### 子智能体（服务端）

| 功能 | 位置 |
| --- | --- |
| 定义存储（barrel） | `server/agent-definitions/index.ts`（`AgentDefinitionStore` 等全从原 `server/agent-definitions.ts` 路径可达） |
| 受限工具策略 | `agent-definitions/policy.ts` |
| 输入校验 | `agent-definitions/validation.ts` |
| 合并/磁盘解析 | `agent-definitions/merge.ts` |
| 原子写 + 串行队列 + 单例 | `agent-definitions/store.ts` |
| HTTP 路由 | `server/agent-definitions-routes.ts` |
| 内置智能体 | `server/builtin-agents.ts` |
| pi 侧执行（worker/生命周期/容量/边界） | `server/pi/subagent-*.ts`（tool/worker/session/lifecycle/execution/capacity/error） |

### 多智能体团队（agent-team）

| 功能 | 位置 |
| --- | --- |
| 运行时编排类（公开 API + 顺序纪律） | `server/agent-team/team-runtime.ts`（路径被带扩展名 import 钉死，不能改成目录） |
| 契约（选项/补丁接口、等待常量） | `team-runtime-contract.ts` |
| 纯函数操作层（成员/任务板/消息/投递/重放/等待） | `team-ops-*.ts` |
| 快照编解码 / 投影 | `team-snapshot.ts` / `team-views.ts` |
| 工具面（orchestrator/worker） | `team-tools.ts` + `team-tools-shared.ts` + `team-tools-worker.ts` |
| 类型 / 注入 / 日志 / 沙箱 | `team-types.ts` / `team-inject.ts` / `team-journal.ts` / `sandbox-tools.ts` + `windows-appcontainer.ts` |

### pi 会话宿主与桥

| 功能 | 位置 |
| --- | --- |
| 会话宿主（注册/事件扇出/命令分发） | `server/pi/host.ts`（host-* 系列是它的拆分服务：commands/events/session-assembly/teams/contract） |
| HTTP 面 | `server/routes.ts`（**提交门禁冻结**）、`server/ws.ts`、`server/static.ts` |
| 会话持久化 | `server/stored-sessions.ts`、`server/pi/session-journal.ts` |
| 附件 | `server/attachment/store.ts` |
| 内置提示词 | `server/prompts/`（`subagent/*.md` 逐字节冻结，规则见该目录 README；设计说明 `docs/system-prompt-design.md`） |

### 工作台（/，8 模块）

| 功能 | 位置 |
| --- | --- |
| 模块导航定义（8 个） | `src/workbench-app/App.jsx` 的 `MODULES`：dashboard 我的主页 / tasks 今日规划 / works 工作助理 / fixes 问题修复 / logs 日志查询 / requirements 需求管理 / codes 代码开发 / knowledge 知识库 |
| 模块实现 | `src/workbench-app/modules/*.jsx`（样式同名 .css；**已退役**的生活模块 Meals/Pets/Relationships/Reviews/Finance/Hotspots/Exercises 文件还在，数据仍在 SQLite，可随时加回导航；AtomBoard 是它们共享的看板组件） |
| 外壳（侧导航/顶栏/AI 全屏对话浮层/命令面板/设置） | `src/workbench-app/shell/`（AI 对话展开后占据整屏、正文列居中，复用 /chat 的 `TranscriptView`；规范见 `docs/workbench-ai-chat-compact-mode.md`） |
| 嵌入聊天（问小台） | `src/workbench-app/pi-webx/`（`useWorkbenchPiChat` 等） |
| 前端 API 客户端 | `src/workbench-app/api.mjs` |
| SQLite 存储与 HTTP | `server/workbench/store.ts`、`router.ts`、`schema.mjs` |
| 知识库接入协议（读/写口子） | `docs/workbench-knowledge-protocol.md`；pi 侧工具 `extensions/pi-webx-knowledge.ts` |

### UI 基础件与图标

| 功能 | 位置 |
| --- | --- |
| 手绘图标（84 个导出） | `src/ui/primitives/icons/`：按类别 `navigation/actions/feedback/files/media/status/tools/objects/product.tsx`，`index.tsx` 是 barrel（路径被 `Menu.tsx` 带扩展名 import 钉死），`props.ts` 放 `IconProps` |
| 其余 primitives（Menu/Modal/Terminal…） | `src/ui/primitives/` |

## 门禁地图（重构雷区）

改下列文件前**必须**先读对应门禁脚本，它们直接断言源码文本或钉死路径：

| 门禁脚本 | 盯什么 |
| --- | --- |
| `scripts/check-agent-definitions-ui.ts` | 读 `AgentDefinitionsSection.tsx` 源码：表单字段（COPY.*）顺序、隐藏字段禁现、无 `type="number"`；读其 `.module.css` 断言窄屏断点 |
| `scripts/check-agent-team-journal.ts` | `team-journal.ts`、`team-runtime.ts` 及 `team-ops-*` 新文件源码**不得含 "durable"** 一词 |
| `scripts/check-task-panel.ts` | 读 `TaskPanel.tsx` 源码与图标 path |
| `scripts/check-agent-team-browser.mjs` | 带扩展名 import `team-runtime.ts` → 该文件不能改成目录 |
| `src/ui/primitives/Menu.tsx` 等 | 带扩展名 import `icons/index.tsx` → barrel 必须留在这个路径 |
| 所有 `scripts/check-*.ts` | 按路径 import 业务模块 → 拆分时原路径保留 barrel 即全绿 |
| `data-testid` | 删改即破坏 UI 门禁（详见根 AGENTS.md） |

## 文件体量约定

- 新文件单一职责，目标 **≤ 400 行**；超过就考虑拆（barrel 文件除外）。
- 拆大文件的标准做法：原路径变成 barrel（`index.ts` 逐项 re-export 公开面），实现移到同目录兄弟文件，**所有引用方零改动**。
- 现存两个登记在案的例外：`AgentDefinitionsSection.tsx`（757 行，表单字段顺序被门禁按源码钉死，可搬部分已全部搬出）、`team-runtime.ts`（595 行编排类，顺序纪律集中在此）。
- `server/routes.ts` 898 行：提交门禁冻结，不拆。

## 相关文档

- 根 `AGENTS.md` — 必跑门禁与硬规则
- `docs/workbench-knowledge-protocol.md` — 知识库写入契约与读/写口子
- `docs/workbench-ai-chat-compact-mode.md` — AI 对话全屏浮层形态与简洁模式输出规范
- `docs/system-prompt-design.md` — 提示词分层设计
- `docs/workbench-redesign.md` — 工作台重塑的需求与决策记录
- `docs/tests/subagents.md` — 子智能体手测记录（历史口径）
- `docs/history/` — 迁移期归档（ALIGN-DSH-REFERENCE、FIXES-TO-PORT）
