# 推理等级改为一排勾选框

Status: implemented

## 决策与理由

「编辑模型配置」的推理等级行从「已选 chip（hover 出 ✕）+ ＋ 下拉追加」改成一排
7 个勾选框，按 pi 词表 低→高 排列（off/minimal/low/medium/high/xhigh/max，
off 显示 disabled），复用同弹窗「输入类型」「模型能力」两行的同一套 chip 语言
（`.chipRow/.chip/.chipOn`），不新造样式。用户明确要求去掉下拉、改成一眼看全
的勾选模式并兼顾美观。数据语义不变：勾 = 写入 `thinkingLevelMap`（保留已有映射
目标），取消 = 移除，空集合仍不写 `reasoning`。勾选集的词表序与幂等抽成纯函数
`toggleThinkingLevel`，由 `scripts/check-model-editor.ts` 钉住。

## 放弃了什么

放弃了 ref0 的对齐决定（ALIGN-DSH-REFERENCE.md ①、提交 `63a506f`）：参考实现
的等级行是光名字 chip、✕ hover 才出现，静止时与参考同形。改勾选框后这一行不再
与参考同形——勾选框本身常驻可见。换来的是：无需 hover 探索、无需下拉展开即可
看全并直达全部 7 档，且与本弹窗其余多选行同一交互语言，7 档全量可见没有第二层
隐藏状态。

## 证据

用户原话：「改成一排的勾选模式（checkbox），不要下拉，并注意样式美观度」。原
对齐记录见 ALIGN-DSH-REFERENCE.md ①（「推理等级的 ✕ 改成 hover 才出现」一条）；
本 note 即推翻记录，ALIGN 文件按历史留痕不改写。

## 复活条件

若重新以 ref0 逐像素对齐为目标，改回光名 chip + hover ✕ + ＋ 下拉即可：数据
契约（`thinkingLevelMap`、`reasoning`）未动，只需换回渲染与 toggle 入口，并撤销
本 note 对 ALIGN ① 该条的推翻。
