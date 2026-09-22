# 用户子智能体：定义/配置/同步派发

> **2026-09-22 后续修复**：已修复 6 项运行时问题并拆分代码职责，现行规则见[生命周期与权限边界修复](../bug-fix/2026-09-22-subagent-lifecycle-boundaries.md)。新增 `check-subagent-lifecycle.ts` / `check-subagent-boundaries.ts`。`selected` 缺工具现在会失败，`all` 缺工具会在模型可见文本中说明；子扩展初始化与用户交互已接入父 UI；超时覆盖初始化。取消后不响应的同进程工作仍保留容量，待实际退出后释放。下方既有 TC / live 结果保留历史口径，不因本次修复重新宣称 live PASS。

Status: **封版 — implemented on `feat/user-subagents`（隔离 worktree，已提交 `1ae3b0a`，未推送、未合并）· 配置/API/UI 已独立验收 · 真实模型 3 次测试已完成：**TC-12 记 PARTIAL**（2 次历史权限 FAIL + 修后 1 次 PASS 13/13；门槛为 3/3 全条件通过）· 安全 blocker 已由独立 host 验 7/7 + live r3 确认修复 · 测试任务完成，不再追加模型轮次 · **界面已按 ZCode 1:1 重写（color/injectAgentsMd 新字段、名称 3..50 码点）** · **内置两个智能体已落地（`builtin:general-purpose` / `builtin:explore`，虚拟条目、只读、恒启用）** · **本轮语义已改：真并发（超限排队）、只读豁免（`selected` 下 `read/grep/find/ls` 免父 active）、失败走 throw（⇒ `isError:true`、`details={}`）+ 错误文本** · **提示词两处修正 + 逐字比对守卫已落地；验特性必须用 8788（主树无此功能）** · **工程门禁（本轮 task-76 / 提示词轮 task-77）四项 exit 0**（前端包仍 `assets/index-BvK7ArLb.js` sha256 `2587fad7…67b8`）**

> **代码在哪**：全部实现位于隔离 worktree **`pi-webx-subagents`**（与主树 `pi-webx` 同级的兄弟目录；分支 `feat/user-subagents`，已提交 `1ae3b0a`）。
> **尚未合并进主工作区**，也**没有提交/推送**——本文所述行为只对**该 worktree 的当前工作区**成立，不要读成「已上线」。
> 契约仍以 `src/shared/agent-definitions.ts` 为唯一真值；手测步骤见 `docs/tests/subagents.md`。

## 范围

用户可以在设置里**新建/编辑/启禁/删除子智能体定义**（名字、描述、系统提示、模型、工具许可、轮次与并发上限），然后在**普通对话里让主 agent 自行委派**——派发是主 agent 的一个工具调用，**同步返回**结果。

**明确不做（no Team）**：没有 Team、任务板、邮箱、durable inbox、成员 roster，也没有后台成员状态。派发不写 `sendCustomMessage`，结果走**普通同步 toolResult**。Team 类协作是后置话题，不在本契约内。

## 实现现状与验证状态

**实现清单（均在 worktree 内，已提交 `1ae3b0a`）**：`server/agent-definitions.ts`（store + 校验 + 文件级 CAS）、`server/agent-definitions-routes.ts`（4 条路由 + 跨站写保护）、`server/pi/subagent-tool.ts`、`server/pi/subagent-worker.ts`、`server/pi/subagent-capacity.ts`、`server/pi/host.ts`（装配与刷新）、`src/lib/agentDefinitions.ts`、`src/components/settings/AgentDefinitionsSection.tsx` + `agent-definitions-form.ts` + `.module.css`（界面按 ZCode 1:1 重写，含颜色标记与「注入 AGENTS.md」）、`src/components/settings/SettingsRoot.module.css`（设置页外壳 ≤768px 窄屏断点）。
**内置相关新文件**：`server/builtin-agents.ts`（两个内置定义、`mergeBuiltinAndUserAgents`、`isBuiltinAgentId`、`nameKey`/NFKC 归一）。

### 真并发、只读豁免与失败语义（本轮三条语义变更）

**A｜真并发（超限排队，不再硬拒）**
- **删除了**「每个父会话同时只允许一个子智能体实例」的硬拒规则与该错误文案（源码里已无该文案）。
- 同一轮可以派发**多个独立任务并并发执行**；上限 = **每定义 `maxConcurrentInstances`**（契约 **1..4、默认 1**；**UI 不展示**，编辑时原样保留）+ **全局 host worker 上限**。
- **超限不再失败，而是排队**：FIFO，**排队不占 capacity**；不同定义不会互相排在对方后面。
- **新错误码 `capacity-timeout`**：排队等待计入工具的 **120s** 超时；等待结束仍未拿到名额即该码。
- **`host-full`（host 会话预算 12 用尽）仍是立即拒绝**——这是设计选择，**不排队**。
- **排队项可立即清除**：父 abort / host `cancelParent` → `parent-aborted`，capacity 归零、**无僵尸**。
- 工具 description 新增并发说明句。

**B｜只读豁免（对旧表述的改写，不是并列）**
- 新增 **`READ_ONLY_CHILD_TOOLS = ['read','grep','find','ls']`**。
- 新语义（**取代**旧文档「子工具面 ⊆ 父 active」的说法）：**`mode:'selected'`** 时名字仍须**存在于子 registry**（缺则进 `unavailableTools`），其中**只读名免于父 active 限制**，**其它名字仍必须 ⊆ 父 active**；**`mode:'all'` 不变**（父 active − restricted）。
- **为什么**：让内置 Explore 这类只读专家在**默认/最小会话**里可用——否则父只开 `read` 时它连 `grep/find/ls` 都拿不到，等于白内置。
- **边界（必须一起写）**：这**不是权限提升、不是沙箱**；**写/命令类（`bash`/`edit`/`write`/`powershell`）绝不豁免**，`subagent` 等 restricted 名照旧被剔除。
- **真实例子**：父 active = `read / bash / edit / write / ask_question / todo / render_ui` 时，`builtin:explore`（`selected: read,grep,find,ls`）**应拿到 `read/grep/find/ls` 四项**——旧语义下只会得到 `read`。

**C｜失败语义（SDK 硬限制）**
- **返回**的工具结果**不能**设 `isError`（SDK `AgentToolResult` 没有该字段；`agent-loop` 的 return 分支**硬编码 false**）；**throw** 才得到 `isError:true`，但结果被替换成 `{content:[…], details:{}}`。
- 因此**失败一律 throw**：`isError:true` + **`details={}`**，归因放进**错误文本**：
  `[subagent failed: 名称 (id)] 原因 (agentId=… definitionRevision=… runId=… reason=…)`；
  进程内调用者还可读 `error.code` / `error.runId`。
- **判失败的口径改写**：此前若有「用 `details.ok === false` / `details.reason` 判失败」的写法，**一律改成看 `isError` 或读错误文本**——失败路径的 `details` 是空对象。
- **成功路径不变**：`isError:false` + 八键 `details`（含条件键）。

### 内置两个智能体（本轮）

- **id**：`builtin:general-purpose`（列表在前）、`builtin:explore`。
- **只读与虚拟**：`source:'builtin'`、`readOnly:true`、`revision:1`、`createdAt/updatedAt:''`；**不落盘**（GET/重启后用户定义文件 sha 不变）；**恒 enabled、无开关**。
- **写保护**：内置 id 的 PATCH/DELETE **在读盘与 CAS 之前**即 **400**（"内置子智能体不可修改/不可删除"）；陈旧 revision 也只得 400（非 409）；文件不存在**也不会被创建**。
- **遮蔽**：同名（NFKC+lowercase）用户定义**整条遮蔽**内置；`nameKey` 在 store 与 builtin 模块两处实现一致。
- **UI**：列表分「内置子智能体」（在前）/「已安装」两组；内置行**无启用开关、无删除图标、点击不进编辑**（只给提示）；计数 `共 N 个子智能体 · M 个已启用` 中**内置计入 total 且恒计入 enabled**；搜索时整组隐藏，过滤后为空才显示「没有找到子智能体」。
- **验收**：契约/运行时独立 **10/10 PASS**（`/tmp/pi-webx-subagents-implementation/verify-builtins.md`，含逐字 diff 与落盘纯度护栏）；浏览器独立 **A1–A6 / B7–B9 / C 全 PASS**（`verify-t66-builtins-narrow.md`）。

**本轮修掉的自查缺陷（task-62）**：初版把派生字段 `source`/`readOnly` 随写入落盘 → 下次 read 因「未知字段」**整份 500**（修复前 store **23/29**、API **11/14** 用例失败）。修法：磁盘形态 `StoredAgent` 与 DTO 形态分离，出口 `responseFor()` 补派生字段；并加护栏断言「文件文本不含 `builtin:` / `"source"` / `"readOnly"`」。

**检查脚本共 6 个，全部存在且可跑**：`scripts/check-agent-definitions.ts`、`check-agent-definitions-api.ts`、`check-agent-definitions-ui.ts`、`check-subagent-tool.ts`、`check-subagent-sdk.ts`、`check-subagents-test-server.ts`（另有被检查对象 `scripts/subagents-test-server.ts` 与共享 `subagents-test-helpers.ts`）。

**独立验收结果（非实现者自测，逐条有报告）**：

| 面 | 结论 | 证据 |
|---|---|---|
| 配置存储 / API / 三态编辑 | **0 blocking**；初验 5 条非阻塞 finding 中 F1–F4 已修复并逐条复验关闭，F5 仍为开放 nitpick | `/tmp/pi-webx-subagents-implementation/verify-config-api.md` |
| 运行时 + 隔离（无模型探针） | **9 PASS / 0 FAIL / 3 NOT RUN**；1 项非阻塞接口差异 | `/tmp/pi-webx-subagents-implementation/verify-runtime.md` |
| 取消竞态与工具契约 | 修复前 3 BLOCKING → 修复后 **9/9 + F4 专项 4/4**（判据未放宽，§I 保留历史证据） | `/tmp/pi-webx-subagents-implementation/verify-runtime-races.md` |
| 浏览器 UI（无模型调用，space 151） | **9 PASS / 0 FAIL**（新构建 `index-C9DY9qWv.js` 复验：TC3 模型下拉 `JSON tuple ["cmdc","deepseek/deepseek-v4.1-flash"]` → `POST 201` rev14 → reload 保持 `low` → `PATCH {model:inherit, thinkingLevel:null} 200` rev15/17 → `GET` 无该 key → UI 删除 rev18 `agents []`）；**仅覆盖无模型调用的界面维度** | `/tmp/pi-webx-subagents-implementation/verify-browser.md`（含 §附 TC3 复验） |
| 真实模型自动委派（3 轮） | **PARTIAL（3 次测试已完成）**：父 prompt 3 / 3 全部发出、**三轮均出现自动委派**，但 r1、r2 因 `effectiveTools` 越出父 active（拿到 `bash`/`write`/`edit`）**FAIL**（历史保留不改写），**task-45 修复后 r3 PASS 13/13**（`effectiveTools=["read","grep"]`、`turns=4`、`durationMs=14017`、`truncated=false`、1 child）。本 TC 的 PASS 门槛是 **3/3 全条件通过** → 实际前 2 次 FAIL，**故 PARTIAL，不因「都发生了自动委派」改判 PASS** | `/tmp/pi-webx-subagents-implementation/live/verify-live.md`（172 行，§9 逐轮表） |
| **ZCode 新契约与运行时注入（颜色/名称/隐藏字段/AGENTS.md）** | **PASS 12/12**（+ 5 个回归脚本全绿、0 blocking）：color 三态、名称 2/3/50/51 码点与逐字文案、读盘容忍与历史行可写性、隐藏字段不被重置、真 `PiHost`+真 `createWorkerSession` 哨兵注入且 `systemPrompt` 不变 | `/tmp/pi-webx-subagents-implementation/verify-zcode-contract.md` |
| **ZCode 1:1 界面浏览器验收（三轮）** | 第一轮 A–H PASS / I FAIL（3 项偏离）；第二轮 ① 删除弹窗 PASS ② CDP `Network.setBlockedURLs` 真实触发重试 PASS ③ 窄屏 FAIL；**第三轮窄屏 PASS**（390 内容列 **348px**、按钮 `cw=sw=112`、rail 变横向 tab；1440 侧栏仍 **256px**） | `/tmp/pi-webx-subagents-implementation/browser/t53*` |
| 父 active 权限接线（task-45 修复的独立复验） | **7/7 PASS**（**当时的口径**：`all`/`selected` 均 ⊆ 父 active、`unavailable` 点名不静默授予、父 active 空 → `surface=[]`、父含 bash/write 时不过度收紧；含 RED 自检）。**注意：该报告早于只读豁免（本轮）**，`selected` 的 `⊆ 父 active` 表述已被本轮改写；豁免行为本轮由 `check-subagent-tool.ts` 断言覆盖 | `/tmp/pi-webx-subagents-implementation/verify-parent-active.md` |
| 真并发 / 只读豁免 / 失败语义（本轮） | **独立验收 PASS**：**A 7/7 · B 7/7 · C 12/12 · 回归 6/6 · 0 blocking**（含自建 loop 探针证明「返回值带不了 `isError`」与**九条失败路径** `isError:true`） | `/tmp/pi-webx-subagents-implementation/verify-concurrency.md`（85 行） |

**逐项独立结论（只列有证据的）**：
- **存储/CAS**：`…/dir/../dir/…` 两种写法并发 → **恰 1 成功 + 1 个 409**；坏 JSON / `schemaVersion:2` / 带 `role` 的条目 → read 500、sha256 逐字未变；HTTP 5 并发同 revision → `[201,409,409,409,409]`。
- **单进程限定**：以上是**单进程**保证；**硬链接/跨进程/TOCTOU 不保证**（store 自述见 `server/agent-definitions.ts` 文件头）。符号链接别名已修为 canonical 路径（**one winner + 409**，`F3 fix`）。
- **跨站写保护**：同源 mixed-case `Host` → **201**、跨站 → 403、伪造 `X-Forwarded-Host` 仍 403；**这是来源敏感（CSRF）保护，不是认证**。
- **长度单位**：UI 与后端统一为 **code point**（40 emoji 允许、64/65 边界两层一致）；`selected` 上限 **128**（129 被 UI 与后端同时拒）。
- **取消竞态**：`await modelRuntime` 期间取消 → `created=0, promptCalls=0`；pre-aborted / create-pending abort → `promptCalls=0`；均**不发起 prompt**；末轮空可见文本 → `no-output`（不再静默成功）。
- **工具面（已按只读豁免改写）**：**`all` = 父 active − restricted**（未变）；**`selected` = 名字 ∩ 子 registry，其中只读名 `read/grep/find/ls` 免于父 active，其余名字仍须 ⊆ 父 active**；凡未获批的名字进 `unavailableTools`（`selected` 若子 registry 缺名 → 抛 `unavailable-tools`；`all` 缺失 → 不拒绝但如实列出）；restricted 只进 `excludedTools`、不提权。
- **动态启用**：父 `none` 会话里把定义 `false→true`，经真实 `PiHost` 刷新路径后父 active **始终不含 `subagent`**（`getToolDefinition('subagent')` 存在但未激活 → 守卫作用在 active 集）；对称正例（父 `['read','grep']`）刷新后得到 `['grep','read','subagent']`。
- **details 字段**：8 个必需键齐全、**无 `finished`**；另有**条件键 `excludedTools` / `unavailableTools`（非空才出现）**——下游不要按 8 键做严格 `deepEqual`。
- **select / JSON tuple**：`model` 以 `{mode:'fixed',providerId,modelId}` 结构化传递（非字符串拼接），模型 id 本身含 `/` 时**完整保留**、不会截断；`thinkingLevel` 省略=保留、`null`=删 property、字符串=设置。

**已知局限（本功能的诚实边界）**：
- **✔ 已修复的历史安全 blocker（保留记录，不改写）**：真实模型 r1/r2 两轮**都自动派发成功**，但子 `details.effectiveTools` = `["read","bash","powershell","edit","write","grep","find","ls"]` —— **越出父 active**（父 active 为 `["read","grep","subagent"]`，`noBashWrite=true`）。根因（源码可复核）：`server/pi/host.ts:563` 的 `parentRegistry` 取 `getAllTools()`（完整注册表）而非父 active，`all` 被展开成全部内置工具——**应用层工具面越权，不是 OS 沙箱结论**。**修复（task-45）**：`host.ts:569` 改为 `parentActiveTools: () => hosted.session.getActiveToolNames()`，`subagent-tool.ts` 同步；`getAllTools()` 仅保留在与权限无关处（`get_tools` 的 UI 目录、定义页工具目录、`deniedToolNames` 的**更宽 deny**）。**验证**：独立 host 探针 **7/7**（task-46，含 RED 自检）+ **live r3 实测 `["read","grep"]`**。合成探针先前只看到 `['read']`（看似 ∩ 生效）——**以真实模型为准，合成不能替代 live**。
- **可信扩展是本地代码，不是沙箱**：结构防递归只覆盖我们自己的派发/配置工具。
- **残余观察（独立验收者列出，不构成 FAIL，但需照实记录）**：
  1. **ZCode 的 Environment 层（dispatch 期）未移植**：`system-prompt.ts:21-45` 的 `buildSubagentEnvironmentContext`（cwd / 是否 git / platform / shell / OS + **模型名**行）在我们的子智能体 prompt 里不存在（全仓无 `Here is useful information` / `<env>`）；**用户定义同样没有**——不是内置独有缺口，而是整层未做。
  2. **`general-purpose` 的 prompt 仍是 ZCode 原文**（含 `Use Read`），**只对 Explore 做了工具名归一**；Explore 的只读禁列仍保留 upstream 的 `Write`/`Edit` 名词（均为**禁止**语义，不构成「指向不存在工具的可执行指令」）。
  3. **内置带产品原生字段**：`readOnly:true`、`maxConcurrentInstances:1`（= `DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES`）、`revision:1`、`createdAt/updatedAt:''`——**ZCode 没有这些字段**，非本轮新增，但写进契约面时要知道它们不在 ZCode 对照范围内。
- **同 cwd 本期不隔离文件系统**：子会话与父共享工作目录，`read`/`bash` 的可见范围依赖父的档位与预设。
- **确定性/合成证据不等于真网络**：以下四项仍**未**被独立验证——`sweep` 在有 active worker 时不杀父（需真实 worker 生命周期 + 60s 窗口）、timeout 真实时钟路径、`maxTurns` 的真实工具续轮、同 cwd 可信扩展 fixture 的独立 child ctx。
- **测试 harness 只是 test-scope**（`scripts/subagents-test-server.ts` 的请求白名单），**不是产品沙箱**。
- 早期测试曾直读 `auth.json`/`models.json` 统计键名与 `hasApiKey` 布尔值（**未打印任何值**），该做法已被指出并停止；准确口径是「**本实例运行期间未写真实 agent dir 的三个配置文件，且本轮未输出任何 secret 值**」，而不是「整个历史从未读过真实配置文件内容」。
- **指纹口径**：真实的 `models.json` / `auth.json` / `settings.json` **这三个文件**在该实例运行前后 size/mtimeMs/sha256 一致——**只能这么说**，不得升级成「整个 agent dir 未被触碰」（实例会**按显式路径读**其中两个配置，agent dir 的其他内容未做整体指纹）。
- **不追加 LLM 验证 3/3**：本目标的测试已完成（3 次样本均发生、修复后 1 次样本通过）；**修后只有 1 次样本**，不得把它当作稳定性概率，也不得以「1 次没复现」否定历史 FAIL，更**不要求、不暗示**追加轮次去凑 3/3。
- harness 已知运维局限（简短）：managed job 的生命周期绑定在 owner agent 上，owner 退出会连带停服（曾造成一次短中断）；另有一次准备期误创建已撤回，**未消耗 LLM 预算**。证据见 `/tmp/pi-webx-subagents-implementation/live-test-server-handoff.md`「生命周期」与「范围偏差记录」。

## 冻结契约（`src/shared/agent-definitions.ts`）

| 类型 | 形状 |
|---|---|
| `AgentToolPolicy` | `{mode:'all'}` 或 `{mode:'selected'; names:string[]}` |
| `AgentModelSelection` | `{mode:'inherit'}` 或 `{mode:'fixed'; providerId; modelId}` |
| `AgentDefinitionInput` | `name / description / systemPrompt / model / thinkingLevel? / tools / maxTurns / maxConcurrentInstances / enabled` |
| `AgentDefinition` | `AgentDefinitionInput` + `id`(UUID 不可改) / `revision` / `createdAt` / `updatedAt` |
| `AgentDefinitionsResponse` | `{schemaVersion:1; revision; path; agents}` |
| 写请求 | `Create{expectedRevision,definition}` / `Update{expectedRevision,patch}` / `Delete{expectedRevision}` |
| `AgentToolOption` | `{name; description; source:'builtin'\|'extension'}` |
| `AgentToolsResponse` | `{tools; sessionScoped; excluded}` |
| 常量 | `DEFAULT_AGENT_MAX_TURNS=8`、`DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES=1`、`SUBAGENT_TOOL_NAME='subagent'`、**`MIN_AGENT_NAME_LENGTH=3`**、**`MAX_AGENT_NAME_LENGTH=50`**、**`AGENT_NAME_PATTERN=/^[\p{L}\p{N}-]+$/u`**、`MAX_AGENT_DESCRIPTION_LENGTH=500`、`MAX_AGENT_PROMPT_LENGTH=32000`、**`SUBAGENT_COLORS`（yellow/red/orange/green/cyan/blue/purple/pink）** |
| 新增可选字段 | **`color?: SubagentColor`**（8 色枚举；缺省=未指定）与 **`injectAgentsMd?: boolean`**（缺省 `false`）；`AgentDefinitionPatch` 里 `color` 支持 **`null` = 删 key**（`NULL_CLEARS_FIELDS = ['thinkingLevel','color']`），`injectAgentsMd` 不需要 null（`false` 本身是合法值，省略=保留） |
| 工厂 | `createEmptyAgentDefinition()`：name/description/systemPrompt 空、model `inherit`、tools `all`、enabled **false**、maxTurns 8、maxConcurrent 1、**`color` 省略（不给默认色）、`injectAgentsMd:false`** |

| 内置条目（响应侧派生） | `id` = **`builtin:general-purpose`** / **`builtin:explore`**；**`source:'builtin'`**、**`readOnly:true`**、`revision:1`、`createdAt`/`updatedAt` **空字符串**（刻意不给假日期）；`enabled` **恒 true 且无开关**；**虚拟条目：不落盘**（GET/重启后用户文件 sha 不变） |

**内置两条的关键行为（写清楚，属于行为变化）**：
- **恒 enabled ⇒ `subagent` 默认注册**：派发工具在「存在 enabled 定义」时注册，而内置恒 enabled，所以**即使用户定义 0 条，普通对话里 `subagent` 也已在工具面里**（父 active 允许时）。
- **同名遮蔽**：用户定义与内置同名（**NFKC + lowercase** 归一，`nameKey` 与唯一性检查两处一致）时，**整条内置从列表消失**，用户定义生效。
- **内置 id 的写请求在读盘/CAS 之前就 400**：PATCH/DELETE `builtin:*` 一律 400「内置子智能体不可修改 / 不可删除」——**即使 `expectedRevision` 陈旧也只会得到 400 而不是 409**；**文件不存在时也不会被创建**。
- **磁盘形态与 DTO 形态分离**：`source`/`readOnly` 只在响应侧由 `responseFor()` 注入（磁盘存 `StoredAgent`，不含这两个字段）。

**两个内置的内容（逐字比对结论）**：`general-purpose` = ZCode `general-purpose.ts:7-24` 原文（`description` **byte-identical**；prompt 正文 1249 B 一字未改，仅末尾追加 Notes）、tools `{mode:'all'}`、color `blue`、`injectAgentsMd:true`、maxTurns `4`；`Explore` = `profile.ts:71-72` 的 description（**byte-identical**）+ `explore.ts:20-68` 的 prompt，**只有三处声明编辑**（与代码常量 `DECLARED_ZCODE_DEVIATIONS` **逐条对应**：① `explore-prompt-tool-names` 工具名归一到我们的名字 `Glob/Grep/Read → find/grep/read`；② `explore-prompt-no-bash` 两行 Bash 规则替换为一句「You have no Bash tool and no write tool of any kind: search and read, never change state」；③ `explore-description-breadth` 尾句 `Specify search breadth:` → `State the intended breadth in the task text:`）、tools `{mode:'selected',names:['read','grep','find','ls']}`（**不含 bash**）、color `cyan`、`injectAgentsMd:false`、maxTurns `4`。两个 prompt 末尾都追加 ZCode `system-prompt.ts:11-18` 的 **Notes 段（逐字）**。

**名称规则（本轮由 64 收紧为 ZCode 口径）**：**3..50 个码点** + `AGENT_NAME_PATTERN`（Unicode 字母 / 数字 / `-`，因此**中文可用**但不接受空格与下划线）；错误文案逐字「**长度必须在 3 到 50 个字符之间**」「**仅允许使用字母、数字和连字符**」。**只在写请求携带 `name` 时校验**：**读盘宽松**（`parseStoredName` 只要求非空字符串），历史不合规名字（如 1 字名、含空格名）**仍可读、可改其它字段、可启禁、可删除**，不会被冻结。

### 运行时：`injectAgentsMd`

`injectAgentsMd: true` 时，子会话**注入父 cwd 的 `AGENTS.md`**（实现是 SDK `noContextFiles` 取反：`noContextFiles: definition.injectAgentsMd !== true`）；`false` / 缺省**不注入**。`systemPrompt` **仍然只取定义自己的 `systemPrompt`**（`systemPromptOverride` 未变）。
**这不是沙箱、不授予任何权限**——它只影响上下文文本，工具面仍由 `定义许可 ∩ 父 active`（`selected` 下只读名豁免）决定。

## ZCode 1:1 界面重写（本轮）

**基线**：`zai-org/ZCode@872ad960` 的 `packages/ui/src/settings/SubagentsSection.tsx`（1841 行，配置界面**不在** `packages/web`）；规格 `/tmp/pi-webx-subagents-implementation/zcode-ui-spec.md`。

**结构**：**列表态 ⇄ 表单态整页互斥**（不再是左右两栏同屏），表单态有「返回」。
**字段顺序**：名称 → 颜色标记 → 模型 →（思考档位）→ 描述 → 可用工具 → 系统提示词 → **注入 AGENTS.md**。
**文案**：22 条逐字取自 ZCode `zh-CN.ts:3314-3394`（工具档「默认所有权限 / 自定义可用工具」、描述 placeholder「展示给模型的简短说明」等）。
**列表**：卡片行 + 头像方块 + 色点 + 模型/工具徽标 + 两行截断描述；**行内启用 `Switch`**；**行内删除 + 二次确认**；搜索框、空态、底部摘要「共 N 个子智能体 · M 个已启用」。
**工具区**：二选一（默认所有权限 / 自定义可用工具）+ 自定义网格；**切到自定义且当前为空 → 自动全选**；支持手动添加扩展工具名；保留**显式全不选**入口（纯推理）。

**已声明的偏离（D1–D19）**：

> **代码真值**：`server/builtin-agents.ts` 的 `DECLARED_ZCODE_DEVIATIONS` **恰好 3 条**（`explore-prompt-tool-names`、`explore-prompt-no-bash`、`explore-description-breadth`），全部落在 Explore 的 prompt/description 上；本表 D1–D13 多为**产品与界面层**的取舍，D14–D19 覆盖内置相关项，其中 **D15/D19 直接对应常量那三条**。

| # | 偏离 | 原因 |
|---|---|---|
| D1 | 无「主模型 / 轻量模型」概念 | 我们没有对应概念，模型选择只做「继承 / 指定」 |
| D2 | 只做「已安装」单组 | 不引入内置/插件来源分组 |
| D3 | 无作用域菜单 | 我们只有单一用户级存储，无 user/workspace 双作用域 |
| D4 | 逐像素色值不可达 | 设计系统不同（antd/`--dsw-alias-*` vs ZCode Tailwind token）；**只有色点用字面色值** |
| D5 | 行内开关对所有行显示 | ZCode 只对 user scope 显示，我们无 scope 之分 |
| D6 | 表单说明句按我们真实存储位置改写 | ZCode 说的是「用户级 Markdown profile 目录」 |
| D7 | 空态为我们的补强版 | ZCode 上游**无搜索词时不渲染**空态（其疏漏） |
| D8 | 手动添加扩展工具名我们独有 | 我们的工具目录含 extension 工具 |
| D9 | 颜色「未指定」用「再点已选色 = 清除」表达 | 无独立清除控件 |
| D10 | ZCode 的 `permissionMode` / `skills` / `background` / `disallowedTools` 不渲染 | **ZCode 上游 UI 本就不渲染**（其将白名单外字段原样回传） |
| D11 | 空 patch 语义保留（`{}` 不改盘、bump 规则不变） | 我们的 CAS/三态语义优先 |
| D12 | **「打开用户子智能体目录」不适用** | 桌面端能力，Web 打不开 OS 目录 → **不实现、不伪造** |
| D13 | **「暂无描述」不可达** | 我们的 `description` 必填，列表行不会出现无描述态 |
| D14 | **Explore 不给 bash** | 只读靠**工具面**（`selected: read/grep/find/ls`）而不是提示词；ZCode 的白名单另含 WebFetch/WebSearch/TodoWrite |
| D15 | **Explore prompt 的工具名改写 + 删 Bash 行**（= 常量里的 `explore-prompt-tool-names` + `explore-prompt-no-bash`） | 让提示词点名子进程**真实拥有**的工具；不改则会出现「指向不存在工具」的指令 |
| D16 | **内置不支持 ZCode 的行内模型覆盖** | 内置恒 `model:{mode:'inherit'}`（继承父模型），无可改控件 |
| D17 | **两个 prompt 末尾追加 Notes 段** | ZCode 是**运行时分层追加**，我们是**拼接进 systemPrompt** |
| D18 | **ZCode 的 Environment 层未移植** | `buildSubagentEnvironmentContext`（cwd / 是否 git / platform / shell / OS + 模型名行）**在我们的子智能体 prompt 里不存在**；它属 **dispatch 期**层而非本轮内置定义内容，**用户定义同样没有** |
| D19 | **Explore description 的 breadth 句改写**（= 常量里的 `explore-description-breadth`） | ZCode 写 `Specify search breadth:`，但**我们的 `subagent` 没有这个参数**（schema 恰为 `agentId`+`task`）——改成「把广度写进 task 文本」 |

**验证证据**：
- 契约/runtime 独立验收 **PASS 12/12**（`/tmp/pi-webx-subagents-implementation/verify-zcode-contract.md`）：color 三态、名称 2/3/50/51 码点边界与逐字文案、emoji 因**字符类**（非长度）被拒、读盘容忍 + 历史行可写性、隐藏字段不被重置（真实 HTTP）、真 `PiHost` + 真 `createWorkerSession` 的 AGENTS.md 哨兵注入与 `systemPrompt` 不变。
- 浏览器验收**三轮**（截图与 wire 在 `/tmp/pi-webx-subagents-implementation/browser/t53*`）：
  - 第一轮 A–H **PASS** / I **FAIL**（3 项偏离，见上表 D 系列）。
  - 第二轮：① 删除弹窗 **PASS**；② 重试用 CDP `Network.setBlockedURLs` **真实触发 PASS**；③ **窄屏 FAIL**。
  - 第三轮：**窄屏 PASS** —— 390 内容列 **348px**、按钮 `cw=sw=112`（不截断）、rail 变横向 tab 条；1440 桌面侧栏仍 **256px**。
  - 口径注：内部 `_contentFrame_` 实测 **1184 = 1440 − 256**（这是**实测值**）；早先预测的 **1114 是实现者估值，不是实测值**，不要把 1114 当实测写。
- **本轮门禁（task-76 / 提示词轮 task-77，实测，出处 `/tmp/final4-*.log`）**：`npm run typecheck` **exit 0**、`npm run check` **exit 0**（22 段脚本全过；日志 **158** 行、`ok` 行 **118**、`ALL CHECKS PASSED` **7** 块；store **32 例**、API **16 例**）、`npm run build` **exit 0**（`✓ built in 3.57s`）、`git diff --check` **exit 0**。**脚本规模**：`check-subagent-tool.ts` 1416→**1601 行**、`check-subagent-sdk.ts` 984→**1009 行**。**本轮只改服务端：前端包未变**。**唯一警告**：vite `Some chunks are larger than 500 kB after minification`。**产物指纹**：`dist/index.html` → **`assets/index-BvK7ArLb.js`**，sha256 **`2587fad70faa45c0bee320ea0c24b8743b697c7ba0be47c8650b4d2bb0af67b8`**（**旧 `index-zaUfD3Dj.js` 已被替换删除**）。**工作树**：`git status --short` **31 项**（10 改 + 21 未跟踪），未 add/未 commit（出处 `/tmp/final4-status.log`）。

**计数（本轮 task-77 值）**：store **32 例**、API **16 例**、UI 末行 `check-agent-definitions-ui: ok`。**口径**：**250 是源码静态 `assert.` 调用数**（`grep -oE 'assert\.' scripts/check-agent-definitions-ui.ts | wc -l`），**不是运行期计数**；出处 `/tmp/final4-check.log`。

**曾经的窄屏缺陷：已修 + 独立复测 PASS**。原症状（task-53 记录）：窄屏 **390** 下「模型设置」分区被裁切不可达（`_modelList_` `clientWidth=72`/`scrollWidth=227`/`overflow-x:clip`，行内按钮 `right 401/433/465` > 面板右边界 `385`，证据 `browser/t53r3-390-models-settings.png`）。修复后由独立验收复测 **B7–B9 全 PASS**：320/390/768 下 `overflow-x:auto` + 行 `min-width:240px`，三按钮 `rect.right ≤ 列表右界`，四档均**无页面级溢出**、无按钮 `scrollWidth > clientWidth`；1440 桌面侧栏布局不变（`_listPane_` 224px + 弹性列）。出处 `/tmp/pi-webx-subagents-implementation/verify-t66-builtins-narrow.md`（B 节，含四档实测表与截图）。

## 诊断纪律：验子智能体特性必须用 8788

**会话 `01a0c8af-18ac-7e03-aff2-067cda321516` 的审查结论（不是产品缺陷、也不是提示词问题）**：
- 该会话的**模型工具面里根本没有 `subagent`**（模型在 thinking 里自述只有 7 个 coding 工具 + `ask_question`/`todo`/`render_ui`），随后用 `bash` 起 **3 个 `pi -p` 子进程**兜底——它**想派发**，只是拿不到工具。
- **真因**：服务它的**不是带该特性的检出**。证据：该会话 `env | grep '^PI_'` **没有 `PI_WEBX_PORT`**（8788 那个进程有），且本机**只有 `pi-webx-subagents` 检出**带该特性。
- 因此本轮的 `SUBAGENT_TOOL_PREAMBLE` / 内置 description/prompt / Notes 段**一个字都没送达该会话**——**不能用这个会话证明提示词有问题**。

**验收纪律（写死）**：
- **验子智能体特性必须用 8788**（或任何**带该特性的检出**实例）。
- **5173 / 8787 默认是主树**——主树**没有**这个功能，用它测子智能体只会得到「工具不存在」的假阴性。
- 诊断先看**两道现场证据**：① 会话工具面里有没有 `subagent`；② 会话 `env | grep '^PI_'` 是否为 8788 实例（有 `PI_WEBX_PORT`）。**两者对不上，先查实例归属，别急着改提示词。**

## 提示词修正（本轮，两处）

**不是上面的根因修复，而是独立发现的两处措辞问题**（报告 `/tmp/pi-webx-subagents-implementation/prompt-review-01a0c8af.md`）：

1. **`SUBAGENT_TOOL_PREAMBLE`**（`server/pi/subagent-tool.ts`）：
   - 去掉不准确的 **`enabled user-configured specialist`**（内置恒可用，不是「用户配置启用的」）。
   - 逃生口 **`If no specialist matches, answer directly.`** 改为：**用户明确点名要子智能体 ⇒ 即使任务很小也派发最接近的那个；只有没点名、且确实没有匹配时才直接答**。
   - 保留「内置恒可用」与 task-70 的**并发/排队**句。
2. **Explore `description` 尾句**：`Specify search breadth: …` → **`State the intended breadth in the task text: …`**。理由：**我们的 `subagent` schema 只有 `agentId` + `task`，根本没有 breadth 参数**（SDK 探针断言 `parameters.properties` **恰为这两项**）。

**新增守卫（值得记）**：
- `scripts/check-subagent-tool.ts` 新增**逐字比对守卫**：把 ZCode 的 **5 份原件冻进脚本**——GP 的 description / prompt+Notes **逐字节相等**、Explore 等于「**原件经声明改写**」、**每次替换必须恰好命中一次**（多命中/少命中即失败）。
- SDK 探针新增：**模型可见描述不得含旧句**、**不得含 `Specify search breadth`**、**schema 属性恰为 `agentId`+`task`**。

**已知但不改（用户明确选择暂不改）**：
1. 两个内置 `systemPrompt` 仍写 **`You are an agent for ZCode CLI`**——产品名不符，但属**逐字复刻**的取舍。
2. Notes 里「bash 调用之间 cwd 会重置」这条**对没有 bash 的 Explore 是死条款**。
3. `general-purpose` 的 description 偏「复杂研究」，**未补**「小任务也可以派」的措辞。

### 管理面（HTTP）

- `GET /api/agent-definitions`、`POST /api/agent-definitions`
- `PATCH /api/agent-definitions/:id`、`DELETE /api/agent-definitions/:id`
- `GET /api/agent-definitions/tools?sessionId=…`（工具目录，供 UI 的 `selected` 模式选择）

**写操作只存在于用户 UI 与 native HTTP 管理面；模型工具里没有任何 CRUD。** 所有写请求带 `expectedRevision`，它是**文件级 CAS**（整个 definitions 文件一个版本号），不是单个 agent 的 revision。写入成功后返回**完整的** `AgentDefinitionsResponse`；新建 agent `revision=1`，每次 patch `+1`；`id` 不可改。

### 存储

- 路径：`<getAgentDir()>/pi-webx/agent-definitions.json`；可用 **`PI_WEBX_SUBAGENTS_FILE`**（绝对路径）覆写，**仅用于部署/测试**。
- 空态：`schemaVersion:1`、`revision:0`、`agents:[]`。
- **不读写 `models.json`**（模型配置与定义是两件事）。
- **定义里不含任何用户凭据。**
- **隔离实例如何拿到模型**（不涉及产品行为，只是测试口径）：SDK public 面**不支持** `AuthStorage` / `ReadOnlyAuthStorage`（实测 export 缺失），所以 harness 用自建只读 `CredentialStore` 适配器——`list` 只返回 `{providerId,type}` 元数据，`read` 只覆盖 `cmdc`、其它 provider 返回 `undefined` 且不触发读取，`modify`/`delete` 一律 throw；凭据值由 SDK 经**真实 `modelsPath` 配置**只读获取，**harness 自己不读、不打印、不复制**。**OAuth 凭据不支持**（遇到就阻塞并只报类型）。

## 决策与理由

**默认 `tools: {mode:'all'}`，但 `all` 是「父已有工具」的交集，不是「全部工具」。** 运行中的子会话有效工具集 = `定义许可 ∩ 父 session 的 active 工具 ∩ 子进程实际 registry`，再**减去 `subagent` 本身与所有派发/定义管理工具**——这是**结构上的防递归**：子 agent 拿不到派发工具，就不可能自己再派一层。父 session 处于 `none` 预设时根本调不到 `subagent`。
**唯一例外是只读豁免**：`mode:'selected'` 下 `READ_ONLY_CHILD_TOOLS`（`read/grep/find/ls`）不要求父 active 命中（仍要求孩子在 registry 里有），见上文 §真并发、只读豁免与失败语义 B 段。

两个必须写在明面上的限定：
- **`all` 不保证「定义里的名字在子进程一定可用」**：交集后仍可能更少（工具未注册、被 `excludeTools` 挡掉、档位不允许）。定义里许可了但子进程拿不到的工具，**要在结果里如实报告为 unavailable**，不是静默忽略，也不是报错崩掉。
- **结构防递归只覆盖「我们自己的派发/配置工具」**：它**不**声称能约束任意 **trusted 扩展**代码——扩展是本地代码、在进程内跑，其行为不在本功能的沙箱保证范围内（本功能本来也不提供沙箱）。

**`all` 是权限边界，不是沙箱。** 它只保证「不超出父的许可」，不保证子 agent 不能做父能做的事，也不提供任何隔离。**不得**把本功能描述成强隔离。

**`selected` 允许空数组**（`{mode:'selected', names:[]}`）：纯推理、不需要工具，是合法配置，**没有「至少一项」的最小限制**。

**`inherit` 是默认模型策略，`fixed` 失败必须报错。** `inherit` 跟随父 session；用户显式 `fixed` 的 provider/model 若解析不了，就**直接报错，不静默 fallback**——静默换模型会让用户以为跑的是自己选的模型。

**名称：3..50 码点、Unicode 字母/数字/`-`、允许中文、`casefold` 去重。** 不强制英文 slug——这是中文产品，硬要求英文名只会让用户起更差的名字；**不接受空格与下划线**（ZCode 口径）。同名（大小写不敏感）拒绝。

**「用户独占」落在两层：** ①定义 CRUD 只在用户 UI/管理面，模型工具面无 CRUD；②派发工具 `subagent({agentId, task})` **只有两个参数**，**不接受** model/prompt/tools 之类覆盖——模型不能借派发改写出别人的定义。其 description 列出 **enabled** 定义的摘要，供主 agent 选择。

**每次派发重读 enabled 与 revision**（不缓存决策）。`disabled`/已删除的定义**立即拒绝后续派发**，但**不 kill 已经在跑的调用**；定义变更**只影响下一次调用**。

**配置在 `<getAgentDir()>/pi-webx/agent-definitions.json`，独立于 `models.json`。** 用 SDK 自己的 `getAgentDir()` 而不是硬编码 `~/.pi/agent`，这样 `PI_CODING_AGENT_DIR` 对定义文件同样生效（隔离测试实例靠它）。

**隔离测试实例的实际顺序（档 2，随集成实现对齐）**：test-only bootstrap **先捕获真实 `agentDir`**（`getAgentDir()`，在覆盖 env 之前），**再把 `PI_CODING_AGENT_DIR` 指向 `$RUN_DIR/agent-dir`**，然后才动态 import `host` / `routes` —— 因此真实 `agentDir` 下的 **extensions / skills / context 不参与**本次测试，转录与缓存也全在 tmp。工厂仍**显式传真实路径**：`authPath = $REAL_AGENT_DIR/auth.json`、`modelsPath = $REAL_AGENT_DIR/models.json`；写面一律 tmp。也就是说：**真实 agentDir 会被「按显式路径读」两个文件，但不被当作环境根来使用**——不要写成「绝不触碰 agentDir」。

## 放弃了什么

- **Team / 任务板 / 邮箱 / 后台成员。** 用户要的是「普通对话里自动调用子智能体」，同步返回就够。引入 durable inbox 会把一个同步工具调用变成一套需要持久化、CAS、恢复语义的子系统，收益与复杂度不成比例。
- **给定义加凭据字段。** 定义只**引用**现有 provider/model；把 key 放进定义会让它进入 UI、导出与日志面。
- **模型可覆写模型/工具。** 派发参数故意只有 `agentId` + `task`；覆写面越大，「定义只能用户管」的边界越假。
- **`fixed` 解析失败时 fallback 到 inherit。** 见上：静默降级会骗用户。
- **名称强制英文 slug。** 见上。

## 证据现状（本轮实际做了什么）

| 项 | 状态 |
|---|---|
| `src/shared/agent-definitions.ts` 与冻结契约逐条一致 | **已完成**（含 `AgentDefinitionPatch` 三态清除语义）；单文件 `tsc --noEmit --strict` 通过 |
| 手测/回归说明 | **已产出并回填**：`docs/tests/subagents.md`（**21 个 TC**，含 TC-15 颜色 / TC-16 注入 AGENTS.md / TC-17–18 内置契约与 UI / **TC-19 真并发与排队 / TC-20 只读豁免**；PASS 均带证据来源，PARTIAL/NOT RUN 如实标注） |
| ZCode 1:1 界面重写 | **已实现**（列表/表单整页互斥 + 返回、字段顺序与 22 条文案逐字对齐、卡片行/色点/徽标/行内开关与行内删除、工具二选一 + 自定义网格）；**D1–D13 偏离已声明**（见上文专节） |
| 新契约字段（`color` / `injectAgentsMd`）与名称规则 | **独立验收 PASS 12/12**（`verify-zcode-contract.md`） |
| **内置两个智能体**（字段/落盘纯度/遮蔽/写保护/运行时工具面） | **独立验收 10/10 PASS**（`verify-builtins.md`，含逐字 diff 与磁盘不落 `builtin:`/`source`/`readOnly` 护栏） |
| **内置 UI 与模型设置窄屏** | **浏览器独立验收 A1–A6 / B7–B9 / C 全 PASS**（`verify-t66-builtins-narrow.md`，四档 320/390/768/1440 实测 + 截图） |
| 计数（本轮 task-77） | store **32 例**、API **16 例**、UI **250**（静态 `assert.` 计数） |
| 后端 store / API | **独立验收通过**（0 blocking，F1–F4 已修复复验；F5 开放 nitpick） |
| 设置页 UI | **两轮独立验收**：① 旧版交互维度 **9 PASS / 0 FAIL**（TC3 复验通过）；② **ZCode 1:1 重写后浏览器三轮**：第一轮 A–H PASS / I FAIL（3 项偏离）、第二轮 ①② PASS + ③ 窄屏 FAIL、**第三轮窄屏 PASS**（390 内容列 348px、按钮 cw=sw=112、rail 横向 tab；1440 侧栏 256px）。口径均不含 live/LLM |
| 运行时派发与有效工具集（含防递归、取消、配额） | **合成/无模型面** 9 PASS / 3 NOT RUN；取消竞态 9/9 + F4 4/4。**真实模型曾暴露越权（r1/r2 FAIL）→ task-45 修复 → 独立 host 验 7/7 + r3 实测 `[read,grep]` 已闭合** |
| 普通对话自动委派（live 3 轮） | **PARTIAL（3 次测试已完成）**：父 prompt 3/3 全部发出、三轮均出现自动委派；**r1、r2 权限 FAIL（历史保留）+ 修复后 r3 PASS 13/13**。该 TC 门槛为 **3/3 全条件通过** → 实际前 2 次 FAIL，**不达 PASS**；成功率不泛化 |
| 项目门禁 | **已跑（task-76 / 提示词轮 task-77，出处 `/tmp/final4-*.log`）**：`typecheck` / `check` / `build` / `git diff --check` **全 exit 0**；唯一警告是 vite chunk >500 kB；前端包未变（`assets/index-BvK7ArLb.js` sha256 `2587fad7…67b8`）；`git status --short` 31 项（未 add） |
| 浏览器通道就绪性 | **已验证**（隔离 harness：TaskSpace 151，Control/观察探针均通过并留截图） |

> **口径说明**：这里**只记状态与证据，不记断言条数**。
> **当前实际计数（非估算，可由脚本输出复核）**：store **32 例**、API **16 例**、UI check **250 断言**（后者为**源码静态 `assert.` 计数**，非运行期计数）。
> 早先流转的「UI 92 断言」是**未经核对的估计值**（UI owner 已承认），已弃用；
> 断言条数会随重构漂移，把它写进决策记录只会制造错误锚点。要复核就跑脚本本身：
> `scripts/check-agent-definitions.ts`、`-api.ts`、`-ui.ts`、`check-subagent-tool.ts`、`check-subagent-sdk.ts`、`check-subagents-test-server.ts`。
> 无论脚本报多少，**脚本退出 0 只是脚本通过**；独立验收结论以上表引用的报告为准。

**项目门禁**：已在**提示词修正后**重跑（task-76 / task-77，出处 `/tmp/final4-*.log`）：`npm run typecheck`、`npm run check`、`npm run build`、`git diff --check` **全部 exit 0**；唯一警告为 vite chunk >500 kB。产物 **`assets/index-BvK7ArLb.js`**，sha256 `2587fad70faa45c0bee320ea0c24b8743b697c7ba0be47c8650b4d2bb0af67b8`（**旧 `index-zaUfD3Dj.js` 已删**）。**工作树状态**：`git status --short` **31 项**（10 改 + 21 未跟踪），**未 add、未 commit、未合并、未推送**；HEAD `f31b4f1e18b42e0454be0ebe56d89243851c7c48`（branch `feat/user-subagents`）。**后续（2026-09-22 21:35）**：该工作区已提交为 `1ae3b0ad252da1eafcd1f2eb8ed45663b0d5195e`（42 files changed, 15645 insertions(+), 312 deletions(-)），未推送、未合并；提交后 Agent Team P2 在途。

## 怎么用（产品操作路径）

1. 打开 **设置 → 子智能体**。
2. **新增**：填**名称**、**职责描述**（这两项是主 agent 选人的依据；描述写清楚「什么时候该找它」）、**系统提示**，按需选**模型**与**工具**（默认「全部可用工具」，即父已有工具的交集），设**最大轮次 / 最大并发**，最后**启用**开关打开。
3. 回到**普通对话**直接说需求即可——**不需要**点名工具或 agent 名；主 agent 会依据各定义的描述自行委派。
4. 定义只能由**用户在 UI 或管理 HTTP 面**创建/修改；**模型自己不能创建或改写定义**（工具面没有 CRUD，派发工具也只接受 `agentId` + `task`）。
5. 想停用：把 `enabled` 关掉或删除该定义——**后续**派发立即被拒，**已经在跑**的调用不会被 kill。
6. 定义变更的生效时机：**下一轮对话**生效；**当前正在运行的 worker 持有的是启动时的快照**（`definitionRevision` 冻结），不会被中途改写。

**模型策略**：`inherit`（默认）跟随当前对话；显式 `fixed` 时，若该 provider/model 不在当前可见可用的目录中，**保存/派发直接报错，不静默 fallback** 到别的模型。

**API 调用要点（当前 worktree 实现）**：

- 写请求 body 是**嵌套 + CAS**：`{"expectedRevision":<文件 revision>, "definition":{…}}`；字段平铺到顶层 → 400「未知字段」；缺 `expectedRevision` → 400。
- **POST = 201**（创建）；**PATCH / DELETE = 200**；`expectedRevision` 过期 → **409**（文件级冲突，响应会带当前 revision）。`id` 由服务端生成，不要传。
- `enabled` 是**必填**（默认值由 UI factory 发送，服务器不猜）。
- 写面的来源检查是**跨站（CSRF）防护，不是认证**——服务只监听 `127.0.0.1`，没有登录态；不要把 403 理解成权限系统。
- 冒烟/写测试请只写 **tmp** 里的 fixture 文件（`PI_WEBX_SUBAGENTS_FILE`），不要指向真实用户的 agent dir。

**隔离复现入口**：`scripts/subagents-test-server.ts`（test-only bootstrap；必须先 `getAgentDir()` 捕获真实 agent dir，再 `PI_CODING_AGENT_DIR=<RUN_DIR>/agent-dir`，然后才 dynamic import host/routes；工厂显式传真实 `authPath`/`modelsPath`，其余 tmp）+ `scripts/check-subagents-test-server.ts`（自检其 gate）。

## 剩余的验证缺口

1. **真实模型自动委派（测试完成，TC 记 PARTIAL）**：父 prompt **3 / 3 全部发出，三轮均自动委派**；**r1、r2 权限 FAIL（历史保留，不改写）+ 修复后 r3 PASS 13/13**。该 TC 的 PASS 门槛是 **3/3 全条件通过** → 实际前 2 次 FAIL，**故 PARTIAL**（不重定义为「只要自动委派就过」）；修后**只有 1 次样本**，不当作稳定性概率，**测试任务已完成，不再追加 LLM 轮次**。
2. **安全 blocker（已闭合）**：r1/r2 的子会话越出父 active（拿到 `bash`/`write`/`edit`），根因 `server/pi/host.ts:563` 用 `getAllTools()`；task-45 改为 `parentActiveTools = getActiveToolNames()`，**独立 host 验 7/7**（`verify-parent-active.md`，含 RED 自检）+ **live r3 实测 `["read","grep"]`**。
3. **ZCode 1:1 界面**：三轮浏览器验收已收敛（第三轮窄屏 PASS）；**原「390 模型设置裁切」缺陷已修并经独立复测 B7–B9 PASS**（见上文专节）。
4. **浏览器 TC3（指定模型下拉）**：**已复验通过并关闭**（JSON tuple 完整保留 `deepseek/deepseek-v4.1-flash`，落盘/回读/清除/删除全链路实测）；`docs/tests/subagents.md` 的 **TC-11 记为 PASS（9 PASS / 0 FAIL）**——口径限于**无模型调用的 UI 维度**。
5. **真实时钟/真实生命周期的四项（仍未独立验证）**：`sweep` 不杀有 active worker 的父、timeout 真实时钟、`maxTurns` 真实工具续轮、可信扩展 fixture 的独立 child ctx。
6. **项目门禁**：**已跑并全绿**（typecheck / check / build / diff-check 均 exit 0，出处 `/tmp/final4-*.log`）；门禁**不再是未验证项**。
7. **手测执行**：按 `docs/tests/subagents.md` 回填；**未跑的不打 PASS**；实例最终指纹与 stop 由 server owner 收尾。
