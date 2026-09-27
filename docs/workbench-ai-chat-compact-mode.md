# 工作台 AI 对话：全屏浮层与工作步骤展示规范

> 需求（2026-09-24）：AI 对话框收起后右下角保留星星入口；展开后**占据整屏、正文列居中**，
> 对话输出与 /chat 正文同源渲染。
> 需求（2026-09-25）：显示模式从单一「简洁」扩为 **dsh 全套四档**（简洁/标准/详细/完全展开），
> 默认「标准」，工作台浮层与 /chat 同时接入，本文第二节是四档规范。
> 对齐参考：`deepseek-harness/packages/client/ui-chat/src/client/presentation-policy.ts`
> （策略表）、`conversation-nodes/README.zh.md`（展示模式表 / 整轮折叠）、`README.zh.md`（正文列宽与滚动归属）。

## 一、形态：全屏浮层，不是侧栏

| 状态 | 表现 |
| --- | --- |
| 收起 | 工作台正常布局；右下角星星按钮（`.fab`，桌面）/ 底部 tab 的 AI 项（移动端）召回。 |
| 展开 | `.ai-overlay`（`position: fixed; inset: 0`）盖过顶栏与导航，占据整个屏幕；Esc 或右上角关闭收起。 |

- 正文列**居中**：转录列与输入区都是 `max-width: 900px; margin: 0 auto`（dsh 正文同宽）。
- 默认**收起**。对话框不记忆「上次是否打开」——全屏形态下自动弹出会盖住工作台，
  原 `prefs.panelOpen` 偏好与设置项已随本形态移除。
- 层级：`--z-drawer`（40）。低于命令面板（60）与弹窗（50），pi 提问弹窗、⌘K 都能盖在它上面。
- 正文渲染**复用 `/chat` 的 `TranscriptView`**（`src/components/TranscriptView.tsx`），
  不在工作台侧另写一套——两边天然一致，不会漂移。主题由 `ThemeProvider themeMode`
  随工作台亮/暗切换，暗色下不出现浅色气泡。

## 二、工作步骤展示四档（dsh 策略表移植）

设置 → 外观 → **工作步骤展示**，四档（dsh 的「设置 → 通用设置 → 工作步骤展示」同款），**默认「标准」**。
策略表在 `src/lib/transcript/presentation.ts`——渲染代码只读策略字段、**永不比较模式枚举**，
加新模式只改那张表（dsh `presentation-policy.ts` 的纪律原样移植）：

| 档位 | 折叠已完成轮 | 进行中轮 | 活动头细节 | 思考行预览（结束后） |
| --- | --- | --- | --- | --- |
| 简洁 `compact` | 折叠 | 折成一条活动头 | 只显示活动类型（「正在运行命令」） | 无 |
| 标准 `standard`（默认） | 折叠 | 折成一条活动头 | 带命令/路径细节（「正在运行命令 · npm test」） | 保留 |
| 详细 `detailed` | 折叠 | 平铺（流式正文、运行中工具卡实时可见——引入模式前 pi-webx 的原行为） | — | 保留 |
| 完全展开 `verbose` | 不折叠 | 平铺 | — | 保留 |

机制要点（与 dsh 逐条对应）：

| 规则 | 内容 |
| --- | --- |
| 答案常显 | 每轮**最终答案**的 markdown 正文永不折叠；简洁/标准下**正在书写的答案文本**（流式、未发工具调用）也实时可见。 |
| 过程折叠 | 已完成轮原位渲染活动摘要（无工具时「已完成分析」，有工具时按类别显示「执行了命令」等）；进行中轮的过程行藏进活动头（`data-testid="live-process-row"`）之后。活动头在首个过程消息前就显示「正在分析请求」，命令运行时显示「正在运行命令」，命令结束而模型继续工作时回到分析提示。 |
| 回复交接 | 回复正文一出现，活动头立即切成完成摘要且停止 shimmer；**尚无过程可摘要时保持「正在分析请求」**（首个叙述窗口：思考已流、文字已开始、工具调用未落地——该步自己的思考留在活动头后，不得弹出，也不得拿空过程合成「已完成分析」）。纯文本回复从开始流式输出到 `agent_settled` 之间始终可见。折叠窗口的 startId 标记跳过流式中的条目（`message_start` 先于 `turn_start` 到达时窗口不得挂在待折叠步骤上）。 |
| 手动展开 | 点活动头/摘要行展开该轮过程；折叠体 `hidden=until-found` 留在 DOM，页内搜索命中自动揭示。 |
| 展开延续 | 活动头与摘要行共用同一展开 key（turnId），轮次结束切换形态时展开状态无缝衔接。 |
| 复制只在答案 | 复制按钮只挂在轮次最终答案下；中间步骤是过程，不提供复制。 |

持久化与入口（两个面、两条既有偏好通路）：

| 面 | 存储 | 入口 |
| --- | --- | --- |
| 工作台 AI 浮层 | 服务端 SQLite prefs 键 `transcriptView`（白名单键，脏值回落 standard） | 设置 → 外观 → 工作步骤展示（`data-testid="settings-steps-mode"`） |
| /chat 页 | localStorage 键 `pi-webx-transcript-view` | 设置 → 通用 → 工作步骤展示 |

工具卡的输出呈现沿用 /chat 的 ToolCard 规则（展开只看结果、150px 独立滚动），此处不重复，
见 `docs/history/ALIGN-DSH-REFERENCE.md` ②。

## 三、工作台本地兜底（不属于转录）

`「问小台」pending 气泡 / 会话失效软提示 / 错误条`是工作台自己叠的状态，不属于会话
transcript，钉在**输入框上方的兜底条**（`data-testid="chat-fallback"`）里：不滚进正文、
永远可见。pending 气泡的留存/撤销由 `shell/AIPanel` 的 `nextAskState` 纯函数决策
（发送在途 ≠ 面板被清空；transcript 回显成功后撤掉），细节见该函数注释与
`scripts/check-workbench-ui.ts` 第 10 节。

## 四、落点（改这里之前先读本文）

| 职责 | 位置 |
| --- | --- |
| 浮层壳（全屏 / 居中 / Esc / 兜底条 / 输入框 / 模式透传） | `src/workbench-app/shell/AIPanel.jsx` |
| 提问作答（dsh 形态：问题占据输入框座位，复用 /chat 的 `QuestionComposer`，无弹窗；转录侧提问行走 `AskQuestionCard`） | `src/workbench-app/shell/AIPanel.jsx` + `src/components/QuestionComposer.tsx` |
| 开合状态与 askAI 接线、prefs 模式解析 | `src/workbench-app/App.jsx`（`panelOpen` 默认 false；`stepsMode` 传入浮层） |
| 会话数据（transcript / localRows / nextAskState 观测） | `src/workbench-app/pi-webx/useWorkbenchPiChat.jsx` |
| 四档策略表 + 活动头派生（模式的机制所在） | `src/lib/transcript/presentation.ts` |
| 折叠计算（reducer，与模式无关） | `src/lib/transcript/fold.ts` |
| 正文渲染（按策略字段分支） | `src/components/TranscriptView.tsx` |
| 摘要行 / 活动头两行组件 | `src/components/TranscriptProcessRow.tsx` |
| 设置入口（工作台） | `src/workbench-app/shell/SettingsSheet.jsx`；prefs 白名单 `server/workbench/store.ts` |
| 设置入口（/chat） | `src/components/settings/GeneralSettings.tsx`；读写 `src/app/preferences.ts` |
| 门禁 | `scripts/check-workbench-ui.ts` 第 10、11 节 |
