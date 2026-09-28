# AGENTS.md — pi-webx 仓库指令

给在本仓库工作的 AI 编码智能体（ZCode / Claude Code / 小台等）的纪律。当前分支以工作台为主。

## 这个仓库是什么

「AI 指挥台」工作台：React 前端（`src/workbench-app/`）+ pi coding agent 平台（`server/`）+ 本地 SQLite 工作台数据（`server/workbench/`）。

## 先看代码地图

找功能代码、了解目录职责、查哪些文件被门禁钉死（源码文本断言 / 带扩展名 import），先读 `docs/code-map.md`；新增或移动功能时同步更新它。改大文件前先看它的「文件体量约定」：原路径做 barrel、实现拆兄弟文件、引用方零改动。

## 必跑门禁（改完代码全绿才算完成）

- `npm run check:workbench` — SQLite 持久化 + HTTP 行为断言
- `npm run check:workbench-ui` — SSR 渲染真实 DOM，断言只认 `data-testid` 的 DOM 证据
- `npm run typecheck` — tsc --noEmit
- `npm run check:module-agents` — 模块 Agent：配置加载、知识隔离、SDK 装配收口
- 提交前跑全量链 `npm run check`；stderr 出现 `Error: 未知模块：unknown` 是门禁故意的 400 断言，不是失败。

## 硬规则

- `server/routes.ts` 有提交门禁会拦截，尽量别动它。
- 删改 `data-testid` = 破坏门禁；新增交互必须补 testid 并同步进 UI 门禁。
- 模块样式放各自 `modules/X.css`，类名带模块前缀，视觉令牌只取 `styles.css`。
- 渲染期不碰 `window/document`（SSR 门禁会跑纯渲染）；浏览器 API 进 effect 并加 `typeof window` 守卫。
- 提示词文件在 `server/prompts/`：`subagent/*.md` 逐字节冻结，改前读该目录 README 的同步规则；架构说明见 `docs/system-prompt-design.md`。
- 知识库接入协议见 `docs/workbench-knowledge-protocol.md`（写入契约与读/写口子）。

## 并行协作

这个工作树常有多个会话并行工作：动手前先 `git status` 并看目标文件的修改时间，别覆盖别人未提交的进行中改动；门禁红了先归因是不是别人的中间态，再决定修还是等。
