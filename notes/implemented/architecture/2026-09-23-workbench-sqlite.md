# 工作台记录归 pi-webx SQLite 服务管理

Status: implemented

## 决策与理由

pi-webx 服务持有工作台 SQLite 数据库，默认路径为 `~/.pi-webx/workbench.sqlite`，可用 `AI_WORKBENCH_DB_PATH` 覆盖。七个数组模块与两个资料模块分别按记录存储；每条记录保留经工作台 schema 校验的 JSON 字段。SQLite WAL、完整同步和事务提交提供持久性，旧 JSON 可一次性导入，旧图片转换为 data URL 一同保存。

选择 `better-sqlite3`，因为 pi-webx 仍支持 Node 20，而 `node:sqlite` 不覆盖该版本。前端只使用 `/api/workbench`；Pi 会话仍由原有会话系统管理。

## 放弃了什么

没有继续使用浏览器 IndexedDB 或应用自带 JSON 服务，否则页面与 Pi Agent 会形成两份数据权威。也没有把整个工作台状态塞进 SQLite 的单个 JSON 行；按记录建表能让更新、删除与导入事务边界更清楚。

## 复活条件

若工作台需要复杂跨模块查询或大批量图片，应针对明确查询和容量证据增加结构化列、索引或独立图片 BLOB 表，并保留现有 API 契约与迁移路径。
