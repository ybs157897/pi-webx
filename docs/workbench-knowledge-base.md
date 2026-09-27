# 知识库模块实现记录：双链笔记 + 问小台

> 2026-09-24，分支 `codex/ai-workbench-migration`，功能位于未提交的工作树改动中（与 `git diff HEAD` 对照读取，未落在任何 commit 上）。
> 本文只记录代码里真实存在的东西：每个结论给 `path:line`，每条检查给原始命令与输出。实现范围以本次任务点名的文件为界：`server/workbench/schema.mjs`、`store.ts`、`router.ts`、`src/workbench-app/modules/Knowledge.jsx`、`App.jsx`、`api.mjs`、`scripts/check-workbench-sqlite.ts`、`scripts/check-workbench-ui.ts`。同族的类型声明文件 `server/workbench/schema.d.mts` 同一批也被改（3 行），不进运行时但被 tsc 检查，单列在 §2 末。

---

## 1. 做了什么

### 1.1 模块形态：三栏笔记工作台

`knowledge` 落在两处注册表里，数字口径先在这里交代清楚：schema 侧 `ARRAY_MODULES` 一共 **12 个** 数组模块（`server/workbench/schema.mjs:8`：tasks、works、hotspots、exercises、meals、finance、reviews、fixes、logs、requirements、codes、knowledge），`knowledge` 是追加在末尾的第 12 个；其中 `hotspots / exercises / meals / finance / reviews` 5 个只存在于服务端与数据层，没有进左导航。导航侧 `App.jsx` 的 `MODULES` 注册表共 **8 项**（`src/workbench-app/App.jsx:45-54`）= 我的主页 + 7 个数据模块，`knowledge` 是第 8 项（`App.jsx:53`），把左导航的数据模块从上一轮的 6 个变成 7 个。另有 **2 个资料型模块** `pets`（宠物日记）/ `relationships`（亲密关系）（`schema.mjs:11`），形状是 `{ profile, records }` 而不是数组。所以「第 8 项注册」「第 12 个数组模块」「扫描 12 个 + 2 个原子模块」是三个不同口径，不冲突。前端是三栏布局（`src/workbench-app/modules/Knowledge.jsx:2-13`，容器 `data-testid="kb-split"` 在 `Knowledge.jsx:504`）：

- **左栏**（列表）：关键词搜索（标题 / 正文 / 标签同查，**前端本地过滤**，见下）、标签过滤（带计数）、按 `updatedAt ?? createdAt` 倒序的条目列表、新建入口、空态 + 灌演示数据入口（`Knowledge.jsx:505-616`）。本地过滤的实参是 `visible` 这个 `useMemo`（`Knowledge.jsx:333-340`）：对已经拉到前端的 data 逐条匹配，不发请求。它和服务端 `/search` 端点不是一条链路——后者是 `store.search()` 的全库 LIKE 检索（`server/workbench/store.ts:283-307`），调用方是 ⌘K 命令面板（`api.search`，`src/workbench-app/api.mjs:57`、`shell/CommandPalette.jsx:30`），§3.1 门禁里 search 断言查的是这条路（`check-workbench-sqlite.ts:85-91`）。数据量行为：整份 state 本来就一次全量拉取（`App.jsx:2-5` 注释），左栏搜索不新增请求，过滤成本 O(n) 落在浏览器每次按键上。
- **中栏**（编辑器）：标题输入、标签输入（逗号分隔，中英文都认）、正文编辑器、`⌘/Ctrl + S` 保存、编辑 / 预览切换（预览走 `AssistantMarkdown`）、加星、删除（带确认弹窗）、脏标记与字数脚标（`Knowledge.jsx:618-731`）。
- **右栏**（链接面板）：出链 / 反链两个分区 + 「问小台」按钮（`Knowledge.jsx:733-810`）。

两条通用约束：渲染期不碰 `window/document`——链接兜底 `computeLinks` 是纯函数，只读 `data` / `selected`，函数体（`Knowledge.jsx:248-285`）内没有 `window` / `document` 标识符，SSR 渲染期只有纯计算与 React 渲染；真正碰浏览器全局的只有两处且都进了 effect 并带 `typeof window` 守卫：链接拉取（`Knowledge.jsx:346-354`，守卫在 L348）与 ⌘S 监听（`Knowledge.jsx:357-371`，守卫在 L362）。所以这条约束对「SSR 不跑 effect」的路径同样成立：那部分渲染只跑纯函数。另一条：全部渲染值从 props 与 data 派生，选中条目与视图来自偏好 `kbSelectedId` / `kbView`（写失败只丢偏好，不打断操作，`Knowledge.jsx:399-407`）。

### 1.2 字段（服务端 schema）

`knowledge` 的可写字段（`server/workbench/schema.mjs:207-210`）：

| 字段 | 规则 | 出处 |
|------|------|------|
| `title` | 必填，非空字符串，trim 后最长 200 字 | `schema.mjs:56-58` |
| `body` | 可选，长文本，最长 50000 字，缺省 `''` | `schema.mjs:62-64` |

`tags`（≤8 个非空串，去重）、`refs`（`{type, id}[]`，≤20 条）、`starred`（布尔，缺省 false）三个通用字段由 `COMMON_FIELDS` 统一注入，`knowledge` 不重复声明（`schema.mjs:127-132`，注入循环 `schema.mjs:214`）。创建 / 更新都走 `validateFields`（更新为 `partial` 模式，只清洗给出的键），不合法抛中文错误（`schema.mjs:247-280`）。时间戳：`knowledge` 在 `STAMPED_MODULES` 覆盖范围内，addRecord / updateRecord 自动维护 `createdAt` / `updatedAt`（`server/workbench/store.ts:32`、`store.ts:191-195`、`store.ts:207-208`）。

旧数据兼容（导入路径，三步，按代码顺序）：① 每条记录跑一次全量 `validateFields(module, record)`——非 `partial` 模式内部确实会算一份带默认值的干净对象，但返回值被 `input(() => …)` 丢掉，这一步**只做校验**（`store.ts:89`）；② 落库的是 `structuredClone(record)` 克隆的**原始记录**，不是上面那份干净对象（`store.ts:92`）；③ 只有时间是 clone 之后单独兜底：缺 `createdAt` / `updatedAt` 且模块在 `STAMPED_MODULES`（`knowledge` 在列，`store.ts:32`）时补 `now`（`store.ts:93-96`）。所以「schema 默认值不落库」与「时间戳会补」同时成立、不矛盾：`tags` / `refs` / `starred` / `body` 这些 schema 字段默认值导入后依然缺失（服务端读接口 `/state` 原样返回，`store.ts:168-185`），由前端 `bodyOf` / `tagsOf` / `refsOf` 兜底为空值（`Knowledge.jsx:130-153`）；时间戳则是 `normalizeImport` 自己写死在 clone 上的兜底，不是 schema `default`，导入后一定有。本文口径：**「默认值」指 schema 层的字段默认值，「时间戳兜底」指 normalizeImport 的手写补写**，§4 未覆盖清单说的「不回填默认值」指前者、不含后者。

### 1.3 links 端点：双向链接查询

- 路由：`GET /api/workbench/links/:module/:id`，返回 `{ outgoing, incoming }`（`server/workbench/router.ts:32-35`）。它是具体路由，刻意排在 `/:module` 通配之前（同文注释 `router.ts:26`、`router.ts:32`）。
- 实现：`WorkbenchStore.links()`（`server/workbench/store.ts:309-347`）把 `workbench_records` 与 `workbench_atom_records` 两张表的记录一次全读进内存，出链 = 本条 refs 指向的、**仍存在**的记录（指向已删记录的引用不入列，`store.ts:336-341`）；反链 = 全库（含 pets / relationships 时间轴）里 refs 指向本条的记录（`store.ts:342-345`）。元素统一 `{ module, id, title }`（类型 `LinkEntry` / `LinkGraph`，`store.ts:16-17`），title 复用搜索的 `hitOf`（`store.ts:405-412`，认得 title/text/type/food/category，logs 用 text）。
- 错误路径：未知模块抛 `WorkbenchInputError`（status 400，`store.ts:62-66`、`store.ts:318`）。
- 前端：`api.links(module, id)`（`src/workbench-app/api.mjs:58`）在 effect 里按 selectedId / 保存后重拉（`Knowledge.jsx:346-354`）；未接线或请求失败时回落客户端 `computeLinks()`——客户端按同一规则扫 data：数组模块直接扫 `data[key]`，范围 `LINK_SCAN_MODULES` 就是 `schema.mjs:8` 那 12 个（`Knowledge.jsx:121-123`）；`pets` / `relationships` 是 `{ profile, records }` 形状，只扫 `.records`（`LINK_SCAN_ATOMS`，`Knowledge.jsx:124`），与 `store.links()` 读 `workbench_records` + `workbench_atom_records` 两张表的范围一一对齐（`store.ts:319-329`）。SSR（不跑 effect）时直接渲染本地推算结果，链接面板永远有内容。

### 1.4 [[双链]]解析

正文写 `[[标题]]`，保存时按 title 解析成 refs，全部在客户端 `Knowledge.jsx`：

1. `WIKI_PATTERN = /\[\[([^\[\]\n]+?)\]\]/g`：不跨行、不嵌套、不支持空标题（`Knowledge.jsx:166-167`）。
2. `parseWikiTitles(body)`：扫出全部标题，去重且保序（`Knowledge.jsx:174-181`）。
3. `resolveWiki(rows, title, selfId)`：title trim 后**精确**匹配（不做模糊，避免误链）；重名笔记全部命中（双链语义就该都指过去）；自己链自己跳过（`Knowledge.jsx:191-195`）。
4. `buildRefs(rows, body, selfId, keepRefs)`：解析出的知识库链接排在前面；记录里**手写**的跨模块 refs（指向任务 / 需求）原样保留；按 type+id 去重；总数截到 schema 上限 20（`Knowledge.jsx:206-222`）。

保存动作：`save()` 组装 `{ title, body, tags, refs }` 走 `api.patchRecord('knowledge', id, …)`，保存后 bump `linksToken` 让服务端链接图谱重拉（`Knowledge.jsx:418-452`）。脚标实时显示「N 个双链已解析 / N 个 [[标题]] 尚未解析」，解析不到的标题不落 refs（`Knowledge.jsx:374-383`、`Knowledge.jsx:722-727`）。

### 1.5 AI 问答接线（「问小台」）

- 模块侧：`askAboutNote()` 把当前草稿的标题 + 正文拼成 `【知识库笔记】…` 文本交给 `askAI`；`askAI` 缺省或类型不对时按钮禁用并换提示文案（`Knowledge.jsx:495-500`、`Knowledge.jsx:795-808`）。
- App 侧：`askAI` 展开面板、先落本地 pending 用户气泡再 `send`（`src/workbench-app/App.jsx:159-166`）；pi 接口不可用时 send 走失败路径，pending 气泡的留存 / 撤销由 `shell/AIPanel` 导出的纯函数 `nextAskState` 决策（发送在途 ≠ 面板被清空，`App.jsx:171-177`），错误文案换成人话 `AI_TEXT.askFailed`，pending 气泡排在错误条之前（`App.jsx:60-62`、`App.jsx:180-195`）。

正文长度：`askAboutNote` **不做任何截断**——标题 + 整篇正文（正文上限 50000 字由 schema 保证，`schema.mjs:62-64`）原样拼进 `【知识库笔记】…` 交给 `askAI`（`Knowledge.jsx:495-500`）。代码里没有上下文长度控制或成本控制，50000 字长笔记会整篇进发送链路，越界行为取决于 pi 侧——这一点列进 §4 未覆盖。

### 1.6 演示数据

`demoState()` 内置 **4 条** 知识笔记（`server/workbench/schema.mjs:455-489`，id 77a–77d）——不是「4 + 另 1 条」：「暗色模式落地」（77c）这一条的 refs 除互链外还同时引用需求 `11a` 与任务 `22a`（`schema.mjs:474-479`），另外 3 条（77a / 77b / 77d）是纯知识库互链。整个演示 state 里知识笔记就这 4 条，门禁断言同样是 `demoKnowledge.length >= 4`（`check-workbench-sqlite.ts:147`）。

---

## 2. 关键改动（按文件，行号为当前工作树）

### `server/workbench/schema.mjs`

- `L8` `ARRAY_MODULES` 追加 `'knowledge'`；`L31` `MODULE_LABELS.knowledge = '知识库'`。
- `L62-64` 新增 `FIELDS.body`（50000 字长文本校验器）。
- `L117-121` `FIELDS.refs`（`{ type, id }` 数组，≤20）；`L113-116` `FIELDS.tags`。
- `L207-210` `MODULE_SCHEMA.knowledge`：`title` 必填 + `body` 可缺省。
- `L214` `COMMON_FIELDS` 统一注入（tags / refs / starred）。
- `L455-489` `demoState()` 追加 4 条互链演示笔记。

### `server/workbench/store.ts`

- `L16-17` 新增 `LinkEntry` / `LinkGraph` 类型。
- `L309-347` 新增 `links(module, id)`：全表扫描算出链 / 反链，悬空引用不列入，unknown 模块抛错。
- `L361-379` `writePrefs` 偏好白名单新增 `kbSelectedId` / `kbView`（注释 `L363-366`：漏在白名单外会被静默丢弃，刷新后用户必然丢状态）。
- `L392-403` `refsOf` 助手：容忍旧数据缺字段或形状不符的 refs 项。
- `L405-412` `hitOf` 助手：一条记录的标题 / 摘要提取，links 的 title 与搜索共用。

### `server/workbench/router.ts`

- `L32-35` 新增 `GET /links/:module/:id`，排在 `/:module` 通配之前（`L26` 注释）。
- 同一批改动里 `/state` 附带返回 `prefs` 与 `empty`（`L17-20`），知识库用到两个字段：
  - `prefs` = `store.readPrefs()` 的已存偏好（`store.ts:350-359`），`kbSelectedId` / `kbView` 就在里面（`store.ts:369-371`）。
  - `empty` = `store.isEmpty()`（`store.ts:277-281`），语义是 `workbench_records` 表 `count(*) === 0`，即**整个库一条记录都没有**（首启场景）——它是全库级标志，不等于「knowledge 为空」。前端在 `App.jsx:142` / `L206` 读成 `snapshot.empty === true`，经 `App.jsx:367-368` 作为 `empty` / `onLoadDemo` 传进模块。Knowledge 的空态判定是双条件：自己一条笔记都没有（`rows.length === 0`，`Knowledge.jsx:517`）且 `empty === true`，才渲染「灌入演示数据」按钮（`Knowledge.jsx:523-536`，testid `kb-load-demo`）——即 §1.1 说的「空态 + 灌演示数据入口」；按钮经 `App.jsx:300-301` 调 `api.loadDemo()`（`api.mjs:60`）→ POST `/demo-data`（`router.ts:45-48`）。`empty` 误报为 true 但库里有记录时不许藏数据，这条双条件对主页有独立断言（`check-workbench-ui.ts:152-160`），知识库侧靠 `rows.length === 0` 的同款写法保证。

### `server/workbench/schema.d.mts`（类型声明，随实现同步改）

- `L1` `ARRAY_MODULES` 元组追加 `'knowledge'`；`L6` 新增 `demoState(now?: Date)` 声明（当前文件全文 11 行）。它不进运行时——实现是 `schema.mjs`——但 `tsc --noEmit` 会检查它（§3.3 的类型检查覆盖这两行）。

### `src/workbench-app/api.mjs`

- `L58` `api.links(module, id)`；`L59-61` `setPrefs` / `loadDemo` / `clearAll`；`L28-33` `unwrapPrefs`（拆 `{prefs:{…}}` 信封，防止写一个键冲掉其余偏好）。

### `src/workbench-app/App.jsx`

- `L24` 引入 `IconBook`；`L40` 引入 `Knowledge`。
- `L53` `MODULES` 注册 `{ id: 'knowledge', label: '知识库', desc: '双链笔记：标题、正文与 [[关联]]' }`——左导航 / 命令面板 / 移动端共用。
- `L68-73` `EMPTY_DATA`、`L99` `normalizeData` 的 `safeArray('knowledge')`：服务端还没这个模块键时不至于让页面崩。
- `L159-166` `askAI` 接线（含 pending 气泡先落）；`L171-177` `nextAskState` effect；`L180-195` `panelChat`（pending 气泡 + 友好错误插队）。
- `L369` 向 `ModuleView` 传 `askAI={askAI}`。

### `src/workbench-app/modules/Knowledge.jsx`（新文件，823 行）

- `L102-118` `LINK_LABELS`：`server/workbench/schema.mjs:17-32` `MODULE_LABELS` 的**手工副本**，理由见文件头注释「前端不 import 服务端代码」。这是一份双份维护的标签表：仓库里没有任何检查或测试钉两边一致（`check-workbench-sqlite.ts` / `check-workbench-ui.ts` 全文读过，无相关断言），服务端改了中文名，前端徽章会静默漂移——已列进 §4。`L121-124` 客户端扫描范围（含两个原子模块）。
- `L130-222` 数据兜底 getter + [[双链]]解析链（`WIKI_PATTERN` / `parseWikiTitles` / `resolveWiki` / `buildRefs`）。
- `L248-285` `computeLinks()`：客户端同规则链接推算。
- `L287-452` 组件主体：种子草稿模式（`L314-323`，照 Codes）、links effect（`L346-354`）、⌘S 单监听 + ref 保存（`L357-371`）、wikiLinks 脚标（`L374-383`）、`save` / `createNote` / `toggleStar` / `confirmDelete`。
- `L495-500` `askAboutNote`；`L502-821` 三栏渲染（testid：`kb-split` / `kb-item` / `kb-editor` / `kb-outgoing` / `kb-incoming` / `kb-link` / `kb-ask-ai` 等）。

### `scripts/check-workbench-sqlite.ts`（新增知识库断言段）

- `L103-117` 偏好白名单必须收 `kbSelectedId` / `kbView`。
- `L145-165` 演示数据：4 条互链笔记、正文 `[[标题]]` 全部可解析、至少一条引用任务 / 需求。
- `L167-187` `store.links()`：出链 / 反链与手工预期逐个比对、title 正确、记录不存在时反链空、悬空引用不入链。
- `L189-204` links 端点的 HTTP 行为（含 unknown 模块回 400）。
- `L206-224` 字段校验：title 必填、body 类型 / 上限、通用字段默认值、旧数据缺字段导入不丢标题、空值兜底。

### `scripts/check-workbench-ui.ts`（新增第 9、10 段）

- `L39-40` 引入 `Knowledge` 与 `AIPanel`；头部覆盖项说明在 `L18-21`。
- `L311-417` 第 9 段：三栏结构、未选中 / 选中 / 预览 / 旧数据 / 空库五种形态的 DOM 断言；出链含 [[解析]] 笔记与手写跨模块 refs、反链两个方向各两条；`askAI` 缺省与接线两形态；末尾按源码钉交互分支（⌘S、`buildRefs`、`api.links`、`typeof window` 守卫）。
- `L424-499` 第 10 段：问小台失败路径（pending 气泡保留笔记内容 + 人话错误条）+ `nextAskState` 状态机逐场景直测。

---

## 3. 门禁与验收结果

本节只写本次会话真实跑过的命令；输出为原始 stdout（exit code 单独标注）。

### 3.1 `npm run check:workbench`（SQLite + HTTP 门禁）——通过

```
$ npm run check:workbench   # 即 tsx scripts/check-workbench-sqlite.ts
exit=0
workbench SQLite: persistence, validation, import rollback and HTTP CRUD passed
workbench SQLite: common fields, timestamps, search, prefs (whitelist, kb keys, envelope) and demo data passed
```

stderr 有一条 `Error: 未知模块：unknown` 调用栈：这是 `check-workbench-sqlite.ts:203-204` 故意请求 `/links/unknown/x` 断言的 400 响应，express 把路由里抛出的 `WorkbenchInputError` 打到 stderr，同时按 `err.status` 回 400，断言通过（退出码 0）。不是失败。

### 3.2 `npm run check:workbench-ui`（SSR DOM 门禁）——通过

```
$ npm run check:workbench-ui   # 即 node --import ./scripts/check-bootstrap.mjs scripts/check-workbench-ui.ts
exit=0
workbench UI: knowledge module (three columns, wiki links, ask-ai) passed
workbench UI: 7 modules (widget board, capture, dual views, fix list, log dialogs, knowledge split, editor) + assistant markdown passed
workbench UI: AI panel ask-ai fallback (pending user bubble + friendly error + nextAskState) passed
```

第二行括号里 7 个描述一一对应脚本的分段：widget board = §1 我的主页、capture = §2 今日规划、dual views = §3 工作助理（看板/列表双视图）、fix list = §4 问题修复、log dialogs = §5 日志查询、knowledge split = §9 知识库、editor = §7 代码开发。唯一没被点名的是需求管理（§6 段），它的断言独立存在于 `check-workbench-ui.ts:246-277`——是日志字符串的取舍，输出没有被截断。

### 3.3 `npm run typecheck`（tsc --noEmit）——通过

```
$ npm run typecheck
exit=0（无输出）
```

`server/workbench/router.ts`、`store.ts`、`schema.d.mts` 的改动类型检查干净。这是顺带跑的（仓库既有验证通路也包含它，`docs/workbench-redesign.md:201`），本次任务点名的两个门禁是上面 3.1 / 3.2。

### 3.4 浏览器验收——未跑（知识库无截图证据）

本次会话没有对知识库跑浏览器验收，不存在可引用的通过结论。现存取证目录 `/tmp/pi-webx-audit/` 里的 `v2-light-*` / `v2-dark-*` 截图只覆盖 `App.jsx:46-51` 的前 7 项注册——我的主页（dashboard）、今日规划（tasks）、工作助理（works）、问题修复（fixes）、日志查询（logs）、需求管理（requirements）、代码开发（codes）——外加移动端、命令面板、设置；`knowledge` 是 `App.jsx:53` 的第 8 项，**没有它的截图**（这里「前 7 项」指导航注册表的前 7 项，与 §1.1 的「12 个数组模块 / 8 项注册表」是三个不同口径，不冲突）。`docs/workbench-redesign.md:217` 那句「全部门禁 + ego 截图通过」指的是不含知识库的上一轮。另外 SSR 门禁自己声明：⌘S、保存落库、[[解析]] 写 refs、问小台发送这些交互分支 SSR 不可达，只按源码钉过结构（`scripts/check-workbench-ui.ts:22-23`、`406`）。这两条叠加意味着浏览器回归点还没补。

---

## 4. 未覆盖与下一步

1. **知识库浏览器验收**：亮 / 暗 / 移动三态截图未拍（§3.4）。这是最直接的下一步——按既有流程 ego 起本地服务后对知识库三栏、选中态、预览态、保存后链接面板重拉各取证一张。
2. **交互分支只有源码断言**：⌘S 保存、保存后 links 面板重拉、链接点击跳模块、删除确认，都停留在 SSR 源码级核对，没有端到端证据。
3. **问小台无长度控制**：`askAboutNote` 把标题 + 整篇正文（schema 上限 50000 字）原样拼进发送文本，无截断、无上下文 / 成本控制（`Knowledge.jsx:495-500`、`schema.mjs:62-64`），超长笔记的行为取决于 pi 侧。要不要截断或先摘要，需要产品侧定，不是实现能单方面决定的。
4. **`LINK_LABELS` 双份维护、无一致性检查**：前端标签表（`Knowledge.jsx:102-118`）是服务端 `MODULE_LABELS`（`schema.mjs:17-32`）的手工副本，两个 check 脚本全文读过都没有钉两边一致的断言；服务端改中文名后前端徽章会静默漂移。最小兜底是在 `check-workbench-ui.ts` 里加一条「两边映射一致」的源码级断言。
5. **links 性能**：`store.links()` 每次请求全表扫 records + atom_records 并解析全部 payload 的 JSON（`server/workbench/store.ts:317-347`）。当前个人数据量无压力，但每保存一次重拉一次；记录量上万后要加索引或缓存（如 `workbench_records.refs` 反查表）。
6. **[[解析]] 只在前端**：schema 与 store 只校验 refs 形状，不经手 `[[标题]]` 文本；通过 AI 工具或直接写接口建 / 改笔记时，refs 不会自动解析，出链面板会空——除非调用方照 demoData 的形状手写 refs。
7. **导入不回填 schema 默认值**：`normalizeImport` 的 `validateFields` 返回值被丢弃、落库的是原始记录的克隆（`store.ts:89`、`store.ts:92`；时间戳兜底是另一回事，区分见 §1.2），所以 `body` / `tags` / `refs` / `starred` 缺字段的旧数据落库后依然缺，读接口 `/state` 原样返回无 `body` 键的对象（`store.ts:168-185`），兜底分散在 UI（`Knowledge.jsx:130-153`）。目前无实际问题，但任何新增消费方都得自己处理缺字段。
8. **重名全部指过去**：`resolveWiki` 对重名笔记全部命中（`Knowledge.jsx:191-195`）。这是明确的语义选择（双链都该指过去），但一个重名的标题会让多条笔记同时出现在出链里，属于「按设计如此」，不是待修缺陷。
