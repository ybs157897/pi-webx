# Agent Team P2：编排角色 + Team 运行时 + 受控成员工具面

Status: **implemented on `feat/user-subagents`（已提交 `1ae3b0a`；P2 代码本人尚未提交，属在途工作）· 独立验证 PASS（task-85 / task-88 整改 / task-89 定向复验）· P3/P4/P5 明确未做**

> **范围一句话**：P2 让「编排角色」能在同一个进程里**只调度已启用的定义**去干活，并把成员的工具面压到只剩两个工具；**状态全在内存**。
> 本文只记录 P2 做到的与证据在哪；**P3 持久化与结果注入、P4 Team 面板、P5 隔离都不在 P2**。

## 一、P2 做了什么

### 1 编排角色（不进定义列表、不可编辑）

- 常量 `TEAM_ORCHESTRATOR_ROLE`（`server/agent-team/team-types.ts:220`）：**不进入用户定义列表、不可编辑、模型继承父会话**。
- `createSession` 带 `teamMode` 时（`server/pi/host.ts:518` 解析、`:533` 建队）：父会话 active = **原有 active + 9 个 Team 工具**，且 **`subagent` 既不激活也不注册**（`customTools.length === 9`）。
- 编排角色的「只读策略」指的是**它不是用户可编辑的定义**，不是工具面只读。

### 2 9 个编排工具（模型侧）

`list_team_members`、`dispatch_agent`、`send_team_message`、`list_team_tasks`、`get_team_task`、`create_team_task`、`update_team_task`、`wait_team`、`interrupt_agent`（`server/agent-team/team-tools.ts:265/288/410/456/481/509/541/573/605`）。

- **只调度已启用定义**：`dispatch_agent` 的清单由 `renderDispatchAgentDescription`（`team-tools.ts:188`）渲染定义 `id` + `name` + `revision` + 一句话描述，**排除 disabled / 被遮蔽的内置 / 编排角色自身**。
- **不接受覆写参数**：14 个覆写键 + 5 个身份键 + 大小写变体 + 嵌套/错类型**全部被拒**（`rejectUnknownKeys`、`team-tools.ts:114`），错误文本**指名第一个违规键**。
- **定义新鲜度**：派发带 `expectedDefinitionRevision`，陈旧 → `DEFINITION_REVISION_STALE`（带 `currentRevision`）；`unknown` → `TEAM_DEFINITION_UNKNOWN`、`disabled` → `TEAM_DEFINITION_DISABLED`，三者都**不建成员**。
- **任务板 CAS**：`TEAM_TASK_STALE_REVISION`（带 `currentRevision`）、`TEAM_TASK_NOT_FOUND`、`TEAM_TASK_NOT_OWNED`（成员只能改自己的任务）。
- **`blockedBy` / DAG**：blocked 任务不能进 `in_progress`/`completed`；依赖完成后 `blocked→pending` 是**派生提升、不 bump revision**（否则无关任务的完成会作废他人手里的 CAS）。
- **`wait_team`**：只回**已 settle 的成员**；文本上限 **32000** 且 `truncated` 可判；**超时与已 settle 可区分**；最坏情况由 10k 轮上限兜底返回 `timedOut:true`（不挂死）。
- **`interrupt_agent`**：走**既有 capacity / 租约 / 取消路径**（`server/pi/host.ts:774` 复用同一 `workerRunner`）——取消后 capacity 与租约归还，不是另开一套调度。

### 3 成员只能拿 2 个工具

- 成员会话 active = **`update_team_task`（仅自己任务）+ `send_team_message`（只能发给 lead）**。
- `deny` = `TEAM_WORKER_FORBIDDEN_TOOL_NAMES`（**7 个**）+ `subagent` + 受限名（`server/pi/subagent-worker.ts:116/119`）。**注意：deny 是 7 个而不是 9 个**——成员自己那两个工具就在那 9 个名字里，按字面把 9 个全 deny 会让它们注册后立刻被排除。
- 成员**不需要** `dispatch` / 查询 / `interrupt` / 配置工具，也不得递归派发；这条有两层防护（allowlist 没有 + deny 明确禁止）。
- 装配**沿用定义**：`subagent-worker.ts:101-107` 把 `definition` 交给 `createWorkerSession`，因此 `injectAgentsMd`、`systemPromptOverride`、`thinkingLevel`、**只读豁免**（`grep`/`find` 在成员面同样生效）都按 task-50 的既有语义走，没有另开一套。

### 4 两个只读 HTTP 路由（无 UI）

- `GET /api/teams/:idOrSessionId`（`server/routes.ts:617`）与 `POST /api/teams/:idOrSessionId/cancel`（`:634`）。
- **两个路由都接受「父会话 `sessionId`」作为别名**（解析集中在一处：`PiHost.resolveTeamId`，`server/pi/host.ts:814-816`）：
  - **teamId 优先**——若该字符串本身就是一个 team id，就用它；**同 id 的会话不得遮蔽 team**（歧义口径）。
  - 否则回退到「该 id 是否是一个**带 team 的父会话**」（`this.sessions.get(id)?.teamId`）。
  - **非 team 模式的会话 id 仍 404**（别名不是「任意会话查表」）；未知 id → **404**。
- **`POST .../cancel` 现在回 `{teamId, cancelled, reason}`**：只知会话 id 的客户端可在这一次调用里**顺带拿到规范 teamId**，此后就能用 teamId 寻址。
- **为什么必须有别名（F1）**：P2 **不把 teamId 发给客户端**——create-session 响应只有 `SessionSummary`（**冻结**，`src/shared/protocol.ts:546-566` 里没有 `teamId` 字段）、**WS 帧也未变**（`welcome/subscribed/event/closed` 都没有）。因此**没有别名，这两个端点在客户端侧就是死接口**（真模型 smoke 正是这么抓到的 F1：客户端只有 sessionId，`GET /api/teams/<sessionId>` 当时是 404）。别名把「客户端唯一拥有的身份」变成可用入口，且**不需要改契约、不需要改 WS**。
- 投影规则：`from`/`to`/`teamId` **由宿主填**；模型写的 `from`/`to`/`teamId`/`memberId` 只出现在 `untrustedPayload`、任务标题只在 `untrusted.title`；投影**不含定义 systemPrompt**；成员视图只给宿主事实（`hasResult`，不给 `resultText`）；未知 team → 404。

## 二、P2 明确**没做**什么

| 项 | 状态 |
|---|---|
| **P3 持久化与结果注入** | **未做**。`grep -rn durable server/agent-team/` = 0；消息只到 `queued`，`fresh-reader-visible` 留给 P3；跨重启可见性依赖 P3 的 journal |
| **P4 Team 面板** | **未做**（无 UI；只有上面两个只读路由可手工验） |
| **P5 隔离** | **未做**（worktree / 进程级隔离都不在 P2） |
| **模型侧定义 CRUD** | **永不**：模型不能创建/改写定义（这与本功能「定义只由用户管」的冻结契约一致） |
| 新增 Team 容量上限 | 未做：**复用既有 capacity**（`host.ts:774`） |

## 三、关键边界（P2 特有的语义）

1. **P2 状态全在内存**：`AgentTeamRuntime`（`server/agent-team/team-runtime.ts:74`）不落盘；新 runtime 实例**完全不知道**刚建的 team（独立验证面 8 的反向尝试失败 = 符合契约）。
2. **成员 `sessionId` 是内存 run 标识**，**不是**持久会话 id；P2 没有「成员 ↔ 持久会话」的关联（JSDoc 与投影都写明这点，P3 才引入）。
3. **成员状态写入校验**（task-88 修的 M2）：成员侧写工具在**状态不是 `running`** 时一律拒绝 → 新错误码 **`TEAM_MEMBER_NOT_ACTIVE`**（`team-types.ts:294`），守卫 `requireRunningMember()`（`team-tools.ts:645`）在**两个成员工具 body 的第一行**（`:670` update_team_task、`:700` send_team_message），位于任何 CAS / `appendMessage` / requestId 记账**之前**，因此拒绝是**纯 no-op**；错误文本含当前状态与下一步，`details` 带 `{memberId, status}`。
4. **成员工具的可见性由 `tools:` 白名单决定，不由显式激活决定**（task-88 修的 M1）：SDK `isAllowedTool`（`agent-session.js:2100-2112`）**把 custom tools 一并按白名单过滤**——名字不在白名单**连结册都进不去**，事后激活救不回；`:2153-2159` 会在 runtime 重建时重新激活白名单里的已注册名。⇒ **承重的是「两个成员工具名必须留在 `toolNames` 里」**，`subagent-session.ts:181-200` 的显式激活是**冗余保险**（保留以防将来 SDK 不再自动激活）。
5. **`wait_team` 的 `timer.unref()` 已知边界**（`team-runtime.ts:64`）：在不持有其它句柄的一次性脚本进程里，`wait_team` 中途会静默 exit 0；**服务端不受影响**（express 全程持有句柄）。保留 `unref` 是因为反之会把进程钉住最长 `MAX_TEAM_WAIT_MS`。
6. **超时≠取消**（`team-runtime.ts:457`）：`wait_team` 超时只是停止等待，**不取消成员**；要真正停下得用 `interrupt_agent`，且**租约仍要等被中止的 turn 自己收尾才归还**——这是既有 worker 生命周期语义。

## 四、验证证据

### 独立验证（验证者 ≠ 实现者，全部自建 harness；仓库外产物）

| 轮次 | 结论 | 命令与产物 |
|---|---|---|
| task-85 | **PASS**：8 个攻击面全部独立复现（**a1 29/29 · a2 31/31 · a3 23/23**，全 exit 0）+ **red-green 4/4 故意写反的断言全部 FAIL**（harness 有判别力）+ **0 项契约被证伪**；提出 M1/M2/M3 | 在 worktree `pi-webx-subagents` 下执行 `npx tsx /tmp/pi-webx-p2-verify/a{1,2,3}-*.ts`（harness 是**仓库外**工件）；报告 `/tmp/pi-webx-p2-verify/verify-p2.md` |
| task-88 整改 | M2（真缺陷）已修：新增 `TEAM_MEMBER_NOT_ACTIVE` + `requireRunningMember()`；红绿 ≥1（去掉守卫 → 4 个 FAIL，还原 → 32/32） | `npx tsx scripts/check-agent-team.ts` → **32/32 passed**（27 → 32 组，+5） |
| task-89 定向复验 | M2 修对：**6 状态 × 2 工具矩阵**全对（running → 两个工具均 ALLOWED；`cancelling`/`cancelled`/`interrupted`/`failed`/`idle` → 全部 `TEAM_MEMBER_NOT_ACTIVE` 且 **revΔ=0 / msgΔ=0 零副作用**）；**requestId 账本不被污染**（被拒成员用 R 后，`requestOwner` 仍 undefined，running 成员用同一 R 成功）；**M1 残留已清**（旧相反断言已改写，现行 JSDoc 与 SDK 事实一致）；回归 a1 29/29 · a2 31/31 · a3 23/23 · **a4（新增）8/8** · redgreen 4/4 仍全红 | 报告 `/tmp/pi-webx-p2-verify/verify-p2-followup.md` |

### 仓库内自动化（进 `npm run check` 链）

- `scripts/check-agent-team.ts`：**32 个断言组**（定义门禁 / 覆写与身份键 / CAS / `blockedBy` / 成员工具面三连测 / `wait_team` / `interrupt_agent` + capacity / requestId 零副作用 / 投影与路由 / team 模式会话面）。
- 成员工具面与 deny 的**两层防护**、team 模式会话面（9 个工具在、`subagent` 不在）都在该脚本有断言。

### 红绿（门禁有判别力）

- task-81 实现者：红 A（把 deny 改回 9 个）→ 新断言失败；红 B（让投影信任 payload 的 `from`）→ 投影断言失败。**附注**：红 A 第一次跑**没有失败**，暴露出当时 check 只是复刻 deny 列表、没走真 dispatcher，随后补了「真 dispatcher 抓 `WorkerSessionOptions`」的断言才咬得住。
- task-88：去掉两处 `requireRunningMember()` → **4 个 FAIL**（`cancelled`/`interrupted`/`failed`/`idle` 各自报 `update_team_task was expected to fail, but it succeeded`）→ 还原 → 32/32。
- task-85：`redgreen.ts` 4 条故意写反的断言（成员「没有」`update_team_task` / 编排「仍有」`subagent` / deny 含 9 个 / running 成员「被当 settled」）**全部 FAIL**。

## 四点五、真模型端到端 smoke（2026-09-22，task-94）

**结论：真模型下 P2 可用（端到端走通）**——一条 prompt 内编排者自己建了 3 个任务、并发派了 2 个成员、按依赖解锁再派第 3 个、用 CAS 收尾并汇总了两份成员结果。**0 次 abort / 0 次超时 / 0 次重试 / 0 次 `subagent` 调用**；模型 `cmdc/deepseek/deepseek-v4-flash`（记录为 `cmdc` + `deepseek/deepseek-v4.1-flash`）。

**会话（可直接打开）**：`http://127.0.0.1:8789/?session=01a0c9a2-d856-7744-beba-bbffc2fe54e1`（HTTP 200 + SPA bundle；`get_state` 43 条消息）。**Team 投影随重启消失**（内存契约的现场演示）。

**关键事件**（原始会话 JSONL + 摘要脚本都在仓库外 `/tmp/pi-webx-p2-smoke/`）：

| 阶段 | 事件 |
|---|---|
| 建模 | 编排者先自己 `read`/`grep` 核事实，再 `create_team_task` ×3（T1、T2、**T3 `blockedBy=[T1]` → 初始 `blocked`**） |
| **同轮并发** | **同一轮两次 `dispatch_agent`**（`requestId=req-A-t1-001` / `req-B-t2-001`，各带 `taskId`），两个成员各自返回真实结果 |
| CAS 现场 | 编排者直接 `update_team_task` → **两次 `TEAM_TASK_STALE_REVISION`**（期望 1、当前 2：派发时 `assignTask` 合法 +1）→ 按错误文本 `get_team_task` 读回 → 用 rev2 置 `completed` |
| 依赖解锁 | T1/T2 完成后 `get_team_task` T3 **自动由 `blocked` 变 `pending`**（派生提升现场生效）→ 派第 3 个成员执行 T3 |
| 汇总 | T3 置 `completed`，`list_team_tasks` 三条全 `completed` 且 owner 正确；`todo` + `render_ui` 收尾；最终答复 1234 字，含轨迹表与两份成员结论 |

**成员工具面（从 `dispatch_agent` 的 `details.effectiveTools` 逐字核对）**：3 个成员（`d8416e60…` / `d4c699f5…` / `4c34881a…`，均 `builtin:general-purpose` rev1，2/4/3 轮，7.6s/20.1s/17.2s）= `read, grep, ask_question, todo, render_ui, update_team_task, send_team_message` ⇒ **7 个禁止的编排工具与 `subagent` 一个都没出现**，两个成员工具在。（`ask_question`/`todo`/`render_ui` 来自既有 worker 装配的全局扩展工具，不是 Team 越权。）

**投影（`GET /api/teams/<idOrSessionId>`，真状态）**：3 个成员全 `status=idle` / `hasResult=true` / `definitionRevision=1` / `sessionId`=各自 runId；3 个任务全 `rev3 completed`、T3 的 `blockedBy` 关系保留；**模型文本只在 `untrusted.title/description`**；`messages: []`（本轮没有成员回信）。收尾 `POST .../cancel` → `{"cancelled":0,...}`（协作式取消只报被请求数）。

**证据路径（全部仓库外）**：`/tmp/pi-webx-p2-smoke/verify-p2-live.md`（报告）、`prompt1.txt`、`get-tools.json`、`proj-{initial,mid,final}.json`、`final-answer.txt`、`session-*.jsonl`。

**F1 修复的独立复验（task-96，仓库外）**：`/tmp/pi-webx-p2-verify/a5-team-alias.ts` → **14 pass / 0 fail**（含验证者**自行构造的歧义用例** A6/A7：同一字符串既是 teamA.id 又是 teamB 的会话 id → 解析到 teamA，且 cancel 只动 teamA）；红绿：影子副本里把别名分支改红 → **8 pass / 6 fail**（A1/A2/A3 进程内别名 + B2/B3/B4 HTTP 别名全 FAIL，**A6/A7 仍 PASS**，说明断言各测各的）→ 还原 → 14/14；回归 a1 29/29 · a2 31/31 · a3 23/23 · a4 8/8 · `redgreen` 4/4 仍全红；`npx tsx scripts/check-agent-team.ts` → **33/33**。报告 `/tmp/pi-webx-p2-verify/verify-f1-fix.md`。

**P4 输入（验证者的独立观察，务必带上）**：

1. **`teamMode` 是「每次创建/恢复请求上的选项」，不随会话存档**（`server/pi/host.ts:518`）。实测：恢复一个 team 会话时**不带** `teamMode` → **201 但 `GET /api/teams/<id>` 404**；**带上** `teamMode:true` → 201 且别名 GET **200**（新 team，`parentSessionId` = 被恢复的会话），`POST .../cancel` 也 200。⇒ **P4 的 UI 刷新/重开想继续用 team，必须把 `teamMode` 一起带上**，否则用户会看到「team 没了」。
2. **没有任何 assistant 回合的 team 会话，转录不落盘**：实测 `POST /api/sessions {sessionId}` → **404 `no stored session`**——重启后连会话都恢复不了。与「P2 全内存」一致，但 **P4 做面板时要意识到**（空会话不可恢复）。

## 五、怎么手工验（无 UI）

无 Team 面板，因此只能用**两个只读路由 + 会话状态**验：

1. **建一个 team 模式的会话**：`POST /api/sessions` 的 body 里带 `teamMode: true`（`server/routes.ts:656` 本地解析，**不改 shared 契约**）；会话 active 应出现 9 个 Team 工具，且**没有** `subagent`。响应里**没有 `teamId`**（契约冻结），**你只需要记住 session id**。
2. **读投影（用 session id 直接打）**：`GET /api/teams/<sessionId>`（**别名**；`teamId` 优先、非 team 会话 id 仍 404）—— 看 `from`/`to` 是否由**宿主**填写，模型自述字段是否被包进 `untrustedPayload`；确认投影里**没有**定义 `systemPrompt`。
3. **取消（同样可用 session id）**：`POST /api/teams/<sessionId>/cancel` → 返回 **`{teamId, cancelled, reason}`**；**回显的 `teamId` 就是规范 teamId**，之后可用它寻址。随后成员进 `cancelling`，settle 后可读；`reason` 传非字符串不应被注入。
4. **成员只读面**：在成员会话里尝试调用 `dispatch_agent` → 应 `Tool dispatch_agent not found`；`update_team_task` 只能改**自己的**任务，`send_team_message` 只能发给 lead。
5. **非持久性**：重启进程后 `GET /api/teams/:id` 应查不到该 team（P2 无持久化）。

> **验特性必须用带该特性的实例**：本机是 **8788**（`pi-webx-subagents` 检出），主树的 5173/8787 **没有**该功能。

## 六、引用稳定性提醒

本文引用的 `server/agent-team/**`、`server/pi/subagent-session.ts`、`server/pi/subagent-tool.ts`、`server/pi/subagent-worker.ts`、`server/pi/host.ts`、`server/routes.ts` 的**行号对应当前工作区**（本文件写作时 `server/pi/subagent-worker.ts` 等仍属**另一队友在途修改**）。这些文件一旦变动，**行号可能漂移**——引用时请以符号名（如 `requireRunningMember`、`planToolSurface`、`TEAM_WORKER_FORBIDDEN_TOOL_NAMES`）为准复核。

## 七、未验证清单（不得当 PASS）

1. **真模型端到端**：✅ **已跑通一次**（见 §四点五 smoke：同轮并发派 2 个成员、依赖解锁派第 3 个、CAS 收尾、最终汇总；0 abort / 0 timeout / 0 retry）。**仍未验的是这些子项**：
   - **`wait_team` 在真模型下未被用上**（`dispatch_agent` 阻塞返回，编排者不需要它）⇒ 真模型下的等待/超时行为未观测。
   - **真模型下未触发 `running→cancelling→cancelled`**（smoke 不打乱主流程；状态机证据来自 harness `a3` 与 task-89 的 6 状态矩阵）。
   - **成员在真模型里没有调用任务板工具**，且**成员会话是 in-memory、无磁盘 transcript** ⇒ **成员内部的工具调用事后不可审计**（task revision 的增量完全由「派发时 `assignTask`」+「编排者收尾」解释）。**P3 需要把成员工具调用投影进 Team 事件或落盘**，否则这条审计缺口会一直存在。
   - `interrupt_agent` 在真模型下未被调用。
2. **被中止 turn 真实退出并释放槽位的时机**：真装配 + **不响应 abort** 的 stream 下，2s 后 `capacity.size` 仍为 1 —— 槽位归还取决于那个 turn 自己退出，**时机未验**。
3. **`cancelling` 与写入的真并发竞态**：task-89 构造的是**状态快照、单线程串行**，不是 abort 进行中的交错。
4. **P3 持久化边界**：无实现，故「重启后成员可见性 / 消息重投 / 注入」全部未验。
5. **`runId` 与成员 `sessionId` 的持久关联**：P2 无此概念（等 P3）。
6. 未跑 `npm run check` / `build`（留给集成 owner 的统一门禁）。
