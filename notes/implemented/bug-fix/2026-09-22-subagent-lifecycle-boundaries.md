# 子智能体：生命周期、权限与宿主边界修复

Status: implemented（`feat/user-subagents`；已提交 `1ae3b0a`，未推送、未合并）

## 决策与理由

修复源码审查复现的 6 项缺陷：初始化超时/取消失效、固定模型模糊回退、扩展未绑定、父子容量竞争、工具缺失静默降级、设置浅合并。保持当前同步委派范围，沿用 pi SDK，不增加后台协作、Team 或新的编排系统。

| 模块 | 唯一职责 | 不持有的能力 |
|---|---|---|
| `server/pi/subagent-tool.ts` | 模型参数、定义快照、父工具授权交集、模型可见结果/错误 | SDK 会话、容量分配 |
| `server/pi/subagent-worker.ts` | 装配依赖，持有运行记录及资源直到清理完成 | 模型解析规则、UI 协议、SDK 会话内部状态 |
| `server/pi/subagent-lifecycle.ts` | 排队/初始化/执行/退出共享取消信号和截止时间；区分调用结束与资源退出 | 工具和模型选择 |
| `server/pi/subagent-execution.ts` | 子轮次计数、停止原因与可见结果校验 | Host、UI 和容量 |
| `server/pi/subagent-session.ts` | 精确模型解析、内存设置、SDK/扩展创建与关闭 | 父会话注册表、父输入框、磁盘凭据复制 |
| `server/pi/session-capacity.ts` | 父会话、创建中会话、worker 的同步预留与幂等释放 | 模型、SDK、队列策略 |
| `server/pi/subagent-capacity.ts` | worker 与定义并发限制、FIFO 排队 | 独立的总会话计数 |
| `server/pi/extension-ui.ts` | 对话框/通知传输、运行归属、子 UI 名称隔离和取消 | 会话切换、模型更改、主会话生命周期 |
| `server/pi/host.ts` | 注册/装配父会话与上述依赖、向浏览器发布事件 | 子初始化和执行细节 |

`SubagentLifecycle` 的 `drained` 不是第二套执行状态；它只证明被它观察的 operation 已执行完 finally。`runs` 继续持有尚未退出的 operation，容量由它实际拥有的 reservation 计算，不能用“工具调用已结束”推断“资源已释放”。

## 修复后的行为

1. **完整调用预算**：默认 120 秒覆盖排队、运行时加载、扩展初始化、模型执行及退出。取消/超时最多额外等待 100ms 协作清理窗口。启动前/启动后检查同一个信号，取消后的迟到会话不会 prompt。
2. **迟到资源归属**：不响应取消的同进程初始化或工具不会阻塞父调用无限等待，但仍占 worker/host 容量；待它返回或拒绝，才销毁、观察错误并释放容量。永久不退出的可信扩展会持续占槽；JavaScript 无法安全强杀同进程扩展。没有把这类未退出工作误报为容量归零。
3. **精确路由**：固定 `{providerId,modelId}` 仅调用 `getModel` 并检查返回二元组与该 provider 凭据。拒绝模糊匹配、跨 provider 回退、自动构造未知模型。继承仍使用父当前模型对象。
4. **扩展生命周期**：prompt 前执行 `bindExtensions/session_start`；正常或取消后的最终清理先发 `session_shutdown` 再 dispose。子会话不能执行 newSession/fork/switchSession/navigateTree/reload。
5. **子用户交互**：沿父对话框通道回到现有 UI，带 `origin={agentId,agentName,runId,toolCallId}` 和名称前缀。用户回复精确匹配 dialog id；取消只关闭该 run 的对话框。状态/组件 key 按 run 隔离，子扩展不能改父输入框。重连快照保留 origin。
6. **容量预留**：create/fork 在首个 await 前与 worker 使用同一个 SessionCapacity。失败回滚；重复恢复拒绝且释放失败方预留；kill/shutdown 先关闭准入并取消父，reset 重建时不允许复活已被关闭的会话。
7. **工具缺失**：selected 缺少父授权或子 registry 工具都失败。all 允许工具面缩小，但缺失项同时写入模型可见 content 与 details。只读豁免和禁止递归沿用原契约。
8. **设置继承**：两个配置层分别放入内存 storage，由 SDK fromStorage 完成递归合并；子设置修改不写父配置文件，也不抹掉项目覆盖。

## 放弃了什么

- 不采用“Promise.race 超时后立刻释放槽位”：初始化仍在运行，释放会造成无主工作和虚假的容量空闲。
- 不把 CLI 的便捷解析用于固定模型配置：结构化精确选择不能带隐式候选回退。
- 不直接把父工具闭包/完整宿主对象传入子会话：扩展在子会话重新加载，只注入窄 UI 端口。
- 不把 UI、调度、初始化全部加入 PiHost：桥接和 worker 运行逻辑分别拆出，Host 总行数下降。
- 不将当前补丁扩展为 ZCode 全量协作模式。若后续明确要求同一 child 的 send/wait/stop/恢复，再以稳定 childSessionId 和持久化关系为入口设计，不复用定义 ID 冒充运行实例。

## 验证

新增 `scripts/check-subagent-lifecycle.ts` 与 `scripts/check-subagent-boundaries.ts`，已纳入 `npm run check`。前者覆盖初始化/执行挂起、超时、父取消、迟到成功/拒绝、保留槽位、幂等释放和关闭准入；后者使用真 SDK/真 PiHost 覆盖精确路由、双层设置、扩展启动/关闭、父子对话框、两个子会话实际并行、回传、取消、容量竞争和失败回滚。

测试 fixture 只在临时目录使用空凭据运行时，模型输出由本地 stream 构造，网络入口显式拒绝。原有 subagent tool/SDK、隔离测试服务、队列、提问卡片、日志、会话身份/状态和工具预设检查通过。项目类型检查与新增测试的严格类型检查通过。本轮不将这些结果表述为真实模型或浏览器验收。
