# 需求全链路追踪验收

日期：2026-09-30。工作目录：`/Users/yin/.codex/worktrees/chatroom-persistent-work/pi-webx`，分支：`codex/chatroom-persistent-work`。本次未提交、推送或合并，原主工作树保持干净。

## 通过的验证

- `npm run typecheck`、`npm run check`、`npm run build` 和 `git diff --check` 通过。全量 check 包含 workbench、workbench-ui、module-agents 与 chatroom 门禁。构建仍提示已有的大块体积警告。
- 真实 SQLite/HTTP 覆盖直接 SQL、迁移、批量替换、事务回滚、一次历史基线、删除后查询、修订冲突、同时间戳歧义、交付幂等与并发审阅。
- 离线脚本模型经真实 Pi SDK 完成需求创建、待办导入、开发文件写入和 bash、助理完成待办、需求分工完成、提交证据、明确接受及冷重启重试。测试还覆盖三个需求根分叉、取消、失败工具、旧修订拒绝、替换 Session 后按逻辑任务聚合重试，以及安全失败分类。这证明运行器和持久化链路，不代表任意配置模型的编码质量。
- SSR 渲染真实 DOM，覆盖 UUID/REQ 入口、时间线、业务完成与正式接受的区别、历史版本、未知时间、证据表单、审阅确认、网络重试与敏感信息不进入公开页面。

最终审查补充的回归已通过：生产界面使用的 `TraceRequestScope` 通过延迟 Promise 验证提交互斥、卸载及 StrictMode 重激活后旧请求失效、迟到 GET 不覆盖新需求；HTTP 验证历史导入真实 ID 与 REQ 编号重名时的查询消歧和写入根隔离。含 `id:`/`req:` 的原始 ID 仍按字面量查询，复制使用真实 ID。这些边界采用定向脚本验证，未重复浏览器操作。

## 浏览器验收

运行 `npm run dev:requirement-trace-fixture`，使用上述真实离线 SDK 的结果，未手工构造成功 Run。Ego 空间 21 的 p1 完成桌面及 390px 验收后已关闭，隔离服务已停止。

- 「按 ID 追踪」在空入口可打开；`REQ-000001` 查询解析为 UUID。
- 需求 ID：`d4f0b718-d1f8-444d-a5f9-aa9ac9765287`。查看消息、待办、分工、Run、工具及证据的真实关联。
- 接受交付按钮后还有明确确认；确认后 trace stage 为 `delivered`，交付为 `accepted`，共 63 条事件，1 条审阅。
- 390px 时文档宽度与滚动宽度均为 390px，对话框宽 358px；Escape 能关闭对话框。
- 截图：`/tmp/pi-webx-requirement-trace-accepted.png`、`/tmp/pi-webx-requirement-trace-mobile.png`。退出时保存 `/tmp/pi-webx-requirement-trace-browser-result.json`。

## 当前配置模型实测未全程通过

显式运行 `scripts/check-requirement-trace-live.ts`，需求与代码阶段完成：开发 Agent 写入、读回并验证 `requirement-live.txt` 中的 `ROOT_CHAIN_OK`，提交交付证据。助理的 SDK 记录两次 `Stream ended without finish_reason`，随后回合 240 秒超时；没有助理业务工具调用，待办仍未完成，需求分工等待助理回报。全链路等待到期后脚本退出 1，接受仍被阻止。

未改模型、凭据或代理。此结果不能标为完整真实配置模型验收成功。失败日志 `/tmp/pi-webx-requirement-live.log`，保留的追踪与文件目录 `/private/var/folders/gl/fpk3jftx5y50txjpk1k7zr280000gn/T/pi-webx-requirement-live-otKQod`。后续需在流中断问题解决后重新执行这个显式门禁。

协议见 [需求全生命周期追踪](../architecture/requirement-lifecycle-tracing.md)。
