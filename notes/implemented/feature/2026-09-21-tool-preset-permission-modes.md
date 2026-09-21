# 工具预设改为三档权限模式

Status: implemented

## 决策与理由

composer 左下角的工具预设菜单从四项预设（纯对话/只读/默认/完全）改为三档权限
模式：仅可查看（read-only）→ 工作区内修改（default）→ 完全权限（full）。三档
的名字直接说出「这个档允许模型动什么」，比「只读/默认/完全」这种相对词更接近
用户真实要做的决定；对齐 ZCode 同类权限菜单的做法——每行一个盾徽、图标随权限
递进（ShieldCheck → 盾+笔 → ShieldAlert），选中行行尾 ✓，行下小字放该档真实
工具清单（清单是三档唯一的实际差异，必须保留）。

图标选型（先查 node_modules 实际导出，lucide-react 0.562.0）：

- 仅可查看：`ShieldCheck`（盾+对勾）。
- 完全权限：`ShieldAlert`（盾+感叹号）；触发 chip 同时染 warning 色，沿用
  ZCode「最高权限档触发器警示」的做法，让最宽的档一眼可辨。
- 工作区内修改：lucide 没有盾内藏笔的字形（ShieldPen 不存在），按仓库手绘
  先例（`IconLockOutline16`、`IconEyeOffOutline16`）在
  `src/ui/primitives/icons` 补了 16 格的 `IconShieldPenOutline16`：盾形描边
  按 lucide Shield 等比缩到 16 网格，内嵌一支斜置小铅笔。不拿不相干图标凑。
- legacy `none`：`ShieldOff`，只在恢复旧会话时出现在触发 chip 上。

档位→图标的映射走 `ToolPresetOption.iconKey`（shared 层存字符串 key，UI 层
一张 `TIER_ICONS` 表解析），调用点不再散落 id→图标判断。

语义与兼容完全不动：`TOOL_PRESET_VALUES` 四值原样，`PRESET_*`、
`presetFromToolNames`、`toolNamesForPreset`、`isToolPreset`、服务端全部照旧；
`toolPresetOption` 的兜底从下标 `?? TOOL_PRESET_OPTIONS[3]`（重排后会摸错档）
改为按 id 显式兜底，垃圾值落 default 档。

## 放弃了什么

- **菜单里的「纯对话」档**。它不是权限档，是「关掉一切」，放进三档递进里只会
  打破梯度的可读性。但类型、`presetFromToolNames([]) → 'none'`、旧会话记录的
  兼容全保留；`toolPresetOption('none')` 返回诚实的 legacy 展示档（仍显示
  「纯对话」/「不启用任何工具，只聊天」），恢复旧会话不撒谎。
- **Wrench 触发图标**。扳手说的是「工具」，新图标说的是「权限到哪一档」，盾徽
  与菜单行同一语言。legacy `none` 用 ShieldOff 表达「什么都没开」。
- 放弃了把完全权限档的 chip 保持中性色：改染 warning（见上，ZCode 先例）。

## Caveat：这是工具允许列表，不是审批层

pi 没有审批/沙箱层：模型调的工具直接执行。三档只是「这个会话存在哪些工具」的
允许列表开关，档名（包括「仅可查看」）是模式名，不是安全保证——完全权限不比
其他档多一层闸门，只是多了工具。文件头与组件注释都保留了这条警告。

## check 链预期冲突

package.json 的 `check` 链与另一在途会话（check-session-recency.ts 插链）有
**一行预期冲突**：解法=两个脚本都保留，合并时 check 链同时含
check-session-recency.ts 与 check-tool-presets.ts。本任务只在自己分支的链尾
追加 `tsx scripts/check-tool-presets.ts`（第 15 个脚本）。

## 钉子

`scripts/check-tool-presets.ts`：菜单恰三档且顺序/中文标签精确；'none' 不在
菜单但 `isToolPreset('none')` 真且 legacy 文案诚实；三档工具集逐项不变 +
四值往返一致；空表→'none'、powershell→bash、扩展工具不挡识别、杂集→default；
垃圾值兜底 default 档。断言消息中文写明各自防的回归。

## 证据

委托方调研（ZCode 权限菜单真实做法）：菜单行=盾图标+标题+描述，最高权限档
ShieldAlert 且触发器染 warning 色，常规档 ShieldCheck——本实现照借。
委托方豁免记录：主树在途改动（package.json check 链 hunk 重叠）已批准照常
在 worktree 改，唯停工条件（在途文件精确命中 tool-presets.ts /
ToolPresetSelect.tsx / check-tool-presets.ts）核查未命中。

## 复活条件

若「纯对话」要回到菜单：把 legacy 档加回 `TOOL_PRESET_OPTIONS`、钉子的
三档断言改四档即可，类型与工具集底座没动过，无需迁移。
