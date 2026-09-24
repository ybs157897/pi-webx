# 内置提示词（server/prompts）

产品自带的提示词源文件。**文件是唯一事实**：`builtin-agents.ts` 与 `host.ts` 的会话创建都通过
`loader.ts` 从这里读取，不再内联字符串常量；门禁（`scripts/check-subagent-tool.ts`）把子智能体
提示词钉在 ZCode 原文上逐字节比对。

## 来源

移植自 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Z.ai 的 coding agent harness）：

| 文件 | 来源 | 对齐基线 |
|---|---|---|
| `subagent/general-purpose.md` | `apps/zcode-cli/packages/core/src/subagent/general-purpose.ts` | pi-webx 钉在 ZCode `872ad960`（见 `scripts/check-subagent-tool.ts` 冻结原文） |
| `subagent/explore.md` | `…/subagent/explore.ts`（非 embedded-search 分支） | 同上，含三处声明过的偏差（见 `builtin-agents.ts` 头注） |
| `subagent/notes.md` | `…/subagent/system-prompt.ts` 的 `Notes:` 段 | 同上 |
| `main/identity.md` | 句式源自 `…/context/sections/identity.ts`（安全声明与 Harness 块逐字保留） | **产品自有**：本分支以工作台为主，人设改写为小台（中文优先） |
| `main/workbench.md` | 产品自有（工作台上下文：模块/数据层/知识库契约/仓库纪律） | 随产品演进手工维护 |

## 目录语义

```
server/prompts/
├── main/       主会话（小台 / 普通 pi 会话）的提示词段：以「追加」方式叠在 pi
│               默认系统提示词之后（host.ts 经 appendSystemPromptOverride 注入，
│               用户自己的 ~/.pi/agent/APPEND_SYSTEM.md 与 <项目>/.pi/APPEND_SYSTEM.md
│               原样保留、排在本目录内容之后）。
└── subagent/   子智能体（general-purpose / Explore）的完整系统提示词与共享尾注；
                整体替换（子智能体不吃默认提示词）。
```

与**用户级提示词**的关系见 `docs/system-prompt-design.md`：用户想自定义提示词时放
`~/.pi/agent/APPEND_SYSTEM.md`（全局）或 `<项目>/.pi/APPEND_SYSTEM.md`（项目），与本目录
（产品内置）互不覆盖、加载时叠加（内置在前、用户在后）。

## 同步规则

1. `subagent/*.md` 是**逐字节冻结**的：改动 = 偏离 ZCode 原文，必须先改
   `scripts/check-subagent-tool.ts` 里的声明（deviations），门禁才放行。
2. `main/identity.md` 跟随 ZCode HEAD 手工同步；含产品名「ZCode」属有意保留
   （与子智能体同一口吻），要改名只改这一个文件。
3. 新增提示词段：先在上游找到逐字来源并在 README 登记，再经 loader 暴露，
   禁止绕过 loader 内联字符串。
