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

- `GET /api/teams/:id`（`server/routes.ts:617`）与 `POST /api/teams/:id/cancel`（`:634`）。
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

## 五、怎么手工验（无 UI）

无 Team 面板，因此只能用**两个只读路由 + 会话状态**验：

1. **建一个 team 模式的会话**：`POST /api/sessions` 的 body 里带 `teamMode: true`（`server/routes.ts:656` 本地解析，**不改 shared 契约**）；会话 active 应出现 9 个 Team 工具，且**没有** `subagent`。
2. **读投影**：`GET /api/teams/:id` —— 看 `from`/`to` 是否由**宿主**填写，模型自述字段是否被包进 `untrustedPayload`；确认投影里**没有**定义 `systemPrompt`；未知 id → **404**。
3. **取消**：`POST /api/teams/:id/cancel` → 返回 `cancelled: <n>`；随后成员进 `cancelling`，settle 后可读；`reason` 传非字符串不应被注入。
4. **成员只读面**：在成员会话里尝试调用 `dispatch_agent` → 应 `Tool dispatch_agent not found`；`update_team_task` 只能改**自己的**任务，`send_team_message` 只能发给 lead。
5. **非持久性**：重启进程后 `GET /api/teams/:id` 应查不到该 team（P2 无持久化）。

> **验特性必须用带该特性的实例**：本机是 **8788**（`pi-webx-subagents` 检出），主树的 5173/8787 **没有**该功能。

## 六、引用稳定性提醒

本文引用的 `server/agent-team/**`、`server/pi/subagent-session.ts`、`server/pi/subagent-tool.ts`、`server/pi/subagent-worker.ts`、`server/pi/host.ts`、`server/routes.ts` 的**行号对应当前工作区**（本文件写作时 `server/pi/subagent-worker.ts` 等仍属**另一队友在途修改**）。这些文件一旦变动，**行号可能漂移**——引用时请以符号名（如 `requireRunningMember`、`planToolSurface`、`TEAM_WORKER_FORBIDDEN_TOOL_NAMES`）为准复核。

## 七、未验证清单（不得当 PASS）

1. **真模型端到端**：成员真实作答、同轮多派并发都没有跑过真模型（task-85/88/89 全程 fake，无 LLM / 无网络）。
2. **被中止 turn 真实退出并释放槽位的时机**：真装配 + **不响应 abort** 的 stream 下，2s 后 `capacity.size` 仍为 1 —— 槽位归还取决于那个 turn 自己退出，**时机未验**。
3. **`cancelling` 与写入的真并发竞态**：task-89 构造的是**状态快照、单线程串行**，不是 abort 进行中的交错。
4. **P3 持久化边界**：无实现，故「重启后成员可见性 / 消息重投 / 注入」全部未验。
5. **`runId` 与成员 `sessionId` 的持久关联**：P2 无此概念（等 P3）。
6. 未跑 `npm run check` / `build`（留给集成 owner 的统一门禁）。
