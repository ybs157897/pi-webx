# 手测说明：用户子智能体（定义 / 配置 / 同步派发）

> **2026-09-22 后续修复**：已修复 6 项运行时问题并拆分代码职责，现行规则见[生命周期与权限边界修复](../../notes/implemented/bug-fix/2026-09-22-subagent-lifecycle-boundaries.md)。新增 `check-subagent-lifecycle.ts` / `check-subagent-boundaries.ts`。`selected` 缺工具现在会失败，`all` 缺工具会在模型可见文本中说明；子扩展初始化与用户交互已接入父 UI；超时覆盖初始化。取消后不响应的同进程工作仍保留容量，待实际退出后释放。下方既有 TC / live 结果保留历史口径，不因本次修复重新宣称 live PASS。

Status: **封版 — 自动委派 3 次样本均已发生：**TC-12 记 PARTIAL**（2 次历史权限 FAIL + 修后 1 次 PASS 13/13；该 TC 门槛为 3/3 全条件通过）· 安全 blocker 已修复并经独立 host 验 7/7 + live r3 确认 · **界面已按 ZCode 1:1 重写（color / injectAgentsMd / 名称 3..50 码点）** · **内置两个智能体已落地（虚拟条目、只读、恒启用 ⇒ `subagent` 默认注册）** · **本轮语义已改：真并发（超限排队）、只读豁免、失败走 `isError` + 错误文本** · **提示词两处修正（preamble 逃生口 + Explore breadth 句）与逐字比对守卫已落地** · **验特性必须用 8788（主树 5173/8787 无此功能）** · **工程门禁：task-76 四项 exit 0；提示词轮 task-77 亦四项 exit 0** · 测试任务已完成，不再追加模型轮次**

> **代码状态**：实现位于隔离 worktree **`pi-webx-subagents`**（与主树 `pi-webx` 同级的兄弟目录；分支 `feat/user-subagents`）。子智能体阶段成果已提交为 `1ae3b0a`（未推送、未合并）；Agent Team P2 正在同一分支上进行中。本文的 verdict 只针对该工作区。
> **怎么读结果**：每个 TC 的 verdict 都指向**证据来源**（独立验收报告路径 / 实跑命令）。**未执行的断言一律 NOT RUN，不得记 PASS**；含未验证项的标 PARTIAL。
> 结果来源：`/tmp/pi-webx-subagents-implementation/verify-config-api.md`（配置存储/API/三态）、`verify-runtime.md`（运行时无模型探针）、`verify-runtime-races.md`（取消竞态与工具契约）、`verify-browser.md`（浏览器 UI）、`live-test-server-handoff.md`（隔离实例与调用范式）、**`verify-zcode-contract.md`（ZCode 新契约字段/名称规则/运行时注入）**、**`browser/t53*`（ZCode 1:1 界面三轮浏览器验收，截图与 wire）**、**`verify-builtins.md`（内置两个智能体契约/运行时 10/10）**、**`verify-t66-builtins-narrow.md`（内置 UI 分组/只读行 + 模型设置窄屏 A/B/C）**、**`verify-concurrency.md`（task-71；**其 A/B 两段已过期**，见「工程门禁」后的降级说明；仅 C 段 12/12 仍有效）**。

- Design Ref: `notes/implemented/feature/2026-09-22-user-subagents.md`（契约、决策与放弃项）
- Wire contract: `src/shared/agent-definitions.ts`
- 本文件是**新套件**，因此它是本仓第一个手测格式契约；后续 TC 一律沿用本文的 Given/When/Then 结构。
- 仓库另有**自动断言**层：`scripts/check-*.ts`（`node:assert/strict`，由 `npm run check` 串起来）。本功能的 8 个脚本**已存在**并各自可跑：
  `check-agent-definitions.ts`（契约与存储）、`-api.ts`（API 面）、`-ui.ts`（UI 纯函数）、`check-subagent-tool.ts`（工具面/假 worker）、`check-subagent-sdk.ts`（真实**无 LLM** SDK probe）、`check-subagents-test-server.ts`（隔离实例的自检）、`check-subagent-lifecycle.ts`（超时/取消/资源归属）、`check-subagent-boundaries.ts`（真 SDK 父子交互与边界）。脚本钉契约与存储，本文钉用户可见行为——**脚本 exit 0 不等于本文的 TC PASS**。

## 0. Harness gate（执行者能不能像人一样操作并独立观察）

| | 结论 | 证据 |
|---|---|---|
| **Control** | **YES** | 隔离 harness 内真实 DOM 注入 + 真实 `click`，读回 `clicked=1`；截图 `control-probe.png` 已目视确认 |
| **Observation** | **YES** | 同一空间跨进程恢复后，点击并用显式等待条件观察状态跃迁 `idle→advanced`；截图 `observation-probe.png` 已目视确认 |

- 浏览器通道：ego-browser，隔离 **TaskSpace 151 / p1**（**仅**用于本功能验收；**不使用**任何先前研究用的空间）。
- 观察是**外部**的：读真实 DOM/像素（`page.evaluate` + `page.screenshot`），不采信产品自述；报告见 `/tmp/pi-webx-subagents-implementation/verify-browser.md`。
- **限制**：浏览器空间若被用户收回，**立即停止**，不得重试或另开空间；此时 UI 类用例记为 NOT RUN 并说明原因。
- **本文件的 verdict 已按独立报告回填**（见「对照表」）；仍未执行的项一律 **NOT RUN**，不预打 PASS。

## 环境（两档，按用例选择）

**隔离事实（先读，B1 的定点）**：
- `getAgentDir()` 读 `PI_CODING_AGENT_DIR`；而 **`PI_CODING_AGENT_SESSION_DIR` 只被 CLI 入口读取**（`dist/main.js`），
  核心 `SessionManager` 的默认目录是 `getAgentDir()/sessions`，**不查该 env** →
  **它不能作为 in-process 隔离的证据**。in-process 的转录隔离必须靠**显式注入 `sessionDir`**（下一节）。
- 两档都**不假定真实 agentDir 完全不被触碰**：bootstrap 只会**读**真实 `agentDir` 的 auth/models，但那是**显式路径**的读取，不是「env 指向它」。
- 隔离的落点是把 **`PI_CODING_AGENT_DIR` 指向运行目录**（于是真实 `agentDir` 下的
  **extensions / skills / context / 转录**都不会被本测试实例加载或写入），
  只把 **定义文件 / 端口 / 转录 / 测试 cwd 四处**指向运行目录；
  真实 `auth.json` / `models.json` 仍被读（见档 2 的显式 `authPath` / `modelsPath`）。

### 档 1：确定性用例（无模型、无凭据）

```bash
export PROJECT_ROOT="$PWD"                                  # 隔离 worktree 根，勿写死机器路径
export RUN_DIR="$PROJECT_ROOT/run/$(date +%Y-%m-%d)-01"     # 每次运行一个新目录
mkdir -p "$RUN_DIR/evidence"
export PI_WEBX_SUBAGENTS_FILE="$RUN_DIR/agent-definitions.json"   # 定义文件 → 运行目录
export PI_WEBX_PORT=8899                                          # 隔离端口，勿用 8787
export BASE="http://127.0.0.1:$PI_WEBX_PORT"
export PI_CODING_AGENT_DIR="$RUN_DIR/agent-dir"                   # 仅无模型档：可整目录指向 tmp
export AGENT_DEFINITIONS_FILE="$PI_WEBX_SUBAGENTS_FILE"           # 断言用别名，避免拼错路径
export REAL_AGENT_DIR="$(node -e 'console.log(require("@earendil-works/pi-coding-agent").getAgentDir())')"   # 显式取真实 agentDir；须在覆盖 PI_CODING_AGENT_DIR 之前求值
```
> 档 1 全是**无模型**用例（CRUD/校验/CAS/重载/静态目录断言），改 `PI_CODING_AGENT_DIR` 不会丢凭据，因为根本不用凭据。

### 档 2：真实 SDK / 浏览器（live）

```bash
export PROJECT_ROOT="$PWD"
export RUN_DIR="$PROJECT_ROOT/run/$(date +%Y-%m-%d)-02"
mkdir -p "$RUN_DIR/evidence" "$RUN_DIR/sessions" "$RUN_DIR/cwd" "$RUN_DIR/models-store"
export PI_WEBX_SUBAGENTS_FILE="$RUN_DIR/agent-definitions.json"   # 定义文件 → 运行目录
export PI_WEBX_PORT=8899
export BASE="http://127.0.0.1:$PI_WEBX_PORT"
export FIXTURE_CWD="$RUN_DIR/cwd"                                 # fixture 工作目录 → 运行目录；TC-12/TC-14 以它为 cwd 建会话
unset PI_CODING_AGENT_SESSION_DIR                                  # 明确不用（只对 CLI 有效）
export REAL_AGENT_DIR="$(node -e 'console.log(require("@earendil-works/pi-coding-agent").getAgentDir())')"   # ① 先捕获真实 agentDir
export PI_CODING_AGENT_DIR="$RUN_DIR/agent-dir"                    # ② 再覆盖成临时目录（host/routes 必须在②之后 dynamic import）
```

- **隔离靠三个动作叠加，缺一不可**（已实现于 `scripts/subagents-test-server.ts`）：
  1. **先捕获真实 agentDir**：`REAL_AGENT_DIR="$(getAgentDir())"`，在覆盖 env **之前**求值；
  2. **再把 `PI_CODING_AGENT_DIR` 覆盖为 `$RUN_DIR/agent-dir`**，然后**动态 import** `host` / `routes` ——
     模块初始化期读到的 agentDir 已是临时目录，因此真实 agentDir 下的 **extensions / skills / context** 不会被加载；
  3. **工厂显式传真实路径**（不继承临时 env）：
     `modelsPath = $REAL_AGENT_DIR/models.json`、auth reader 显式读 `$REAL_AGENT_DIR/auth.json`，
     其余 `modelsStore` / `sessionDir` / `settings` / `cwd` **全部落 tmp**。
- 这三步的净效果是：**产物与扩展面隔离在 tmp，真实 agentDir 只被显式读取两个文件**；不声称真实目录不被访问。

- **档 2 的隔离靠 test-only bootstrap 注入**，不靠 env：`scripts/subagents-test-server.ts`（**已存在**，自检脚本 `scripts/check-subagents-test-server.ts`）以
  `PiHost({ modelRuntimeFactory, sessionDir, settingsManagerFactory })` 构造：
  - **凭据（已更正）**：SDK **公开面没有 `AuthStorage` / `ReadOnlyAuthStorage`**（那两个类只在 `dist/core/auth-storage.d.ts`，`index.d.ts` 未导出），
    且 `fromStorage(...)` 的类型与 `CreateModelRuntimeOptions.credentials` 不匹配 —— **原写法作废**。
    批准的做法是一个 **test-only `CredentialStore` 适配器**：只调用公开的
    `readStoredCredential('cmdc', authPath)`，把结果**在进程内部**交给 SDK 消费；其它 provider 一律 `undefined`；
    `modify` / `delete` **直接 throw**（结构性只读，写路径被堵死）。
    凭据值**不打印、不复制、不落盘**，harness 也拿不到它（与 `readStoredCredential` 的返回值只在适配器闭包内流转）。
  - **模型目录**：`modelsPath = $REAL_AGENT_DIR/models.json`（**显式只读**，不随 `PI_CODING_AGENT_DIR` 漂到 tmp）；
    `modelsStorePath = <RUN_DIR>/models-store.json`（缓存写进 tmp）；`allowModelNetwork: false`。
  - **凭据路径**：`authPath = $REAL_AGENT_DIR/auth.json`（显式传入适配器，同样不依赖 env）。
  - `sessionDir = $RUN_DIR/sessions`，`settingsManagerFactory = SettingsManager.inMemory`。
- **命名核对（照公开面，不照猜）**：`readStoredCredential(providerId, authPath?)` 与 `CreateModelRuntimeOptions{ credentials, authPath, modelsPath, modelsStore, modelsStorePath, allowModelNetwork }` 均为公开导出；
  `CredentialStore` 本身由底层 `@earendil-works/pi-ai` 导出（本包 `index.d.ts` 未转发），适配器按结构实现即可。
- **真 key 只在 SDK 进程内被解析**：harness **不读出、不复制、不打印**任何 key；断言只用元数据
  `hasConfiguredAuth('cmdc')` / `checkAuth('cmdc')` / `getAvailable('cmdc')` 与结果里的 `details.model.{provider,id}`。
  **禁用（针对 harness / 研究者与任何打印路径）**：直接调用 `readStoredCredential()` 去「看」凭据、`getApiKey()`、`printenv`、读取或复制 `auth.json` 内容。
  
  > **必须区分的两件事**（否则上一条与本节自相矛盾）：
  > - **允许**：test-only `CredentialStore` 适配器**在进程内部**调用 `readStoredCredential('cmdc', authPath)`，把凭据**直接交给 SDK 消费**，值从不离开适配器闭包；这是「SDK 正常加载凭据」的等价物。
  > - **禁止**：harness / 研究者 / 任何日志或证据路径去读、打印、复制、或断言凭据的**值**。
  > 断言只允许用**元数据**：`hasConfiguredAuth('cmdc')` / `checkAuth('cmdc')` / `getAvailable('cmdc')` 与结果里的 `details.model.{provider,id}`。
- **措辞区分**：SDK 在进程内读真实凭据来源是**产品正常运行方式**；本测试要求的是**研究者不读、不打印、不复制**密钥内容——两者不是一回事。
- **对真实 models/auth/settings 不产生写入**：只用 `stat`/`hash` 记录 before/after（**不输出文件内容**）作为证据。
  二者是有意区分的：**auth/models 被读是设计内**（显式路径），**任何写入都是缺陷**。
  正向对照：产物（`$RUN_DIR` 下的定义文件 / `sessions` / `models-store.json`）**应当**增长，用来证明「写路径确实活着」，从而让「真实目录没动」不是空断言。
- **管理 API 纪律**：只用 `GET /api/models` 与子智能体定义 UI；**严禁**调用旧的 models/providers 写 API，也**严禁**在 UI 改默认模型。
- 模型相关用例固定 provider **`cmdc`**、model **`deepseek/deepseek-v4.1-flash`**。

### 共同纪律

- **不要**把任何凭据复制进运行目录，**不要**输出真实 `~/.pi` 下任何文件的内容（只用 `stat`/`hash` 元数据）；
  SDK 只经**显式路径**读真实 `auth.json` / `models.json`，harness 自己不读、不打印、不复制。
- 每个用例**自备前置**，不依赖别的用例留下的状态。
- **失败不清理**：任一断言失败或 PARTIAL 时**跳过 cleanup**，保留文件与日志供排查。
- **验子智能体特性必须用 8788**（或任何**带该特性的检出**实例）；**5173 / 8787 默认是主树，没有这个功能**——用它测只会得到「工具不存在」的**假阴性**。
- **诊断口诀（本轮教训）**：先看两道现场证据——① 会话工具面里**有没有 `subagent`**；② 会话 `env | grep '^PI_'` **是否为 8788 实例**（有 `PI_WEBX_PORT`）。**两者对不上，先查实例归属，别急着改提示词。**
- 反例存档：会话 `01a0c8af-18ac-7e03-aff2-067cda321516` 的 `subagent` 调用 **0 次**，模型自述工具面里没有它、用 `bash` 起了 3 个 `pi -p` 兜底——**这是实例归属问题，不是提示词缺陷**；该轮 preamble/description/prompt/Notes **一个字都没送达**。审查报告 `/tmp/pi-webx-subagents-implementation/prompt-review-01a0c8af.md`。

- **live bootstrap 未就绪时**（`scripts/subagents-test-server.ts` 不存在或未能启动）：档 2 用例记 **NOT RUN**，
  **不得**用文档假装能启动，也不得退化成「不隔离、直接跑在真实 agentDir 上」。
- **当前状态**：`scripts/subagents-test-server.ts` **已存在**，并用 `scripts/check-subagents-test-server.ts` 自检过其 gate（exit 0）。
  实例运行事实与调用范式见 `/tmp/pi-webx-subagents-implementation/live-test-server-handoff.md`（URL `http://127.0.0.1:8899`、RUN_DIR、模型 id、写请求必须嵌套 + CAS）。
  **本文件不代表该实例此刻在运行**——是否存活由持有者按 `job_kill <jobId>`（**不要** `killall node`）管理。

## 对照表

> verdict 遵循：**有独立证据且该项本身已执行 → PASS；只验证了部分子项 → PARTIAL；未执行 → NOT RUN**。不含估算的断言条数。

| TC | 优先级 | 覆盖 | verdict | 证据来源 |
|---|---|---|---|---|
| TC-01 定义 CRUD 与空态 | P0/Critical | 新建/读回/改名/删除 + 空态 `revision:0` | PASS | UI 流程独立验收（真实 HTTP 201/200/200）；store/API 独立复现 |
| TC-02 默认 `tools: all` 与 `enabled` 必填 | P0/Critical | 工厂默认值 + POST 缺 `enabled` → 400 且文件不变 | PASS（「禁用不派发」见 TC-13b/TC-14 的机制证据） | check 脚本 exit 0 + 独立复现 `2c`（缺 `enabled` → 400、文件不存在） |
| **TC-15 颜色标记 `color`（8 色 / 可空 / `null` 清 key）** | P1/High | 8 色往返、缺省不落 key、非法值 400、PATCH `null` 删 key、UI 色点与「再点已选色=清除」 | **PASS** | `verify-zcode-contract.md` 用例 1a–1d/2 + `browser/t53-C-color-saved-1440.png`、`t53-G.row-C.cleared-1440.png` |
| **TC-16 注入 AGENTS.md `injectAgentsMd`** | P1/High | true 注入父 cwd `AGENTS.md`、false/缺省不注入、`systemPrompt` 不变、UI 开关 | **PASS** | `verify-zcode-contract.md` 用例 7a–7c（真 `PiHost` + 真 `createWorkerSession` 哨兵） |
| **TC-17 内置两个智能体（契约/写保护/遮蔽）** | P0/Critical | 两条虚拟内置、`source/readOnly`、不落盘、内置 id 写请求 400、同名遮蔽 | **PASS** | `verify-builtins.md` §1–§4（含逐字 diff 与落盘纯度护栏） |
| **TC-18 内置 UI 分组与只读行** | P1/High | 「内置子智能体」组在前、无开关/无删除/点击不进编辑、计数含内置、搜索整组隐藏 | **PASS** | `verify-t66-builtins-narrow.md` A1–A6 |
| **TC-19 真并发与排队（新语义）** | P0/Critical | 同轮多派发并发执行、超 `maxConcurrentInstances` 排队、`capacity-timeout`、排队可 abort、`host-full` 立即拒绝 | **PARTIAL（证据已按 task-87 实跑重指）**：两 child 真并发、同定义排队、排队中取消清队列、配额回基线、`host-full` 拒绝**都有现行证据**；**FIFO 顺序与全局 `MAX_WORKERS` 上限仅仓库外 harness 覆盖**；`capacity-timeout` 真实墙钟**未验** | 仓库内：`scripts/check-subagent-boundaries.ts:140`（`peak===2`）、`scripts/check-subagent-lifecycle.ts:92-104`；仓库外：`/tmp/pi-webx-subagents-implementation/verify-runtime-races.ts`（sha256 `1214aa9c…`，C1–C6） |
| **TC-20 只读豁免（新语义）** | P0/Critical | `selected` 下 `read/grep/find/ls` 免父 active、其余仍 ⊆ 父 active、`all` 不变、写/命令类不豁免 | **PASS，但证据要换**：`verify-concurrency.md` §B（B 7/7）**已过期**——其旧期望与「`selected` 缺工具现在会失败」相矛盾，今天实跑 B exit 1（4 pass / 1 fail） | 现行证据：`scripts/check-subagent-tool.ts`（豁免与 `unavailable` 断言）、`server/pi/subagent-tool.ts` 的 `planToolSurface` |
| TC-02b N2：`thinkingLevel` 三态清除 | P0/Critical | set → 保留 → `null` 清除 → 重设；非法值拒绝 | PASS | 独立复现 `4/4b/9b`（DTO 与盘上都无该键；**真实 wire body 含 `"thinkingLevel":null`**） |
| TC-03 坏输入：非法 JSON / 未知字段 / 超长 / 重名 | P0/Critical | 校验与拒绝语义 | PASS（仅 code point 长度这一种单位） | 独立复现 `1c/1e/7/7b/8c` + 截断 JSON 经完整 app 栈 → 400 且文件 sha 不变 |
| TC-04 文件级 CAS | P0/Critical | 过期 `expectedRevision` → 409，无写入 | PASS（**单进程**；硬链接/跨进程/TOCTOU **不保证**） | 独立复现 `1a/1b/1d`：恰 1 成功 + 1 个 409；HTTP `[201,409,409,409,409]` |
| TC-05 重载与 isolated 目录 | P0/Critical | 重启后读同一文件；`PI_WEBX_SUBAGENTS_FILE` 生效 | PARTIAL（**实例重启后复验在途**） | 同一文件多实例读一致性（独立复现 `1b`）；`response.path` 断言未执行 |
| TC-06 取消派发 | P1/High | 客户端中止 → 调用终止、无残留副作用 | PARTIAL（竞态语义 PASS；真实时钟/UI 取消未执行） | `verify-runtime-races.md` §II：`created=0, promptCalls=0`、pre-aborted → `promptCalls=0`、`no-output` |
| TC-07 disabled 定义立即拒绝 | P0/Critical | 关闭后立即拒绝后续派发 | PARTIAL（**活模型派发未执行**；重读 enabled 语义已有证据） | `verify-runtime.md` 点 1（enabled `false→true→false` 刷新）与 TC-14 机制 |
| TC-08 派发不接受覆盖 | P0/Critical | `subagent` 只有 agentId/task，多余参数无效 | PASS | 独立复现：参数 **exact-keys**，多余键被拒且 `calls.length===0` |
| TC-09 防递归 | P0/Critical | 子会话拿不到 `subagent`；**非只读工具 ⊆ 父 active，只读工具豁免** | **PASS（修复已验证，口径已按只读豁免改写）**：live r1/r2 曾越权（历史 FAIL 保留）；task-45 改为读父 **active** 后，独立 host 探针 **7/7** + **live r3 实测 `effectiveTools=[read,grep]`** 确认边界成立；本轮 `selected` 下 `read/grep/find/ls` 免父 active（仍须在子 registry） | `verify-parent-active.md`（7/7，含 RED 自检；**该报告早于只读豁免**）+ `live/verify-live.md` §9 + `scripts/check-subagent-tool.ts`（豁免断言） |
| TC-10 `selected: []` 纯推理合法 | P1/High | 空 selected 可保存且子会话无工具 | PASS | check 脚本 + 独立复现 `3a`（`selected:[]` → `toolNames=[]`）；UI 保存 `names:[]` → 200 |
| TC-11 UI：新增/编辑/启禁/删除 + 409 草稿保留 | P1/High | 设置页字段级交互 | **PASS**（TC3 已在新构建复验通过 → 整组 **9 PASS / 0 FAIL**，**仅限无模型调用的 UI 维度**） | `verify-browser.md` 附 TC3 复验（新构建 `index-C9DY9qWv.js`）：TC1/2/4/5/6/7/8/9 沿用上轮 PASS + **TC3 PASS**；两轮共 34 张截图 + wire 捕获 |
| TC-12 普通对话自动委派 | P1/High | 未点名工具的自发委派（3 轮） | **PARTIAL：已完成 3 次测试；2 次历史 FAIL + 修后 1 次 PASS，自动调用 3 次均发生**。本 TC 的 PASS 门槛是**3/3 全条件通过**，实际前 2 次 FAIL → **不达 PASS**（**不得**把门槛重定义为「只要发生自动委派就算过」） | `/tmp/pi-webx-subagents-implementation/live/verify-live.md`（172 行最终报告，§9 逐轮表）+ 下文「live 轮次」 |
| TC-13 阴性：无定义 / 全 disabled / 父 none | P0/Critical | 不得派发 | PARTIAL（`c` 父 none 有实测且修复后仍为 `surface=[]`；`a`/`b` 的活模型侧未执行） | `verify-runtime.md` + `verify-parent-active.md` case D（父 active 空 → `surface=[]`） |
| TC-14 B2：动态 enabled × 父 none / 空选择 | P0/Critical | 刷新不得把 inactive 翻成 active | PASS | 真实 `PiHost` + fixture runtime 走真实 `refreshSubagentTool`：父 none 恒 `[]`，对称正例得 `['grep','read','subagent']` |

### 结果概览（按上面的 verdict 归纳）

- **PASS**：TC-01、TC-02、TC-02b、TC-03、TC-04、TC-08、**TC-09（修复后已验证）**、TC-10、**TC-11**、TC-14 —— 均来自**独立**验收（复现脚本 / 真实 SDK probe / 真实浏览器），非实现者自述。
- **PARTIAL**：TC-05（重启复验在途）、TC-06（真实时钟与 UI 取消未执行）、TC-07 与 TC-13（活模型派发侧未执行）、**TC-12（3 次测试已完成：2 次历史 FAIL + 修后 1 次 PASS；本 TC 门槛是 3/3 全条件通过 → 不达 PASS）**。
- **NOT RUN**：无。
- **历史 FAIL（保留不改写）**：live r1、r2 的**工具面越权**（`effectiveTools` 越出父 active）——已由 task-45 修复并经独立 host 验 + r3 验证；**TC-12 不得写成 3/3 全过，也不得因「3 次都发生了自动委派」改判 PASS**。
- **维度提示**：UI 的 **9 PASS / 0 FAIL 仅覆盖「无模型调用」的界面行为**；live 维度是 **2 次历史 FAIL + 修后 1 次 PASS**，**成功率不泛化**（每个领域只观测一次），且**不证明 OS 沙箱**。**测试任务已完成 ≠ 该 TC 全过。**

### ZCode 1:1 重写（本轮新增，两轮浏览器验收）

**基线**：`zai-org/ZCode@872ad960` 的 `packages/ui/src/settings/SubagentsSection.tsx`（1841 行；配置界面**不在** `packages/web`）；规格 `/tmp/pi-webx-subagents-implementation/zcode-ui-spec.md`。

- **结构**：列表态 ⇄ 表单态**整页互斥** + 「返回」（不再是左右两栏同屏）。
- **字段顺序**：名称 → 颜色标记 → 模型 →（思考档位）→ 描述 → 可用工具 → 系统提示词 → **注入 AGENTS.md**；22 条文案逐字取自 ZCode `zh-CN.ts:3314-3394`。
- **列表**：卡片行 + 头像方块 + 色点 + 模型/工具徽标 + 两行截断描述；**行内启用 Switch**、**行内删除 + 二次确认**；搜索 / 空态 / 底部摘要「共 N 个子智能体 · M 个已启用」。
- **工具区**：二选一（默认所有权限 / 自定义可用工具）+ 自定义网格；**切到自定义且为空 → 自动全选**；支持手动添加扩展工具名；保留**显式全不选**（纯推理）。
- **浏览器三轮结论**（证据 `/tmp/pi-webx-subagents-implementation/browser/t53*`）：
  1. **第一轮** A–H **PASS** / I **FAIL**（3 项偏离）。
  2. **第二轮**：① 删除弹窗 **PASS**；② 重试用 CDP `Network.setBlockedURLs` **真实触发 PASS**；③ **窄屏 FAIL**。
  3. **第三轮**：**窄屏 PASS** —— **390 内容列 348px**、按钮 **`cw=sw=112`**（不截断）、rail 变横向 tab 条；**1440 桌面侧栏仍 256px**（不回归）。
  - 口径注：内部 `_contentFrame_` 实测 **1184 = 1440 − 256**（**实测值**）；早先预测的 **1114 是实现者估值，不是实测值**，不得写成实测。
### 本轮三条语义变更（真并发 / 只读豁免 / 失败语义）

**A｜真并发（超限排队，不再硬拒）**

| 项 | 新语义 |
|---|---|
| 并发上限 | **每定义 `maxConcurrentInstances`**（契约 1..4、**默认 1**；UI 不展示）+ **全局 host worker 上限** |
| 超限时 | **排队**（**排队不占 capacity**；不同定义不互相排队）——**不再直接失败**。**口径**：调度是**按到达顺序扫描放行**，**不是严格队头阻塞**——队头被某定义的上限挡住时，异定义的后到者仍可先走。**别写成「严格 FIFO」。** |
| 排队超时 | 新错误码 **`capacity-timeout`**，由**生命周期层的排队期定时器**出码（`server/pi/subagent-lifecycle.ts:22-28`：`queued ? 'capacity-timeout' : 'timeout'`）。`subagent-worker.ts:90` 也有一处排队码，但在当前实现里**被生命周期层遮蔽、可观测行为上冗余**（Lead 已决定：**不改代码、只记录为设计观察**）。排队等待计入工具 **120s** 超时。 |
| host 预算用尽 | **容量层码是 `host-full`**（`server/pi/subagent-capacity.ts:136`），**而调用方实际看到 `capacity-full`**（`server/pi/subagent-worker.ts:50` 把容量层错误包装成 `capacity-full`）。**立即拒绝、不排队**（设计选择）。写文档/断言时别把两层的码混用。 |
| 排队中取消 | 父 abort / host `cancelParent` → **`parent-aborted`**，capacity 归零、**无僵尸** |

- 触发原因：用户实测里「同一会话同时只能有一个子智能体」的硬拒挡住了正常的并发派发；该硬拒规则与错误文案**已删除**。
- 工具 description 新增并发说明句。

**B｜只读豁免（这是改写，不是并列保留）**

- 新增 **`READ_ONLY_CHILD_TOOLS = ['read','grep','find','ls']`**。
- **新语义**：`mode:'selected'` 时名字须**存在于子 registry**（缺则进 `unavailableTools`），其中**只读名免于父 active 限制**，**其余名字仍必须 ⊆ 父 active**；**`mode:'all'` 不变**（父 active − restricted）。
- **替换掉的旧表述**：本文此前写的「子工具面 ⊆ 父 active」**已作废**，现行口径是「**非只读工具 ⊆ 父 active；只读工具豁免（但仍须在子 registry 存在）**」。
- **为什么**：让内置 Explore 在**默认/最小会话**里可用——父只开 `read` 时它本应也能拿到 `grep/find/ls`。
- **边界**：**不是权限提升、不是沙箱**；**`bash`/`edit`/`write`/`powershell` 绝不豁免**，`subagent` 等 restricted 名照旧剔除；`unavailable` 仍然如实报告而不静默授予。
- **真实例子**：父 active = `read / bash / edit / write / ask_question / todo / render_ui`，`builtin:explore`（`selected: read,grep,find,ls`）**应拿到 `read/grep/find/ls` 四项**（旧语义只会给 `read`）。

**C｜失败语义（SDK 硬限制，判定口径必须改）**

- SDK 里**返回**的结果**不能**带 `isError`（`AgentToolResult` 无该字段；`agent-loop` 的 return 分支硬编码 `false`）；**throw** 才得 `isError:true`，但结果被替换为 `{content:[…], details:{}}`。
- 故**失败一律 throw**：**`isError:true` + `details={}`**，归因放进**错误文本**：
  `[subagent failed: 名称 (id)] 原因 (agentId=… definitionRevision=… runId=… reason=…)`；进程内调用者还可读 `error.code` / `error.runId`。
- **判定口径**：**看 `isError` 或读错误文本**——**不要再**用 `details.ok === false` / `details.reason` 判失败（失败路径 `details` 是空对象）。
- **成功路径不变**：`isError:false` + 八键 `details`（外加非空才出现的条件键）。

**独立验收（task-71，`/tmp/pi-webx-subagents-implementation/verify-concurrency.md`，85 行）——⚠ 覆盖已被 task-87 复核修正**：

> **原结论是 A 7/7 · B 7/7 · C 12/12**。**今天的实跑结果是：A → exit 1（`Probe A: 1 pass, 1 fail`，探针仍用重构前的 `SubagentCapacity({maxWorkers, hostSessions, maxHostSessions})` 构造 → `Cannot read properties of undefined (reading 'onRelease')`）；B → exit 1（`4 pass, 1 fail`，旧期望与「`selected` 缺工具现在会失败」相矛盾）；C → exit 0，12 pass / 0 fail（仍有效）。**
> ⇒ **A/B 两段按「重构前历史口径、现行代码上不可复现」对待**（历史记录保留，不删）；**只有 C 段仍可引用**。
> **现行证据见下方表格**（仓库内脚本 + 仓库外 `verify-runtime-races.ts` 的 C1–C6）。

要点（下表带 ✅/⚠ 标注现行有效性）：

**现行覆盖矩阵（task-87 实跑，worktree `pi-webx-subagents` @ `0edebd0` + 脏工作树）**：

| 声称 | 现行证据（文件 + 行号 + 命令） | 判定 |
|---|---|---|
| 两 child **真并发**同时在飞 | `scripts/check-subagent-boundaries.ts:140`（`peak===2 / disposed===2 / live===0`）；`npx tsx scripts/check-subagent-boundaries.ts` | ✅ PASS |
| 同定义超 `maxConcurrentInstances` **排队** | `scripts/check-subagent-lifecycle.ts:92-104`（`definitionLimit:1` 第二个排队、释放后放行、预算回基线）；`npx tsx scripts/check-subagent-lifecycle.ts` | ✅ PASS |
| 排队中取消 → `parent-aborted`、**清队列无僵尸** | `scripts/check-subagent-lifecycle.ts:45-53`（`capacity.queued===1` → `cancelParent` → 码为 `parent-aborted`、`queued===0`） | ✅ PASS |
| 配额回基线（成功/失败/取消） | `scripts/check-subagent-lifecycle.ts:52-53,71-72,85-87` | ✅ PASS |
| `host-full` 立即拒绝 | `scripts/check-subagent-lifecycle.ts:99`（`capacity.acquire` 被拒）；**口径见上表：调用方见 `capacity-full`** | ✅ PASS（口径已改） |
| 排队码 vs 运行期 `timeout` 两码可区分 | `scripts/check-subagent-lifecycle.ts:42` + 仓库外 C4 | ✅ PASS |
| **异定义不互相排队** | **仅**仓库外 `/tmp/pi-webx-subagents-implementation/verify-runtime-races.ts` C2（`size=2 queued=1`，a1 释放后 b1 之后 a2 才起） | ⚠ 仅仓库外 |
| **全局 `MAX_WORKERS` 上限** | **仅**同脚本 C3（`maxWorkers=2` → 第三个排队） | ⚠ 仅仓库外 |
| **到达顺序放行（非严格 FIFO）** | **仅**同脚本 C1（单槽 + 三**不同**定义 → `admitted=[task-1,task-2,task-3]`）；变异 `waiting.unshift→LIFO` 能让 C1 变红 | ⚠ 仅仓库外，且**口径是「按到达顺序扫描放行」** |
| 旧硬拒文案 `grep` = 0 / description 并发句 | `verify-concurrency.md` A5（**A 段唯一仍活着的用例**） | ✅ PASS（引用须注明 A 段其余 6 例已不可复现） |

- 仓库外门禁：`/tmp/pi-webx-subagents-implementation/verify-runtime-races.ts`，sha256 **`1214aa9c624e6a22a74da177375cb13a5c7ab8ea671eef06b7fe85c7e5343b80`**；本轮实测 **`15 pass / 0 fail / 0 skip`（A6+B3+C6），连跑 6/6 一致**；8 个变异**全部咬人**（含 `MAX_WORKERS 2→3`、`waiting.unshift→LIFO`、取消只到最老 run 等）。
- **不要用静态 `record(` 计数当通过数**（静态 18 处 ≠ 运行时 15 例）。
- **B（⚠ 已过期）**：原报「父 active 仅 `['read']` → 得 `[read,grep,find,ls]`、写/命令类不放宽、`all` 不变」——**结论方向仍成立，但该报告的 B 段今天实跑 exit 1**（4 pass / 1 fail），**其旧期望与「`selected` 缺工具现在会失败」相矛盾**。**引用只读豁免请改用** `scripts/check-subagent-tool.ts` 的豁免/`unavailable` 断言与 `server/pi/subagent-tool.ts` 的 `planToolSurface`。
- **C（✅ 仍有效，12/12）**：报告**自行复核**并**自己写了 loop 式探针**证明「返回值里塞 `isError:true` 也没用，执行器仍报 `false`」——**返回结果无法表达失败**；只有 throw 得 `isError:true` + `details={}`。**九条失败路径**（invalid-arguments / unknown-agent / disabled / max-turns / capacity-timeout / unavailable-tools / no-output / parent-aborted / internal）**全部 `isError:true`** 且错误文本带 `reason=`；**成功路径仍是 `isError:false` + 八键 details**。

### 内置两个智能体（本轮）

**这是行为变化，要写明白**：内置恒 `enabled`，而 `subagent` 工具在「存在 enabled 定义」时注册 ⇒ **即使用户 0 个定义，普通对话里 `subagent` 也已可用**（父 active 允许时）。

| 项 | `builtin:general-purpose` | `builtin:explore` |
|---|---|---|
| description | ZCode `general-purpose.ts:7-24`，**byte-identical** | `profile.ts:71-72`，**byte-identical** |
| prompt | ZCode 原文 + 末尾 **Notes 段** | ZCode 原文 + **三处声明编辑**（工具名 / 删 Bash 行 / breadth 句）+ 末尾 Notes |
| tools | `{mode:'all'}` | `{mode:'selected',names:['read','grep','find','ls']}`（**不含 bash**） |
| color / injectAgentsMd / maxTurns | `blue` / `true` / `4` | `cyan` / `false` / `4` |

- **只读与虚拟**：`source:'builtin'`、`readOnly:true`、`revision:1`、`createdAt/updatedAt:''`；**不落盘**（GET/重启后用户文件 sha 不变）。
- **写请求在读盘/CAS 之前 400**（"内置子智能体不可修改/不可删除"）：陈旧 revision 也只得 **400**（不是 409）；文件不存在**也不会被创建**。
- **同名遮蔽**：用户定义与内置同名（**NFKC + lowercase**）→ **整条内置消失**，用户定义生效。
- **Explore 的三处编辑**（= 代码常量 `DECLARED_ZCODE_DEVIATIONS` 三条）：① `explore-prompt-tool-names`：`Glob/Grep/Read → find/grep/read`；② `explore-prompt-no-bash`：两行 Bash 规则替换为「You have no Bash tool and no write tool of any kind: search and read, never change state」；③ `explore-description-breadth`：`Specify search breadth:` → `State the intended breadth in the task text:`（我们**没有 breadth 参数**）。
- **逐字比对守卫（新增）**：`scripts/check-subagent-tool.ts` 把 ZCode **5 份原件冻进脚本**——GP description/prompt+Notes **逐字节相等**、Explore = **原件经声明改写**、**每次替换恰好命中一次**；SDK 探针另断言**模型可见描述不含旧句**、**不含 `Specify search breadth`**、**schema `properties` 恰为 `agentId`+`task`**。
- **已知但不改（用户明确选择暂不改）**：① 两个内置 `systemPrompt` 仍写 `You are an agent for ZCode CLI`（产品名不符，属逐字复刻）；② Notes 里「bash 调用间 cwd 重置」对**没有 bash 的 Explore 是死条款**；③ `general-purpose` description 偏「复杂研究」，未补「小任务也可派」。
- **UI**：两组「内置子智能体」（在前）/「已安装」；内置行**无开关、无删除、点击不进编辑**；计数 `共 N 个子智能体 · M 个已启用` **内置计入 total 且恒计入 enabled**；搜索时整组隐藏，过滤为空才显示「没有找到子智能体」。
- **本轮修掉的自查缺陷**：初版把 `source`/`readOnly` 随写入落盘 → 下次 read 因未知字段**整份 500**（修复前 store **23/29**、API **11/14** 失败）；改为磁盘/DTO 形态分离 + 出口 `responseFor()` 补派生字段。

**未移植层（照实记录）**：ZCode 在 **dispatch 期**追加的 Environment 层（cwd / 是否 git / platform / shell / OS + 模型名）**我们整层没有**——用户定义同样没有，不是内置独有缺口。

- **偏离已声明（D1–D19；其中 3 条与代码常量 `DECLARED_ZCODE_DEVIATIONS` 逐条对应）**：D1 无「主模型/轻量模型」；D2 只做「已安装」单组；D3 无作用域菜单；D4 逐像素色值不可达（仅色点用字面色值）；D5 行内开关对所有行显示；D6 表单说明句按我们真实存储位置改写；D7 空态为我们的补强版（ZCode 无搜索词时不渲染）；D8 手动添加扩展工具名我们独有；D9 「未指定」用再点已选色=清除；D10 ZCode 的 `permissionMode`/`skills`/`background`/`disallowedTools` 上游 UI 本就不渲染；D11 空 patch 语义保留；**D12「打开用户子智能体目录」不适用**（Web 打不开 OS 目录，不实现不伪造）；**D13「暂无描述」不可达**（我们 `description` 必填）；**D14 Explore 不给 bash**（只读靠工具面）；**D15 Explore prompt 工具名改写 + 删 Bash 行**；**D16 内置不支持行内模型覆盖**（恒继承父模型）；**D17 Notes 段是拼接而 ZCode 是运行时追加**；**D18 ZCode 的 Environment 层（cwd/git/platform/shell/OS + 模型名）未移植，用户定义同样没有**；**D19 Explore description 的 breadth 句改写**（ZCode 写 `Specify search breadth:`，但我们的 schema **没有这个参数**，改成「把广度写进 task 文本」）。

> **代码真值**：`server/builtin-agents.ts` 的 `DECLARED_ZCODE_DEVIATIONS` **恰好 3 条**——`explore-prompt-tool-names`、`explore-prompt-no-bash`（对应上表 **D15**）、`explore-description-breadth`（对应 **D19**）；`scripts/check-subagent-tool.ts` 的**逐字比对守卫**把 ZCode 5 份原件冻进脚本，每次替换必须**恰好命中一次**。完整表见 notes 同名专节。

### 计数与门禁

- **计数（本轮 task-77 值，出处 `/tmp/final4-check.log`）**：store **32 例**、API **16 例**、UI 末行 `check-agent-definitions-ui: ok`；**口径**——**250 是源码里静态 `assert.` 调用数**（`grep -oE 'assert\.' scripts/check-agent-definitions-ui.ts | wc -l`），**不是运行期计数**。

### 曾经的窄屏缺陷：已修 + 独立复测 PASS

- 原症状（task-53）：窄屏 **390** 下「**模型设置**」分区被裁切且**不可达**（`_modelList_` `clientWidth=72` / `scrollWidth=227` / `overflow-x: clip`；行内按钮 `right 401/433/465` > 面板右边界 `385`）。历史证据 `browser/t53r3-390-models-settings.png`。
- **修复后独立复测 B7–B9 全 PASS**（`/tmp/pi-webx-subagents-implementation/verify-t66-builtins-narrow.md`）：320/390/768 用 `overflow-x:auto` + 行 `min-width:240px`，三按钮 `rect.right ≤ 列表右界`；**四档（320/390/768/1440）均无页面级溢出**，无任何按钮 `scrollWidth > clientWidth`；1440 桌面布局不变（`_listPane_` 224px + 弹性列）。
- 实测口径注：390 子智能体分区内容列实测 **337(rect)/335(content)**，与早先“约 348px”差 11px，差值是 `_panelBody_` 的 11px 纵向滚动条所致，**非缺陷**。

### 已经验证到什么（要点）

- **存储/CAS**：`…/dir/../dir/…` 与符号链接别名都收敛为**一个 winner + 一个 409**；坏文件/未知字段/带 `role` 的条目 → 500 且文件 sha256 逐字未变。
- **写面保护**：同源 mixed-case `Host` → 201；跨站 Origin / `Sec-Fetch-Site: cross-site` / 伪造 `X-Forwarded-Host` → 403；`text/plain`、缺 content-type → 400；`GET` 仍可用。**这是来源敏感（CSRF）保护，不是认证**——服务只监听 `127.0.0.1`、无登录态。
- **凭据不泄露**：往沙箱 `models.json` 注入假 secret 后，写请求 400 的错误文本、`GET` 响应、固定模型被拒的报文都**不含**该串。
- **长度与上限**：UI 与后端统一 **code point**（40 emoji 允许、64/65 边界一致）；`selected` 上限 **128**（129 两层同拒）。
- **三态清除**：拦截 `fetch` 抓到的**真实 wire body** 含 `"thinkingLevel":null`，回放给服务器 → 200 且盘上无该键（UI→后端链路真的通）。
- **details 字段**：8 个必需键齐全、**无 `finished`**；另有**条件键** `excludedTools`（非空才出现）与 `unavailableTools`——下游**不要**按 8 键做严格 `deepEqual`。
- **新契约字段**：`color` 8 色往返 8/8 `201`+落盘；缺省**不写 key**；非法值 400 且文件 sha 不变；`null` 真删 key。`injectAgentsMd` 显式 `false` 落盘、缺省不写 key、PATCH 省略保留、非布尔 400。
- **名称规则**：**3..50 码点** + `^[\p{L}\p{N}-]+$/u`；实测 `2=400` / `3=201` / `50=201` / `51=400`、中文 3 字 `201`；**emoji 被拒是因为字符类**（`😀😀😀` 是 3 码点、长度合法），**空格/下划线被拒**；文案逐字命中。**读盘不校验**：手写 1 字名与含空格名仍可 read，且**其它字段可改、可启禁、可删除**（只有请求里带上 `name` 才按新规则校验）。
- **隐藏字段保留**：界面不再展示 `maxTurns`/`maxConcurrentInstances`，但**契约与存储不变**——手写 `maxTurns=12`/`maxConcurrent=3` 后 PATCH 其它字段（真实 HTTP），两值**原样保留**。
- **运行时注入**：`injectAgentsMd:true` → 子会话上下文含父 cwd 的 `AGENTS.md` 哨兵；`false`/缺省不含；两者 `systemPrompt` 仍取定义；**不是沙箱、不授予权限**。
- **⚠ 合成探针与真实模型的结论不一致**：合成 SDK probe 里子 active 只有 `['read']`（看着像 ∩ 生效），但 **live r1 的子 `effectiveTools` 含 `bash`/`write`/`edit`**（父 active 并没有这些）。**以真实模型为准**——合成证据**不能**替代 live，交集语义在真实路径上确实失效（根因见「live 轮次」r1）。

### live 轮次（真实模型）

- 模型固定 `cmdc` / `deepseek/deepseek-v4.1-flash`；**总预算 3 次父 prompt**（子调用是实现内部成本，不另计）。
- **最终账：父 prompt 3 / 3 全部发出**（`attempts.json` 3 条均 `promptSent=true`），**每轮各 1 次 child**；**未重置预算、不重跑旧轮、不补跑**。原始报告：`/tmp/pi-webx-subagents-implementation/live/verify-live.md`（172 行，§9 为最终判定）。

**逐轮结果（历史保留，不改写）**：

| 轮 | 领域 | 自动委派 | `details.effectiveTools` | 判定 |
|---|---|---|---|---|
| r1 | 代码复审 | 有 `subagent` 调用 | `["read","bash","powershell","edit","write","grep","find","ls"]` ← 越出父 active | **FAIL（权限越权）** |
| r2 | 测试用例 | 有 `subagent` 调用 | 同上越权 | **FAIL（权限越权）** |
| r3 | 故障归因 | 有 `subagent` 调用 | **`["read","grep"]`**（当时口径：⊆ 父 active） | **PASS 13/13** |

- r3 运行事实：`turns=4`、`durationMs=14017`、`truncated=false`、整轮 ≈24.1s 未超时、child 调用 1 次（≤3）；父 final 正确汇总子结论（`payload.items` vs `payload.data.items` **错层**判定）。
- 三轮**其余判据均通过**：toolCall 存在、args 恰为 `agentId`+`task`、`agentId` 匹配本轮 enabled 定义、toolResult `isError=false` 且非空、`details` 必需键齐、`model` 精确、不含派发工具、final 非空、父无 bash/write 旁路、child ≤3。**r1/r2 的唯一 FAIL 就是 `effectiveTools ⊆ 父 active`**。
- **根因（历史）**：`server/pi/host.ts:563` 的 `parentRegistry` 取 **`getAllTools()`（完整注册表）** 而非父 **active**；与**当时**的冻结口径冲突（「定义允许 ∩ 父 active」——该口径在只读豁免后已改写为「非只读 ⊆ 父 active；只读豁免」）。**定性：应用层工具面越权，不是 OS 沙箱结论。**
- **修复（task-45）**：`host.ts:569` 改为 **`parentActiveTools: () => hosted.session.getActiveToolNames()`**，`subagent-tool.ts` 同步用 `parentActiveTools` 语义；`getAllTools()` 仅保留在**与权限无关**处（`get_tools` 的 UI 目录、定义页工具目录、`deniedToolNames` 的**更宽 deny**）。
- **独立验证（task-46）**：`verify-parent-active.md` **7/7 PASS**，含 **RED 自检**（用旧接线喂入必须复现越权 → 确认探针有牙）、`selected` 缺口点名不静默授予、父 active 空 → `surface=[]`、以及**不过度收紧**（父含 bash/write 时 surface 相应放宽）。
- **修复已由 live 验证**：r3 的 `effectiveTools=[read,grep]` 就是同一语义下的真实模型确认。
- **最终口径（Lead 决议，逐字）**：**共 3 次父 prompt 全部发出；前 2 次因权限越权失败（历史记录保留），task-45 修复后第 3 次通过。** —— **不是 3/3 全过**；成功率**不泛化**（每领域各一次）；**不证明 OS 沙箱**。
- 修后仅 1 次样本，**不得**把它当作稳定性概率（1/1 不是"通过率"）；也不得以"1 次没复现"否定历史 FAIL。

### Agent Team P2 怎么手工验（无 UI）

> P2 = 编排角色 + Team 运行时 + 受控成员工具面 + 2 个只读路由；**无 Team 面板**。完整记录见 [`notes/implemented/feature/2026-09-22-agent-team-p2.md`](../../notes/implemented/feature/2026-09-22-agent-team-p2.md)。

**Given** 用带 `teamMode: true` 的 body 建会话（`server/routes.ts:656` 本地解析，不改 shared 契约）  
**Then** 该会话 active 出现 **9 个 Team 工具**（`list_team_members`/`dispatch_agent`/`send_team_message`/`list_team_tasks`/`get_team_task`/`create_team_task`/`update_team_task`/`wait_team`/`interrupt_agent`）  
**And** **`subagent` 既不激活也不注册**（`customTools.length === 9`）  
**And** 响应里**没有 `teamId`**（`SessionSummary` 冻结（`src/shared/protocol.ts:546-566` 无 `teamId` 字段）、WS 帧未变）——**你只需要记住 session id**  

**When** `GET /api/teams/<sessionId>`（**别名**：`GET /api/teams/:idOrSessionId`，`server/routes.ts:617`；解析在 `PiHost.resolveTeamId`，`server/pi/host.ts:814-816`）  
**Then** 能拿到投影（**不必先知道 teamId**）；**teamId 优先**（同 id 的会话不遮蔽 team）、**非 team 会话 id 仍 404**、未知 id → **404**  
**And** `from`/`to`/`teamId` **由宿主填写**；模型写的这些字段只出现在 `untrustedPayload`、任务标题只在 `untrusted.title`；投影**不含**定义 `systemPrompt`；成员视图只给 `hasResult`（不给 `resultText`）  

**When** `POST /api/teams/<sessionId>/cancel`（`:634`）  
**Then** 返回 **`{teamId, cancelled, reason}`**——**回显的 `teamId` 就是规范 teamId**，此后可用它寻址；成员进 `cancelling`，settle 后可读；非字符串 `reason` 不被注入  

**When** 在成员会话里试 `dispatch_agent`  
**Then** `Tool dispatch_agent not found`（成员只有 `update_team_task` 仅自己任务 + `send_team_message` 仅发给 lead）  

**When** 重启进程后再 `GET /api/teams/<sessionId>`  
**Then** **P2 时期是 404**（状态全内存）；**P3-A 起**按 journal 重放后应为 **200**（append 到磁盘、**无 fsync**，不承诺掉电安全）——见下文「P3-A 怎么手工验」  

#### 真模型 smoke 结论（2026-09-22，task-94）

**可用（端到端走通）**：1 条 prompt 内建 3 个任务（含 1 条 `blockedBy`）、**同一轮并发派 2 个成员**、依赖解锁后派第 3 个、CAS 收尾前先吃 **两次 `TEAM_TASK_STALE_REVISION`** 再读回、最终汇总；**0 abort / 0 timeout / 0 retry / 0 次 `subagent`**（会话 `http://127.0.0.1:8789/?session=01a0c9a2-d856-7744-beba-bbffc2fe54e1`；证据在**仓库外** `/tmp/pi-webx-p2-smoke/verify-p2-live.md`）。3 个成员 `effectiveTools` **不含** 7 个禁止的编排工具与 `subagent`。  
**F1 修复的独立复验**：`/tmp/pi-webx-p2-verify/a5-team-alias.ts` **14 pass / 0 fail**（含验证者自造歧义用例）；红绿 **8 pass / 6 fail**（别名分支改红）；报告 `/tmp/pi-webx-p2-verify/verify-f1-fix.md`。

**未验证（手工也验不了）**：真模型下 **`wait_team` 未用上**、**`running→cancelling→cancelled` 未在真模型触发**、**成员在真模型里未调用任务板工具且成员会话 in-memory ⇒ 成员内部工具调用事后不可审计（P3 需投影或落盘）**；被中止 turn 真实退出并释放槽位的时机；`cancelling` 与写入的真并发竞态；P3 持久化边界。

**P4 输入（验证者独立观察）**：① **`teamMode` 是每次创建/恢复请求上的选项、不随会话存档**——恢复 team 会话不带 `teamMode` → 201 但 `GET /api/teams/<id>` **404**；带上 → 别名 GET/cancel 均 **200** ⇒ **P4 的 UI 刷新/重开必须带 `teamMode`**。② **没有 assistant 回合的 team 会话转录不落盘**（`POST /api/sessions {sessionId}` → **404 no stored session**），重启后连会话都恢复不了。

### P3-A 怎么手工验（无 UI）

> P3-A = append-only TeamJournal + 启动重放 + 投递机会账本。完整记录见 [`notes/implemented/feature/2026-09-22-agent-team-p3.md`](../../notes/implemented/feature/2026-09-22-agent-team-p3.md)。

**Given** 建一个 `teamMode: true` 的会话，并用 `POST /api/teams/<sessionId>/cancel` 或 `GET /api/teams/<sessionId>` 拿到规范 `teamId`（响应里本来没有 `teamId`）  
**When** kill 进程，再用**同一 `PI_CODING_AGENT_DIR` / journal 目录**重启  
**Then** `GET /api/teams/<teamId>` **与** `GET /api/teams/<sessionId>` 都应 **200**，且**逐字节相同**（返回重放后的 `members` / `tasks`）  
**And** 原本 in-flight 的成员应为 **`interrupted`**、**只有曾 settle 的成员恢复 `resultText`**（**成员不可复活**）  
**And** 未知 id 仍 **404**；`teamId` 优先级不变  

**When** 看启动日志  
**Then** 成功重放时打印 **`files` / `teams` / `unusable` / `skipped`** 四个量（`teams` = 重放后内存里的 team 数）；**journal 不可用**（路径被占位/不可写，`EEXIST`/`ENOTDIR`/`EACCES`）→ 打印 `team journal unavailable (<原因>)` 并**退化为纯内存模式**，服务器照常启动  

**When** 重启后 `POST /api/sessions {sessionId}`  
**Then** 仍 **404 `no stored session`**——**会话本身仍不可 resume**（没有 assistant 回合就没有转录）；这与「Team 投影可重放」**不矛盾**  

**未验证 / 不能承诺（写清楚）**：**不承诺掉电安全**（每行 `appendFileSync`、**无 fsync**）；**不支持多进程并发写**同一 journal；真实 `kill -9` 未验；**P3-B 注入未实现**（`claimDelivery` 只记「投递机会已用掉」）；真模型下「重启 → 恢复 → 继续派成员」未跑。证据（仓库外）：自测 `check-agent-team-journal.ts` 15/15 与 `check-agent-team.ts` 33/33；独立验证 `/tmp/pi-webx-p3-verify/verify-p3a.md`（j1 21/21 · j3 10/10 · j2 14/2）与 `/tmp/pi-webx-p3-verify/verify-p3a-followup.md`（**j2 25/25 · j3 15/15 · j1 21/21** + 真进程重启 E2E）。

### 工程门禁（**本轮 task-77**，出处 `/tmp/final4-*.log`；上一轮 task-76 同样四项 exit 0）

| 命令 | 实测结果 | 出处 |
|---|---|---|
| `npm run typecheck` | **exit 0**（`tsc --noEmit` 无输出，`error TS` 计数 **0**） | `/tmp/final4-typecheck.log` |
| `npm run check` | **exit 0**（22 段脚本全过；日志 **158** 行、`ok` 行 **118**、`ALL CHECKS PASSED` **7** 块；store **32 例**、API **16 例**） | `/tmp/final4-check.log` |
| `npm run build` | **exit 0**（`✓ built in 3.57s`） | `/tmp/final4-build.log` |
| `git diff --check` | **exit 0**（输出为空） | `/tmp/final4-diff-check.log` |

- **唯一警告（如实记录，非失败）**：vite `Some chunks are larger than 500 kB after minification`。
- **计数与门禁一致**：store 段 32 条 `ok`、API 段 16 条 `ok`；UI 末行 `check-agent-definitions-ui: ok`，其 **250** 为源码静态 `assert.` 计数（**非运行期计数**）。
- **本轮脚本规模变化**：`check-subagent-tool.ts` 1416 → **1601 行**（新增逐字比对守卫）、`check-subagent-sdk.ts` 984 → **1009 行**（新增描述/schema 断言）。
- **产物指纹**：本轮**只改服务端**，前端包**未变**——仍是 **`assets/index-BvK7ArLb.js`**，sha256 `2587fad70faa45c0bee320ea0c24b8743b697c7ba0be47c8650b4d2bb0af67b8`。
- **工作树状态**：`git status --short` **31 项**（10 改 + 21 未跟踪），**未 add / 未 commit**。

### 已修缺陷（TC3 复验通过，关闭）

- **指定模型下拉被 `/` 截断**（旧构建 `index-DVC9gqZp.js`）：`AgentDefinitionsSection.tsx` 曾用 `providerId + "/" + modelId` 作 option value，又用 `split('/')` 解析，导致 `deepseek/deepseek-v4.1-flash` 被截成 `deepseek` → `PATCH` 400「模型不可用」，TC3 FAIL。
- **修法与复验（新构建 `index-C9DY9qWv.js`）**：option value 改为 **JSON tuple `["cmdc","deepseek/deepseek-v4.1-flash"]`**，`modelId` 含 `/` 时完整保留。复验实测：
  `POST 201`（body 里 `model.modelId = "deepseek/deepseek-v4.1-flash"`、`thinkingLevel:"low"`）→ rev14；**reload 后仍为指定模型 + `low`**；
  `PATCH {"model":{"mode":"inherit"},"thinkingLevel":null} → 200` → rev15（复测 rev16→rev17 行为一致）；**`GET` 无 `thinkingLevel` key**（删除语义）；
  最后经 UI 删除 `DELETE rev17 → 200` rev18，`GET = revision 18 / agents []`。
- 判定：**TC3 PASS → TC-11 整组 9 PASS / 0 FAIL**（口径仍是**无模型调用的 UI 维度**）。

### 已知测试局限（不要当产品沙箱）

- **✔ 已修复的历史安全 blocker（保留记录）**：真实模型 r1/r2 的自动派发**成功**，但子会话 `effectiveTools` 越出**当时的**父 active 上限（拿到 `bash`/`write`/`edit`）→ 应用层工具面越权。**注意 `bash`/`edit`/`write` 至今仍严格 ⊆ 父 active，绝不在只读豁免范围内。**根因：host 用 **`getAllTools()`（完整注册表）** 而非父 **active**。修复：`host.ts:569` 改 `parentActiveTools = getActiveToolNames()`（task-45）。**独立 host 验 7/7**（task-46，含 RED 自检）+ **live r3 实测 `[read,grep]`** 确认已闭合。**历史 FAIL 不删除、不改写**；**仍不声称 OS 沙箱**。
- **指纹口径**：真实的 `models.json` / `auth.json` / `settings.json` **三个文件**在实例运行前后 size/mtimeMs/sha256 完全一致——**只能这么说**，不得升级为「整个 agent dir 未被触碰」（实例会**按显式路径读**这两个配置，且真实 agent dir 其他内容未做整体指纹）。
- **`scripts/subagents-test-server.ts` 只是 test-scope 请求白名单**：它按已列合法 API 形状放行、未知请求 403，**不是**产品级沙箱。
- 该实例**不保证**：OAuth 凭据（遇到即阻塞，只报类型）、多会话/并发上限行为、真实模型轮次（UI/live tester 自己跑 prompt 会**产生真实调用与计费**）。
- 服务生命周期绑定在启动者（owner agent）上：owner 退出会**连带停服**，曾造成一次短中断；另有一次准备期误创建已撤回，**未消耗 LLM 预算**。证据：`live-test-server-handoff.md`「生命周期」「范围偏差记录」。
- **未验证（不得当 PASS）**：`sweep` 在有 active worker 时不杀父（需真实 worker 生命周期 + 60s 窗口）、timeout 真实时钟、`maxTurns` 真实工具续轮、同 cwd 可信扩展 fixture 的独立 child ctx。**工程门禁已跑（见上文实测表，四项 exit 0，不再是未验证项）**。
- **真实模型与浏览器渲染由独立验收者实跑**：live 三轮（`verify-live.md`，2 FAIL + 1 PASS 口径）+ 浏览器三轮（`browser/t53*`）；本文不改写这些结论。
- **曾经的窄屏缺陷已修**：390 下「模型设置」裁切不可达已修复并经独立复测 **B7–B9 PASS**（见上文专节）。
- **本轮未验证（不得当 PASS）**：
  1. **真实模型的同轮双派端到端**：`verify-concurrency.md` 无真模型；用户复测会话暴露的「第二个被拒 + `details={}`」后端已换实现，但**未由真实模型重跑**。
  2. **`capacity-timeout` 的真实墙钟路径**：独立验收与 task-87 的 C4 **都只用可控 fake 预算**（C4 用 40ms），**真实墙钟未验**。
  3. **FIFO/到达顺序与全局 `MAX_WORKERS` 上限只在仓库外 harness 有证据**（`verify-runtime-races.ts` C1/C3），仓库内脚本未覆盖。
  4. **`pump()` 不是严格全局 FIFO**：本轮只断言「单全局槽 + 三个不同定义」下的到达顺序。
  5. **UI/会话面板对失败文本的渲染**：未验（无浏览器）。
  6. `model-error` / `invalid-model` 未在本轮单独构造；`runId` 在部分失败码缺席是否**设计期望**未与实现者确认（报告按「若已分配」口径判读）。
- **残余观察（独立验收者列出，不构成 FAIL）**：
  1. **ZCode 的 Environment 层（dispatch 期）未移植**（cwd / 是否 git / platform / shell / OS + 模型名）——**用户定义同样没有**，不是内置独有缺口。
  2. **`general-purpose` 的 prompt 保持 ZCode 原文**（仍写 `Use Read`）；**只有 Explore 做了工具名归一**。
  3. **内置带产品原生字段**：`readOnly:true`、`maxConcurrentInstances:1`、`revision:1`、`createdAt/updatedAt:''`——**ZCode 无对应字段**。

---

## TC-01 定义 CRUD 与空态（P0/Critical）

**Design Ref**: notes §管理面 / §存储 · **Preconditions**: 环境变量已导出；`$PI_WEBX_SUBAGENTS_FILE` 指向的文件**不存在**（空态起点）；后端在该端口运行。

**Given** definitions 文件尚不存在  
**When** `curl -sS "$BASE/api/agent-definitions"`  
**Then** HTTP 200，且响应 `schemaVersion == 1`、`revision == 0`、`agents` 为空数组、`path` 等于 `$PI_WEBX_SUBAGENTS_FILE`  
**And** 文件可能尚未创建（空态允许惰性建文件）；若创建，其内容等价于空态  

**When** `curl -sS -X POST "$BASE/api/agent-definitions" -H 'content-type: application/json' -d '{"expectedRevision":0,"definition":{"name":"代码复审员","description":"审查改动并给出行级意见","systemPrompt":"你只做只读审查。","model":{"mode":"fixed","providerId":"cmdc","modelId":"deepseek/deepseek-v4.1-flash"},"thinkingLevel":"low","tools":{"mode":"all"},"maxTurns":8,"maxConcurrentInstances":1,"enabled":true}}'`  
**Then** **HTTP 201**；响应 `revision == 1`；`agents` 长度 1；该 agent `revision == 1`、`id` 是 UUID 形状、`enabled == true`、`name == "代码复审员"`（中文名保留）  
**And** 记下 `ID` 与当前 `revision`，写入 `$RUN_DIR/evidence/tc01-*.json`  

**When** 再次 GET，然后 PATCH `"$BASE/api/agent-definitions/$ID"`（写状态码：**POST=201，PATCH/DELETE=200**） 发送 `{"expectedRevision":1,"patch":{"description":"审查改动并给出可执行建议"}}`  
**Then** HTTP 200；响应 `revision == 2`；该 agent `revision == 2`、`description` 已更新、**`id` 未变**、`createdAt` 未变而 `updatedAt` 变化  

**When** DELETE `"$BASE/api/agent-definitions/$ID"` 发送 `{"expectedRevision":2}`  
**Then** HTTP 200；`revision == 3`；`agents` 中不再含该 `id`  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-02 默认 `tools: all` 与 `enabled` 必填（P0/Critical）

**Design Ref**: notes §冻结契约 / §管理面（**POST=201**；`enabled` 是必填，默认值由 **UI factory** 发送，服务器不猜）

**When** 用 tsx 运行工厂并把结果打印为 JSON（路径相对 `$PROJECT_ROOT`）  
**Then** 输出满足：`name===""`、`description===""`、`systemPrompt===""`、`model.mode==="inherit"`、`tools.mode==="all"`、**`enabled===false`**、`maxTurns===8`、`maxConcurrentInstances===1`  
**And** 用 `$AGENT_DEFINITIONS_FILE` 记录 before 的 `revision` 与 `hash`  

**When** POST 一个新定义但 **省略 `enabled`**  
**Then** **HTTP 400**（缺必填，错误信息点名 `enabled`）  
**And** 定义文件**未被改动**：`revision` 与 `hash` 与 before 完全一致，`agents` 数量不变  

**When** 重复同一 POST，但按 UI factory 的实际行为显式带上 `"enabled":false, "tools":{"mode":"all"}`  
**Then** **HTTP 201**，创建成功且 `enabled == false`  

**When** 在普通对话里请主 agent 委派这个**未启用**的定义  
**Then** **委派不发生**：transcript 中 `subagent` 工具调用计数为 **0**，也没有子会话结果  
**And** 断言为结构断言（数调用与 `details`，不比对自然语言措辞）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-03 坏输入：非法 JSON / 未知字段 / 超长 / 重名（P0/Critical）

**Design Ref**: notes §冻结契约（长度常量、casefold 去重）

**Given** 已有一个定义 `name: "spawn"`（或任意名）  
**When** 依次发送下面四个请求  
**Then** 每个都**被拒绝**（HTTP 4xx，带可读错误），且**文件内容不变**（前后 `revision` 与 `agents` 完全一致）  

| 子例 | 请求 | 期望 |
|---|---|---|
| a 非法 JSON | body 为 `{"expectedRevision":1,"definition":`（截断） | 4xx，错误信息可读，**非** 500 |
| b 未知字段 | `definition` 里多一个 `"color":"blue"` | 4xx（未知字段拒绝，不静默忽略） |
| c 超长 | `name` 长度 65 / `description` 长度 501 / `systemPrompt` 长度 32001（三个分别试） | 每个 4xx，错误指出超限字段；**长度按 code point 计**（40 emoji 必须**允许**，64 允许 / 65 拒绝） |
| e 选中工具超限 | `tools: {mode:"selected", names:[…129 项]}` | 4xx（上限 **128**）；UI 侧同一上限并给出可读提示 |
| d 重名 | 再 POST 一个 `name: "SPAWN"`（大小写不同） | 4xx，指出重名；原定义不受影响 |

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-04 文件级 CAS（P0/Critical）

**Design Ref**: notes §管理面（`expectedRevision` 是文件级 CAS）

**Given** 已有 1 个定义，文件 `revision == 1`  
**When** 用**过期**的 `{"expectedRevision":0}` PATCH 该定义  
**Then** HTTP **409**；错误信息说明版本冲突；文件 `revision` 仍为 1、该定义内容未变  
**And** 同一过期版本再 DELETE → 同样 409，且定义仍在  
**When** 用**当前** `{"expectedRevision":1}` 执行同一 PATCH  
**Then** HTTP 200，`revision == 2`  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-05 重载与隔离目录（P0/Critical）

**Design Ref**: notes §存储（`PI_WEBX_SUBAGENTS_FILE` 覆写）

**Given** 用 `PI_WEBX_SUBAGENTS_FILE=$RUN_DIR/agent-definitions.json` 新建了 1 个定义  
**When** 停掉后端后重新启动（同一 env），再 GET  
**Then** 读到**同一**定义（`id`、`name`、`revision` 一致）；证明真值来自该文件而非内存  
**And** 断言 `response.path` 等于 `$PI_WEBX_SUBAGENTS_FILE`  
**And** **无写断言（B1 定点）**：对**明确路径**取证，而不是引用未导出的变量。档 1 下定义文件在 `$AGENT_DEFINITIONS_FILE`；  
真实配置面用 `$REAL_AGENT_DIR` 下三个文件逐一 before/after 比对，**只取 stat/hash，不输出内容**：  
  - `stat -f '%m %z' "$REAL_AGENT_DIR/models.json" "$REAL_AGENT_DIR/auth.json" "$REAL_AGENT_DIR/settings.json"` → before/after **完全一致**；  
  - `ls "$REAL_AGENT_DIR/sessions" | wc -l` → **未增加**（档 1 不产生真实转录）；  
  - `shasum -a 256 "$AGENT_DEFINITIONS_FILE"` → 只反映我们自己的定义写入，与真实配置无关。  
**And** **正向对照**：`$PI_CODING_AGENT_DIR`（= `$RUN_DIR/agent-dir`）下的 `sessions/`、`models-store.json` 与定义文件**按预期变化**——证明本实例的写路径是活的、真实目录「没动」不是因为什么都没发生。  

> 本档刻意让 `PI_CODING_AGENT_DIR` 指向 tmp，所以真实 `agentDir` 的 **extensions / skills / context 不参与**；
> 但不要写成「`PI_CODING_AGENT_DIR` 不改真实目录」或「绝不触碰 agentDir」——档 2 会**读**真实 auth/models（见环境节三个动作）。

**Cleanup**: 停后端；`rm -rf "$RUN_DIR"` 中生成的 definitions 文件

## TC-06 取消派发（P1/High）

**Design Ref**: notes §决策（派发是同步 toolResult）

**Given** 有一个 enabled 定义；一次会产生明显耗时的工作（例如让它读多个文件）  
**When** 主 agent 发起委派后，用户在 UI 里**取消**当前轮  
**Then** 该 `subagent` 工具调用终止（transcript 中该调用为取消/错误终态，而**不是**成功结果）  
**And** **没有**留下子会话继续跑的痕迹（无新增子会话结果/事件）  
**And** 说明"取消是协作式"：已经写出的文件**不回滚**（若用例触发了写入，断言文件仍在，并注明这是预期）  

**Cleanup**: 无（取消用例不改定义文件）

## TC-07 disabled 定义立即拒绝（P0/Critical）

**Design Ref**: notes §决策（重读 enabled，不 kill 当前）

**Given** 有 1 个 enabled 定义，且刚刚成功委派过一次  
**When** PATCH 把它改成 `enabled:false`（带当前 `expectedRevision`），然后**再**请主 agent 委派同一个 `agentId`  
**Then** 第二次委派**被拒绝**：没有新的子会话结果；transcript 中该次调用为错误终态，错误可读（说明该 agent 未启用）  
**And** **第一次**委派的结果**仍在**（不被回溯撤销），当时的进行中调用**没有被 kill**  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-08 派发不接受覆盖（P0/Critical）

**Design Ref**: notes §决策（`subagent({agentId, task})` 只有两项）

**Given** 有一个 enabled 定义，其 `model.mode == "inherit"`  
**When** 查看 `subagent` 工具的参数 schema  
**Then** 只有 `agentId` 与 `task` 两个属性；**没有** `model`/`systemPrompt`/`tools`/`thinkingLevel` 之类字段  
**And** 即使模型在调用里塞入额外字段（若协议允许），它们**不生效**：子会话结果中记录的模型/工具与定义一致（结构断言，不比对自然语言）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-09 防递归（P0/Critical）

**Design Ref**: notes §决策（有效集 = 交集 − subagent − 派发/配置工具）

**Given** 有一个 enabled 定义，其 `tools.mode == "all"`，父 session 使用 `default` 预设  
**When** 让子 agent 尝试再派发一个子 agent（提示它"需要再委派"）  
**Then** 子会话的工具列表里**没有** `subagent`（也没有其它派发/定义管理工具）  
**And** transcript 中该子会话内 `subagent` 调用计数为 **0**；子 agent 以文字说明无法继续派发  
**And** 父会话仍能正常派发（功能未被误伤）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-10 `selected: []` 纯推理合法（P1/High）

**Design Ref**: notes §决策（无最小一项限制）

**When** POST 一个 `tools: {"mode":"selected","names":[]}`、`enabled:true` 的定义  
**Then** HTTP 200，保存成功（**不**报"至少选择一项"）  
**When** 委派它，并让它去读一个文件  
**Then** 子会话可用工具集为空 → 它**无法**读文件，并如实说明没有工具  
**And** 结果仍是正常同步 toolResult（不是崩溃/超时）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-11 UI：新增/编辑/启禁/删除 + 409 草稿保留（P1/High）

**Design Ref**: notes §范围；契约字段表 · **Preconditions**: 隔离端口的 UI 已打开于指定浏览器空间

**Given** 设置页打开"**子智能体**"分组（ZCode 1:1 后的文案），列表为空  
**When** 点击空态里的"新增"  
**Then** 出现字段级表单，**字段顺序为 名称 → 颜色标记 → 模型 →（思考档位）→ 描述 → 可用工具 → 系统提示词 → 注入 AGENTS.md**；**不再展示 `maxTurns` / `maxConcurrentInstances`**（契约与存储不变，保存时原样保留）  
**And** `enabled` 默认**关闭**  

**When** 填一个中文 `name`、选 provider `cmdc` / model `deepseek/deepseek-v4.1-flash`、tools 保持"全部"，保存  
**Then** 列表出现该项，显示状态"已禁用"与所引模型  
**When** 打开 `enabled` 开关  
**Then** 列表状态变为"已启用"（无需刷新整页）  

**When** 在另一个客户端先改同一定义，然后本页提交一次编辑  
**Then** 服务端返回 **409**，UI 提示"配置已被他处修改，请刷新"，**且本页草稿仍在**（不丢用户输入）  
**And** 刷新后草稿按提示处理（刷新动作由用户确认，不在断言里强制）  

**When** 删除该项  
**Then** 出现**二次确认**；确认后从列表消失  
**And** 浏览器空间被收回时**立即停止**本用例并记 NOT RUN  

**Cleanup**: 删除运行目录内 definitions 文件

## TC-12 普通对话自动委派（P1/High，LLM 非确定性）

**Design Ref**: notes §范围（普通对话自动调用）

> **本轮 verdict：PARTIAL**（见对照表）。3 次测试**已执行完**：r1、r2 历史 FAIL（工具面越权）+ 修后 r3 PASS 13/13，**自动调用 3 次均发生**；但本 TC 的 PASS 门槛是 **3/3 全条件通过**，实际前 2 次 FAIL → **不达 PASS**。**测试任务已完成 ≠ 本 TC 全过**，也不为凑 3/3 追加轮次。

**Given** 有 2 个 enabled 定义，描述区分明显（例如"代码复审员"与"测试用例作者"）；模型固定 provider `cmdc` / model `deepseek/deepseek-v4.1-flash`  
**When** 在**普通对话**里提一个明确属于其中一个的请求，**不**点名任何工具（不提 `subagent`、不提 agent 名）  
**Then** 主 agent **自发**调用 `subagent`，`agentId` 指向**已启用**的那个定义  
**And** transcript 里出现该子调用的结果，主 agent 基于结果作答  
**And** 断言为**结构断言**：①存在 `subagent` 调用；②`agentId` ∈ enabled 集合；③结果非空。**不**比对自然语言措辞  

**预算（硬上限）**：**总共最多 3 次父 prompt**（子调用是实现内部必要成本，**不另计轮次预算**）。
**3/3 通过 → 本周目记通过；2/3 → 记「不稳定」并报观察值，不追加补跑、不泛化结论。** 3 轮后仍不自动委派 → FAIL 并给出 tool description 的具体分析，**仍不追加轮次**。

**每轮断言（缺一不可，全部为结构断言）**：

1. 父 assistant 出现名为 **`subagent`** 的 toolCall，参数键**精确等于** `agentId` + `task`（无 `model`/`systemPrompt`/`tools` 等覆写键）。
2. `agentId` ∈ 当时 enabled 集合，且等于该轮预期定义 id。
3. toolResult 的 `details` 含**必需字段**：`agentId`、`definitionRevision`、`runId`、`model:{provider,id}`、`effectiveTools`、`turns`、`durationMs`、`truncated`。
   **必需字段缺失或异名即 FAIL**；**不要求**任何额外的 `finished` 字段（该字段不存在）。
   另有**条件键**：`excludedTools`（有受限工具被排除时）、`unavailableTools`（有许可但实际缺失的工具时）——它们**非空才出现**，所以断言要用「必需 8 键存在」而**不是** `deepEqual` 整组键。
4. 父最终 assistant **非空**且引用了子结论的可判读要点（不比对自然语言措辞）。
5. 父侧无旁路：父工具面为 `read`/`selected`；若父自行写文件或自行完成本应委派的工作 → 该轮 FAIL。
6. 模型错误（`isError`）或子结果为空 → 该轮 **FAIL**。

**证据采集（可执行框架；具体脚本由 harness/tester 补）**：每轮独立 `$RUN_DIR/evidence/`，用 HTTP 只读取证，**不把原始密钥内容混入证据**：

```bash
# 轮次 r 的会话 id
SID_R=<该轮会话 id>
curl -sS "$BASE/api/sessions/$SID_R/messages" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d)[:200])'   # 断言 1/4：找 toolCall name=subagent
curl -sS "$BASE/api/sessions/$SID_R/tools"                                                              # 断言 5：父 active 工具面
curl -sS "$BASE/api/sessions/$SID_R/state"                                                              # 断言 3：details / turns / durationMs / truncated
```
> 上述三条路由名以实现为准（`get_messages` / `get_tools` / `get_state` 语义）；证据里只留**摘录**与计数，不留密钥或整段原始转录。

**阴性**：若提示明显不属于任一 agent，则不要求必须派发（允许直接回答）

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`；停掉隔离 server

## TC-13 阴性：无定义 / 全 disabled / 父 none（P0/Critical）

**Design Ref**: notes §决策（父 `none` 不能调；disabled 立即拒绝）

| 子例 | 前置 | When | Then |
|---|---|---|---|
| a 无定义 | definitions 空 | 请求一个本该委派的任务 | `subagent` 调用计数 0；主 agent 说明没有可用子智能体（不得编造） |
| b 全 disabled | 有定义但全部 `enabled:false` | 同上 | `subagent` 调用计数 0 |
| c 父 none | 有 enabled 定义；父 session 用 `none` 预设 | 让主 agent 去派发 | 主 agent**没有** `subagent` 工具可用（工具列表断言），调用计数 0 |

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-02b N2：`thinkingLevel` 三态清除（P0/Critical）

**Design Ref**: 契约 `AgentDefinitionPatch`（省略=保留 / 字符串=设置 / **`null`=删除回落继承**）

**Given** definitions 文件为空态，`revision == 0`；档 1 环境已导出  
**When** POST 创建定义 A，显式带 `"thinkingLevel":"high"`（`enabled:false` 可）  
**Then** **HTTP 201**；响应中该 agent 的 `thinkingLevel == "high"`；记 `ID` 与该次响应 `revision`  

**When** PATCH `"$BASE/api/agent-definitions/$ID"`，body 为 `{"expectedRevision":<R>,"patch":{}}`  
**Then** HTTP 200；该 agent 的 `thinkingLevel` **仍为 `"high"`**（**省略 ≠ 清除**，`{}` 是不写盘的读回）  
**And** 文件 `revision` **不变**（空 patch 不 bump revision）  

**When** PATCH 发送 `{"expectedRevision":<R>,"patch":{"thinkingLevel":null}}`  
**Then** HTTP 200；响应里该 agent **不再含 `thinkingLevel` key**（属性被删除，不是 `null`、也不是空字符串）  
**And** 落盘文件里该 agent 的 JSON **同样不含** `thinkingLevel` key（用 `python3 -c` 读文件断言 key 不存在）  
**And** 文件 `revision` 已 +1  

**When** 再次 PATCH 发送 `{"expectedRevision":<R2>,"patch":{"thinkingLevel":"low"}}`  
**Then** HTTP 200；`thinkingLevel == "low"`（清除后仍可重新设置）  

**When** PATCH 发送 `{"expectedRevision":<R3>,"patch":{"thinkingLevel":"bogus"}}`  
**Then** HTTP 4xx；`thinkingLevel` 仍为 `"low"`，文件 `revision` 不变  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-14 B2：动态 `enabled` × 父 `none` / 父空选择（P0/Critical）

**Design Ref**: notes §决策（每次派发重读 enabled；`all` = 父 active − restricted；`selected` 下只读名豁免、其余 ⊆ 父 active；父 `none` 不能调）

> 这是**同一会话两步**的用例：定义在会话进行中从 `false` 变成 `true`，刷新不得把 `subagent` 从 inactive 翻成 active。
> **档 2（真实 SDK）**；本用例的断言面是 `get_tools` + `get_state` + 本地 SDK probe，**不需要真正调用模型**（不占 live 轮次预算）。

**Given** 档 2 环境；后端已起（`scripts/subagents-test-server.ts` **已存在**；无法启动则本用例记 NOT RUN）  
**And** 已有一个定义 D，初始 `enabled:false`；父会话以 `none` 档创建，记 `SID`  

**When** 对该父会话取工具面：`curl -sS "$BASE/api/.../get_tools?sessionId=$SID"`（具体路由以实现为准）  
**Then** 父会话 active 工具列表中**不含** `subagent`  
**And** 用 `curl -sS "$BASE/api/.../get_state?sessionId=$SID"` 记录状态作为 before  

**When** 另一个客户端（`curl`）PATCH D 为 `enabled:true`（带当前 `expectedRevision`），然后再次触发该会话的正常 prompt/queue drain/idle followup 路径（即实现里会刷新 `store.read` + `refreshTools()` 的路径）  
**Then** 该会话工具列表**仍不含** `subagent`（`none` 档下刷新**不得**悄悄启用）  
**And** 若本会话产生一次 `subagent` 调用，**该会话的调用计数必须为 0**；非 0 即 FAIL  
**And** 断言面优先用**真实 SDK fixture probe**（`scripts/check-subagent-sdk.ts`，**已存在**）固化「refreshTools 后父空选择仍为空」，避免依赖活模型  

**When（空选择子例）** 父会话工具选择为空数组（`toolSelection=[]`）而非 `none` 档，重复上面两步  
**Then** 与 `none` 档结论一致：刷新后 active 仍为空，`subagent` 计数 0  

**When（对称正例）** 把父会话切到**包含 `subagent` 的档位**（或所选集合里含 `subagent`），同一会话再请它委派 D  
**Then** 此时 `subagent` 出现在 active 工具中，且**新增**的许可工具可用（正例证明上一步的 0 不是「一律不能用」）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`；停掉隔离 server

## TC-15 颜色标记 `color`（8 色 / 可空 / `null` 清 key）（P1/High）

**Design Ref**: notes §冻结契约（新增字段）· 独立验收 `/tmp/pi-webx-subagents-implementation/verify-zcode-contract.md` 用例 1a–1d、2

**Given** 档 1 环境；definitions 文件为已知状态  
**When** 对 **8 个合法色值**（`yellow/red/orange/green/cyan/blue/purple/pink`）**逐一** POST  
**Then** 每个都 **HTTP 201**，且落盘 JSON 里该 agent **含该 `color` key**（实测：8/8 `201` + `disk-ok`）  

**When** POST 一个**不带 `color`** 的定义  
**Then** 响应 DTO 与落盘都**没有** `color` key（缺省 = 未指定，不是写个默认色）  

**When** POST 一个 `color:"chartreuse"`（非法值）  
**Then** **HTTP 400**，文案逐字「**颜色必须是 yellow/red/orange/green/cyan/blue/purple/pink 之一**」，且文件 sha256 **不变**  

**When** 对已设 `green` 的定义 PATCH `{"patch":{}}`，再 PATCH `{"patch":{"color":null}}`，再 PATCH `{"patch":{"color":"purple"}}`  
**Then** 三态正确：**省略=保留**（仍 `green`）；**`null`=删 key**（DTO `undefined` 且盘上无该 key）；**值=设置**（`purple`）  
**And** UI 侧：色点按字面色值渲染；**「未指定」用「再点已选色 = 清除」表达**（无独立清除控件，见 notes D9）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-16 注入 AGENTS.md `injectAgentsMd`（P1/High）

**Design Ref**: notes §运行时：`injectAgentsMd` · 独立验收 `verify-zcode-contract.md` 用例 3、7a–7c

**When** POST 一个 `injectAgentsMd:false` 的定义，再 POST 一个缺省该字段的定义  
**Then** 显式 `false` **落盘为 `false`**；缺省的条目盘上**没有该 key**（两者语义等价，都是「不注入」）  
**And** PATCH 只改 `description`（不带该字段）→ **保留原值**  
**And** PATCH 传字符串（如 `"yes"`）→ **HTTP 400**（非布尔值拒绝）  

**Given** 子会话的父 cwd 下存在 `AGENTS.md`（含测试哨兵文本）  
**When** 用 `injectAgentsMd:true` 的定义派发（真 `PiHost` + 真 `createWorkerSession`）  
**Then** 子会话上下文/project 文件**含该哨兵**（实测 `contains=true`）  
**And** `false` / 缺省的同一探针**都取不到**哨兵  
**And** 两种情况下 `systemPrompt` **仍以 `definition.systemPrompt` 为准**（不被 AGENTS.md 顶替）  
**And** 子会话 active 工具面不变（注入**不是权限、也不是沙箱**），实测 `activeTrue=["read"] activeFalse=["read"]`  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-17 内置两个智能体：契约、写保护与遮蔽（P0/Critical）

**Design Ref**: notes §内置两个智能体（本轮）· 独立验收 `/tmp/pi-webx-subagents-implementation/verify-builtins.md` §1–§4

**Given** 空 store（definitions 文件**不存在**）  
**When** `GET /api/agent-definitions`  
**Then** 响应含**两条**内置，顺序为 `builtin:general-purpose` → `builtin:explore`（实测 `ids=["builtin:general-purpose","builtin:explore"]`）  
**And** 两条均 `source=='builtin'`、`readOnly==true`、`revision==1`、`createdAt/updatedAt==''`、`enabled==true`  
**And** **GET 不创建文件**（实测 `fileExists=false`）——内置是虚拟条目  

**When** 对 `builtin:explore` 发 PATCH（分别用**当前**与**陈旧** revision），再发 DELETE  
**Then** 三者**一律 HTTP 400**「内置子智能体不可修改 / 不可删除」  
**And** 陈旧 revision 也**不是 409**（写保护在读盘/CAS **之前**判定）  
**And** 文件仍**不存在**（未被这两个内置请求创建）  

**When** 写入一条用户定义，再读回文件文本  
**Then** 文件文本**不含** `builtin:`、`"source"`、`"readOnly"`（实测 `hasBuiltin=false hasSource=false hasReadOnly=false`）  
**And** `GET` 返回 **3** 条（2 内置 + 1 用户），读到用户定义正常（**不 500**）  

**When** 新建一条名为 `general-purpose` 的用户定义，再 GET  
**Then** `builtin:general-purpose` **消失**、`builtin:explore` **仍在**（同名遮蔽只作用于同名那条）  
**And** 用全角变体 `\uFF27eneral-purpose` 或 `GENERAL-PURPOSE` 再建 → **400**（NFKC + 大小写不敏感的唯一性）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-18 内置 UI 分组与只读行（P1/High）

**Design Ref**: notes §内置两个智能体（本轮）· 独立验收 `/tmp/pi-webx-subagents-implementation/verify-t66-builtins-narrow.md` A1–A6

**Given** 设置页「子智能体」分组已打开，**用户定义为 0 条**  
**When** 查看列表  
**Then** 只渲染「**内置子智能体**」组（组头计 2），说明句逐字「**内置 profile 是运行时默认能力，当前不可在这里编辑。**」  
**And** `已安装` 组因无内容**整组不渲染**  
**And** 页脚显示「**共 2 个子智能体 · 2 个已启用**」（内置**计入 total 且恒计入 enabled**）  

**When** 检查两条内置行的交互面  
**Then** 行内 `role=switch`/`checkbox` **数量为 0**、删除按钮 **0**、下拉/文本输入 **0**（**无开关、无删除、不可编辑**）  
**When** 点击 `general-purpose` 行  
**Then** **仍停留列表态**（不进编辑表单），无「编辑子智能体」标题，仍显示内置说明句  
**And** 徽标为 `[继承当前对话, 全部工具]`（Explore 为 `[继承当前对话, 4 个工具]`）  

**When** 搜索框输入 `Explore`，再输入 `zzz-no-match`，再清空  
**Then** 命中时只显示「内置子智能体」组（`已安装` 组整组隐藏）；无命中时显示「**没有找到子智能体**」；清空后两组恢复  
**And** 页脚计数**不随搜索变化**  

**When** 新建一条用户定义  
**Then** 立刻出现在「**已安装**」组，且该行**有**启用开关与删除图标；点击该行**能进入编辑态**  
**And** 删除后回到「共 2 个 · 2 个已启用」，文件 `agents: []`  

**Cleanup**: 删除本用例创建的用户定义

## TC-19 真并发与排队（P0/Critical）

**Design Ref**: notes §真并发、只读豁免与失败语义 · 实现 `server/pi/{subagent-capacity,subagent-worker,host}.ts`

> 触发原因：用户实测会话里「同一会话同时只能有一个子智能体实例」的硬拒挡住了正常并发。**该硬拒已删除。**

**Given** 一个定义 D，`maxConcurrentInstances = 1`，父会话可派发  
**When** 在同一轮里对同一 D 连续发起 **2 次**派发  
**Then** 第一次**立即运行**，第二次**排队**（不报错、不失败）  
**And** 第一次结束后第二次**自动开始**（**按到达顺序放行**，非严格队头阻塞），最终**两次都有结果**——**不再**出现任何「已有实例」拒绝  

**When** 把 D 的 `maxConcurrentInstances` 调到 **2** 后再连续派发 2 次  
**Then** 两者**并发执行**（第二个不再等待第一个结束）  

**Given** 父会话已用满 worker 名额（或派发方主动制造排队）  
**When** 一次派发在队列里**等待超过工具 120s 超时**  
**Then** 该次以错误码 **`capacity-timeout`** 结束（不是静默成功、也不是无限等待）  

**Given** 一个请求**正在排队**（尚未开始运行）  
**When** 父会话 abort（或 host 调 `cancelParent`）  
**Then** 排队项**立即被移除**：错误码 **`parent-aborted`**，capacity **归零**，**没有僵尸 worker**  

**Given** host 会话预算（12）已用尽  
**When** 再派发  
**Then** **立即拒绝**——**容量层码是 `host-full`，调用方实际看到 `capacity-full`**；**不排队**（设计选择）  

**And** 判失败看 **`isError`/错误文本**（不是 `details.ok`），且错误文本含 `reason=` 归因（见 TC-12 的失败口径）  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

## TC-20 只读豁免（P0/Critical）

**Design Ref**: notes §真并发、只读豁免与失败语义 B 段 · 实现 `planToolSurface`（`server/pi/subagent-tool.ts`）

> 这是**改写后的口径**：不再是「子工具面一律 ⊆ 父 active」。

**Given** 父会话 active = `read / bash / edit / write / ask_question / todo / render_ui`（**没有** `grep`/`find`/`ls`）  
**When** 派发 `builtin:explore`（`tools: {mode:'selected', names:['read','grep','find','ls']}`）  
**Then** 子会话有效工具集 = **`read / grep / find / ls` 四项**（`grep`/`find`/`ls` **因只读豁免**得以给出）  

**Given** 一个 `selected` 定义声明了 **`bash`**（父 active **不含** `bash`）  
**When** 派发  
**Then** `bash` **不获批** → 进 `unavailableTools`；**写/命令类绝不豁免**（`edit`/`write`/`powershell` 同理）  

**Given** 一个 `selected` 定义声明的名字在**子 registry 里不存在**  
**When** 派发  
**Then** 该名进 `unavailableTools`（豁免不等于凭空获得）  

**Given** `mode:'all'`  
**When** 派发  
**Then** 语义**不变**：父 active − restricted（豁免**不**放宽 `all`）  

**And** `subagent` 等 restricted 名在任何模式下都只进 `excludedTools`、不提权  
**And** 结论口径：**非只读工具 ⊆ 父 active；只读工具 `read/grep/find/ls` 豁免（仍须在子 registry 存在）**——**不是**权限提升、**不是**沙箱  

**Cleanup**: `rm -f "$PI_WEBX_SUBAGENTS_FILE"`

---

## 交付与记录

- 每轮运行写到独立 `$RUN_DIR`；证据（HTTP 响应、transcript 片段、截图）放 `$RUN_DIR/evidence/`，**不覆盖**历史运行目录。
- 报告格式：`TC-ID · verdict(PASS/PARTIAL/FAIL/SKIP/NOT RUN) · 失败的断言名（实际值 vs 期望值）`。**未执行的断言一律记 NOT RUN，不得记 PASS**。
- **失败口径**：判失败用 **`isError`** 或**读错误文本**（`[subagent failed: … reason=…]`）；**不要**用 `details.ok === false` / `details.reason`（throw 路径的 `details` 是空对象）。
- **工具面口径**：**非只读工具 ⊆ 父 active；`selected` 下只读名 `read/grep/find/ls` 豁免**（仍须在子 registry 存在）；`all` 不变。
- **每个 verdict 必须带证据指向**：实跑命令 + 退出码，或独立验收报告路径（本文件的对照表已按此规则填写）。实现者自测的 `exit 0` **只算脚本通过**，不能单独构成 PASS。
- **部分覆盖就写 PARTIAL**：不要因为「主路径过了」把整条 TC 记成 PASS（例如 UI 组在模型下拉复验完成前不记为整组通过）。
- **live 轮次记实**：原样记录「已发几次 / 上限 3」与每轮观察值（成功与否定结果都记）；**预算用满即停，不追加补跑**。
- 失败时保留状态；确认排查完再执行 cleanup。
- 路径可移植性检查：`grep -rn -- "$PROJECT_ROOT" docs/tests/` 应只在本文的环境小节出现（用于定义变量），用例正文不得写死机器路径。
