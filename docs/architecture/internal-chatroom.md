# 模块 Agent 内部聊天室

内部群是需求管理、代码开发、我的助理、日志查询的公开协作记录。群消息、Agent 私有会话、协作任务及单次执行分别持久化；普通模块对话不自动公开到群里。

## 使用流程

1. 用户在群中发消息，可 @ 一位成员，也可广播让成员按职责认领。输入区显示当前话题，补充消息延续该话题；「新话题」清除关联。回复气泡保留 replyTo。
2. 普通交流或澄清进入成员自己的讨论会话。Agent 明确接下可交付工作后调用 `chatroom_work(action="accept")`，创建协作任务和自己的分工；讨论会话升级为此分工的执行会话，原讨论绑定清空。
3. 用户在任务卡片点「继续」，后续消息明确携带协作任务 ID。其他成员接到同任务交接后拥有自己的分工及执行会话。没有唯一任务关联时保留讨论身份，不猜测最近任务。
4. Agent 调用 `chatroom_work(action="update")` 记录等待用户、等待同事、完成或失败，并给出真实工作摘要。消费成功只表示这条输入处理回合成功并有公开回复，不表示任务或业务待办完成。
5. 用户可取消任务，控制直接作用于当前运行；已取消但结果不明的任务可单独「核对完成」，保持取消状态并解除原话题阻拦。中断任务保留原会话与执行记录；未核对的工具副作用要求用户检查实际改动后明确恢复，不自动重跑。

群任务是协作执行记录，引用现有需求和待办，不替代业务记录。历史群消息原样保留；旧回合没有持久接收 Session 绑定的，不伪造恢复关系，后续输入按新绑定处理并可查询旧公开记录。`requirements_dispatch` 原子保存需求与待办；`assistant_coordinate` 仍只允许按服务端研发回报及版本校验完成待办。安排方案仍须界面确认。

## 身份与状态

| 对象 | 持久身份 | 职责 |
| --- | --- | --- |
| 群消息 | messageId / seq / threadId | 公开正文、回复关系、来源与业务引用 |
| 逐成员消费 | messageId + agentId | 固定订阅者快照、认领与处理确认 |
| 讨论绑定 | workspaceKey + roomId + threadId + agentId | 持续普通交流，不与个人聊天共享 |
| 协作任务与分工 | taskId / taskId + agentId | 工作目标、各成员状态、成果摘要与执行会话 |
| Run | runId / attempt | 一次接收执行、sessionId、输入来源、检查点及工具记录 |

讨论及执行 Session 均使用公共模块装配入口，身份、工作目录、配置快照、Skills、MCP、知识范围继续按模块收口。逻辑会话可持续，运行实例每回合结束释放；再次接收输入按持久 sessionId 冷恢复。配置更新只作用于新会话；原会话按原配置快照恢复。

个人会话与群执行会话分别绑定。`module_agent_session_index` 精确登记模块 Session 路径与身份，不依赖全局最近 200 条列表；历史未登记日志按 header ID 查找并经原身份与快照校验后登记。客户端不能指定 sessionPath 或覆盖工具面。

工作状态包括 waiting、running、waiting_for_user、waiting_for_agent、completed、failed、interrupted、needs_review、cancelled。每个成员的状态独立，任务状态由分工汇总。completed 必须显式报告真实成果，不因收到消息、工具运行或回合结束自动生成。业务待办完成另走受限业务工具。

## 消息协议与执行

- `chatroom_send` / `chatroom_read` / `chatroom_work` 是模块公共通信工具，按 YAML 白名单装配。发言身份取服务端闭包，模型不能指定 sender。正文 @ 与可选 to 须一致，一条消息只点名一人。
- 群广播固定快照全部其他启用成员。成员使用禁业务工具的短命判定会话；认领后进入自己持久绑定的工作会话，判定 JSON 不污染工作上下文。收悉、感谢和结果广播不认领；自动记录的最终正文不再次路由 @。
- 消息落库后入调度，发送工具不等待下游，避免相互等待。调度有界并行，只认领当前可执行的成员消息；同一成员的积压不会占满投递名额。每 Agent 收件箱 FIFO 串行，不同 Agent 可以独立处理。广播按成员顺序准入，同一时刻一个广播投递；广播已终态的成员可处理后续点名消息，其余成员保持原顺序。现有模块工作目录冲突检查和 maxRunningSessions 继续生效。
- `sessionId + entryKey` 保持消息幂等，同键不同请求拒绝。协作工具和用户任务操作分别记录幂等键；消费终态不自动重复执行。自动接力仍限制深度及每段消息总数。
- 接收执行的 sessionId、Run、工具开始/结束及交接父 Run 持久关联。群里只公开任务摘要和成员执行状态，不公开内部路径、私有转录、思考过程或工具参数。
- 持久群记录完整保留，提示词仅注入上次成功游标后的公开增量。超过注入上限会显式说明遗漏数量，Agent 可用 chatroom_read 查回原文；SDK 自己管理模型窗口和压缩。原始记录保存与模型一次能看到的上下文是不同边界。

## 中断与恢复

未开始的 pending 消息可继续投递。重启时不自动重跑 running 消费：保留已经成功的成员，并将未确认执行记录为 interrupted；有工具副作用风险时为 needs_review。任务、原 Session、工具记录与已持久交接保留，子交接可以有自己的消费结果。

继续失败/中断任务会创建明确的新用户输入和新 Run，恢复原成员的执行 Session。结果不明须 reviewed:true；恢复前先核对文件及业务状态，模型提示词也要求不得盲目重复。取消只结束执行目标，不回滚已发生的文件或外部副作用。review 要求 reviewed:true，保留历史 Run 的未明结果并写入核对时间；已取消任务保持取消，原话题可继续讨论，不能借核对重新启动已取消任务。

当前采用单宿主进程的收件调度与 Session 单写者，未引入跨进程调度租约；同数据库多宿主并行调度不在支持范围。工具开始/结束及人工核对账本用于识别恢复风险，不提供 Shell/API 的 exactly-once 保证。

## HTTP 与界面

- `POST /api/chatroom/messages`：`{body,entryKey,replyTo?,threadId?,collaborationTaskId?}`；来源固定用户，由服务端 HttpOnly cookie 提供幂等范围。任务必须属于该话题，不能注入业务引用。
- `GET /api/chatroom/messages?after=<seq>&limit=100&watch=<seq,...>`：群、成员、分页消息、被观察消息更新及公开 `tasks[]`。逐成员消费和任务状态分别显示。
- `POST /api/chatroom/tasks/:id/actions`：`{action:"resume"|"cancel"|"review",entryKey,expectedVersion,agentId?,reviewed?,body?}`；多成员恢复需指定成员，版本冲突须刷新，不覆盖并发变化。
- 用户退出或刷新群页面不会销毁任务；页面按 seq 拉齐消息，持续轮询成员和任务状态。草稿及失败重试键保持关联，切话题与任务后不能误重用其他路由的发送键。

## 实现与验证

`server/modules/chatroom/` 拥有消息、工作记录、路由、工具及运行器。模块装配与精确会话索引在 `server/module-agents/`，不重新实现 PiHost 事件协议。前端专属界面在 `src/workbench-app/modules/chatroom/`。

`npm run check:chatroom` 覆盖 SQLite/HTTP/业务边界、真实离线 SDK 运行、持续会话、任务状态、并发、取消及 SSR DOM。`scripts/check-module-session-index.ts` 验证超出最近列表范围的旧日志查找、真实 SDK 冷恢复和身份校验。`npm run dev:chatroom-fixture` 提供临时数据库/工作目录和真实 SDK 工具的离线浏览器验收服务。脚本模型可证明协议链路，不能替代真实模型规划与编码质量验收。

## 设计参考（固定提交）

- [AutoGen：成员缓冲与私有上下文独立保存](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_chat_agent_container.py#L197-L213)。save_state 不自动落盘，也不保存完整运行中队列。
- [LangGraph：逐任务 pending writes](https://github.com/langchain-ai/langgraph/blob/07b33185eab893be2ed031eedae52f09314bf77c/libs/checkpoint/README.md#L57-L69)。恢复可能重执行节点，副作用需独立校验。
- [OpenHands SDK：状态恢复与事件存储](https://github.com/OpenHands/software-agent-sdk/blob/79df4e896c1925a9c23d7d1f3cb2d4d1a801bd26/openhands-sdk/openhands/sdk/conversation/state.py#L430-L451)。加载 conversation 不等于自动继续被中断的执行。
- [DSH：持久 inbox 变更](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/src/inbox.ts#L197-L242)。其子 Agent 在线父级和进程内所有权限制不直接用于群消息承诺。
- [AAMP：TaskId 与 Session-Key、接收/求助/最终结果](https://github.com/larksuite/aamp/blob/7fd750875f4da2417672b91aa39eb30d4d7c80d3/docs/AAMP_CORE_SPECIFICATION.md#L94-L166)。借鉴语义，内部传输继续使用 SQLite 和现有 API。

真实模型验收 `scripts/check-chatroom-live.ts` 使用临时工作目录、数据库及当前配置模型，核对点名和广播的真实文件写入、读取及显式任务完成。可用 `PI_WEBX_CHATROOM_LIVE_TIMEOUT_MS`（默认 120000，最大 600000）调整验收回合预算，产物记录实际预算；生产默认回合预算为十分钟。
