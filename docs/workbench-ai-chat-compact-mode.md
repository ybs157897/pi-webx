# 工作台 AI 对话：全屏浮层与简洁模式输出规范

> 需求（2026-09-24）：AI 对话框收起后右下角保留星星入口；展开后**占据整屏、正文列居中**，
> 对话输出与 /chat 正文同源渲染；显示模式对齐本地 deepseek-harness 的「简洁模式」
> （设置 → 通用设置 → 工作步骤展示 → `compact`），本文是该形态的输出规范。
> 对齐参考：`deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/README.zh.md`
> （展示模式表 / 整轮折叠）与 `README.zh.md`（正文列宽与滚动归属）。

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

## 二、简洁模式输出规范（对齐 dsh `compact`）

转录按「最终答案正文常显、过程折叠」输出，规则与 dsh 简洁模式逐条对应：

| 规则 | 内容 | dsh 对应 |
| --- | --- | --- |
| 答案常显 | 每轮**最终答案**的 markdown 正文永不折叠：思考、工具调用都收起后，答案留在原位。 | 「最终答案正文，不随过程收起」 |
| 过程折叠 | 已完成轮次的过程（思考 + 工具调用 + 中间回复）默认收起，原位渲染一条摘要行：`已思考 · N 次工具调用 · N 条消息`（有哪段显示哪段）。 | 「符合条件的已完成轮次：初始收起」 |
| 摘要即预告 | 摘要行是类别级概括（思考/工具/消息计数），**不带**已结算推理的首行预览。 | 「已结算推理预览：隐藏」 |
| 手动展开 | 点摘要行展开该轮过程；过程里的单条思考、单个工具卡再各自手动展开。收起不影响浏览器查找（折叠体 `hidden=until-found` 保留在 DOM）。 | 「单个推理与工具正文：手动展开」 |
| 运行中不折 | 轮次进行中过程全部实时可见（流式正文、运行中的工具卡），轮次结束才折叠。 | 「尚未结束：过程内容保持展开，不能收起整轮」 |
| 复制只在答案 | 复制按钮只挂在轮次最终答案下；中间步骤是过程，不提供复制。 | 「复制属于读者要的东西：轮次最后一段正文」 |

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
| 浮层壳（全屏 / 居中 / Esc / 兜底条 / 输入框） | `src/workbench-app/shell/AIPanel.jsx` |
| 开合状态与 askAI 接线 | `src/workbench-app/App.jsx`（`panelOpen`，默认 false） |
| 会话数据（transcript / localRows / nextAskState 观测） | `src/workbench-app/pi-webx/useWorkbenchPiChat.jsx` |
| 折叠与正文渲染实现（简洁模式的机制所在） | `src/components/TranscriptView.tsx` + `src/lib/transcript/fold.ts` |
| 门禁 | `scripts/check-workbench-ui.ts` 第 10 节 |
