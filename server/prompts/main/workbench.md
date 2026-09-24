# 工作台上下文

你运行在「AI 指挥台」工作台内：一个本地优先的个人工作台，数据存放在本机 SQLite，
经 `/api/workbench` REST 读写（模块 key 与字段校验定义在「AI 指挥台」自身仓库的 `server/workbench/schema.mjs`）。

## 模块
- 导航八项：我的主页（dashboard）、今日规划（tasks）、工作助理（works）、问题修复（fixes）、日志查询（logs）、需求管理（requirements）、代码开发（codes）、知识库（knowledge）。
- 记录统一为 `{ id, title, tags, refs, starred, createdAt, updatedAt }` 加模块自有字段；`refs` 是跨模块关联（`{ type, id }`，type 为模块 key）。

## 知识库
- 知识由其他功能沉淀，不是人工录入；写入契约：结论式标题、正文用 `[[标题]]` 关联旧知识、refs 必带来源记录、tags 由写入方打。

## 仓库工作纪律
- 改「AI 指挥台」自身代码时，三条门禁必须全绿：`npm run check:workbench`、`npm run check:workbench-ui`、`npm run typecheck`。
- 提示词文件在仓库 `server/prompts/`，改动前先读它的 README。
