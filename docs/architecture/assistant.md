# 我的助理：待办与今天

「我的助理」是工作台里唯一的待办与日程入口：一份 `tasks` 待办、一个「今天」时间轴、一段常驻的
assistant 会话，三者同屏。侧栏只有一个入口（assistant），页面内是「今天 / 待办」两个页签；
对话列由 App 以节点注入，页签切换和对话收起不卸载会话、不丢草稿。

本文由原 `life-secretary.md`（生活秘书）与 `works-agent-planning.md`（工作助理）合并而来，
并记录 2026-09-29 的合并决策。

## 合并决策记录（2026-09-29）

**问题**：生活秘书（life）与工作助理（works）各自持有一份数据面，却共享同一批要处理的事：

- 排期字段两套：life 用 `tasks.plannedDate / startTime / endTime`，works 用 `works.scheduledDate / startTime / endTime`；
- 两套时段冲突校验互不感知——同一个人同一段时间可以在两个模块里被排两件事；
- 状态两份权威：works 的 `status`（todo/doing/done）与 `tasks.done` 各算各的；
- 用户要在两个入口之间自己决定「这件事算工作还是生活」。

**候选方案**：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A 保持两模块 | 加跨模块冲突校验、状态双向同步 | 两份权威状态永久存在，冲突校验只能靠互相调用，耦合面继续扩大 |
| B 合并为单模块（选定） | 只留 assistant；`tasks` 唯一待办、`plans` 统一草稿确认流；works 三态看板退役 | 需要一次性数据迁移与会话退役，但系统概念数下降 |
| C 只折叠 UI | 入口合一，数据面不动 | 冲突与双权威仍在，只是更难被发现 |

**决定的边界**：`tasks` 是唯一待办与完成状态（`done`）的权威来源；`plans` 是唯一草稿确认流
（生成不改待办，确认才整批写入）；works 的三态看板与 `works_schedule_entries` 绑定表退役，
`works` 记录按 `scheduledDate → plannedDate`、`status === 'done' → done` 并入待办。

**代价（接受）**：旧 life / works 会话不可恢复——`AgentId` 收缩为
`requirements | codes | logs | assistant`，`/api/module-agents/{works,life}/*` 一律 404；
迁移只保数据、不保会话与草稿。旧库（`works` 记录、`lifePlans`、`works_schedule_entries`）与旧导出
JSON 都并入 `tasks / plans`，迁移可重复执行、不重复建记录。

## 页面与事项

- **今天**（默认页签）：一天的安排 = 一根时间轴。有 `startTime` 的事项（不分固定/灵活）按时间
  升序进同一根轴，`fixed` 用实心锚点、`flexible` 用空心补位；相邻两件事之间空闲 ≥45 分钟画一条
  「空 X」呼吸缝，当前时刻线插在时间序里。没有 `startTime` 的进轴末「今天，时间待定（N）」小节。
- 概览四张独立组件卡同源派生：已排未完成件数与预计用时、待安排（未排期未完成）件数、空闲余量
  （整段跨度减去各带时段事项的时长，带时段项少于 2 件时不臆造数字）、当天完成 `n/m` 与进度条。
  日程时间轴单独成卡，遗留与候选是辅助卡；根据数据区实际宽度显示主次两列或单列。
- 轴外的两个默认折叠区：遗留（`plannedDate` 早于今天、且不是当前查看日）与候选（未排期未完成）。
  遗留可「安排到这天」或「暂不安排」，候选可「安排到今天」；空日自动展开候选并给引导。
- **待办**：快速捕获（`#标签`、`@明天`、`!高`）、范围筛选（全部 / 未安排 / 即将到期）、搜索，
  按紧迫度分为「已逾期 / 今天 / 稍后 / 已完成」四组，已完成组默认折叠；行内可安排今天、看详情、
  星标、改标题、删除。已完成不再占范围筛选档位。`originalText`（原话）只在详情弹窗
  「最初记录」里呈现，列表行不重复。
  顶部用独立统计组件展示全部待办的未完成、今天安排、已逾期、已完成数量；快速记录和分组列表各自成卡。
  搜索与来源筛选影响列表，概览始终标明全量口径。
- 需求导入、主页与知识来源的待办链接落到「待办」页签并保留来源筛选；内部切页签清掉来源。
- `due`（最晚何时完成）与 `plannedDate`（准备哪天做）互相独立；取消安排只清计划日期与时段，
  不改截止日，完成状态始终是同一个 `tasks.done`。
- 数据区占据页面主体；桌面对话栏贴齐最右侧，支持工具栏按钮、对话标题栏按钮和 Esc 收起。
  收起后数据区扩展到全部宽度；对话保持挂载，未发送草稿、在途回答和方案卡继续保留。
  工具栏显示当前会话的待确认数量；展开后将焦点送回输入框或待回答问题，收起后回到展开按钮。
- 窄屏（≤1000px）一次只显示事项或对话一列，首次进入优先展示数据；「对话」按钮也保留待确认数量。
- 以 Web 为设计与验收目标；刷新后沿用模块 Agent 的会话恢复机制。

## 能力与确认

`config/agents/assistant.yaml` 与 `config/agents/prompts/assistant.md` 统一维护身份、提示词与
工具白名单。assistant 拥有独立会话、工作目录与知识库绑定（`homeBinding: assistant`），
复用模块 Agent 的 SDK 装配机制；不指定模型时继承用户默认模型，工具面为四个 `assistant_*`、通用文件与命令工具（read/write/edit/bash/grep/find/ls）加两项 `chatroom_*`。

- `assistant_context`：读取服务器本地日期、时区、未完成待办与待确认建议，支持 `query/limit/offset`
  分页并如实返回截断信息；重新安排必须使用返回的最新 `updatedAt`。
- `assistant_capture`：把用户话里的事提取成待办，保留 `originalText` 原话；`(sessionId, entryKey)`
  固定绑定，重试不重复新建；没有明确日期不填 `due`，更不排期。
- `assistant_propose_plan`：把安排写成 `plans` 草稿（按 `sourceSessionId` 绑定会话），此时不改任何待办。
- `assistant_coordinate`：仅在当前群聊交接中依据研发显式回报的任务 ID 完成关联待办；需求 Agent 负责建待办并 @代码开发；校验来源和版本，不写排期。`chatroom_send/read` 用于交接通信，详见 [内部聊天室](internal-chatroom.md)。
- 对话列底部的方案确认卡（`PlanReview`）：展开后按天分组显示时段、时长与「为什么这么排」；
  「确认安排」调 `POST /api/workbench/plans/:id/apply`（带 `expectedUpdatedAt`），服务端在同一个
  SQLite 事务里校验并整批写入；版本过期或任一条失败整批回滚，界面给「方案已过期，请和助理重新
  确认一次」而不是静默重试。「取消建议」调 `DELETE /api/workbench/plans/:id`，只丢草稿。
- 只展示当前会话的草稿；同一会话有多份时用「另有 N 份建议」翻页；应用成功的卡片挂
  「已加入日程 · N 条」等用户收起。
- 助手只收集与安排，不承诺定时提醒、后台执行或日历同步；固定时间应得到保护，改固定安排走手动操作。

## 数据与工具边界

- 数据模块只有 `tasks`（待办）与 `plans`（安排建议），字段定义在
  `server/modules/tasks/schema.mjs` 与 `server/modules/assistant/schema.mjs`，由
  `server/workbench/schema.mjs` 聚合、纳入导出导入。
- 排期校验（`server/modules/assistant/validation.ts`）对 HTTP 写入、整库导入和 Agent 调用一致生效：
  时段成对出现且与计划日期同时填写、结束时间晚于开始时间、固定安排必须有完整时段、未完成事项的
  时段不能重叠；确认整批建议时先把这一批一起落到最终状态再逐条校验，所以同批交换时段不会被中间
  状态误判为冲突。
- 通用 CRUD 不得伪造方案与来源：`plans` 只能由 `assistant_propose_plan` 生成、只能经
  `/plans/:id/apply` 应用、只能经 `DELETE /plans/:id` 丢弃；普通记录 POST/PATCH 不接受客户端
  指定 `sourceSessionId`。
- 旧数据：`works` 记录、`lifePlans`、`works_schedule_entries` 在启动迁移中并入 `tasks / plans`
  （可重复执行），旧导出 JSON 的 `works / lifePlans` 键同样兼容；会话与草稿不迁移。

## 验收

- `npm run check:workbench-ui` 纳入 `scripts/check-assistant-ui.tsx`（SSR DOM：壳层页签与计数、
  时间轴与呼吸缝、时间待定、认知分组与折叠、方案卡与导航映射）与
  `scripts/check-module-agent-settings-ui.tsx`（四个模块 Tab，assistant 首位）。
- `npm run check:workbench` 纳入 `scripts/check-assistant-plans.ts`：收集幂等、草稿→确认→取消全链路、
  版本过期整批回滚、固定安排不被挪动、重复确认幂等、HTTP 写入口守卫、works/lifePlans 旧数据与
  旧导出兼容。
- `npm run check:module-agents` 纳入 `scripts/check-assistant-agent.ts`：真实配置加载与真实 Pi SDK
  装配（不联网、不调模型）、工具面恰为配置允许的 `assistant_*` 与 `chatroom_*`、独立工作目录、会话身份条目，
  works/life 的 HTTP 入口 404。
- 类型检查、完整 `npm run check` 与生产构建通过。

## 可重复浏览器验收

`npm run dev:assistant-fixture` 起隔离验收服务：独立临时数据库、独立配置与工作目录，模型回合由
脚本扮演（不访问网络），但工具调用、HTTP 与 SQLite 都是真的。默认 API 为 `127.0.0.1:18879`；
用 `PI_WEBX_ASSISTANT_FIXTURE_DIR` 指定隔离目录（同一目录可重启恢复）、
`PI_WEBX_ASSISTANT_FIXTURE_PORT` 换端口；前端以 `PI_WEBX_PORT=18879 npm run dev:web -- --port 15174 --strictPort`
连到它。启动日志会打印这一轮的两轮输入与预期结果。

2026-09-29 合并后复核记录：

- 新库与迁移库的 `npm run check`、`npm run check:workbench-ui`、`npm run check:module-agents`、
  `npm run typecheck` 全部通过。
- UI 门禁用真实 SSR 产物钉住：默认停在「今天」、页签计数为「当天未完成 / 未完成总数」、
  两件带时段事项之间出现呼吸缝、遗留与候选默认折叠但 DOM 保留、已完成组默认折叠、
  需求来源筛选只显示对应需求的待办、方案卡只认本会话草稿。
- 服务端门禁覆盖旧库迁移（works/lifePlans/绑定表）与旧导出导入，重复执行不重复建记录。
