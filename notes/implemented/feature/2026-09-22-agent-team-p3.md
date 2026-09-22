# Agent Team P3-A：TeamJournal（append-only）与可重放 inbox

Status: **implemented on `feat/user-subagents`（P3-A 代码本人尚未提交，属在途工作）· 独立验证 PASS（task-100）+ 整改（task-101）+ 定向复验 PASS（task-102）· P3-B 注入未做**

> **范围一句话**：P3-A 让 Team 的状态**可跨重启按日志重放**，并让「消息投递机会」在重启后也不会被重复使用。**它不承诺掉电安全，也不支持多进程并发写**——这两条是边界，不是待办。
> 本文所有「可重放」都指：**正常的进程重启后能从日志重建**。

## 一、做了什么

### 1 日志格式与写入

- **append-only JSONL，一个 team 一个文件**：`<dir>/<teamId>.jsonl`（目录来自 `PiHost` 的 `teamJournalDir`，`server/pi/host.ts:823`；默认 `<getAgentDir()>/pi-webx/teams`，`:357`）。**per-team 文件**让一条坏行的影响范围只在一个 team 内。
- **记录形状**：`{ v, seq, ts, teamId, type, ...snapshot }`，`v = TEAM_JOURNAL_SCHEMA_VERSION = 1`（`server/agent-team/team-journal.ts:38`）；`seq` **每 team 单调**；每条记录带的是**变更后的实体快照**（不是 diff），因此重放就是逐实体的「last write wins」，也顺带让 round-trip 断言可写；压缩（compaction）是后续工作。
- **8 种记录类型**（`team-journal.ts:44-53`）：`team-created`、`member-added`、`member-updated`、`task-created`、`task-updated`、`message-queued`、`message-updated`、`delivery-claimed`。
- **写入时机**：**先改内存、再 append**（`server/agent-team/team-runtime.ts:126-131` 的 JSDoc 明确写出）。因此崩溃窗口的后果是「内存里已经发生、日志里没有」——重启后那次改变不见。

### 2 读取与重放

- **读侧策略**（`team-journal.ts:24-32` 的 JSDoc，实现见 `parseJournal`，`:221`）：**被截断的最后一行丢弃**（崩溃中途的情形）；**其它任何不可读的行都被跳过并计数**——未知 schema 版本、未知记录类型、坏 JSON、属于别的 team、空白行各有 reason；**什么都不静默忽略、什么都不抛**（损坏的 journal 不该阻止宿主启动）。
- **启动即重放**：`server/index.ts:74` 在**第一个请求到达之前**调用 `manager.hydrateTeams()`（`server/pi/host.ts:756`）——它**从不抛**：journal 损坏、缺失、甚至不可写，都只在这里报出来，服务器照常启动（完全不可写时就是**纯内存模式**）。
- **重放结果**（`hydrate`，`team-runtime.ts:680`）：重建 members / tasks / messages；**mid-flight 成员被记 `interrupted` 并带原因**；**只有曾经 settle 的成员恢复 `resultText`**——**成员不可复活**（成员会话是 in-memory 的，重放只能恢复状态，不能恢复那个会话）。

### 3 投递幂等

- `claimDelivery`（`team-runtime.ts:532`）、`pendingDeliveries`（`:551`）、`setMessageDeliveryState`（`:562`）。
- **P3-A 只记录「这条消息的投递机会已经被用掉」**：真正的注入是 **P3-B**。账本跟着 journal 走（`delivery-claimed` 记录），所以**重启之后同一条 `messageId` 也不会拿到第二次机会**——这是「至少一次投递 + 目标侧去重」里属于我们这一侧的那一半。

### 4 路由解析顺序（本轮 F-C 的修复点）

`PiHost.resolveTeamId`（`server/pi/host.ts:927-935`）现在是三段：

1. **teamId**：`this.teams.get(id)` 命中即用（**teamId 优先**）；
2. **重放索引**：`teams.findTeamByParentSession(id)`——映射来自 `team-created` 记录里**宿主填的 `parentSessionId`**（`team-runtime.ts:107-113` 的 JSDoc 写明它就是「F1 别名在重启之后仍然可用的原因」）；
3. **活会话表**：`this.sessions.get(id)?.teamId`。

⇒ **重放之后，用 `<sessionId>` 也能查到那个 Team**（此前只在活会话表里找，重启后必然 404）。第二段**必须排在第三段之前**，因为会话本身可能连转录都没落盘（没有 assistant 回合），在活会话表里根本不存在。

## 二、边界与诚实口径（**不要把这些写成产品缺陷，也不要升级成承诺**）

| 边界 | 事实 |
|---|---|
| **不承诺掉电安全** | 每行都走 `appendFileSync`（`team-journal.ts:1-12` 的 JSDoc 用 `appended via appendFileSync; no fsync guarantee` 的措辞）——**没有 fsync**。这与 pi 自身会话存储的保证同级（对 SDK 的研究没在写路径上找到 `fsync`；新读者也分不清页缓存命中与稳定存储）。**「崩溃必只截尾行」是假设，不是承诺。** |
| **不支持多进程并发写** | **没有锁文件**；构造前提是「一个宿主一个进程」。锁文件也活不过持有者死亡，所以第二个进程并发 append 同一 journal **不在支持范围内**。 |
| **成员不可复活** | 重放把 in-flight 成员记 `interrupted`（带原因）；**只有曾 settle 的成员恢复 `resultText`**。成员会话 in-memory，重放不能恢复会话本身。 |
| **会话本身仍不可 resume** | 没有 assistant 回合的 team 会话**转录不落盘** ⇒ `POST /api/sessions {sessionId}` → **404 `no stored session`**。P3-A 恢复的是 **Team 投影**，不是会话。 |
| 状态写入顺序 | 先改内存、再 append ⇒ 崩溃窗口内「内存已发生、日志没有」的那次改变**重启后不见**。 |

### 启动日志与退化行为

- **成功重放时**（`server/index.ts:80-86`）打印四个量：**`files` / `teams` / `unusable` / `skipped`**（外加 `bytes`、`interrupted`、`durationMs`）。语义：`files` = 实际解析出内容的 journal 文件数、`teams` = **重放后内存里存在的 team 数**（不是「恰好解析成功的文件数」）、`unusable` = **没有产出任何 team 的文件**（空文件，或每条记录都属于别的 team）、`skipped` = 被跳过的坏行数。
- **journal 不可用时**（`:75-79`）：目录路径被占位/不可写（`EEXIST` / `ENOTDIR` / `EACCES` 等） ⇒ **`journalDisabled` 被设置**，日志打印 `team journal unavailable (<原因>); Teams will run in memory only and will not survive a restart`，**退化为纯内存模式**（P2 的行为），服务器**照常启动**。

## 三、验证证据

| 轮次 | 结论 | 证据（仓库外） |
|---|---|---|
| 自测（task-99 / task-101） | `check-agent-team-journal.ts` **15/15**；`check-agent-team.ts` **33/33** | 仓库内脚本：`npx tsx scripts/check-agent-team-journal.ts`、`npx tsx scripts/check-agent-team.ts` |
| 独立验证（task-100） | **PASS，带 2 项必须修正**（启动脆弱点 + 启动指标虚报；都不是状态正确性问题）：`j1-replay` **21/21** · `j3-host` **10/10** · `j2-resilience` **14/2**（那 2 个失败就是报的问题）；**真进程重启 E2E 通过**（kill → 重启同实例 → `GET /api/teams/<teamId>` 返回重放后的 members/tasks：mid-flight 成员 `interrupted`、任务状态与消息 `seq`/`deliveryState` 保留）；红绿：影子副本改坏两条约束 → 断言 FAIL | `/tmp/pi-webx-p3-verify/verify-p3a.md`（`j1-replay.ts`/`j2-resilience.ts`/`j3-host.ts` 同目录） |
| 整改（task-101） | `created` 计数修正 + `files`/`teams`/`unusable`/`skipped` 四量；journal 不可用 → 内存模式 + 警告；`parentIndex` 重放索引；空白行计数；自测 **11 → 15 组** | `scripts/check-agent-team-journal.ts` |
| 定向复验（task-102） | **F-A/F-B/F-C 三条都修对、无回归、无新发现**：`j2` **14/2 → 25/25**、`j3` **10/10 → 15/15**（新增 5 条 F-C 优先级断言）、`j1` **21/21**；**F-C 真进程重启 E2E 通过**——重启后 `GET /api/teams/<sessionId>` 由 404 变 **200 且与 `<teamId>` 逐字节相同**，`POST .../cancel` 两种标识返回**同一规范 teamId**，未知 id 仍 404，**teamId 优先级不变**；先红后绿 ≥2（改 `created` 计数 → j2 20/5；去掉 `mkdirSync` try/catch → j2 19/3） | `/tmp/pi-webx-p3-verify/verify-p3a-followup.md` |

## 四、怎么手工验（无 UI）

1. **建一个 team 模式的会话**：`POST /api/sessions`，body 带 `teamMode: true`（响应里没有 `teamId`，**只需记住 session id**）。
2. **拿 teamId**：`POST /api/teams/<sessionId>/cancel` 会**回显规范 `teamId`**（或 `GET /api/teams/<sessionId>` 的 `teamId` 字段）。
3. **kill 进程，再用同一 `PI_CODING_AGENT_DIR` / journal 目录重启**（journal 目录默认在 agent dir 下的 `pi-webx/teams`）。
4. **看重放**：`GET /api/teams/<teamId>` **与** `GET /api/teams/<sessionId>` 都应 **200**，且返回重放后的 `members` / `tasks`（members 里原本在飞的应为 **`interrupted`**）——**两者逐字节相同**；未知 id 仍 404。
5. **看启动日志**：应出现 `team journal replayed: <teams> team(s) from <files> file(s) … <skipped> bad line(s) skipped, <unusable> file(s) held no team …`；若 journal 不可写，则出现 `team journal unavailable (<原因>)` 且团队退化为内存模式。
6. **边界对照**：`POST /api/sessions {sessionId}` 仍应 **404**（会话不可 resume）；这与 Team 投影可重放**不矛盾**。

## 五、未验证清单（不得当 PASS）

1. **真实掉电 / `kill -9`**：没有 fsync，独立验证也只验了「正常 append + 正常 kill 后重放」。**「崩溃必只截尾行」是假设。**
2. **多进程并发写同一 journal**：不支持，**未测**。
3. **真模型下「重启 → 恢复 → 继续派成员」**：未跑（harness 全 fake）。
4. **P3-B 注入未实现**：`claimDelivery` 只记「机会已用掉」，真正的消息注入、以及「注入后目标侧去重」的另一半没有实现。
5. **判断语义的两条观察**（来自独立复验，非缺陷）：`unusable` 把「空文件」与「全 foreign-team 文件」归为一类；`hydrateTeams()` 的读失败也算进 `skipped`（行级与文件级原因混在同一计数里）。P4 若要区分需再拆维度。
6. 本轮未跑 `npm run check` / `build`（留给集成 owner 的统一门禁）。
