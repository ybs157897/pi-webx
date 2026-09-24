# 任务模式对齐 dsh：整表替换的 todo 工具 + 停靠任务面板 + 权限菜单去命令清单

Status: implemented

## 起因（用户四张截图）

| 图 | 现状 | 要的 |
|---|---|---|
| 图1 | dsh 的任务面板：头部「任务 2 已完成 · 1 进行中 · 2 待处理」+ 三态字形列表，停在 composer 上方 | 目标态 |
| 图2 | pi-webx：「待办事项 3/3」+ `☑ #1 …` 的**代码块 widget** | 改成图1 的面板 |
| 图3 | 权限菜单每档下面多一行命令清单（`read / grep / find / ls`） | 与 dsh 一样不显示 |
| 图4 | 一次「写三个小故事」= 3 行 `todo {"action":"add"}` + 3 行 `todo {"action":"toggle"}` | 一行、一批 |

## 图4 的根因（可复现，不是渲染问题）

生效的 pi 扩展是 `~/.pi/agent/extensions/pi-deck-todo.ts`（不在本仓库），它注册的
`todo` 工具参数是 `{action:'list'|'add'|'toggle'|'clear', text?, id?}` —— **一次调用
只能加一项或勾一项**。模型要表达「三个任务」这个状态，就只能调三次 add；做完再调三次
toggle。面板于是必然出现 6 行、还分两批。

真实会话统计（同一任务、同一个模型）：

- 改动前（pi-deck-todo）：`todo` 调用 **6 次**，actions = `['add','add','add','toggle','toggle','toggle']`，整表调用 **0 次**。
- 改动后（pi-webx-todo）：`todo` 调用 **2 次**，每次参数都是完整的 `todos` 数组（先建表并标 `in_progress`，再整表更新为完成），逐项调用 **0 次**。

结论：这不是 UI 该修的（把 6 行合并成 1 行是在掩盖协议问题），而是**工具契约**该修的。
dsh 的做法正是如此：`todo_write` 每次调用提交**整张表**，替换上一张，UI 只读最后一张快照
（`deepseek-harness/packages/todo/tool-todo/src/index.ts`：*"Send the ENTIRE list every
call — it REPLACES the previous list"*）。

## 决策

1. **工具契约照 dsh 重写**（`extensions/pi-webx-todo.ts`，部署到 `~/.pi/agent/extensions/`）：
   `todos: [{ content, status }]` 必填、整表替换；状态三态；同时最多一个 `in_progress`；
   结果 `details = { todos }` 就是面板的**唯一读取面**。旧的 `pi-deck-todo.ts` 移成
   `.bak`（后缀不是 `.ts`/`.js`，pi 的 loader 不再加载），两个扩展不会抢同一个工具名。
   工具描述、promptGuidelines 的措辞照抄 dsh（含「不要边做边逐项追加」）。
2. **面板读会话事件，不读 widget 文本**：`src/lib/todos.ts` 从 transcript 里最后一次成功的
   `todo` 调用取快照（last-write-wins），`TaskPanel.tsx` 只画这张表。widget 文本行只在
   拿不到结构化记录时兜底（旧会话），且行数与表头不符就整张作废——不猜。
   这与 dsh「todo 写进 session，UI 从 session events 渲染」同构，也让分支/重开会话自动正确。
3. **面板形状逐条照抄 dsh `TodoPanel`**：一行头部（清单字形 ·「任务」· 计数摘要 · chevron，
   整行是 button 且带 `aria-expanded`）+ 每项一行（`data-status` + 14×14 三态字形画在
   16×16 格子里）+ 列表 180px 自滚。svg path、渐变 stop、`2.4 2.4` 虚线逐字搬，不重画。
4. **权限菜单只留一行**：删掉每档标签下的命令清单（dsh 的 `PermissionSelect` 菜单行只有
   盾徽 + 名称）；`hint` 仍在数据层（server 与旧会话都读它），只作为 **trigger 的
   `title`** 出现——那也是 dsh 放 preset 说明的位置。
5. **todo 工具卡走 dsh 的任务行**：清单字形 +「任务」+ `d/t 已完成 · 第一个进行中项` +
   独立的不可收缩 `+K`（并行在跑的其他任务）。摘要与面板共用 `src/lib/todos.ts` 的同一套
   判定，两处不可能各说一套。

## 与 dsh 的两处**有意偏离**（都写在代码注释里）

1. **面板默认展开**。dsh 是 `useState(true)`（默认折叠，宿主里它只是 dock 的一行）；
   用户的图1 是展开态、要看得到条目，所以这里默认展开，点头部折叠。
2. **列表 key 带位置**（`` `${index}:${content}` ``）。dsh 只拿 `content` 当 key；dsh 的
   todo 允许两行同样措辞，那样 key 会撞。

## 放弃了什么

- **放弃在 UI 层合并连续 todo 调用**。把 6 行折成 1 行只是把协议缺陷藏起来：模型仍然
  在为「3 个任务」付 6 次工具往返，token 与延迟照旧。改契约才是修根因。
- **放弃保留旧扩展的 `action` 参数做兼容**。同一个工具名不能有两套参数语义；旧**会话
  记录**的兼容留在读取侧（`src/lib/todos.ts` 认 `{action,todos:[{id,text,done}]}` 与
  widget 文本行），旧**调用方式**不再支持。
- **放弃「菜单里保留命令清单但换成 tooltip」以外的第三方案**（例如折叠/`?` 图标）：
  用户明确要求「与 DeepSeek harness 保持一致」，dsh 的菜单行就是一行。

## 钉子

| 脚本 | 钉住的东西 |
|---|---|
| `scripts/check-todos.ts` | 投影契约：三态词表、整表归一（含旧 `{text,done}` 形态）、坏项只丢一项、last-write-wins、失败调用不改写面板、`{todos:[]}` = 清空、头部文案的段序与 U+2002、widget 行兜底（行数不符即作废） |
| `scripts/check-todo-tool.ts` | 扩展本身：3 项一次调用成整表、重复/空内容/多 `in_progress` 被拒、空表清空、widget 行能被投影还原（假 pi 加载扩展，不联网不调模型） |
| `scripts/check-task-panel.ts` | 面板 SSR：头部「任务」+ `progressLabel` 原文、三态字形字面量（逐字来自 dsh）、180px 自滚 / 8px 行距 / 13px 行高、空表不渲染、默认展开、`WidgetStrip` 不再画 todo widget 原文、结构化优先 + widget 兜底 |
| `scripts/check-tool-preset-menu.ts` | 菜单 HTML **不含**三串命令清单、仍含三档中文标签与选中态；trigger 另带 `aria-label` 与 `title` |
| `scripts/check-tool-presets.ts` | 数据层 `hint` 仍在（三串逐字），菜单不再渲染 |
| `scripts/check-tool-card.ts` | todo 行：`任务 1/3 已完成 · 进行中项` + 不可收缩 `+K`；缺/坏快照退回通用摘要；失败行无 `+K`；空表 `0/0` |

`package.json` 的 `check` 链尾部新增四个入口（顺序：tool-presets → tool-preset-menu →
todos → todo-tool → task-panel）。

## 证据

- `npx tsc --noEmit` exit 0；`npm run check` 全 PASS（含四个新入口）；`npm run build` exit 0。
- 部署校验：`extensions/pi-webx-todo.ts` 与 `~/.pi/agent/extensions/pi-webx-todo.ts`
  sha256 一致；用 pi 自己的 `discoverAndLoadExtensions` 实跑，注册 `todo` 的扩展**恰好 1 个**；
  实际参数 schema 是 `{todos: array<{content,status}>}`，`additionalProperties:false`。
- headless 真机（`node_modules/.bin/pi -p …`）：改动前后 6 次 → 2 次调用，原始片段见上文。
- 浏览器验收：见验证任务的报告（面板渲染、菜单展开、一行摘要）。

## 复活条件

- 若要回到「折叠优先」：把 `TaskPanel.tsx` 的 `useState(false)` 改回 `true` 即可，
  其余形状与钉子都不依赖初始态（脚本断言的是初值本身，改时同步改断言文案）。
- 若要支持并行多 `in_progress`（未来接 subagent/后台任务）：删掉扩展里的单活跃校验并同步
  dsh 的 `allowParallelInProgress` 描述分支；`planSummary` 的 `+K` 已经按多活跃设计。
