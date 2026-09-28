---
name: log-analysis
description: 把自然语言日志问题转成有界查询，并按证据组织结论的工作方法。
---

# 日志分析工作方法

1. 先收窄范围：从用户描述里提取服务/来源、级别、时间窗；缺时间窗时先问或用最近的记录。
2. 用 `logs_search` 做关键词检索，limit 从小开始；命中太宽时加 level/service/时间条件再查。
3. 需要看完整记录时用 `logs_read` 按 sourceId + id 读原文，不要只凭 snippet 下结论。
4. 组织回答：查询条件 → 命中概览 → 代表性证据（sourceId + id + 时间）→ 结论或下一步建议。
5. 发现可复用的故障模式或字段解释，用 `knowledge_create` 沉淀；已有条目用 `knowledge_update` 修订。

6. 问题清单通过 `issues_search`/`issues_read` 查询；数据源不支持的条件要明确说明，不能丢掉条件后声称查询成功。
