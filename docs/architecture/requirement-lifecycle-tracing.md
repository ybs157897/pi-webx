# 需求全生命周期追踪

唯一业务根为 `requirements.id`（requirementId），首次保存需求草稿生成，此后修改、导入待办、派工、重试与交付不更换。新需求使用 UUID，历史或导入需求保留其原始 ID；规范关联始终使用真实 ID。`REQ-000001` 是同数据库内可读编号。原始 ID 与展示编号重名时，普通查询拒绝歧义，可用 `id:原始ID` 或 `req:编号` 明确指定。普通无关对话不强行生成需求。

## 生命周期与身份

需求内容修订 `requirementVersion` 独立于更新时间及会话 ID。title、note、priority、taskDrafts、refs、tags 改变时递增；星标、业务状态、导入标记等元信息也完整记录，但不使旧交付失效。删除及整批重导入产生新的修订，旧根与审计保留。时间戳映射若有歧义，旧客户端必须读取当前数字修订后再交接。

- 原始需求 → 业务待办 refs / importedTaskIds → 协作任务 → 每个 Agent 的分工 → 独立 Session → 单次 Run → 工具 → 交接 → 交付证据 → 人工审阅，全部以根 ID 关联。
- 输入消息及 Run 冻结根 ID 和数字修订，不因后续需求修改而改写。需求生成前已经发生的活动回填根关联及原时间，但其输入修订仍为 unknown。
- 同一话题创建新需求是显式分叉：旧消息和 Run 留在旧根，新根记录来源根、消息与父 Run；新交接和执行属于新根。不会把旧根的输入或证据静默搬到新根。
- 重试保留所有尝试。尚未认领也保存明确的协作任务引用；最新结果按 Agent 与逻辑任务聚合，不按可替换的 Session 聚合。

`draft / ready / developing / verifying / delivered / needs_review / cancelled / deleted` 是追踪投影。业务 task done、协作 completed、Run succeeded、证据 submitted、用户 accepted 是不同事实。delivered 只在当前内容修订已被明确接受且当前执行条件满足时显示；人工接受会在同一事务中将原需求业务状态置 done（元信息操作）。历史接受记录不随后续修订删除，也不会自动算新修订已接受。

## 数据与边界

`server/workbench/mutation-journal.ts` 安装需求/待办的 SQLite INSERT/UPDATE/DELETE 触发器。直接 SQL、批量导入、迁移、安排应用及普通 HTTP CRUD 都进入同事务变更日志；失败事务不会留下假事件。整批替换有 dataset_replaced 边界。旧数据只建立一次历史基线，原始事件时间未知，不伪造过去发生的步骤。

`server/modules/requirements/lifecycle-*` 以日志重建根、修订、时间戳映射、对象关联、时间线、交付及审阅。`server/modules/chatroom/trace-links.ts` 在既有写事务内记录消息、任务、Run、工具、交接、取消、核对与版本拒绝。原始 SQLite/SDK 数据仍是对应实体的事实源，链接不能替代不存在的实际 Run 或工具记录。

工具只记录名称、ID、状态、结果 SHA-256、字节数以及可确定的 bash 退出码；不复制原输出、参数、推理、令牌或凭据。Run 错误展示已分类的安全摘要。需求来源 Session 可能讨论多个需求，关联不意味着该会话所有内容都属于一个需求；界面只复制真实 UUID，不展开私有上下文。

## 查询与交付

- `GET /api/workbench/requirements/:id/trace` 接受真实 ID 或 REQ 编号，返回根/修订/stage、覆盖警告、事件、任务/分工/Run/消息/工具关联、交付及阻塞原因。可选 `lookup=id|human|auto`（默认 auto），自动查询遇到原始 ID 与编号冲突返回 409；id 只查真实 ID，human 只查展示序号。交付及审阅写入路径只使用返回的真实 ID。
- `POST /api/workbench/requirements/:id/deliveries` 接收 `{entryKey,expectedUpdatedAt,expectedRequirementVersion,summary,evidence,runIds?}`。evidence 包括 file/commit/pull_request/test/report 的引用，可关联 runId/toolCallId。外部引用是提交者报告；observed 仅表示有关联的成功工具记录，不自动证明引用或测试结论真实。
- `POST /api/workbench/requirements/:id/deliveries/:deliveryId/review` 接收 `{decision:accept|reject,entryKey,expectedUpdatedAt,comment?}`。这是明确用户操作，SDK 无接受工具。必须是当前需求修订、实际成功 Run、完成的业务待办与成员分工、无未核对或进行中执行；冲突拒绝并要求重新确认。
- `chatroom_trace` 仅可读当前交接根，或需求 Agent 自己保存的需求；`chatroom_delivery` 从当前可信上下文推导根与版本，不能伪造另一个根。新工具统一经 config/agents YAML 白名单装配。

需求工作区既可从详情打开追踪，也可在无任何记录时用「按 ID 追踪」查询删除后保留的审计。时间线按实际时间排序，同时间使用 seq，未知基线明确标未知。接受交付有明确确认；保存成功与列表刷新失败分开，不因网络重试重复提交。

## 验收

`check-mutation-journal.ts`、`check-requirement-lifecycle.ts`、`check-requirement-trace-runtime.ts`、`check-requirement-trace-ui.tsx` 已接必跑门禁。完整真实离线 SDK 正链、三个根的分叉、重启、修订、取消/失败及元数据/HTTP边界可重复验证。`npm run dev:requirement-trace-fixture` 提供真实 SDK 种子的隔离浏览器验收。

`check-requirement-trace-live.ts` 是显式运行的真实配置模型验收，所有记录与文件在临时目录。此次实测需求与代码阶段完成、证据 submitted；助理连续出现 `Stream ended without finish_reason` 后回合超时，未达到完整交付。未改模型、代理或凭据，也未把此实测标为成功；追踪保留失败与阻塞，不能接受未完成链路。成功正链由真实 SDK 离线脚本模型及浏览器人工确认路径验证，不据此承诺任意模型编码质量。
