# 群聊持续协作验收（2026-09-30）

实现分支：`codex/chatroom-persistent-work`，基于 `f0e701bf526cb51e4b0a12da3c9f2bc050afb915`，当前改动未提交。

## 验收范围

- 群记录、成员消费、协作任务、分工、Session、Run 与工具记录分别持久化；消息消费不自动完成任务。
- 真实离线 Pi SDK 验证同 Session 冷恢复，上一回合的工具结果仍在模型上下文；个人会话独立，旧群输入不重复注入。
- 六条慢代码消息积压时，日志 Agent 先完成，代码 Agent 始终单回合；广播某成员终态后，其后续点名输入可开始。
- 在真实 SDK bash sleep 中直接取消，无迟到公开回复；实际 write 已发生但结束账本未写入时重启，保留 needs_review，不自动重放。
- HTTP 版本、身份、幂等及人工核对经过验证：已取消任务核对后保持 cancelled，同话题普通讨论解除阻拦；成员进度变化也使旧任务版本失效。
- 模块精确索引验证旧日志在 650 个更新日志之后仍能查找；日志 header 和 Agent 身份不符时拒绝。

## 浏览器验证

`npm run dev:chatroom-fixture` 使用临时数据库、独立工作目录、真实 Pi SDK 与离线脚本模型。浏览器实际发送任务、补充继续验证并完成，数据库两条 Run 的 session_id 相同；文件通过 write/read 工具生成及读取。运行中的取消返回 cancelled，刷新后未发送正文与话题保留。390px 布局下文档宽度与 scrollWidth 均为 390，未出现页面横向溢出。新核对动作和多成员接收人选择另由 SSR/HTTP 门禁覆盖。

## 真实模型验证

运行 `PI_WEBX_CHATROOM_LIVE_TIMEOUT_MS=240000 node --import tsx scripts/check-chatroom-live.ts`，使用当前配置模型，隔离所有业务数据和文件。点名输入与广播输入均为 delivered，代码成员 consumed，其余广播成员 skipped；`mq-directed.txt` / `mq-broadcast.txt` 内容分别严格为 DIRECTED_OK / BROADCAST_OK，两项协作任务经显式状态工具 completed。

首轮在 120 秒验收预算内未完成广播收尾；文件已经写入。转录显示模型发布完成通知后又轮询其认领状态。提示词现明确先记工作状态，再由最终正文自动入群；实际交接才发送新消息，发送后不等待或轮询下游。重新验收点名约 36 秒、广播约 44 秒完成；最终产物记录 240000 毫秒的实际预算，未宣称任意长任务模型质量都已验证。

实时脚本打印 LIVE_ARTIFACTS，保留 result.json、consumption.log、SQLite 及 SDK 转录，可复查。生产回合默认预算十分钟；验收预算可配置，未改模型、凭据或生产目录。

## 检查命令

`npm run check:workbench`、`npm run check:workbench-ui`、`npm run typecheck`、`npm run check:module-agents`（包含 chatroom）、`npm run check`、`npm run build`。Windows AppContainer 的实际 Windows 运行检查在 macOS 按已有门禁跳过；本功能使用当前单宿主进程，不提供跨进程多写者调度或外部工具 exactly-once。
