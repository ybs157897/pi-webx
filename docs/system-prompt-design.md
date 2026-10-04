# 小台系统提示词设计：全局一份 + 项目一份

> 2026-09-24，分支 `codex/ai-workbench-migration`。回答的问题是：给工作台 AI 副驾（小台）配置自定义提示词，全局一份、每项目一份，文件放哪、怎么加载。
>
> 结论先行：**pi 内核已经内置了这套机制，pi-webx 零代码继承**。设计工作是把「用哪两个槽、语义边界、信任模型、产品化路径」定清楚，而不是发明新的加载器。

## 1. 机制事实（全部已验证，pi@dist/core）

pi 的 `ResourceLoader`（`@earendil-works/pi-coding-agent/dist/core/resource-loader.js`）在每次会话创建时自动发现四类提示词文件：

| 槽 | 项目级（需 trusted） | 全局 | 语义 |
|---|---|---|---|
| SYSTEM | `<项目根>/.pi/SYSTEM.md` | `~/.pi/agent/SYSTEM.md` | **整体替换** pi 默认系统提示词（L809-817） |
| APPEND | `<项目根>/.pi/APPEND_SYSTEM.md` | `~/.pi/agent/APPEND_SYSTEM.md` | **追加**到系统提示词之后（L820-830） |
| 上下文 | `<项目根>/AGENTS.md`（候选含 AGENTS.override.md / CLAUDE.md，L33） | — | 包成 `<project_context>` 注入（L33 + buildSystemPrompt L103-111） |
| 工具行为 | 扩展的 `promptSnippet` / `promptGuidelines` | 同左 | 并入提示词的 tools / guidelines 节 |

关键常量：项目配置目录 `CONFIG_DIR_NAME = ".pi"`（`dist/config.js:402`，可被包配置改写，pi-webx 未改写）；全局目录 `getAgentDir()` 默认 `~/.pi/agent`。

**加载链路**（全部已存在于内核与 host 接线，pi-webx 主会话未传任何 override，`server/pi/host.ts:539` 走默认 settings + resourceLoader）：

```
会话创建（cwd 取自会话所在项目，host.ts:488）
  → ResourceLoader.load()
      discoverSystemPromptFile()      项目(trusted)优先，缺省全局 → 基底（替换或 pi 默认）
      discoverAppendSystemPromptFile() 项目(trusted)优先，缺省全局 → 追加段
      AGENTS.md 候选收集               → contextFiles
  → agent-session.js:754  appendSystemPrompt 传入 buildSystemPrompt
  → 最终系统提示词 = [SYSTEM.md 替换基底 | pi 默认]
                    + APPEND_SYSTEM.md（追加段）
                    + <project_context>（AGENTS.md）
                    + skills 清单 + cwd
```

**必须写进文档的关键语义：项目命中则全局不生效**。`discoverAppendSystemPromptFile()` 返回单个文件（项目 trusted 且存在即返回项目文件，L821-824），全局槽只在项目槽缺席时兜底——两级是**覆盖关系，不是合并**。

## 2. 设计决策

### D1 文件即配置，不自造存储

提示词放 markdown 文件，不进 SQLite、不进 settings JSON。理由：
- pi 内核的发现、信任、拼装已实现并有测试覆盖，pi-webx 零代码继承；
- 与 pi CLI / 其他 pi 生态工具**同源生效**（同一份 `~/.pi/agent/APPEND_SYSTEM.md` 对命令行 pi 和工作台小台同时成立）；
- 内核升级无兼容成本（settings.md 无提示词键，说明上游也不打算把它做成设置项）。

### D2 只推荐 APPEND 槽，SYSTEM 槽标为高级逃生舱

默认提示词携带工具使用说明与 pi 文档导航，`SYSTEM.md` 整体替换会把这些一起丢掉。因此：
- **全局提示词 = `~/.pi/agent/APPEND_SYSTEM.md`**：小台人设与通用交互规则（语言、简洁度、引用工作台数据的习惯）。
- **项目提示词 = `<项目根>/.pi/APPEND_SYSTEM.md`**：该项目的工作规则（门禁三件套、协议文档指针、目录约定）。
- `SYSTEM.md` 两级都保留可用，文档标注「整体替换，慎用」。

### D3 与 AGENTS.md 的分工

| 文件 | 装什么 | 为什么 |
|---|---|---|
| `.pi/APPEND_SYSTEM.md` | 机器指令：行为规则、输出约束 | 进 system prompt，权重最高 |
| `AGENTS.md` | 项目知识：架构、门禁、协议指针 | 进 `<project_context>`，同时管住所有编码 AI（Claude Code / ZCode / 小台） |

同一份规则不要两处重复放：指令性内容放 APPEND，知识性内容放 AGENTS.md。

### D4 信任边界照内核默认，不放松

项目级两个槽都要求 `isProjectTrusted`（L811、L822）——防恶意仓库借提示词注入。全局文件是用户自有资产，不设防。pi-webx 不绕过、不放宽这个检查。

## 3. 文件布局总览

```
~/.pi/agent/                       全局（跨项目，一份）
└── APPEND_SYSTEM.md               【全局提示词】小台人设 + 通用交互规则

<项目根>/                           每项目（一份）
├── .pi/
│   └── APPEND_SYSTEM.md           【项目提示词】该项目工作规则
└── AGENTS.md                      项目知识/规范（编码 AI + 小台共用）

（高级逃生舱，默认不用）
~/.pi/agent/SYSTEM.md · <项目根>/.pi/SYSTEM.md
```

## 4. 内容分工建议

- 全局：回答语言、简洁度、要不要主动引用工作台模块数据、「改动必须过门禁」这类跨项目纪律。
- 项目：本项目特有的约定（例如 pi-webx 仓库：三条门禁命令、`server/routes.ts` 提交门禁、知识库协议文档指针）。
- 项目知识（架构、协议）优先写 `AGENTS.md`，让编码 AI 一起受益。

## 5. 生效时机与验证

- 系统提示词在**会话创建时定格**：改文件只影响新会话；正在进行的对话不变。产品里提示「保存后新会话生效」。
- 手工验证：写入文件 → 新建会话 → 问小台「你的系统提示词里有哪些规则」或观察行为变化。
- 自动化验证（如做门禁）：临时 agentDir + scratch cwd 放 `APPEND_SYSTEM.md`，起会话断言 system prompt 含追加段（ResourceLoader 可脱离服务单测）。

## 6. 产品化路径（可选二期，当前不做）

工作台设置页加「系统提示词」分区：两个编辑器分别读写全局 / 项目文件。实现要点：
- 服务端加固定路径的读写端点（GET/PUT `/api/prompts/global` 与 `/api/prompts/project`，**不接受前端传路径**，防任意文件写）；项目级写入前校验 trusted。
- 保存后提示「新会话生效」。
- 若不做 UI，本设计的核心（两个文件）已经完整可用——这是 D1 的直接推论。


## 模块 Agent 的绑定项目（2026-10-03）

上文描述普通 Pi 会话的默认发现机制。模块 Agent 使用独立 profile，绑定的整个工作区就是其当前项目；项目路径来自已校验的会话绑定，不能用宿主应用身份、编辑器选择或其他 Agent 的路径替代。目录名只用作项目标识，项目用途和技术事实须来自材料。

参考 DSH standard 的 cwd 与 agent-instructions 分层：公共装配注入项目身份和目录政策，角色 Prompt 保留各自职责与工具契约；绑定根的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md` 通过 SDK 的 project_context 注入。相同路径或内容去重，单文件有界读取，注入正文总预算 64 KiB，超限正文带截断说明。只读根内真实文件，指向根外的符号链接不加载；不向父目录寻找 Git root，也不加载用户全局指令、SYSTEM 覆盖、扩展或未声明 Skill。README 和具体代码按任务由已配置工具读取。

这保留模块身份与权限隔离，同时给模型确定的项目对象。项目指令不能增加工具、授权或跳过业务确认；“当前项目”无需反复询问，未知的业务规则仍需核实。恢复会话保持原 profile 与工作目录，项目材料在装配时重新读取；修改角色 Prompt/Skill 后的新对话使用最新配置，旧对话仍保留其原始配置快照。
