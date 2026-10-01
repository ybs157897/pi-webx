# 代码地图（Code Map）

> 给人和 AI 的功能定位地图：想找某个功能的代码，先查这里。
> 维护纪律：**新增/移动功能时同步更新本文件**；它过期的那一刻就开始误导人。

更新日期：2026-10-01。生活秘书与工作助理已合并为「我的助理」：一份待办（tasks）、一根今天的时间轴、一套方案确认流（plans）；共九个导航入口，业务实现按模块目录归位。

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
 ├─ server/modules/             工作台领域字段与模块工具（tasks / plans / requirements / logs / knowledge …）
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
| 需求 Agent 提示词与方法 Skill | `config/agents/prompts/requirements.md` 保留身份、证据/授权边界与协作纪律；`config/agents/skills/requirements/product-requirements/` 的 `SKILL.md` 按需读取需求质量/规格、产物/交接参考，正文映射到 note + taskDrafts，由 `requirements.yaml` 显式挂载 |
| 契约（AgentId/AgentScope/配置/装配产物） | `server/module-agents/contracts.ts` |
| 统一加载器（逐文件隔离、Skill YAML 字符串/`{path,enabled}`、仅快照选中项、profileRevision 摘要） | `server/module-agents/profiles.ts` |
| 左侧 Agent 配置页的后端设置（GET/PUT、提示词/模型/Skill 正文编辑与目录导入、乐观并发、原子回滚） | `server/module-agents/settings/{router,service,validation,imports,persistence}.ts`；共享 HTTP 类型 `src/shared/module-agent-settings.ts`。`server/index.ts` 先挂设置路由，配置根可用绝对路径 `PI_WEBX_AGENT_CONFIG_DIR` 指向临时克隆；新对话使用新配置 |
| 模块独立工作区（默认目录、自定义绑定、真实路径与重叠校验） | `server/module-agents/workspace.ts`；YAML 可选 `workspace`，配置快照固定有效目录，新会话按绑定创建，恢复保留原目录 |
| 提示词 AI 润色（无工具单次模型调用、预览后应用、超时与取消） | `server/module-agents/settings/polish.ts`；复用 PiHost 模型配置与凭据，不创建会话或写配置 |
| 知识绑定表 + 受限 KnowledgeAccess | `server/module-agents/knowledge.ts` |
| 模块注册表（createTools 工厂，assistant + requirements + logs + codes） | `server/module-agents/registry.ts` |
| HTTP 入口 `GET /api/module-agents`、`POST /api/module-agents/:id/sessions` | `server/module-agents/router.ts`（`server/index.ts` 挂载，先于 `/api` 通配）；`session-service.ts` 共享用户/聊天室会话创建、快照恢复、工作区占用校验 |
| 日志领域工具（`logs_*`） | `server/modules/logs/index.ts` + `tools.ts`；`server/module-agents/logs/tools.ts` 仅兼容 re-export |
| 知识工具（`knowledge_*`） | `server/modules/knowledge/tools.ts`，经 `server/module-agents/knowledge.ts` 的 KnowledgeAccess 做服务端作用域校验与输出截断 |
| 装配纯函数（工具白名单过滤 + 校验 + MCP 连接装配） | `server/module-agents/assemble.ts`（router 与会话/MCP 门禁共用） |
| 数据源统一契约与适配器 | `server/data-sources/contracts.ts`、`registry.ts`、`workbench.ts`、`http-json.ts`、`mapping.ts`；接入说明 `docs/architecture/data-source-adapters.md` |
| 配置资源快照与受限 Skill 读取 | `server/module-agents/resources.ts`、`snapshots.ts`；文本可经 `skills_read` 读取，二进制配套资源以 base64 留存固定版本 |
| MCP 适配（envRefs/headerRefs 注入、工具桥接、dispose） | `server/module-agents/mcp.ts`；stdio fixture `scripts/mcp-fixture-server.ts` |
| 前端会话 hook（懒创建、双存储恢复指针、requestId 幂等） | `src/workbench-app/agents/useModuleAgentChat.jsx` |
| 前端面板（复用 AIPanel 外壳 + 能力卡） | `src/workbench-app/agents/ModuleAgentPanel.jsx`、`definitions.js`、`AgentCapabilities.jsx`；日志专属文案在 `modules/logs/agent-ui.js`（App.jsx 以 `agentPanel` 态与通用浮层互斥；日志页已对话化，`logs-agent-open` 侧挂入口退役） |
| 宿主收口点 | `HostedSession.moduleAgent`（`pi/host-contract.ts`）；装配/恢复/fork/reset 在 `host-session-assembly.ts`；`setToolSelection`（host.ts）、`set_tools`（host-commands.ts）、`refreshSubagentTool`（host-teams.ts）对模块会话短路 |
| 会话身份条目 | 日志自定义条目 `pi-webx:module-agent`（version 1，装配时写入会话日志） |
| Store 扩展入口 | `WorkbenchStore.searchKnowledge`（json_extract 按库过滤）/ `readKnowledge` / `listRecords` / `sqlite`（@internal） |
| 门禁 | `scripts/check-data-source-adapters.ts`（异构接口与插件）、`check-module-agent-http.ts`（幂等/并发/快照恢复）、`scripts/check-module-agent-profiles.ts`（A15）、`check-module-agent-knowledge.ts`（A05 服务端）、`check-module-agent-sessions.ts`（A01/A02/A09 服务端，真实 SDK 无模型调用）、`check-module-agent-mcp.ts`（A03/A04 服务端，stdio fixture 子进程） |
| 设置门禁 | `scripts/check-module-agent-settings.ts`（临时配置根、HTTP 编辑/目录导入、资源完整性、新旧 SDK 会话版本、路径/并发/写失败）；`check-module-agent-skill-settings.ts`（导入、编辑、二进制资源和越界/回滚）；`check-module-agent-prompt-polish.ts`（模型调用契约、错误、超时、取消）；`check-module-agent-workspaces.ts`（SDK 工作目录与新旧会话绑定）；`check-module-agent-workspace-settings.ts`（目录保存、冲突、重置、并发隔离） |

### 工作台（/，9 个导航入口）

| 功能 | 位置 |
| --- | --- |
| 模块导航定义（9 个） | `src/workbench-app/App.jsx` 的 `MODULES`：dashboard 我的主页 / assistant 我的助理 / fixes 问题修复 / logs 日志查询 / requirements 需求管理 / codes 代码开发 / chatroom 内部聊天室 / knowledge 知识库 / agent-settings Agent 配置 |
| 模块实现 | `src/workbench-app/modules/{dashboard,assistant,today,tasks,fixes,logs,requirements,codes,chatroom,knowledge}/`：各自 `index.jsx` 公开页面，专属 JSX、model、CSS 同目录；today / tasks 是 assistant 页签的内容组件；其余 `modules/X.jsx` 无业务逻辑，仅兼容旧 deep import。旧 `modules/{Tasks,Works}.jsx` 与 `modules/{life,works}/` 已随合并退役 |
| 日志查询（对话优先，2026-09 与需求管理同形态） | `modules/logs/index.jsx`（日志对话/日志记录页签 + 跨视图查询/记录按钮，弹窗挂根）、`LogsChat.jsx`（`useModuleAgentChat('logs')` + AIPanel，`supportsImages` 开）、`Landing.jsx`（首页三件套 + 快捷检索 chips）、`View.jsx`（密集结果表，保留 `logs-*` 旧 testid）、`Dialogs.jsx`（查询/记录/删除三弹窗）；布局在 `Logs.css`；`navigationTarget.selectedId` 直落记录视图 |
| Agent 配置页 | `src/workbench-app/modules/agent-settings/`：`index.jsx` 页面与离页草稿保护，`Editor.jsx` 组合编辑区，`WorkspaceEditor.jsx` 独立目录与系统原生文件夹选择绑定（复用 `src/lib/api.ts` → `POST /api/workspace/pick` → `server/directory-picker/`），`ModuleTabs.jsx` 模块卡片切换（四份注册 Agent：assistant / logs / requirements / codes，assistant 首位），`PromptEditor.jsx` 提示词编辑与润色预览，`SkillList.jsx` 勾选/详情/正文编辑/目录导入，`skill-import.js` 目录分组与上传编码，`useAgentSettings.js` 加载与保存；UI 门禁 `scripts/check-module-agent-settings-ui.tsx` |
| 外壳（侧导航/顶栏/AI 全屏对话浮层/命令面板/设置） | `src/workbench-app/shell/`（AI 对话展开后占据整屏、正文列居中，复用 /chat 的 `TranscriptView`；规范见 `docs/workbench-ai-chat-compact-mode.md`） |
| 模块对话输入框附件（图片 + 文本文件） | `shell/composer-attachments.mjs`（准入/转换/内联格式/卡片元数据 `attachmentBadge`，图片复用 `src/shared/attachments` 限额）+ `shell/AIPanel.jsx` 的 `supportsImages` 开关：回形针、粘贴、拖拽落点（`composer-drop` + 悬浮层）三个入口，文件以卡片展示（类型角标 + 文件名 + 类型标签）；`agents/useModuleAgentChat.jsx` 的 `send(text, attachments)` 把文本内联进消息、图片走 prompt 信封 `images`；借鉴 ZCode prompt-attachment 的「文本内联 + 注入防护」思路，PDF 等二进制暂拒 |
| 嵌入聊天（问小台） | `src/workbench-app/pi-webx/`（`useWorkbenchPiChat` 等） |
| 前端 API 客户端 | `src/workbench-app/api.mjs` |
| SQLite 存储与 HTTP | `server/workbench/store.ts`、`router.ts`；`schema.mjs` 保留 `ARRAY_MODULES`、公共校验和演示数据，`schema-fields.mjs` 放共享字段，`server/modules/<id>/schema.mjs` 放模块字段（`knowledgeBases` / `knowledgeFolders` 归 knowledge） |
| 知识库接入协议（读/写口子） | `docs/workbench-knowledge-protocol.md`；pi 侧工具 `extensions/pi-webx-knowledge.ts` |

### 系统原生目录选择器（/api/workspace/pick）

选择器跑在服务端宿主机上（`server/routes.ts` 的 `POST /api/workspace/pick`，连接断开即中止），前端只见 `{ path }`——取消是 `null`，宿主机没有选择器才是 501。

| 功能 | 位置 |
| --- | --- |
| 平台分发（barrel，引用方零改动） | `server/directory-picker/index.ts`：`pickNativeDirectory` / `DirectoryPickerUnsupportedError` |
| darwin / linux / 其他平台 | `native-picker.ts`：darwin 走 AppleScript `choose folder`（带 `default location`），linux 走 zenity → kdialog，都没有则报 `DirectoryPickerUnsupportedError`；`execFile` 直传 argv，不经 shell |
| win32（koffi + IFileOpenDialog） | `win32-driver.ts` 起子进程并映射 IPC 协议、用 WM_CLOSE 服务中止；`win32-worker.ts` 是子进程入口（阻塞在模态 `Show` 里）；`win32-bindings.ts` 是 koffi FFI（vtable 槽位、GUID、`SetFolder` 的 SHCreateItemFromParsingName）；`win32-dialog.ts` 是纯 COM 时序，注入绑定即可全平台测试 |
| koffi | `dependencies` 里的原生模块，只在 win32 子进程里被加载（父进程与门禁都不碰）；宿主机装不上就如实报错，没有 PowerShell 兜底档 |
| 门禁 | `scripts/check-directory-picker-win32.ts`：假 koffi 内存里跑完整 COM 调用序（含 GUID/槽位/有符号 HRESULT/内存释放）、driver 的中止协议与 kill 兜底、平台分发；非 Windows 上还会真起一次子进程验证 tsx + IPC 链路，并用真 koffi 钉住「地址解码得到字符串、buffer 解码得到自身字节」 |

### 需求对话与待办导入

流程、接口和验收边界见 `docs/architecture/requirements-workflow.md`。

| 功能 | 位置 |
| --- | --- |
| 菜单直达中央对话、历史记录切换、导入后跳待办 | `src/workbench-app/modules/requirements/index.jsx`；布局 `Conversation.css`；`Landing.jsx` 维护居中首页标题、输入工具栏与需求快捷入口，发送后回到消息布局 |
| 独立需求会话与草稿投影 | `modules/requirements/RequirementsChat.jsx`；复用 `useModuleAgentChat('requirements')` 与 `AIPanel`，按 `sourceSessionId` 过滤本次会话草稿，回合结束/恢复后刷新 SQLite 投影 |
| 原有需求列表、阅读和编辑 | `modules/requirements/Records.jsx`、`Reader.jsx`、`Dialogs.jsx`；保留旧 `req-*` testid |
| 确认导入弹窗 | `modules/requirements/ImportDialog.jsx`、`ImportDialog.css`；预览需求与待办、编辑/勾选、键盘焦点和错误反馈 |
| 需求领域工具与原子导入 | `server/modules/requirements/{tools,import-tasks}.ts`；`requirements_save_draft` 只保存草稿，`POST /api/workbench/requirements/:id/import-tasks` 显式确认、版本校验、整批事务、防重复 |
| 配置和结构化字段 | `config/agents/requirements.yaml`、`prompts/requirements.md`；`server/modules/requirements/schema.mjs` 维护 `sourceSessionId` / `taskDrafts`，导入标记由服务端写入 |
| 待办来源跳转 | `App.jsx` 的 `navigationTarget`、`shell/navigation.mjs`（tasks → assistant 的「待办」页签）、`modules/tasks/{index,model}.jsx`；导入后进入全部视图，任务 refs 回到对应需求记录 |
| 门禁 | `scripts/check-requirements-import.ts` 覆盖持久化/HTTP/事务/幂等；`scripts/check-requirements-ui.tsx` 与 `check-workbench-ui.ts` 覆盖真实 SSR DOM |

### 我的助理：待办与今天

产品契约、合并决策与验收方法见 `docs/architecture/assistant.md`。

| 功能 | 位置 |
| --- | --- |
| 入口壳层与「今天 / 待办」两页签 | `src/workbench-app/modules/assistant/index.jsx`（`AssistantWorkspace`）：页签、计数徽章与 tablist 键盘导航；`ChatDock.jsx` 管理最右侧对话容器及展开/收起按钮，隐藏保持会话挂载；`mobile-view.jsx` 传递展开动作和当前会话待确认数，窄屏「事项 / 对话」切换 |
| 常驻对话列 | `modules/assistant/AssistantChat.jsx`：`useModuleAgentChat('assistant')` + `AIPanel` 的 embedded 形态，`assistant-agent-chat` / `data-agent-id="assistant"`；写入工具指纹变化后回读数据 |
| 方案确认卡 | `modules/assistant/PlanReview.jsx`：挂在输入框上方的 dock，只展示本会话草稿；确认 `POST /api/workbench/plans/:id/apply`（带 `expectedUpdatedAt`，409 → 重新确认），取消 `DELETE /api/workbench/plans/:id`；展开区 `PlanEntries` 按天分组 |
| 待办视图（收集 / 分组 / 筛选） | `src/workbench-app/modules/tasks/`：`index.jsx` 组合快速记录卡与分组卡，`TaskOverview.jsx` 展示全量待办的未完成/今天安排/逾期/完成统计；`model.jsx` 快速捕获语法 `parseQuickAdd` 与认知分组；`server/modules/tasks/schema.mjs` 是待办字段真相源 |
| 今天视图（时间轴） | `src/workbench-app/modules/today/index.jsx`：日程主卡、遗留/候选侧卡；`TodayOverview.jsx` 四项同源概览。有 `startTime` 的事项按时间进轴，`fixed` / `flexible` 只分节点符号；≥45 分钟空档画呼吸缝，保留时间待定小节；布局随内容容器宽度切换 |
| 业务记录导航 | `src/workbench-app/shell/navigation.mjs` 把 tasks / today 数据链接折算到 assistant 的对应页签并保留需求来源筛选；`recordNavigationLabel('tasks')` = 「我的待办」。UI 门禁 `scripts/check-assistant-ui.tsx` 验证侧栏单入口与映射 |
| 独立身份与提示词 | `config/agents/assistant.yaml`、`config/agents/prompts/assistant.md`；工具白名单为 `assistant_context` / `assistant_capture` / `assistant_propose_plan` / 受限 `assistant_coordinate`、通用文件与命令工具（read/write/edit/bash/grep/find/ls），以及 `chatroom_send` / `chatroom_read`，独立会话、工作目录与知识库沿用公共装配机制 |
| 工具、草稿确认与排期校验 | `server/modules/assistant/{tools,service,validation}.ts`、`schema.mjs`：生成草稿不改待办，确认时事务内整批校验并写入（时段成对、结束晚于开始、固定安排需完整时段、未完成事项不重叠）；`plans` 只能经确认接口应用或取消 |
| 旧数据迁移与兼容 | `server/workbench/store.ts`：`works` 记录（`scheduledDate → plannedDate`、`status === 'done' → done`）、`lifePlans → plans`、`works_schedule_entries` 绑定表在启动迁移中并入，可重复执行；旧导出 JSON 同键兼容；旧 life / works 会话不迁移 |
| 门禁与隔离浏览器服务 | `scripts/check-assistant-plans.ts`（服务端全链路与迁移）、`check-assistant-agent.ts`（真实 SDK 装配、works/life HTTP 404）、`check-assistant-ui.tsx`（SSR DOM）；`npm run dev:assistant-fixture` 起离线模型 + 真实 SDK/SQLite 的隔离验收服务 |

### 需求生命周期全链路

| 功能 | 位置 |
| --- | --- |
| 同事务业务变更日志 | `server/workbench/mutation-journal.ts`：需求/待办 SQL triggers、一次历史基线、整批替换边界；在 Store 建表后、迁移前安装 |
| 根 ID、修订与审计投影 | `server/modules/requirements/lifecycle.ts` barrel，`lifecycle-{contracts,schema,journal,events,trace}.ts`：UUID/REQ 查询、内容修订、tombstone、时间线与对象关联 |
| 交付与明确审阅 | `lifecycle-deliveries.ts` / `lifecycle-router.ts`：证据、版本、真实 Run/工具、幂等及并发确认；原业务完成与正式接受分开 |
| 受限 Agent 追踪工具 | `lifecycle-tools.ts`：chatroom_trace / chatroom_delivery 由 assemble 注入并经统一 YAML 白名单；不能接受交付 |
| 群消息输入与执行根 | `modules/chatroom/trace-links.ts`：冻结消息/Run 的需求根与版本、跨根分叉来源、工具摘要、交接与失败/取消；`module-agents/failures.ts` 安全错误分类 |
| 全链路界面 | `modules/requirements/Trace{Drawer,Content,DeliveryForm}.jsx` / `Trace.css`：ID查询、时间线、证据提交、确认接受/退回、Session UUID关联与安全诊断；`TraceRequestScope.js` 约束异步请求归属、切换互斥和卸载后失效 |
| 验收 | `scripts/check-{mutation-journal,requirement-lifecycle,requirement-trace-runtime,requirement-trace-ui}.ts*`；`requirement-trace-fixture.ts` 共用真实 SDK 种子；`npm run dev:requirement-trace-fixture` 起隔离浏览器服务；live 脚本显式运行 |

详细协议见 `docs/architecture/requirement-lifecycle-tracing.md`。

### 内部聊天室（模块 Agent 通信）

产品与运行边界见 `docs/architecture/internal-chatroom.md`。

| 功能 | 位置 |
| --- | --- |
| 微信群式正文、输入、@与回复 | `src/workbench-app/modules/chatroom/`；侧栏/命令面板由 `App.jsx` 的 chatroom 注册项提供；按 seq 增量同步、watch 更新投递状态 |
| @ 成员语法 | `src/shared/chatroom-mentions.mjs`：前后端共享别名、目标校验与输入补全定位 |
| 独立持久消息与有界并行投递 | `server/modules/chatroom/{contracts,store,service}.ts`：独立 SQLite 表、身份盖章、幂等键、来源引用、认领记录（`claimants` 内部列）、循环上限、重启恢复；`consumption-store.ts` 存固定订阅者快照和逐成员消费确认，成功须有公开回复，终态防重复执行，部分失败可见；`service-input.ts` / `service-context.ts` / `service-provenance.ts` / `service-scheduler.ts` 收口输入与业务来源 |
| 模块公共通信工具与消息 API | `modules/chatroom/{tools,router}.ts`：`chatroom_send` / `chatroom_read`，`GET/POST /api/chatroom/messages`；`module-agents/assemble.ts` 按 YAML 白名单注入 |
| 唤醒真实模块 Agent 与广播认领扇出 | `modules/chatroom/runtime.ts` 是公开 barrel；`runtime-dispatch.ts` / `runtime-turn.ts` / `runtime-mailbox.ts`：共享 `module-agents/session-service.ts` 装配隔离 SDK 会话，忙时等待、创建/回合超时与退出清理；`runtime-prompts.ts` 负责正文提示词和严格 JSON 认领解析，判定阶段 SDK 禁用工具；订阅者先独立禁工具判断、认领后接续持久工作会话，逐成员 FIFO、跨成员并行；生产装配在 `server/index.ts` |
| 持续任务、分工与执行账本 | `modules/chatroom/work-{contracts,input,store,service,user-actions}.ts`：讨论绑定、协作任务、成员分工、Run、工具开始/结束与父交接，显式完成、中断核对、版本及幂等恢复/取消/单独核对；群记录公开任务投影，不公开私有 Session |
| 精确会话恢复 | `server/module-agents/session-index.ts`：持久登记 Session 路径、按 ID 查历史 header；`session-service.ts` 统一身份/配置快照检查，个人和群会话不依赖最近 200 条列表 |
| 话题与任务界面 | `modules/chatroom/TaskBoard.jsx`、`useChatroomContext.js`、`useChatroomTaskActions.js`：任务成员状态、继续/取消/核对后恢复，话题与草稿/请求幂等键跨刷新保存 |
| 助理交接领域工具 | `server/modules/requirements/dispatch.ts`：被点名的需求 Agent 原子建需求和待办并绑定引用；`server/modules/assistant/coordination.ts`：只按研发回报完成关联待办，事务/版本/身份检查，排期保持原确认流 |
| 门禁 | `npm run check:chatroom`：`scripts/check-chatroom.ts`（SQLite/HTTP/投递，`chatroom-check-fixtures.ts` 为接收回合消费确认夹具）、`check-chatroom-consumption.ts`（成员消费确认/HTTP watch/部分失败/重启）、`check-chatroom-coordination.ts`（真实业务写入边界）、`check-chatroom-runtime.ts` 与 `check-chatroom-persistent-runtime.ts`（离线真实 SDK 链路、持续会话、冷恢复、并发与取消）、`check-chatroom-work.ts`（工作记录/HTTP/中断核对）、`check-chatroom-ui.tsx`（SSR）；手动真实模型发消息验收为 `scripts/check-chatroom-live.ts`，输出临时消费日志与文件结果；`npm run dev:chatroom-fixture` 提供隔离浏览器服务 |

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
| `scripts/check-assistant-ui.tsx` | 读 `modules/assistant/PlanReview.jsx` 源码：确认动作带 `expectedUpdatedAt`、409 映射成「重新确认」；DOM 侧钉 assistant-* / today-* / tasks-* / task-* testid 与折叠默认态 |
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
- `docs/architecture/assistant.md` — 我的助理（待办与今天）的契约、合并决策与验收
- `docs/workbench-knowledge-protocol.md` — 知识库写入契约与读/写口子
- `docs/workbench-ai-chat-compact-mode.md` — AI 对话全屏浮层形态与简洁模式输出规范
- `docs/system-prompt-design.md` — 提示词分层设计
- `docs/workbench-redesign.md` — 工作台重塑的需求与决策记录
- `docs/tests/chatroom-persistent-work.md` — 群聊持续协作的门禁、真实模型与浏览器验收
- `docs/tests/requirement-lifecycle-tracing.md` — 唯一需求根、修订、执行、证据与正式接受的验收及模型实测限制
- `docs/tests/subagents.md` — 子智能体手测记录（历史口径）
- `docs/history/` — 迁移期归档（ALIGN-DSH-REFERENCE、FIXES-TO-PORT）
