# 代码地图（Code Map）

> 给人和 AI 的功能定位地图：想找某个功能的代码，先查这里。
> 维护纪律：**新增/移动功能时同步更新本文件**；它过期的那一刻就开始误导人。

更新日期：2026-09-29。新增生活秘书：我的待办与今日规划共享事项和独立 life Agent；共九个导航入口，业务实现按模块目录归位。

## 总体架构

```
浏览器
 ├─ /            工作台前端（src/workbench-app/，React，8 业务入口 + Agent 配置）
 └─ /chat        聊天前端（src/App.tsx → src/app/，LobeHub 风格）
        │ SSE + POST
        ▼
 本地桥 server/index.ts（Express，127.0.0.1:8787）
 ├─ server/routes.ts            HTTP 面（提交门禁冻结，尽量别动）
 ├─ server/ws.ts                WebSocket
 ├─ server/pi/                  pi 会话宿主（进程内 SDK）
 ├─ server/modules/             工作台领域字段与日志/知识工具
 ├─ server/module-agents/        Agent 公共装配与作用域机制
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
| 主题/渲染风格/侧栏/工作步骤展示偏好 | `src/app/preferences.ts`（读写在函数体内，模块级不碰 localStorage） |
| 连接状态/引导配置 | `src/app/connection.ts` |
| 会话打开/创建/发送/写模型 | `src/app/use-session-lifecycle.ts` |
| 会话列表加载、地址栏恢复 | `src/app/use-session-runtime.ts` |
| 5s 轮询、启动副作用 | `src/app/use-shell-effects.ts` |
| 顶栏 | `src/app/TopBar.tsx`；侧栏列 `SidebarColumn.tsx`；输入坞 `ComposerDock.tsx` |
| 其余 hooks/子视图 | `src/app/use-*.ts`、`src/app/*.tsx`（一文件一职责，文件头有注释） |

### 转写（transcript）渲染与归约

| 功能 | 位置 |
| --- | --- |
| UI 渲染 | `src/components/TranscriptView.tsx`、`MessageItem.tsx`、`ToolCard.tsx`；轮次摘要行/进行中活动头在 `TranscriptProcessRow.tsx` |
| Skill / MCP 加载与调用记录 | `src/lib/capability-call.ts` 统一识别名称、资源与失败；`components/CapabilityToolCard.tsx` 展示状态并按需展开参数/结果，`ToolRunView.tsx` 分发；`scripts/check-capability-tools.ts` 随工作台 UI 门禁运行 |
| 工作步骤展示（简洁/标准/详细/完全展开四档，默认标准） | 策略表 `src/lib/transcript/presentation.ts`（模式→渲染开关，渲染层只读字段不比枚举；`liveProcessSpec` 派生活动头）；工作台存 SQLite prefs `transcriptView`，/chat 存 localStorage（`src/app/preferences.ts`）；规范 `docs/workbench-ai-chat-compact-mode.md` |
| 归约器（reducer） | `src/lib/transcript/`，barrel 在 `index.ts`（公开面：`createTranscript` / `applySnapshot` / `applyPiEvent` / `answerIndexOf` / `addEcho` / `retireEcho`） |
| ├ 未知值守卫 | `guards.ts` |
| ├ content 块解析（文本/思考/图片/工具调用） | `blocks.ts` |
| ├ 条目追加/替换 | `entries.ts` |
| ├ ToolRun 生命周期（找/更新/挂结果/调和） | `tool-runs.ts` |
| ├ 回合状态机（startMessage/endMessage/…） | `turns.ts` |
| ├ 提示条（重试/延迟文案） | `notices.ts` |
| ├ 回合折叠与汇总 | `fold.ts` |
| ├ 工作步骤展示策略表（不经 barrel，消费方深引） | `presentation.ts` |
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

### 模块 Agent（module-agents）

设计文档：`docs/architecture/workbench-independent-agents.md`（P0+P1 实施中）。

| 功能 | 位置 |
| --- | --- |
| 配置真相源（YAML） | `config/agents/*.yaml` + `prompts/` + `skills/`；文件名必须等于注册 id |
| 契约（AgentId/AgentScope/配置/装配产物） | `server/module-agents/contracts.ts` |
| 统一加载器（逐文件隔离、Skill YAML 字符串/`{path,enabled}`、仅快照选中项、profileRevision 摘要） | `server/module-agents/profiles.ts` |
| 左侧 Agent 配置页的后端设置（GET/PUT、提示词/模型/Skill 正文编辑与目录导入、乐观并发、原子回滚） | `server/module-agents/settings/{router,service,validation,imports,persistence}.ts`；共享 HTTP 类型 `src/shared/module-agent-settings.ts`。`server/index.ts` 先挂设置路由，配置根可用绝对路径 `PI_WEBX_AGENT_CONFIG_DIR` 指向临时克隆；新对话使用新配置 |
| 模块独立工作区（默认目录、自定义绑定、真实路径与重叠校验） | `server/module-agents/workspace.ts`；YAML 可选 `workspace`，配置快照固定有效目录，新会话按绑定创建，恢复保留原目录 |
| 提示词 AI 润色（无工具单次模型调用、预览后应用、超时与取消） | `server/module-agents/settings/polish.ts`；复用 PiHost 模型配置与凭据，不创建会话或写配置 |
| 知识绑定表 + 受限 KnowledgeAccess | `server/module-agents/knowledge.ts` |
| 模块注册表（createTools 工厂，life + works + requirements + logs + codes） | `server/module-agents/registry.ts` |
| HTTP 入口 `GET /api/module-agents`、`POST /api/module-agents/:id/sessions` | `server/module-agents/router.ts`（`server/index.ts` 挂载，先于 `/api` 通配） |
| 日志领域工具（`logs_*`） | `server/modules/logs/index.ts` + `tools.ts`；`server/module-agents/logs/tools.ts` 仅兼容 re-export |
| 知识工具（`knowledge_*`） | `server/modules/knowledge/tools.ts`，经 `server/module-agents/knowledge.ts` 的 KnowledgeAccess 做服务端作用域校验与输出截断 |
| 装配纯函数（工具白名单过滤 + 校验 + MCP 连接装配） | `server/module-agents/assemble.ts`（router 与会话/MCP 门禁共用） |
| 数据源统一契约与适配器 | `server/data-sources/contracts.ts`、`registry.ts`、`workbench.ts`、`http-json.ts`、`mapping.ts`；接入说明 `docs/architecture/data-source-adapters.md` |
| 配置资源快照与受限 Skill 读取 | `server/module-agents/resources.ts`、`snapshots.ts`；文本可经 `skills_read` 读取，二进制配套资源以 base64 留存固定版本 |
| MCP 适配（envRefs/headerRefs 注入、工具桥接、dispose） | `server/module-agents/mcp.ts`；stdio fixture `scripts/mcp-fixture-server.ts` |
| 前端会话 hook（懒创建、双存储恢复指针、requestId 幂等） | `src/workbench-app/agents/useModuleAgentChat.jsx` |
| 前端面板（复用 AIPanel 外壳 + 能力卡） | `src/workbench-app/agents/ModuleAgentPanel.jsx`、`definitions.js`、`AgentCapabilities.jsx`；日志专属文案在 `modules/logs/agent-ui.js`（App.jsx 以 `agentPanel` 态与通用浮层互斥；日志页保留 `logs-agent-open` 入口） |
| 宿主收口点 | `HostedSession.moduleAgent`（`pi/host-contract.ts`）；装配/恢复/fork/reset 在 `host-session-assembly.ts`；`setToolSelection`（host.ts）、`set_tools`（host-commands.ts）、`refreshSubagentTool`（host-teams.ts）对模块会话短路 |
| 会话身份条目 | 日志自定义条目 `pi-webx:module-agent`（version 1，装配时写入会话日志） |
| Store 扩展入口 | `WorkbenchStore.searchKnowledge`（json_extract 按库过滤）/ `readKnowledge` / `listRecords` / `sqlite`（@internal） |
| 门禁 | `scripts/check-data-source-adapters.ts`（异构接口与插件）、`check-module-agent-http.ts`（幂等/并发/快照恢复）、`scripts/check-module-agent-profiles.ts`（A15）、`check-module-agent-knowledge.ts`（A05 服务端）、`check-module-agent-sessions.ts`（A01/A02/A09 服务端，真实 SDK 无模型调用）、`check-module-agent-mcp.ts`（A03/A04 服务端，stdio fixture 子进程） |
| 设置门禁 | `scripts/check-module-agent-settings.ts`（临时配置根、HTTP 编辑/目录导入、资源完整性、新旧 SDK 会话版本、路径/并发/写失败）；`check-module-agent-skill-settings.ts`（导入、编辑、二进制资源和越界/回滚）；`check-module-agent-prompt-polish.ts`（模型调用契约、错误、超时、取消）；`check-module-agent-workspaces.ts`（SDK 工作目录与新旧会话绑定）；`check-module-agent-workspace-settings.ts`（目录保存、冲突、重置、并发隔离） |

### 工作台（/，9 个导航入口）

| 功能 | 位置 |
| --- | --- |
| 模块导航定义（9 个） | `src/workbench-app/App.jsx` 的 `MODULES`：dashboard 我的主页 / life 生活秘书 / works 工作助理 / fixes 问题修复 / logs 日志查询 / requirements 需求管理 / codes 代码开发 / knowledge 知识库 / agent-settings Agent 配置 |
| 模块实现 | `src/workbench-app/modules/{dashboard,life,today,tasks,works,fixes,logs,requirements,codes,knowledge}/`：各自 `index.jsx` 公开页面，专属 JSX、model、CSS 同目录；旧 `modules/X.jsx` 无业务逻辑，仅兼容旧 deep import |
| Agent 配置页 | `src/workbench-app/modules/agent-settings/`：`index.jsx` 页面与离页草稿保护，`Editor.jsx` 组合编辑区，`WorkspaceEditor.jsx` 独立目录与系统原生文件夹选择绑定（复用 `src/lib/api.ts` → `POST /api/workspace/pick` → `server/directory-picker.ts`），`ModuleTabs.jsx` 模块卡片切换，`PromptEditor.jsx` 提示词编辑与润色预览，`SkillList.jsx` 勾选/详情/正文编辑/目录导入，`skill-import.js` 目录分组与上传编码，`useAgentSettings.js` 加载与保存；UI 门禁 `scripts/check-module-agent-settings-ui.tsx` |
| 外壳（侧导航/顶栏/AI 全屏对话浮层/命令面板/设置） | `src/workbench-app/shell/`（AI 对话展开后占据整屏、正文列居中，复用 /chat 的 `TranscriptView`；规范见 `docs/workbench-ai-chat-compact-mode.md`） |
| 嵌入聊天（问小台） | `src/workbench-app/pi-webx/`（`useWorkbenchPiChat` 等） |
| 前端 API 客户端 | `src/workbench-app/api.mjs` |
| SQLite 存储与 HTTP | `server/workbench/store.ts`、`router.ts`；`schema.mjs` 保留 `ARRAY_MODULES`、公共校验和演示数据，`schema-fields.mjs` 放共享字段，`server/modules/<id>/schema.mjs` 放模块字段（`knowledgeBases` / `knowledgeFolders` 归 knowledge） |
| 知识库接入协议（读/写口子） | `docs/workbench-knowledge-protocol.md`；pi 侧工具 `extensions/pi-webx-knowledge.ts` |

### 需求对话与待办导入

流程、接口和验收边界见 `docs/architecture/requirements-workflow.md`。

| 功能 | 位置 |
| --- | --- |
| 菜单直达中央对话、历史记录切换、导入后跳待办 | `src/workbench-app/modules/requirements/index.jsx`；布局 `Conversation.css` |
| 独立需求会话与草稿投影 | `modules/requirements/RequirementsChat.jsx`；复用 `useModuleAgentChat('requirements')` 与 `AIPanel`，按 `sourceSessionId` 过滤本次会话草稿，回合结束/恢复后刷新 SQLite 投影 |
| 原有需求列表、阅读和编辑 | `modules/requirements/Records.jsx`、`Reader.jsx`、`Dialogs.jsx`；保留旧 `req-*` testid |
| 确认导入弹窗 | `modules/requirements/ImportDialog.jsx`、`ImportDialog.css`；预览需求与待办、编辑/勾选、键盘焦点和错误反馈 |
| 需求领域工具与原子导入 | `server/modules/requirements/{tools,import-tasks}.ts`；`requirements_save_draft` 只保存草稿，`POST /api/workbench/requirements/:id/import-tasks` 显式确认、版本校验、整批事务、防重复 |
| 配置和结构化字段 | `config/agents/requirements.yaml`、`prompts/requirements.md`；`server/modules/requirements/schema.mjs` 维护 `sourceSessionId` / `taskDrafts`，导入标记由服务端写入 |
| 待办来源跳转 | `App.jsx` 的 `navigationTarget`、`modules/tasks/{index,model}.jsx`；导入后进入全部视图，任务 refs 回到对应需求记录 |
| 门禁 | `scripts/check-requirements-import.ts` 覆盖持久化/HTTP/事务/幂等；`scripts/check-requirements-ui.tsx` 与 `check-workbench-ui.ts` 覆盖真实 SSR DOM |

### 生活秘书：我的待办与今日规划

产品契约与验收方法见 `docs/architecture/life-secretary.md`。

| 功能 | 位置 |
| --- | --- |
| 生活秘书入口与两个内部页签 | `src/workbench-app/modules/life/index.jsx`、`LifeChat.jsx`；侧栏 life，内含 today/tasks 页签，切换不卸载对话 |
| 业务记录导航 | `src/workbench-app/shell/navigation.mjs` 将 tasks 数据链接与 today 跳转映射到 life 的对应页签；保留需求来源筛选。`check-life-navigation.tsx` 验证父菜单与映射 |
| 事项收集、编辑、完成、安排 | `src/workbench-app/modules/tasks/`；原 `Tasks.jsx` 继续 re-export |
| 日期安排与未完成事项 | `src/workbench-app/modules/today/`；从 tasks.plannedDate 派生，截止日仍为 due |
| 方案预览和显式确认 | `src/workbench-app/modules/life/PlanReview.jsx`；只展示当前 life 会话草稿 |
| 生活秘书工具、草稿确认与排期校验 | `server/modules/life/`；通过工作台 router/store 接入事务、版本校验与持久化 |
| 事项字段、草稿字段 | `server/modules/tasks/schema.mjs`、`server/modules/life/schema.mjs`；schema 聚合 lifePlans，纳入导出导入 |
| 独立配置与提示词 | `config/agents/life.yaml`、`config/agents/prompts/life.md`；Agent 配置页独立编辑 |
| 自动门禁与隔离浏览器服务 | `scripts/check-life-secretary.ts`、`check-life-secretary-ui.tsx`、`check-life-agent.ts`、`life-agent-browser-fixture.ts` |

### 工作助理 Agent 与时间安排

流程、工具边界和验收方法见 `docs/architecture/works-agent-planning.md`。

| 功能 | 位置 |
| --- | --- |
| 规划对话和时间表入口 | `src/workbench-app/modules/works/index.jsx`、`WorksChat.jsx`、`Agenda.jsx`、`Planning.css`；桌面并列，窄屏切换对话/安排 |
| 原看板/列表与手动改期 | `modules/works/Records.jsx`、`RecordDialogs.jsx`、`ScheduleFields.jsx`、`model.jsx`；保留已有 `works-*` testid，`schedule.mjs` 负责排期投影 |
| 独立身份与提示词 | `config/agents/works.yaml`、`config/agents/prompts/works.md`；Agent 配置页可独立编辑，独立会话/工作目录/知识库沿用公共装配机制 |
| 待办读取与排期工具 | `server/modules/works/tools.ts`、`schedule.ts`；`works_context` 返回本地时间、时区、未完成待办与已有安排，`works_schedule` 原子保存日期和时段、关联待办但不修改待办 |
| 排期字段与校验 | `server/modules/works/schema.mjs`、`validation.ts`；`scheduledDate` / `startTime` / `endTime` 同组维护；HTTP、导入和 Agent 共用有效日期/时段/冲突校验 |
| 门禁与隔离浏览器服务 | `scripts/check-works-agent.ts`、`check-works-planning-ui.tsx`；`npm run dev:works-fixture` 运行离线模型流但真实 SDK 工具和 SQLite 的隔离验收服务 |

### 代码开发 IDE 与固定对话

| 功能 | 位置 |
| --- | --- |
| IDE + 最右侧固定代码对话 | `src/workbench-app/modules/codes/index.jsx`、`Workspace.css`、`CodeChat.jsx`；桌面双列独立滚动，窄屏切换编辑器/对话 |
| 开项目绑定与状态协议 | `modules/codes/workspace-binding.mjs` 仅读取 codes settings 的当前目录，进入菜单自动打开，换目录统一在 Agent 配置页；`ide-state.mjs` 校验 iframe 状态，父页同时核验 origin/source；未保存/保存中阻止离页 |
| 原 SQLite 开发事项 | `modules/codes/Records.jsx` + `View.jsx` + `model.jsx` + `Codes.css`，通过「开发事项」按钮进入；已有 testid 保留 |
| 嵌入对话变体 | `agents/ModuleAgentPanel.jsx`、`shell/AIPanel.jsx` 的 `embedded` 变体，非模态 region；会话指针/草稿按项目目录分离 |
| 独立编辑器来源 | 同级 `../web-idea`：Monaco、文件树、轻量编辑、快速导航及可选 Java LSP；嵌入状态/开项目握手在其 `apps/web/src/embed.ts` |
| 本地 IDE 服务 | `server/modules/codes/ide-runtime.ts` 懒启动 Go gateway；`ide-router.ts` 同源静态页与配置；`ide-proxy.ts` HTTP/WS 代理；`server/index.ts` 负责装配和退出清理 |
| 安装构建与门禁 | `scripts/setup-web-idea.mjs`、`scripts/check-codes-ide.ts`；UI 纳入 `check-workbench-ui.ts`，项目绑定/真实SDK文件读写纳入 `check-module-agent-http.ts` |

接入说明与边界：`docs/architecture/codes-ide.md`。代码 Agent 在 `registry.ts` 注册，`config/agents/codes.yaml` 启用 read/grep/find/ls/edit/write；cwd 作为已保存工作区或历史会话目录的一致性断言。

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
| 所有 `scripts/check-*.ts` | 按旧路径 import 业务模块仍可用；源码文本断言应读取新目录的真实实现文件，不能只读兼容 re-export |
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
