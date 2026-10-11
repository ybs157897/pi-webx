# 项目约定（自动落账，人工可改）

## 2026-10-10
- 判据：门禁全绿以提交内容为准（CI 跑 `npm run check`）；本机活配置不进仓库。

- 定了：本地桥全局安全面——Host 回环白名单 + 写请求 Origin 校验 + WS 握手同规则，先于一切路由与 JSON 解析（`server/security-middleware.ts`，门禁 `check-server-origin.ts`）。
- 定了：模块 Agent 配置归属两层——仓库 `config/agents/` 只读、机器无关默认；`~/.pi-webx/agents/`（`PI_WEBX_USER_CONFIG_DIR`）用户层按**字段级薄覆盖**（model/workspace/enabled/skills/tools + 提示词/Skill 同名文件影子，Skill 改动整目录影子保住 references 附属文件），设置页保存只写差异字段，一键恢复默认。
- 否了：用户层整份接管（会把提示词、工具白名单冻成拷贝，仓库演进穿不透）。
- 定了：`npm run check` 换并行 runner（`scripts/run-checks.mjs`，跑完全部再汇总失败）；全仓 `.gitattributes` 强制 LF。
- 定了：依赖修复只钉安全必需（MCP SDK 1.31.0、sharp 0.35.5、katex 0.18.11 override、shell-quote 1.12.0）；其余大件精确回钉原版（pi 1.0.0 / lobehub 5.47.1 / express 5.2.1 等），发布满 7 天再单独升。
- 未决：Windows CI 剩 6 项（agent-team AppContainer 预检 ×3、PowerShell Get-Acl 模块加载、MCP stdio fixture 连接即断、requirements-agent-context 路径形态）；pi-coding-agent 嵌套的 brace-expansion 5.0.9 受 npm override bug 所限暂留（直接依赖已钉 5.0.12）。

## 2026-09-30
- 判据：做完自己测试发消息，看日志和结果验证。

- 定了：群聊按话题和成员绑定会话，任务与运行状态分别保存。
- 否了：每条消息重建工作会话，消息消费成功就算任务完成。
- 定了：需求从首次保存到交付用唯一 ID 追踪，覆盖全部关联链路。
