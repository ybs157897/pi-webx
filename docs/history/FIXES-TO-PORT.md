# 待移植到 main 的问题清单

**用途**：`main` 是基础支架，扩展（软考人设、知识检索、教室视图、learning/grading）
都在别的分支上做。这份清单只记**问题点**和**出现位置**——说明哪里坏了、坏在哪个文件的哪个位置，
不写实现。`main` 自己决定怎么修。

**记录基线**：`feat/ruankao-agent` @ `f303b30`，外加当时工作区里**尚未提交**的改动。
下面这些问题点全部来自那批工作区改动，`origin/main` 上一条都没有。

**前置**：本地 `main`（`b3b0b98`）落后 `origin/main`（`e8120b9`）7 个提交，且可快进。
动手前先 `git switch main && git pull --ff-only origin main`，否则一半文件对不上。

**为什么放在仓库根目录而不是 `docs/`**：`docs/` 是软考人设的资料库语料
（`server/agent/ruankao.agent.json` 的 `materials.root = "docs"`，由
`knowledgeRuntimeFor(persona.docsRoot)` 整目录建索引）。工程笔记放进去会被检索当成教材。
这条对以后放任何工程文档都适用。

---

## 怎么读这份清单

每条按四段写：

- **现象** —— 用户在界面上/接口上实际看到什么。
- **根因** —— 机制层面为什么发生（不涉及具体写法）。
- **出现位置** —— 文件 + 内部位置，这是移植时真正要找的东西。
- **怎么算修好了** —— 可观察的判定，不看代码也能验。

---

# 一、正文（transcript）

## 1. 复制按钮散落在正文中间

**现象**：一轮回答输出过程中，正文被工具卡切成好几段，每段下面都挂一个「复制」图标。
轮次结束后折叠本应收掉它们，但折叠只覆盖"结尾正文步"之前的步骤，覆盖不到的会**永久留在正文里**。

**根因**：一轮回答在 pi 里是**多条 assistant 消息**（正文→工具→正文→工具→正文），
每段各成一条 entry。复制行当前只有一个条件——这段有正文就渲染，跟"是不是最终答案"无关。

关键在于：**「谁才是本轮答案」这条规则已经存在**（折叠逻辑里用它在算锚点，
也就是 dsh 的 `latestAnswer`：最后一个"结尾是正文且没调工具"的步骤），
但它是内联在折叠函数里的，没有对外暴露，于是消息视图只能自己另写一个近似条件。
两处规则迟早分叉，届时复制按钮会指向一段下一秒就被折进摘要行的内容。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `src/lib/transcript.ts` → 折叠函数（turn fold 区） | 「答案」规则在这里，需要成为两个消费者共用的单一事实源 |
| `src/components/MessageItem.tsx` → `AssistantMessageItem` 的复制行 | 渲染条件只看"有正文"，与"是不是答案"无关 |
| `src/components/TranscriptView.tsx` → 两条渲染路径 | 需要按「轮次」切分 entries（user 消息开启下一轮），只给每轮的答案放行；折叠体内那一批同样要传 |
| `src/components/TranscriptView.tsx` → `rows` 这个 `useMemo` 的依赖数组 | 新的判定必须进依赖，否则折叠展开后按钮归属不刷新 |
| `scripts/check-transcript.ts` | 回归断言的落点，覆盖三件事：①答案是"最后一个无工具调用的正文步"；②**每个步骤都调了工具的轮次没有答案**（与折叠一致）；③工具步、空白正文、空 region 都不是答案 |

**附带一条语义要求**：**进行中的那一轮不给按钮**。轮次没结束就没有答案、只有过程；
否则按钮会挂在"恰好是最后一步"的那条上，随流式推进而移动，结束后再凭空消失。

> 记一笔容易写错的预期：上面第 ② 条曾经被写成"停在工具调用上的轮次仍有一个答案、返回下标 0"，
> 实测是 -1。**错的是预期，不是规则**——带工具调用的步骤本来就不是候选。

**怎么算修好了**：按**可见性**（`el.getClientRects().length > 0`）统计，不按 DOM 计数
——折叠后的内容仍留在 DOM 里（`hidden="until-found"`，为了让页内搜索能命中）：

- 流式期间按钮数恒等于**已完成轮次**的数量，进行中那一轮贡献 0；
- 稳定态下"同一条消息里既有工具卡又有复制按钮"的条数为 **0**；
- 折叠展开前后，按钮归属不跳变。

## 2. 流式输出时每个 delta 都触发一次强制同步布局

**现象**：一轮长讲解（成百上千个 token 更新）期间页面发涩。

**根因**：贴底滚动的 effect 依赖 `transcript.entries`。一次 token 更新就重建
entries 数组 → effect 触发一次 → 里面读 `scrollHeight`，而读它会强制一次同步布局。
于是每个 delta 都强制回流一次。

**出现位置**：`src/components/TranscriptView.tsx` → 贴底滚动的 `useEffect`（`stick` 与
`containerRef` 那一处），以及它缺失的清理路径。

**怎么算修好了**：滚动仍然贴底，但每帧最多读一次 `scrollHeight`；组件卸载后没有残留的帧回调。

## 3. pi 的「插入消息」（custom 消息）在正文里完全读不到

**现象**：扩展通过 pi 的 `sendCustomMessage()` 往会话里插了一条消息，pi 把它写进了转写文件、
也会通过 `message_start` / `message_end` 事件推给客户端，但界面上什么都不显示。

**根因**：pi 的消息模型里有一个 `role: 'custom'` 的消息类型
（带 `customType` / `content` / `display` / `details`）。客户端的三层类型与归约都没有它：

- 协议的消息联合类型里没有 custom 成员，事件流里来的这条会被当成未知角色丢掉；
- transcript 的 entry 联合类型里没有对应条目，落不进状态；
- 三个消息入口都只处理 user / assistant / toolResult，custom 从哪个口进来都漏。

**语义要点（决定"怎么算对"）**：`display` 是这条消息是否进正文的开关。
`display: false` 的 custom 消息**留在会话里、参与模型上下文，但不该出现在正文中**
（典型用途是本轮决策的内部约定）。所以判定不是"收到就渲染"，而是"`display` 为真才渲染"。

还有一条：custom 消息**不属于一轮的过程步骤**，折叠时不应被当成 step 收进摘要行。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `src/shared/protocol.ts` → `PiAgentMessage` 联合类型 | 缺 custom 成员（`customType` / `content` / `display` / `details`） |
| `src/shared/transcript.ts` → `TranscriptEntry` 联合类型 | 缺对应的 entry 形状 |
| `src/lib/transcript.ts` → `startMessage`（live 的 `message_start`） | 消息入口之一 |
| `src/lib/transcript.ts` → `endMessage`（live 的 `message_end`） | 消息入口之二；注意 custom 的 end 要回到 start 的处理，否则只收到 end 的那一路会漏 |
| `src/lib/transcript.ts` → `applySnapshot`（快照重建时按 role 分发） | 消息入口之三，刷新/重连后重建历史走这里 |
| `src/components/TranscriptView.tsx` → `EntryView` 的 `switch (entry.kind)` | 渲染分发，需要为 custom 提供一个通用渲染（**不要**直接引用扩展组件，见第六节） |
| 折叠逻辑（`src/lib/transcript.ts` 与 `TranscriptView` 的 `hiddenIds` 过滤） | custom 不能进"过程步骤" |

**怎么算修好了**：造一条 `display: true` 的 custom 消息，正文出现；造一条 `display: false` 的，
正文不出现但会话统计里能感知到它；两者刷新页面后表现一致（live 与快照两条路径都对）。
`scripts/check-transcript.ts` 可以钉住这两条。

## 4. 提问附带的图片与工具结果里的图片只显示一个数字

**现象**：用户提问时贴了图，正文里只有一行「N 张图片」，看不到图。工具（多模态类）返回的图片
同样只有计数，看不到内容。

**根因**：两个消息入口都只提取了 `imageCount`，没有把图片内容本身带进 entry；工具结果的
`images` / `imageCount` 字段在状态类型里也不存在。属于**能力缺口**而非回归——但如果要让 main
支持多模态提问，这里是唯一需要动的地方。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `src/shared/transcript.ts` → `ToolRun` | 缺 `images` / `imageCount` |
| `src/shared/transcript.ts` → `UserEntry` | 只有 `imageCount`，缺 `images` |
| `src/lib/transcript.ts` → 内容块解析处 | 需要把 image 块规范成受支持的 mime 类型与大小上限；三处使用（`message_start`/`attachToolResult`/`applySnapshot`）必须走同一个提取 |
| `src/lib/transcript.ts` → `tool_result` 事件归约 | live 路径与快照路径要产出同样的字段，否则刷新前后不一致 |
| `src/components/MessageItem.tsx` → `UserMessageItem` 的 `belowMessage` | 目前只渲染计数 |

**怎么算修好了**：贴图后正文能看到缩略图；刷新后仍在；工具返回图同样能看到；
超出 mime 白名单或体积上限的块被安全忽略而不是让界面炸掉。

---

# 二、会话（session）

## 5. 桥接层会话 id 与转写文件里的 id 不是同一个，服务端一重启 `?session=` 就失效

**现象**：页面地址栏里带着 `?session=<id>`（教室是主入口，它只有这个 id）。桥接服务重启后
所有内存会话结束，刷新页面只会得到「这堂课已结束」，而磁盘上的转写明明还在。
唯一出路是回会话列表手动重新打开。

**根因**：桥接层自己铸了一个 id（`crypto.randomUUID()`），与 pi 写进转写文件里的那个 id
毫无关系。于是"按 id 找文件"根本无从下手——两个 id 不在同一个命名空间里。
一旦两者统一，磁盘查找才有意义。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `server/pi/host.ts` → `create()` 里生成 `hosted.id` 的那一行 | 应取 pi 自己的会话 id，而不是另铸 |
| `server/routes.ts` → 会话创建的请求解析与创建分支 | 需要支持"只给 id，文件在哪你去找"；查找要复用 `server/stored-sessions.ts` 已有的列表能力（它已带 mtime+size 缓存地解析过每个文件头），不要再扫一遍目录 |
| `server/routes.ts` → `parseCreateSessionRequest` 的字符串字段白名单 | 新字段要进白名单，否则会被静默丢弃 |
| `src/shared/protocol.ts` → `CreateSessionRequest` | 缺按 id 恢复的字段 |
| `src/App.tsx` → `sessionId` 的初始 state、写入 URL 的 effect、以及"已连接但会话不在列表里"的补捞 effect | 三处配套：从 URL 读、变更回写、服务端不认时补一次创建请求。补捞只在**已连接**且**会话确实不在列表里**时动手（连接未建立时的空列表不代表不在），且每个 id 只试一次，避免与轮询互相触发成环 |

**怎么算修好了**：新建会话后，桥接 id === `sessionManager.getSessionId()` === `summary().id`，
且转写文件名以 `_<id>.jsonl` 结尾。重启服务后只带 `?session=<id>` 刷新，对话能回来。

## 6. 刷新/重连后的快照丢掉"进行中的那半条回答"和挂起的弹窗

**现象**：回答流到一半时刷新页面（或 WebSocket 重连触发快照），已经流出来的那半条回答
不见了，要等下一个 delta 才重新长出来。若此刻扩展正等着用户回答一个弹窗，
刷新后弹窗也消失了，而 pi 那边还在等——用户被永久卡住。

**根因**：快照接口只回 `messages`（已落盘的完整消息）和 `throughSeq`，
缺三样东西：会话是否仍在运行、`agent.state` 里那条正在流式的 assistant 消息、
以及挂起中的弹窗请求。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `server/pi/host.ts` → `get_messages` 分支的返回内容 | 需要补：`running`、`streamingMessage`、`pendingDialogs` |
| `server/pi/host.ts` → 挂起弹窗的数据结构 | 只有响应回调是不够的：要能回放出**请求原文**，并把 `timeout` 按已经过去的时间折算成**剩余值**（否则刷新一次弹窗就多活一个完整超时） |
| `src/lib/session-client.ts` → 快照落地处（原先直接调用 `applySnapshot`） | 需要一处统一的"快照恢复"，把进行中的消息和弹窗一起放回去 |
| 新增的 `src/lib/session-snapshot.ts` | 把上面这件事收在一处，避免 live 与快照两条路径再次分叉 |
| `src/shared/protocol.ts` → 快照响应/`get_messages` 的数据形状 | 字段要出现在类型里 |

**怎么算修好了**：流式中途刷新，正文不会闪断，进行中的那半条立刻在；有挂起弹窗时刷新，
弹窗原样回来（剩余超时小于原始超时），作答后 pi 正常继续。

## 7. 扩展弹窗（select / confirm / input / editor）的一串生命周期缺陷

**现象**（可分开修，也可一并修）：

1. pi 侧主动关闭一个弹窗时，界面上它不会消失（`close_dialog` 无人处理）。
2. 弹窗超时/被 abort 后，界面上不会同步关掉；反过来，界面关掉后 pi 侧还挂着。
3. 点「停止」不会取消挂起的弹窗，扩展会一直等一个不会来的回答。
4. `select` 类弹窗被取消（超时或 abort）时，`undefined` 会被某些扩展当成"用户选了第 1 项"
   ——取消被记成了一次真实选择。
5. `select` 弹窗一打开就默认选中第一个选项，用户直接点确定会得到一个自己没看过的答案。
6. 用户点确定后界面**先**把弹窗关掉、**再**发响应：发送失败时弹窗已经没了，
   用户既看不到失败也无从重试；而且按钮可以重复点，会重复发送。
7. 长选项文字不换行，被截断成一个看不懂的前缀。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `src/shared/protocol.ts` → `PiExtensionUiMethod` 联合类型 | 缺 `close_dialog` |
| `server/pi/host.ts` → 弹窗登记处（`pendingDialogs`） | 值只有一个 resolve 回调；需要同时保留请求原文与创建时间（剩余超时、回放都依赖它） |
| `server/pi/host.ts` → 弹窗 settle 函数 | settle 时要向客户端广播一次"这个弹窗关了"，否则客户端只能等自己的超时 |
| `server/pi/host.ts` → `abort` 分支 | 停止时没有取消挂起弹窗 |
| `server/pi/host.ts` → `select` 的取消路径 | 取消时的 fallback 被当成返回值交给扩展；取消必须与"选了一项"区分开 |
| `src/lib/session-client.ts` → 扩展 UI 请求的分发（`handleExtensionUi`） | 没有 `close_dialog` 分支 |
| `src/lib/session-client.ts` → 用户作答路径 | 顺序反了（先关后发），且没有防重复提交、没有失败提示 |
| `src/components/Dialogs.tsx` → `DialogBody` 的初始选中值 | `request.options?.[0]` 默认选中第一项 |
| `src/components/Dialogs.tsx` → `ExtensionDialogs` 的渲染 | 需要按 request id 重建组件（否则下一个弹窗会继承上一个的输入）；下拉在选项较多/较长时的虚拟化与换行也不对 |

**怎么算修好了**：pi 主动关 → 界面同帧消失；界面作答失败 → 弹窗保留且给出可重试的提示；
重复点确定只发一次；停止后挂起弹窗全部消失且扩展不再等；取消 `select` 不会被记成选了第一项；
新弹窗不继承上一个的输入。

## 8. 本地开发时被误判为离线

**现象**：在 localhost 上开发时，浏览器报 offline（或断网/联网事件抖动一下）就让 WebSocket
不再重连，界面停在「未连接」，但其实本地服务好好的。

**根因**：连接控制器把 `navigator.onLine` 当成了"服务端可达"的充分条件。
本地回环地址上的可达性与"能不能上网"无关。

**出现位置**：`src/lib/connection.ts` → `connect()` 的离线短路、`scheduleReconnect()` 的离线判断、
以及 `online` / `offline` 两个网络事件处理器（四处都只看 `navigator.onLine`）。
另有一处相关的重复连接问题：`online` 事件到达时不看当前 socket 是否已经 OPEN/CONNECTING，
会白白重开一次。

**怎么算修好了**：在 localhost 上把系统网络断掉，服务仍在，界面应保持连接；
`offline` 事件不应打断回环连接；`online` 事件在已连接时不重开 socket。

## 9. 思考档位改变的事件没有落到界面

**现象**：扩展或命令把思考档位改了，界面上的档位显示不跟着变，直到下一次全量刷新。

**根因**：pi 会发一个思考档位变更事件，但协议的事件联合类型里没有它，
客户端的 piState 也就没有更新入口。

**出现位置**：`src/shared/protocol.ts` → `PiEvent` 联合类型；
`src/lib/session-client.ts` → 事件分发处（写回 `piState` 的位置）。

**怎么算修好了**：触发一次档位变更，界面档位即时跟着变，无需刷新。

---

# 三、输入与投递

## 10. 轮次收尾的一瞬间发送会被拒，用户看到一条红色报错

**现象**：回答刚要结束、界面上「停止」按钮已经变回「发送」的那一瞬，用户点了板书上的一个
选项或按了发送，得到一条红色的 `Agent is already processing. Specify streamingBehavior ...`。
而他只是"接着说了一句"。

**根因**：判定"忙不忙"的两边不是同一个事实。客户端的"正在执行"是从 transcript 与快照**派生**的，
pi 的 `isStreaming` 是它自己的运行标志；轮次收尾的瞬间前者落后于后者。
此时界面以为空闲，把裸 prompt 发出去，SDK 直接拒掉。

还有一层让客户端无法自愈的原因：pi 的 preflight 拒绝**不是错误响应**，
而是 `success: true` + `data.accepted: false`，并且响应里没有说原因。
只检查 `success` 的客户端会把这条路径整个漏掉。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `src/lib/session-send.ts`（新增） | 判定"要不要换成 steer 重发一次"的唯一落点 |
| `src/lib/session-client.ts` → 提交 prompt 的路径 | 失败只报错，没有自愈；且只认 `success`，漏掉 `accepted: false` |
| `server/pi/host.ts` → `prompt` 分支 | 投递方式完全信客户端传的 `streamingBehavior`；服务端明明知道自己的真实状态 |
| `server/pi/host.ts` → `prompt` 分支的响应 | 被拒时只回 `accepted: false`，没有原因，客户端无法区分竞态与真正的拒绝 |
| `server/pi/host.ts` → `prompt` 分支的重入 | 同一会话两个 prompt 并发进入 preflight 时行为未定义（需要一道"正在准备"的闸） |
| `scripts/check-session-send.ts`（新增） | 回归断言的落点 |

**立场要点**：本项目的取向与 DSH 一致——**服务端从不因为"正忙"而拒绝一条用户消息**。
调用方显式指定投递方式就照办，没指定就按服务端此刻的真实状态补上（忙则排进当前轮）。
重发必须复用同一个 requestId，否则会出现两条用户消息。

**怎么算修好了**：在轮次收尾的窗口里连点发送，消息进入当前轮，界面**没有**红色报错，
且正文里只出现一条用户消息。

## 11. 失败原因把 5xx 原文直接丢给用户

**现象**：出错时提示条上写的是 `520: {"message":"Upstream model provider is temporarily
unavailable..."}` 这类原文，用户不知道该怎么办。

**根因**：状态条直接把原始错误字符串渲染出来。缺少一层归因与措辞。
注意这里有个反面陷阱：**不能什么都归成"断网"**——「证据不足」「评分不可用」是教学结论，
不是网络故障，归错了会误导用户去重启。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| 新增的 `src/lib/failure.ts` | 归因（离线 / 上游 / 超时 / 未知）+ 人话措辞的唯一落点 |
| `src/components/StatusStrip.tsx` → 重试提示 | 原先直接渲染原始 `error` |
| 新增的 `src/components/RetryNotice.tsx` + 配套样式 | 提示组件；原始错误放进可展开的详情里备查 |
| `scripts/check-failure-copy.ts`（新增） | 把真实出现过的错误串钉住 |
| `src/main.tsx` | 全局样式表的导入位置（组件若要在 Vite 之外被渲染检查跑起来，CSS 只能在入口导入一次） |

**怎么算修好了**：四种归因各有自己的标题；标题里不出现 3 位状态码、`upstream`、`ECONN`；
原始错误仍可展开看到；「证据不足」这类教学结论不被归成断网。

---

# 四、模型配置

## 12. 改了 `models.json` 不生效（要重启进程）

**现象**：在设置面板改了模型的上下文大小（或任何 `models.json` 字段），保存成功、面板里也显示
新值，但不重启服务就不生效：新建会话拿到旧窗口，已开着的会话一直旧值，「上下文 N%」按旧窗口算。

**根因有三条，要一起修才算修好**：

1. **路径写死**。配置读写路径被拼成 `~/.pi/agent/models.json`，而 pi 运行时读的是
   `getAgentDir()` 下的那份，并且它认 `PI_AGENT_DIR`。一旦这个环境变量被设置，
   "设置面板写的"和"运行时读的"就是两个不同文件——表现与"保存没生效"完全一样。
2. **只读一次 + 永久缓存**。`ModelRuntime.create()` 读一次 `models.json` 就建快照，
   而 host 把这个 runtime 永久缓存，进程里再没有任何"回到文件"的路径。
   所以任何**外部写入**（在编辑器改、`pi` CLI、脚本、同步工具）都无人发现，直到重启。
   `tsx watch` 也救不了：文件在 `~/.pi/agent/`，不在被监听的项目目录里。
3. **已开会话不跟随**。会话持有的是创建时的 model 对象，所以即使 runtime 重读了快照，
   开着的那条会话依然用旧窗口，而上下文百分比与 pi 自己的压缩阈值都读它。

**出现位置**：

| 位置 | 说明 |
| --- | --- |
| `server/models-config.ts` → 配置路径常量 | 写死 `~/.pi/agent`；应跟随 pi 自己的 agent dir |
| `server/pi/host.ts` → `runtime()` | 永久缓存，且没有记录"上次读的是哪一版文件" |
| `server/pi/host.ts` → `create()` 解析 model 之前 | 建会话前没有校验配置是否变过 |
| `server/pi/host.ts` → `get_session_stats` 分支 | 上下文百分比就是这个命令算的，算之前要校验 |
| `server/pi/host.ts` → 需要一个"重读 + 带回已开会话"的入口 | 现状缺失；重读后要重新采用模型，但**新配置里已经没有的模型要原样放过**——一次文件编辑不该弄坏运行中的会话 |
| `server/routes.ts` → `reloadModelsConfig()` | 只在 app 自己写文件时被调用，且直接操作 runtime |
| `server/routes.ts` → `GET /models-config`、`GET /models`、`GET /providers` | 三条读路径在返回前都不校验配置文件是否变过 |

**取向要点**：重读应当是**按需校验**（比较文件的大小+修改时间），而不是 `fs.watch`。
按需检查不会漏事件、没有自己的生命周期，也不怕编辑器"写临时文件再改名"的原子保存
（那会让监听文件 inode 的 watch 静默失效）。文件不存在也是一种值得重载的状态
（runtime 应当丢掉配置已不再声明的 provider）。校验没变时只花一次 stat，可以放在热路径上。

**怎么算修好了**（全程**不重启**）：

| 改配置的方式 | `/api/models` 目录 | 新建会话 | 已开的会话 |
| --- | --- | --- | --- |
| 直接改文件 | 新值 | 新值 | 新值 |
| 走 app 设置接口 | 新值 | 新值 | 新值 |

另外要确认**改回原值也同样即时生效**，并核对文件 sha 与备份一致。
`PI_AGENT_DIR` 指到别处时，面板写的和运行时读的必须是同一个文件。

---

# 五、零碎

## 13. 正文很长时底部输入区与状态条被压扁

**现象**：对话一长，底部输入框或状态条被挤掉一截（高度被压缩）。

**根因**：主界面是纵向 flex 布局，底部这些块没有声明自己**不可收缩**，
默认的 `flex-shrink: 1` 让它们在内容溢出时被压。

**出现位置**：`src/components/Composer.tsx` → 最外层容器的样式；
`src/components/StatusStrip.tsx` → 最外层容器；
`src/App.tsx` → 包住状态条的那层（配套的类名定义在新增的反馈样式表里）。

## 14. `.gitignore` 缺本地运行产物

**出现位置**：仓库根 `.gitignore`，缺 `.pi-webx/`。

---

# 六、往 main 上搬的时候注意什么

## 6.1 别整文件搬：多个文件里混着扩展改动

`git diff origin/main HEAD -- <文件>` 为空 = 该文件在基线与 `origin/main` 之间没被扩展提交动过，
补丁可以直接落；非空 = 上下文会撞车，要手工挑。

| 文件 | 与 `origin/main` 差异 | 要挑出来的支架部分 | 要剔掉的扩展部分 |
| --- | --- | --- | --- |
| `server/models-config.ts` | 一致 | 全部 | — |
| `server/routes.ts` | 一致 | 问题 12、问题 5 | `/learning/prompt` 接口 |
| `src/lib/transcript.ts` | 一致 | 问题 1、问题 3、问题 4 | 无（但图片部分属能力取舍） |
| `src/lib/session-client.ts` | 一致 | 问题 5–7、9、10 | 无 |
| `src/lib/connection.ts` | 一致 | 问题 8 | — |
| `src/components/TranscriptView.tsx` | 一致 | 问题 1、2、3 | `AskQuestionCard`、扩展的工具卡渲染、`readOnly`/当前轮判定 |
| `src/components/MessageItem.tsx` | 一致 | 问题 1（复制行那一个条件） | 结构化工具卡、学习输入文案、提问图片 |
| `src/components/Dialogs.tsx` | 一致 | 问题 7 | — |
| `src/components/StatusStrip.tsx` | 一致 | 问题 11、13 | — |
| `src/components/Composer.tsx` | 一致 | 问题 13 | 示例问题回填（`seed`） |
| `src/shared/protocol.ts` / `src/shared/transcript.ts` | 一致 | 问题 3–7、9、10 | — |
| `src/components/EmptyState.tsx` | 一致 | — | 黑板入口改造（整文件都是扩展） |
| `server/pi/host.ts` | **+43 行** | 问题 5–7、10、12 | persona/learning/knowledge 的扩展接线与 systemPrompt 覆盖 |
| `src/App.tsx` | **+110/−17** | 问题 5、13 | 教室路由、视图注册表、课堂历史、学习提交守卫 |

## 6.2 `package.json` 的 `check` 脚本不能整行照搬

`origin/main` 现在是 `check-transcript && check-journal && check-models-config`。
工作区版加了一串跑在 `server/learning`、`server/grading` 上的脚本，那些在 main 上不存在。
移植时只加与本次问题直接对应的新脚本（`check-session-send.ts`、`check-session-identity.ts`，
以及可选的 `check-failure-copy.ts`）。

## 6.3 建议按问题分组提交

问题本身互不重叠，可以各自独立成一刀，便于单独回滚：正文（1–4）、会话（5–9）、
投递（10–11）、模型配置（12）。

但注意**文件会重叠**：`server/pi/host.ts` 同时被问题 5–7、10、12 碰到，
`src/lib/session-client.ts` 被问题 5–7、9、10 碰到，`server/routes.ts` 被问题 5、12 碰到，
`src/App.tsx` 被问题 5、13 碰到。分刀提交时要按 hunk 拆，不能按文件拆。

## 6.4 一条与 3D 视图有关的通用陷阱（如果 main 永远不接 3D，可忽略）

> Three.js 视图在 React StrictMode 下**不能**调用 `renderer.forceContextLoss()`。
> 开发模式下每个 effect 会挂载两次，用的还是**同一个 canvas 元素**；被强制丢失的上下文无法
> 重新初始化，three 会读到 null 的 shader precision 而抛错，整个应用**白屏**。
> 正确做法是只 `renderer.dispose()`，把上下文的释放交给 canvas 元素被移除时。
> 这个 bug 的症状极具迷惑性：控制台只有一句 `Cannot read properties of null (reading
> 'precision')`，指向 three.js 内部，看不出跟 StrictMode 有关。

## 6.5 三条通用教训（这批改动反复踩到的）

- **同一份数据不要在两个地方各写一遍规则**：问题 1 的正面做法是让"谁是答案"成为
  折叠与复制共用的单一事实源；反例是教室视图里"折行排版每逻辑行才推进一次 y"，
  导致折行段落全部叠在同一基线上。
- **长驻缓存 + 外部可改的文件 = 必须有一条回到文件的路径**：问题 12 就是这条。
- **派生状态不能用来判断对方的状态**：问题 10 就是这条。界面上的"正在执行"是派生的，
  不能拿它去决定"对方忙不忙"。

---

# 七、明确不要带进 main 的（扩展分支专属）

- 教室视图与人物：`src/classroom/`、`src/classroom-page/`、`src/views/index.ts`、
  `src/components/ViewTabs.tsx`、`src/lib/routes.ts`、`src/components/BoardWelcome.tsx`、
  `board-welcome.css`。
- 软考人设与语料：`server/agent/`、`docs/`（除 `docs/architecture/` 里的工程文档外，
  `docs/` 整体是教学语料）。
- 检索与教学闭环：`server/knowledge/`、`server/learning/`、`server/grading/`、
  `server/typesafe/`、`server/env.ts`、`src/shared/learning.ts`、`src/lib/question-records.ts`、
  `src/components/AskQuestionCard.tsx`、`StructuredToolResult.tsx`、`LearningResultCard.tsx`、
  `learning-results.css`。
- 噜噜的 GLB 资产：`public/models/lulu.glb`、`assets/lulu/`。
- 探索脚本：`scripts/bench-*`、`check-classroom*`、`check-knowledge`、`check-grading*`、
  `check-learning*`、`check-persona-refresh`、`check-bootstrap.mjs`。
- 其他：`tasks/`、`skills-lock.json`、`package.json` 里扩展专用的依赖与脚本。
