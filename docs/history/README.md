# 迁移期归档

这两份文档记录的是 **2026-09-23 迁移前后**的状态，事件已完结，仅作历史存档：

- `ALIGN-DSH-REFERENCE.md` — `feat/align-dsh-reference` 分支对齐 deepseek-harness 参考实现的
  21 刀改动 review 材料。那些改动已随迁移进入本仓库主干历史。
- `FIXES-TO-PORT.md` — 待移植到 main 的问题清单（基线 `feat/ruankao-agent`）。清单所指向的
  移植已完成；其中的文件路径（如 `src/lib/transcript.ts`）在 2026-09-24 拆分轮次后已失效，
  现行路径见 `docs/code-map.md`。

读这两份文档时以 `git log --all` 的实际提交为准，不要按文中路径直接找代码。
