# 侧栏会话行：排序按"最后说话"，状态点只在有话说时出现

Status: implemented

## 症状（对照截图里的侧栏）

1. 点开一条旧会话，那一行立刻跳到列表顶部、时间变成「刚刚」，把真正最近的会话挤进
   「展开其余 N 条」；截图上 5 行「刚刚」里 4 行其实是 9 月 19–20 日的老对话。
2. 每一行都顶着一个永远不消失的绿点：历史会话、空闲会话、正在跑的会话长得一样。

## 参考实现怎么做的

两条都在 `deepseek-harness` 的 `ui-workspace` 里：

```ts
// api-session-controller/src/list.ts —— 列表排序键
function updatedAt(header, metadata) { return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0) }

// ui-workspace/src/client/rows/Rows.tsx —— 前导 slot 画不画点
const showStatus = primaryStatus.state !== 'done' || row.completed
```

`row.completed` 是 `ui-session` 的 `completionUnread`：一轮 `running` 从 true 变 false 时
**这个会话不是当前视图**，就留下绿点；打开它（或它重新跑起来）就清掉。`done` 的另一半
——空闲、历史、进程已结束——前导 slot 是空的；扁平列表连 slot 都不画
（`.flatSessionRowWithoutStatus`）。

## 改了什么

| 层 | 之前 | 现在 |
| --- | --- | --- |
| 排序键（活行） | 桥接进程对象的 `createdAt`（点一下就是"现在"） | 它宿主的那份转写的 `lastPromptAt` |
| 排序键（历史行） | 文件头的 `startedAt`（会话开始的时间） | 转写里最后一条 `role:"user"` 的时间 |
| 转写元数据 | 头 + 预览 + mtime 缓存 | 再加 `lastPromptAt`（只读尾部 64KB，按 size/mtime 缓存） |
| 列表载荷 | `startedAt` | 加 `updatedAt`（服务端也用这个键排序、`limit` 取的都是真正最近的） |
| 前导点 | `slot` 永远画 `sessionStatuses[0]` | 只有 `warning`/`ongoing`/`completed` 画；其余留空 slot |
| 扁平列表 | 空 slot 也占 16px | 不画 slot，标题回到左边（dsh 的 `.flatSessionRowWithoutStatus`） |
| 搜索结果 | 先活行后历史行 | 与树共用一个 recency，新的在前 |

绿点新状态由 `src/components/sidebar/completion.ts` 的 `observeCompletions` 维护：纯粹的
一趟观察（首次看到只做基准，不产生绿点），hook 只负责把 `running` 快照留住。列表是 5 秒
轮询，所以"开始和结束都发生在两次轮询之间"的一轮看不到——这不画点是**漏报**，比恒亮一个
清不掉的绿点诚实。

## 放弃了什么

- **点开旧会话会把它顶到列表最前。** 那正是 pi-webx 的行为，也是这次要修的 bug：它来自
  "桥接什么时候把这个会话捡起来"这个事实，而不是"这场对话什么时候说过话"。参考实现对
  点击**不重排**（`lastPromptAt` 只有真正发消息才动），照抄。
- **"空闲/历史/已结束"也在行上占一个点。** 恒亮的标记无法表达"你离开时它跑完了"；这三态
  现在只在悬停卡里说（悬停卡仍然每次都写清楚标签 + 点）。
- **扁平列表保留空 slot。** 扁平列表没有层级缩进，空 slot 只是把标题白白右移 16px。
- **改 `orderBy` 默认值与拖拽的开关。** dsh 默认 `最近更新`，并且在 `最近更新` 下也能拖、
  一拖就切成手动并播种当前顺序；pi-webx 是 `手动排序` 才有拖拽（`拖动排序` 只在 manual
  出现，见 `WorkspaceBrowser` 的 `drag={orderBy !== 'manual' ? undefined : …}`）。把默认
  改成 `updated` 会顺手拿走新用户"一上来就能拖"的能力，所以这一条留着不动。

## 证据

- `scripts/check-session-status.ts`：`sessionShowsDot` 的六种分支 + 绿点生命周期
  （首见不点、离开时跑完点、点开清、再跑清、会话消失清）。
- `scripts/check-session-recency.ts`：尾部解析（记账条目/assistant/toolResult/半行都不算
  提问）、`storedNode` 用 `updatedAt`、**点开旧会话后不跳顶**、扁平与搜索共用同一时钟。
- 真浏览器（ego lite，`http://127.0.0.1:5173`，本机 ~/.pi 真实转写）实测：
  - 侧栏每行 `[data-state]` 全为 `null`（旧代码下每行都是 `done`）；
  - 点「01a0bac7-f18」（该组里最旧的一行）后它仍是**活行、仍在最后一位**、时间仍是「1天」，
    没有跳到顶部变「刚刚」；
  - 视图选项切「一个列表」：行内没有 slot 元素，标题左边界 = 行左边界 + 8px padding。
  - 截图：`2026-09-21-sidebar-status-dot-after.png`（分组）、
    `2026-09-21-sidebar-flat-recency.png`（扁平，可见真实 recency 交错与悬停卡里的「历史会话」）。

`npm run typecheck` / `npm run check`（全部 15 个脚本，含新增的两个）/ `npm run build` 全绿。
