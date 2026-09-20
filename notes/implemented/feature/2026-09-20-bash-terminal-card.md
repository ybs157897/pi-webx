# bash 工具卡改用 dsh 的终端卡

Status: implemented

## 决策与理由

`bash` / `powershell` 的展开体改成 deepseek-harness 的 `TerminalBlock`：一张卡里
「状态点 · 工作目录 · 命令」的提示行，输出在它下面，退出码是行上的 pill，输出按 ANSI
上色并按列对齐（`src/ui/primitives/TerminalBlock.tsx`、模型在 `src/lib/terminal-card.ts`）。
原来的通用 IN/OUT 形状（`输出` caption + 带边框的 Highlighter）留给 read/write/edit，
它们在 `scripts/check-tool-card.ts` 里的断言原样保留。

行摘要仍然是命令本身，而不是 dsh 那种一句描述——这是被数据逼出来的，不是排版偏好，
见下一条。

两处移植约束值得记下来，它们都不是「照抄」能解决的：pi 的 bash 失败是靠**抛异常**
报告的（结果是 `isError` 的文本 `<输出>\n\nCommand exited with code N`），没有 dsh 的
`[exit code: N]` 结果标记，所以退出码从错误文本里解析；而 pi 自己那条直连 shell
（`bashExecution` 记录，由快照回放）反而是把 `exitCode` 当**字段**给的，转写把它放在
run 的 `details` 上优先采用。另外代码字体必须走 `font-family` 而非参考实现的 `font:`
简写：参考的 `--dsw-font-markdown-code-block` 是完整 font 简写，本仓库的
`--ds-font-family-code` 只是字体栈，`font: <字体栈>` 是非法声明会被整条丢弃——实测表现
是终端文字悄悄退回正文字体（只有真实浏览器量 computed style 才看得见），
`check-tool-card.ts` 现在把这条钉住。

## 放弃了什么

- **给 bash 合成一句描述。** dsh 的 bash schema 把 `description` 列为必填，所以它的行
  读作 `Bash · Compare dist artifacts vs source timestamps`；pi 的 bash 只有 `command`
  和 `timeout`（核对过 `pi-coding-agent/dist/core/tools/bash.js` 的真实会话记录），没有
  任何可用的描述字段。前端拿命令「翻译」一句人话属于自造数据：它并不知道命令的意图，
  写出来的描述会**像**却不准。参考实现遇到没有 description 的调用也退回命令，所以这里
  跟着退。代价是短命令会在行摘要和卡内提示行各出现一次。
- **`signal` 分支。** 参考实现有「被信号终止」的 pill；pi 的 bash 把非零退出、超时、
  中止都作为抛出的文本报告，从不给信号名。留一个没有数据来源的分支只是死代码。
- **`labels` 注入层。** 参考实现是 cordis-free 的包，所有文案由调用方注入；本应用没有
  locale 层（文案是内联中文），照搬只会多出一个被自己独占的参数。
- **通用回退体。** 参考实现在「终端卡不成立」时退回 IN/OUT 体；pi 的 shell 调用必然带
  命令，那条回退永远不会触发，只会在卡里把命令再打印一遍。

## 复活条件

- **如果 pi 的 bash 开始带 `description`**（上游 schema 变更）：行摘要改为
  `terminal.description ?? 命令`，即 `src/lib/terminal-card.ts` 的 `TerminalCard` 增加
  一个字段、`ToolCard` 的行摘要优先取它；`check-tool-card.ts` 里「行摘要 = 命令」的断言
  要改成「有描述时用描述」。
- **如果 pi 开始在 bash 结果里给结构化退出码**（不再靠抛异常）：`splitFailure` 的文本
  解析可以整个删掉，`terminalCard` 只读 `details`。
