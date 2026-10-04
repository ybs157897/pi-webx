# 模块 Agent 绑定项目验收

2026-10-03：各 Agent 的整个绑定工作区作为当前项目。参考 DSH 的 cwd 与项目指令分层，公共装配将绑定身份加入提示词，并仅加载绑定根的 AGENTS.md / CLAUDE.md / local 指令。

## 自动门禁

本轮已通过 `npm run check:workbench`、`npm run check:workbench-ui`、`npm run typecheck`、`npm run check:module-agents` 与 `git diff --check`。四份角色配置已通过运行中的 settings API 发布并读回，绑定目录和模型保留原值；新会话使用新 Prompt/Skill，旧会话保留原快照。

`npm run check:module-agents` 包含 `check-module-agent-project-context.ts` 和需求上下文回归。验证四个 Agent 各自绑定的真实 SDK 会话、项目身份与指令、根内多模块身份不变、空目录仍是项目、大小截断、符号链接与全局/父目录隔离、工具白名单保持配置范围。需求门禁还检查项目资料读取、requirements/ 投影只读、越界拒绝和历史工作区恢复。离线脚本只证明装配和工具接线，不用于声称真实模型的需求判断正确。

## 配置模型实测

命令：`npm run check:module-agent-project-live`。实际模型为 `cmdc/deepseek/deepseek-v4.1-flash`，保留真实角色 Prompt、Skill、工具及模型配置；业务数据库和工作目录使用临时隔离夹具。夹具复制当前绑定 deepseek-harness 的 AGENTS.md 与 README.md，不复制完整源码树。

输入原句：`我想要加一个贪吃蛇的小游戏到当前项目里`。

模型实际调用 skills_read、requirements_context、ls、read README.md，并明确回答：

> 绑定项目 deepseek-harness：Cordis 的“一切皆插件”agent harness；README 说明 Web UI 由 dsh web 启动。

模型如实说明夹具没有完整源码，然后只澄清游戏承载形态、用途与玩法；没有重复询问项目身份。结束 stopReason=stop，需求记录 0，待办 0。该实测覆盖绑定项目理解，未实施游戏或宣称其实现验收。

原始会话与工具记录由脚本保存在其打印的 LIVE_PROJECT_ARTIFACTS 临时目录；脚本不改真实业务库、工作区文件或模型凭据。
