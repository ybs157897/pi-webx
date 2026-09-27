# 知识库接入协议（knowledge v1）

> 2026-09-24，分支 `codex/ai-workbench-migration`。协议版本 v1，适用 knowledge 模块的全部读写消费方。
>
> 与 `docs/workbench-knowledge-base.md`（实现记录，记"代码现在长什么样"）的分工：本文只管**接入契约**——任何功能想把知识写进来、读出去，遵守本文即可，不需要读 Knowledge.jsx 的实现。两者冲突时以代码与门禁（`scripts/check-workbench-sqlite.ts`）为准，并回改本文。

## 0. 设计前提

知识库的内容**不是人工录入的**，而是其他功能的沉淀副产物（需求结论、问题修复经验等）。因此协议围绕三个原则设计：

1. **写入口子必须自足**：写入方只给 `title` + `body` 就能得到完整双链，`[[标题]] → refs` 的解析由服务端负责（§5 R3），不要求写入方理解 refs 结构。
2. **结构自动推断**：不设目录树、不要求人工分类。知识的组织维度（来源、标签）全部由写入方在写入时带出。
3. **来源可溯**：每条知识通过 `refs` 指回产出它的记录（需求/修复/日志…），展示层据此渲染来源徽标与溯源跳转。

明确不做（v1 范围外）：审核/确认状态、树形目录、图谱视图、沉淀自动接线（各功能自行按本文接入）。

## 1. 架构总览

```
写入方                          读取方
├─ 功能代码（需求/修复流程）     ├─ Knowledge 模块 UI（三栏）
├─ pi 扩展工具（knowledge 工具） ├─ 命令面板（⌘K 全局搜索）
└─ 任何 HTTP 客户端             └─ 未来功能（按本文读接口消费）
        │                              │
        ▼                              ▼
┌────────────────── workbench REST（协议面）──────────────────┐
│  写：POST/PATCH/DELETE /api/workbench/knowledge[/:id]        │
│  读：GET /state · GET /search?q= · GET /links/:module/:id    │
└──────────────────────────────────────────────────────────────┘
        │ store：R1 校验 → R2 时间戳 → R3 [[标题]]→refs 解析
        ▼
   SQLite workbench_records（knowledge 行，payload JSON）
```

分层职责：

| 层 | 职责 | 代码位置 |
|---|---|---|
| REST 路由 | 协议面：路由、信封、错误码 | `server/workbench/router.ts` |
| store | 校验（R1）、时间戳（R2）、`[[解析]]`（R3，待落地） | `server/workbench/store.ts` |
| schema | 字段校验器与默认值 | `server/workbench/schema.mjs:207-210` + `COMMON_FIELDS`（L128-132） |
| pi 扩展工具 | 把 REST 包成模型可调用的 `knowledge` 工具（§6，待落地） | `extensions/pi-webx-knowledge.ts`（新） |
| UI | 三栏展示与人工修订（协议的普通消费方） | `src/workbench-app/modules/Knowledge.jsx` |

## 2. 知识记录协议（v1 字段表）

一条知识 = `workbench_records` 表中 `module='knowledge'` 的一行，payload 形状：

| 字段 | 规则 | 必填 | 协议约定 |
|---|---|---|---|
| `title` | 非空字符串，trim 后 ≤200 字 | 是 | **一句话结论式标题**（C1）：写"XX 场景用 YY 方案"，不写主题词。机器写入的知识没有人在旁边补上下文，标题必须自带答案 |
| `body` | 字符串 ≤50000 字，markdown | 否（缺省 `''`） | 支持 `[[标题]]` 双链语法（不跨行、不嵌套）；用 `[[已有笔记标题]]` 关联旧知识（C2） |
| `tags` | 非空字符串数组，≤8 个，写入自动去重 | 否（缺省 `[]`） | 由**写入方**打（C4）：来源模块名 / 类别（如 `修复`、`需求` + 产品线）。知识库 UI 只做人工修订，不承担新建标签体系 |
| `refs` | `{ type, id }[]`，≤20 条 | 否（缺省 `[]`） | **来源契约**（C3）：至少一条指向产出本知识的记录，`type` 是模块 key（`requirements` / `fixes` / `logs` / …，词表 = `schema.mjs:8` 的 `ARRAY_MODULES` + 两个原子模块），`id` 是该记录 id |
| `starred` | 布尔，缺省 `false` | 否 | 人工加星，协议不消费 |
| `createdAt` / `updatedAt` | ISO 时间戳 | 服务端维护 | 调用方传入无效，写入时自动刷新（R2） |

缺字段兜底：v1 之前落库的记录可能没有 `body` / `tags` / `refs` 键（导入路径不回填默认值，见实现记录 §1.2），**消费方必须按空值处理**，不得假设键存在。

## 3. 写入口子（REST）

唯一写入口，不做第二套写入路径：

| 动作 | 端点 | 请求体 | 成功返回 |
|---|---|---|---|
| 创建 | `POST /api/workbench/knowledge` | `{ title, body?, tags?, refs? }` | `{ record }`（含服务端生成的 `id`） |
| 修改 | `PATCH /api/workbench/knowledge/:id` | 任意字段子集（partial，只清洗给出的键） | `{ record }` |
| 删除 | `DELETE /api/workbench/knowledge/:id` | — | — |

错误语义：字段不合法回 `400` + 中文错误信息（如 `知识库数据不合法：title 是必填项`），未知模块同样 `400`。前端 `mutate()` 会把 `payload.error` 直接展示，所以**错误信息就是给写入方开发者看的文档**，措辞保持人话。

服务端职责（写入时依次执行）：

- **R1 校验**：`validateFields('knowledge', fields)`（已有，`schema.mjs:248-280`）。
- **R2 时间戳**：`createdAt` / `updatedAt` 自动维护（已有，`store.ts:191-208`）。
- **R3 `[[标题]]` 解析**（**本协议新增的实现要求，待落地，见 §8 P0a**）：payload 含 `body` 时，服务端在写入路径上解析 `[[标题]]` 并合并进 refs。规则与前端现有实现逐条对齐（`Knowledge.jsx:166-222`）：trim 后精确匹配、重名全部命中、自链跳过、解析不到的不落 refs；解析出的 knowledge refs 排在前面，**手写的跨模块 refs 原样保留**，按 type+id 去重后截到 20。PATCH 语义：只改 `title` / `tags` / `starred` 时 refs 不动；含 `body` 时以新正文整体重解析。幂等性：前端 `buildRefs` 的产出再过一遍 R3 结果不变。

写入方注意事项：

- **防重复沉淀是写入方的责任**：协议不做标题去重（重名合法，双链语义全指）。写入前可先走 §4 检索确认是否已有同类知识，命中则 `PATCH` 追加而非 `POST` 新建。
- 修改 `title` 后，其他笔记正文里的 `[[旧标题]]` 不会自动改写——与现状一致，已知行为，不视为缺陷。

## 4. 读取口子（REST）

| 需求 | 端点 | 说明 |
|---|---|---|
| 全量读取 | `GET /api/workbench/state` | `data.knowledge[]` 一次拉全。个人数据规模下的既定架构（`App.jsx:2-5`），协议不做分页 |
| 关键字检索 | `GET /api/workbench/search?q=` | 全库 LIKE 检索，返回 `SearchHit[]`（`{ module, id, title, snippet }`，标题命中优先，`store.ts:285-309`）。**知识库专用检索 = 按 `hit.module === 'knowledge'` 过滤**，v1 不加模块参数，保持最小协议面 |
| 出入链查询 | `GET /api/workbench/links/knowledge/:id` | `{ outgoing, incoming }`，元素统一 `{ module, id, title }`；指向已删记录的悬空引用不入列（`store.ts:309-347`）。这是"知识 ↔ 需求 ↔ 修复"溯源网络的数据源 |

读取方一律从 §2 字段表 + 缺字段兜底出发消费，不依赖 UI 层的 `bodyOf` / `tagsOf` 等私有兜底函数。

## 5. 工具协议（AI 接入面）

AI 会话（小台 / 子智能体）通过 pi 扩展工具接入，**工具只是 REST 的包装，不引入第二套语义**：

- 新扩展 `extensions/pi-webx-knowledge.ts`，照 `extensions/pi-webx-todo.ts` 的既有模式注册 `knowledge` 工具：TypeBox 参数、`promptSnippet`、`promptGuidelines`、校验失败走 content 文本不抛异常、`details` 回传结构化结果。
- 工具动作（一个工具，四个 action）：

| action | 参数 | 语义 |
|---|---|---|
| `search` | `{ q, limit? }` | §4 检索，工具层过滤 `module==='knowledge'`，返回命中列表 |
| `read` | `{ id }` | 单条全文（含 tags / refs / 时间戳） |
| `create` | `{ title, body?, tags?, refs? }` | §3 创建；四条写入契约写进 `promptGuidelines`，模型不读文档也守约 |
| `update` | `{ id, title?, body?, tags? }` | §3 修改 |

- 传输：扩展内 HTTP 调 workbench REST。基址读环境变量 `PI_WEBX_WORKBENCH_URL`，缺省 `http://127.0.0.1:8790`。部署方式与 todo 扩展相同（复制进 `~/.pi/agent/extensions/`）。
- 为什么包一层工具：REST 错误信息 + 契约在参数描述里人话化，模型调错时能自我修正；同时避免模型直接拼 HTTP 请求。

功能代码（非 AI）不走工具层，直接按 §3 / §4 调 REST 即可——同进程代码也可以 import `WorkbenchStore`，但**协议面以 HTTP 为准**，跨进程行为（端口、重启、并发）只在 HTTP 语义下有定义。

## 6. 展示层对接（消费方参考实现）

Knowledge 模块对协议的消费全部是**只读 refs**，不需要新字段。展示形态为 PandaWiki 式两态（2026-09-24 定稿）：

- **首页态**：大搜索框（输入即过滤）+ 标签 / 来源筛选 chips + 最近知识卡片网格；卡片渲染来源徽标（聚合 `refs[].type`）与摘要。
- **阅读态**：左栏目录（按主要来源分组）+ 右栏阅读工作区——标题、来源条（`refs` 渲染成可跳转的「沉淀自：需求「XXX」」）、markdown 预览（默认视图）、出链 / 反链分区；编辑是阅读页上的一种视图（`kbView` 偏好，默认预览）。
- 修改入口：编辑视图的标题 / 标签 / 正文 + ⌘S 保存，走 §3 的 PATCH。

## 7. 反模式（接入方不要做）

1. 不要绕过 REST 直接写 SQLite——R1/R2/R3 全部失效。
2. 不要在 refs 里发明新 `type`（词表是模块 key，不是自由标签）。
3. 不要用 `tags` 承载结构化语义（状态、优先级）——那是来源记录自己的字段，知识条目只做检索维度。
4. 不要假设 `[[标题]]` 解析在写入方完成——服务端 R3 落地后，写入方写正文即可；但 R3 落地前的过渡期，走 REST 的写入方如需出链要自带 refs（与演示数据 `schema.mjs:455-489` 同形状）。

## 8. 实施顺序

| 优先级 | 事项 | 位置 | 状态 |
|---|---|---|---|
| P0a | R3：`[[标题]]`→refs 解析下沉服务端 + 门禁断言 | `store.ts` + `check-workbench-sqlite.ts` | ✅ 已实施（2026-09-24） |
| P0b | 本协议文档 | `docs/workbench-knowledge-protocol.md` | 本文 |
| P1 | 展示层对接（PandaWiki 两态：首页搜索卡片 / 目录+阅读） | `Knowledge.jsx` + `Knowledge.css` | ✅ 已实施（2026-09-24） |
| P2 | `knowledge` 工具扩展 | `extensions/pi-webx-knowledge.ts`（新） | 待实施 |
| 暂缓 | 沉淀自动接线（需求/修复完成时写入） | 各功能模块 | 等功能方按本文接入 |
| 不做 | 审核/确认状态、树形目录、图谱视图 | — | v1 范围外 |

## 9. 演进规则

- v1 字段**只增不改不删**；新增字段必须可选且带默认值，旧消费方零改动。
- `refs.type` 词表跟随 `MODULES` 自动扩展，不单独发版。
- 破坏性变更（改字段语义、删字段）升 v2，并在本文追加迁移章节；协议版本号写在文首。
