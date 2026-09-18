# pi-webx 接入官方 pi 协议的迁移评估

评估日期：2026-09-18。pi-webx 基线提交：`3b180fddaaeac6934f2049e5cf9b01520efd652b`；评估时依赖及实际安装版本为 pi 0.84.4，对照官方 v0.85.1 源码及 npm 发布包。版本与能力结论固定在本次核验时点，后续实施前应重新检查上游发布状态。

## 在其他电脑接续

本次交付只包含这份评估文档，不包含架构改造或依赖升级。评估时工作区位于 `feat/ruankao-agent`；软考“明远”人设、`server/agent/`、人设验证脚本及教材资料等仍是该工作区的未提交改动，**拉取 main 不会得到这些功能或资料**。下文“当前能力”中涉及软考人设的内容描述的是当时工作区，不表示 main 已实现；其余功能也应以拉取后的实际源码为准。

在已经克隆的 pi-webx 仓库中，确认工作区干净后执行：

```sh
git fetch origin
git switch main
git pull --ff-only origin main
```

先阅读“决策”“推荐的最小改造范围”和“补充：DeepSeek Harness 的做法”。本报告提供研究结论和实施候选项，不表示任何迁移已经完成。使用本文的 GitHub 固定版本链接可查证上游实现，不依赖原电脑目录。需要本地检查 DSH 时，克隆 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，切换到本文记录的提交；不要用其他版本的行号直接替代证据。

## 决策

当前推荐继续使用受支持的进程内 SDK，并缩减自写会话管理、类型镜像和未完成的命令映射。不建议立即把主产品迁到实验性 pi-client / pi-server / Chord 链路。

官方远程协议具备 Web 接入的技术基础，但 coding-agent 的完整实验运行时目前不是可通过普通 npm 安装获得的受支持产品接口。迁移还涉及插件、会话存储、工具配置和前端状态模型，不能归为“替换传输层”。

实验服务端可以单独研究，暂不作为主线改造方案。

**实施更新（2026-09-18，b3b0b98 之后）**：上面"三条路线"中路线一的 HTTP/SSE 建议已被用户决策替代——传输层改为 **单条 WebSocket 多路复用**（`/api/ws`），但采纳的是 DSH 的分层语义而非其 Cordis/Typert/Gateway 机制：unary 命令仍走 HTTP POST（与 DSH 相同的拆分）；每会话内存事件日志（seq 环形缓冲，`server/pi/session-journal.ts`）承担断线补帧，缺口回退 `get_messages` 全量快照，pi SessionManager 仍是权威记录；prompt 级 requestId 去重/回显/echo-retire（`PromptRequests` + `transcript.addEcho/retireEcho`）；前端抽出框架无关的 `PiSessionClient` 会话对象（`src/lib/session-client.ts`）经 `useSyncExternalStore` 接入 React，WS 重连状态机独立在 `src/lib/connection.ts`。SSE 路由已移除。相关定点检查：`npm run check`（transcript + journal）与 `scripts/ws-smoke.ts`（需先起服务）。

## 关键证据

### 发布状态是第一道限制

[官方 0.85.1 CHANGELOG](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/CHANGELOG.md#L17) 明确说明：0.85.0 曾意外发布内部实验代码并导致 SDK 导入失败；0.85.1 将 experimental client/plugin 子路径及 server/client 命令改为仅源码通过 pi-test.sh 可用，受支持的 local SDK 和 stdio RPC 保持不变。

实际下载 npm 0.85.1 tarball 后验证：

- `dist/index.js`、`dist/bundle/rpc-entry.js` 存在。
- `dist/client/index.js`、`dist/experimental/server.js`、`dist/experimental/cli.js` 不存在。
- Node ESM 解析根 SDK 和 `/rpc-entry` 成功。
- Node ESM 解析 `/client` 与 `/experimental/plugin` 均返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

单独发布的 pi-client/pi-protocol/pi-server 底层包，与 coding-agent 完整业务服务可以稳定直接安装使用，是不同的问题。

### 浏览器可行，但没有现成完整 Web 入口

[pi-client](https://github.com/earendil-works/pi/blob/v0.85.1/packages/client/README.md) 使用 ByteTransport；[pi-server](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/README.md) 使用 ServerListener，内置 Unix socket 实现。Web 需要提供 WebSocket 双端适配，或把 WebSocket 字节转发给 Unix socket。

本次以 esbuild 的 browser 平台打包 v0.85.1 Client 源码及 Chord/protocol 依赖成功，无 external imports。这只证明核心客户端能形成浏览器 bundle，不证明现有 React 产品已接通服务端，也不覆盖插件展示层。

协议与会话服务也在演进：项目 0.84.4 为协议 v1、PiClient/RemoteSession；对照版为协议 v8、Client/Chord 服务。不能跨版本混用示例和接口。

## 功能匹配

| 当前 pi-webx 能力 | 官方实验链路现状 | 迁移判断 |
|---|---|---|
| 文本、图片、steer/follow-up、abort、compact | AgentController 有对应服务 | 能力有基础，请求结果与操作 ID 语义需要映射 |
| 流式正文、思考、工具卡、重连恢复 | Transcript 提供 replicated lane state | React 渲染可保留，现有事件 reducer/订阅逻辑需重新适配 |
| 软考“明远”人设与资料库提示 | 当前实验 worker 创建 Harness，未沿用项目 DefaultResourceLoader 注入链路 | 必须单独实现并核验系统提示；不能默认继承 |
| render_ui、旧式 pi 扩展 | 当前项目使用 ExtensionAPI/registerTool；实验路径加载 Chord session/presentation facets | 无已证实的直接兼容路径，需要适配或重写扩展接入 |
| confirm/input/editor/select 弹窗 | 实验 PresentationUI 是本地服务，暴露 select/showStatus | 当前反向弹窗协议仍需产品实现，不能直接删除 |
| 四种工具预设及会话持久化 | 底层 lane 有工具能力；实验 worker 当前默认 read/write/bash，控制服务未暴露现有 get_tools/set_tools 契约 | 要补工具注册、服务与持久化语义 |
| 历史记录、resume、fork | 新 JsonlSessionRepo 使用 format 4，并具有 legacy v3 兼容转换 | 并非完全不兼容，但不是无损原位替换；需副本验证及回退策略 |
| 多工作区 cwd | 实验 SessionCreateOptions 只含可选 id；参考 server 用 process.cwd() 创建会话 | 必须扩展创建契约或调整服务实例划分 |
| 模型选择与 thinking | Models 服务已有选择、刷新和 thinking 控制 | 可复用，但元数据和配置 UI 契约不同 |
| provider/API key/model CRUD、Git、目录选择 | 不由已有实验会话服务完整提供 | 产品后端仍需保留 |

功能证据主要来自 [官方服务清单](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/experimental/services/README.md)、[实验 worker](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/experimental/session-worker.ts#L808)、[会话服务](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/experimental/services/sessions.ts)、[PresentationUI](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/experimental/services/presentation-ui.ts)。

关于历史记录：当前 SessionManager 写 v3；新存储支持读取 v3，首次写入时可升级到 v4。项目自己的历史扫描、custom 工具预设记录及分叉行为仍需要对照验证。不能直接让试验服务写入真实历史目录。

## 三条路线

| 路线 | 获益 | 成本/限制 | 建议 |
|---|---|---|---|
| 保留 HTTP/SSE，使用现有进程内 SDK | 延续现有功能与配置；无需引入新进程拓扑 | 仍需少量浏览器适配和产品状态投影 | 当前首选 |
| 薄 Web 服务转发官方 stdio RPC | 上游维护命令执行及扩展 UI 协议；进程隔离 | 恢复子进程生命周期管理；自定义命令仍要扩展 | 只有确实需要进程隔离时优先考虑 |
| 官方实验 client/server + WebSocket | 长期可复用官方路由、状态复制、挂接和 worker 管理 | 源码构建、接口不稳定、插件/存储/状态迁移，范围大 | 独立研究，暂不切主线 |

官方 [RPC 文档](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md) 本身建议 Node/TypeScript 应用考虑直接使用 AgentSession。当前 Express + SDK 架构符合这条路线。

本次在隔离的临时 agent 配置目录、离线模式、无扩展、无持久化、无模型调用条件下启动本地 0.84.4 官方 RPC：get_state/get_messages/get_commands 成功；get_tools 返回 Unknown command。说明 RPC 可运行，但并非当前自定义协议的完整替换件。测试子进程已退出。

## 推荐的最小改造范围

1. 优先核对公共 SDK 类型，减少 src/shared/protocol.ts 中重复定义；保留必须跨 HTTP 序列化以及产品自定义的字段。仅类型导入，避免把 Node 运行时带入浏览器。
2. 评估每个 hosted conversation 使用 AgentSessionRuntime，把 new/switch/fork 时的 cwd 绑定服务重建和生命周期交给官方；宿主仍负责路由身份、订阅重绑及弹窗清理。不能简单把当前整段复制式 fork 换成一个同名方法。
3. 补齐 SDK 已存在但当前 host 返回 unsupported 的自动压缩、自动重试、HTML 导出等映射。能力是否对用户展示应由真实支持情况决定。
4. 保留必要的 HTTP/SSE、Web UI 交互、工作区/Git/模型配置服务，以及软考人设和组件渲染。
5. 清理误导性 bridge/子进程注释和 README 过期能力描述。命名清理本身不计作架构收益。

主要触面：[host.ts](../../server/pi/host.ts)、[protocol.ts](../../src/shared/protocol.ts)、[usePiSession.ts](../../src/lib/usePiSession.ts)、[transcript.ts](../../src/lib/transcript.ts)。这四个文件在评估时工作区合计约 3335 行（包含未提交的人设改动）；其中含必要的 UI 投影和业务语义，不能当作可整体删除的冗余代码。

## 未来整迁的验证门槛

- 首先选定可复现的上游版本和发布方式；若依赖源码构建，明确由项目承担升级维护成本。
- 浏览器到服务端跑通流式消息、图片、工具结果、abort、steer/follow-up、断线重连和状态快照；不重复提交已接收操作。
- 人设全文、资料库路径、render_ui 的交互闭环、四类弹窗均保持可用。
- 四种工具预设及恢复后的工具集保持一致。
- 仅用历史副本验收 v3→v4、压缩边界、分叉、自定义记录和回退。
- 多 cwd 的文件操作、配置与会话相互隔离；关闭页面与结束执行的生命周期语义可验证。
- Web 传输补齐连接访问控制、帧限额、背压与清理行为。

## 本次验证边界

- 已检查当前源码、安装包、上游 tag 和实际 npm 0.85.1 tarball。
- 评估时工作区的 `npm run typecheck` 通过；这是历史验证结果，不代表未来改造已经通过验证。
- scripts/check-transcript.ts 的 20 项检查通过。
- 官方 Client 源码 browser bundle 通过，未做完整浏览器端到端连接验收。
- 官方 stdio RPC 的无模型只读探针通过，并验证了 get_tools 的协议缺口。
- 评估阶段没有修改产品源码、更新依赖、迁移历史数据或改变用户 pi 配置；本次交付只新增评估文档。

因此，本次能支持的决策是“保留正式 SDK，针对性减薄宿主；实验远程路线暂缓”，而不是声称整迁已经验证完成。

## 补充：DeepSeek Harness 的做法

核验对象为 [DeepSeek Harness 提交 `c291e7961a515f6d7af9304e7fd1d257929aef26`](https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26)。以下是源码与定点行为测试结论，不代表已核实当时运行的 dsh web 进程与该 checkout 完全一致。

DSH Web 使用同进程核心 Agent/Session、会话领域适配层和通用 Remote 网关。其对外 TypeScript SDK 是另外一条启动 dsh --profile sdk 并经 stdio JSON-RPC 驱动运行时的入口；Web 主链路没有经由该 SDK。

| 层 | 责任 | 固定版本源码证据 |
|---|---|---|
| React / 会话客户端对象 | 提交用户操作、观察稳定快照和事件窗口 | [发送](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/client/sessions/session.ts#L249)、[订阅快照](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/client/sessions/session.ts#L479) |
| 生成的 Remote 客户端 / Gateway | 类型与值校验、方法调用、流管理 | [Remote 调用](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/gateway/src/client/index.ts#L443) |
| Connection | HTTP 请求信封、rpcId 关联、Host/Origin 和 cookie 鉴权 | [HTTP 调用](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/connection/src/client/rpc.ts#L31)、[鉴权](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/connection/src/browser-auth.ts#L233) |
| SessionController | prompt/cancel/history/control 业务适配、Agent 激活策略 | [prompt 入口](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/index.ts#L346) |
| Agent / Session / agent-loop | prompt 组装、模型与工具执行、权威会话事件 | [Agent 流](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent-loop/src/agent.ts#L380)、[会话提交](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/session/src/index.ts#L749) |

理解上述链路时，需要保留以下语义边界：

1. **观察不激活不是所有读取接口的统一保证。** `list/page/control` 不恢复冷 Agent；普通冷会话的 `follow` 在 opening snapshot 发出后调用 promote，最终调用 resolveObservedAgent/resume。因此 follow 会有 Agent 生命周期副作用，但不能据此等同于自动发送新 prompt。证据：[快照后 promote](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/history.ts#L203)、[后台激活](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/index.ts#L173)。
2. **live 没有 durable cursor，不等于完全不恢复。** Host 为 live 保留 revision 和 activeAttempt 的 compact prefix；follow snapshot 携带该 baseline，Client 检查逐帧 revision/index，缺口触发重建。证据：[累计前缀](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/assistant-stream.ts#L84)、[快照基线](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/history.ts#L184)、[revision 校验](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/client/transport.ts#L206)。
3. **最终替换不仅处理 assistant/message。** 中断或失败还可能落为 assistant/attempt；客户端按 attempt 和 matching end 交接 durable settlement。小数 seq 只是前端临时排序，不能当作持久化游标。证据：[临时排序](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/client/sessions/assistant-stream.ts#L148)、[交接类型](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/client/sessions/assistant-stream.ts#L203)。
4. **“唯一对接层”应限定为会话领域主适配入口。** Gateway/Connection 承担通用协议，其他 Remote 命名空间仍有自己的领域服务；subagent 的 prompt 例如经 remote.subagents.prompt。SessionController 不等于全系统唯一接触核心 Agent 的代码。
5. **按会话组合能力成立，但并非所有服务都是会话私有。** composeAgent 调用 presets.mount(agentCtx, id)，Web profile 禁用相应 host tool 行；subagent registry/provider 等跨会话服务仍留在 host。证据：[会话组合](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/agent.ts#L374)、[Host 共享服务](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/bundle/web-app/cordis.patch.yml#L437)。
6. **客户端并非一个大 snapshot store 包含一切。** 会话状态的 subscribe/getSnapshot 与 MutableSessionEventSource 的事件窗口分开，UI 再按自身需要订阅。

值得迁入 pi-webx 的设计：明确会话对象接口；让运行时拥有权威会话记录；将已完成记录、正在生成的展示状态和队列/状态基线区分；对发送请求建立业务 requestId 去重；把网络恢复与 React 展示解耦。DSH 的 [commands.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/commands.ts#L321) 已检查排队或日志中存在的 requestId，这与单次 HTTP 的 rpcId 是不同责任。

不宜照搬 DSH 的整套 Cordis/Typert/AgentLoop。DSH 同时拥有核心 Session 事件与 Web 适配，pi-webx 消费外部 SDK；若 pi 未提供对应持久事件游标，不能用宿主临时计数伪装成同等的 durable replay。现阶段继续以 pi SessionManager/消息快照为权威，再按产品需要设计 Web 恢复语义。

验证：在上述 DSH 提交执行以下定点测试，3 个文件、29 项测试通过，无模型调用。该结果不替代后续改造的浏览器端到端验收。

```sh
node node_modules/vitest/vitest.mjs run \
  packages/api/session-controller/tests/assistant-stream.host.spec.ts \
  packages/api/session-controller/tests/assistant-stream.client.spec.ts \
  packages/api/session-controller/tests/session-history-journal.host.spec.ts
```

项目现有 transcript 检查命令为：

```sh
npm run typecheck
npx tsx scripts/check-transcript.ts
```

后续开始实施时，先重新运行与改动触面相符的检查，再验证真实 UI 的流式回复、取消、重连、工具卡、弹窗及历史恢复。
