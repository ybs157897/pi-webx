# 将个人工作台作为 pi-webx 默认页面

Status: implemented

## 决策与理由

从 `codex/workbench-sqlite` 创建独立分支，迁入 `ai-workbench` 提交 `de37b8c` 的十模块前端。默认 `/` 显示工作台，原有完整 Pi 界面保留在 `/chat`，带 `?session=` 的旧链接仍进入 Pi 界面。工作台直接复用本仓库的 `usePiSession` 与 API 客户端，模块记录走同一进程的 SQLite API。

## 放弃了什么

没有把 pi-webx 整套服务反向复制到 `ai-workbench`，也没有复用 pi-webx 里先前的三页练习原型。两者都会让前端或会话运行时出现第二份权威。Pi Agent 尚未注册工作台数据工具，页面如实显示这一边界。

## 复活条件

若需要 Pi Agent 直接读写模块记录，应在 pi-webx 中注册与 HTTP 接口共用 SQLite store 的受控工具，并为写操作定义确认与验收；不要解析模型回复来驱动数据库写入。
