# 模块 Agent 提示词与 Skill 调研（GitHub 收集）

> 调研日期：2026-09-29。检索工具：gh CLI（`gh search repos` / GitHub API 读目录树与文件），检索口径存档见文末第 7 节。
> 目标：为工作台各模块 Agent 收集 GitHub 上高质量、契合的提示词与 skill，标注契合点与接入裁剪方式。
> 覆盖五个方向：codes（代码开发 · 只收 Java/微服务）、logs、requirements、works、生活秘书（规划中——2026-09-27 退役的生活模块已彻底清除，恢复需重新实现，素材按未来接入准备）。

## 结论速览

| 方向 | 首选来源 | 契合度 | 建议动作 |
|---|---|---|---|
| codes · 框架/架构 | [Jeffallan/claude-skills](https://github.com/Jeffallan/claude-skills) 的 java-architect / spring-boot-engineer / microservices-architect | 高 | 裁剪 frontmatter 后挂载 |
| codes · 编码规范 | [Sxuan-Coder/alibaba-java-development-guide](https://github.com/Sxuan-Coder/alibaba-java-development-guide)（中文） | 高 | 可直接挂载 |
| codes · 角色/规则提示词 | [jabrena/cursor-rules-java](https://github.com/jabrena/cursor-rules-java) | 中高 | 摘取 agent 需连同被引用规则文件 |
| logs | [Jeffallan] `debugging-wizard`（方法论） | 中高 | 合并进自家 `log-analysis` |
| requirements | [Jeffallan] `feature-forge` | 高 | 方法论保留，产物映射到 `saveDraft` |
| works | 无对口现成货 | — | 维持自有提示词，不引入 |
| 生活秘书 | [PlexPt/awesome-chatgpt-prompts-zh](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) + 零散专项 skill | 中低 | 自建拼装（详见第 5 节） |

---

## 1. codes —— 代码开发（Java / 微服务）

### 1.1 可直接挂载的 skill

**[Jeffallan/claude-skills](https://github.com/Jeffallan/claude-skills)**（11.7k★，MIT）。SKILL.md + references 渐进披露结构，与本项目 `config/agents/skills/logs/log-analysis/` 同构。

| Skill | 内容 | references |
|---|---|---|
| `skills/java-architect` | Spring Boot 3.x + 微服务 + 响应式架构，Java 21 LTS；工作流带验证检查点与 MUST DO/MUST NOT | jpa-optimization / reactive-webflux / spring-boot-setup / spring-security(OAuth2+JWT) / testing-patterns |
| `skills/spring-boot-engineer` | 实现向：Spring Security 6、Spring Data JPA、WebFlux；**Spring Cloud（Config/Discovery/Gateway/熔断）单独在 `references/cloud.md`** | web / data / security / cloud / testing |
| `skills/microservices-architect` | 微服务架构方法论：DDD 限界上下文拆分、REST/gRPC/事件通信选型、saga/事件溯源/CQRS、熔断重试隔离、链路追踪 | decomposition / communication / patterns / data / observability |

同库可搭配的周边 skill：`api-designer`、`code-reviewer`、`database-optimizer`、`kubernetes-specialist`、`secure-code-guardian`、`legacy-modernizer`。

### 1.2 整编型 skill（中文）

- **[Sxuan-Coder/alibaba-java-development-guide](https://github.com/Sxuan-Coder/alibaba-java-development-guide)**（47★，2026-08 仍在更新）：《阿里巴巴 Java 开发手册（黄山版）》整编成 Coding Agent Skill——`SKILL.md` + `data/` 8 篇（编码规范、异常与日志、单测、安全、MySQL、工程结构、设计规范、附录），带 `evals/` 评测用例（SQL 注入、金额计算、并发等坏代码评审）。star 少但体系完整、即挂即用。
- [baigeixia/AI-project-level-restriction-prompts--java](https://github.com/baigeixia/AI-project-level-restriction-prompts--java)（2★）：阿里规范嵩山版的项目级 AI 限制提示词，star 少，备选参考。

### 1.3 角色提示词 / 规则库（需小改适配）

- **[jabrena/cursor-rules-java](https://github.com/jabrena/cursor-rules-java)**（441★，Apache-2.0，2026-09-28 仍在更新，已打包成 Claude 插件）：`.cursor/agents/` 下有 `plinth-java-spring-boot-coder`（Spring Boot 实现专家，覆盖 Security/Kafka/MongoDB/测试切片）、`plinth-java-performance`、`plinth-architect`、`plinth-tech-lead`，另有 Quarkus/Micronaut 版本。注意：提示词用 `@1xx/@3xx/@7xx` 编号引用仓库内规则文件，摘取单个 agent 必须连同被引用文件一起搬。
- **[github/awesome-copilot](https://github.com/github/awesome-copilot)**（39.5k★，GitHub 官方）：`agents/java-mcp-expert.agent.md`（Java MCP 服务端专家，Reactor + 官方 SDK + Spring Boot 集成）、`extensions/java-modernization-studio`。
- **[PatrickJS/awesome-cursorrules](https://github.com/PatrickJS/awesome-cursorrules)**（40.9k★）：`rules/java-general-purpose-*.mdc`、`java-springboot-jpa-*.mdc`、`kotlin-springboot-*.mdc`。
- **[holtwood/awesome-cursorrules-zh](https://github.com/holtwood/awesome-cursorrules-zh)**（236★，中文）：`rules/backend/java/springboot-jpa/` 把规范拆成 8 条细则（DTO、Entity、Repository、RestController、全局异常处理、ApiResponse 等约定），中文改起来最省事。
- **[alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills)**（26.8k★）：`engineering-team/skills/code-reviewer/languages/java.md`——精炼的 Java 代码审查检查单（原始类型、静默吞异常、try-with-resources、`InterruptedException` 处理等），可与 codes agent 的评审场景直接配套。

### 1.4 底层素材（适合抄做 references）

- [alibaba/p3c](https://github.com/alibaba/p3c)（30.9k★）：《阿里巴巴 Java 开发手册》官方仓库。
- [in28minutes/java-best-practices](https://github.com/in28minutes/java-best-practices)（1.5k★）：编码/设计/架构实践。

### 1.5 空白点

中文微服务生态（Spring Cloud Alibaba / Nacos / Dubbo / Sentinel）方向**没有找到成体系的现成 skill 或提示词仓库**。最近的替代：以 `microservices-architect` 做方法论骨架 + p3c/阿里手册 skill 做规范内容，自行整编一份。

## 2. logs —— 日志查询 Agent

现有自家 skill：`config/agents/skills/logs/log-analysis/SKILL.md`（收窄范围 → 有界查询 → 证据引用 → 知识沉淀）。

| 来源 | 内容 | 评估 |
|---|---|---|
| [Jeffallan] `skills/debugging-wizard` | 假设驱动排查方法论：复现→隔离→假设验证→定位；描述明确覆盖"关联日志条目定位故障点、根因分析" | **最值得借**。但它的终点是修 bug，logs agent 只读不写——裁掉修复部分，把假设驱动步骤合并进 `log-analysis` |
| [alirezarezvani] `engineering-team/skills/incident-response` | SEV1-4 分级、误报过滤、升级路径、取证清单（NIST SP 800-61） | 偏安全事件而非普通故障；与 `issues_search` 的问题管理部分对得上，可挑分级/升级两节 |
| [Jeffallan] `monitoring-expert` / `sre-engineer` | Prometheus/Grafana 管道、告警规则、SLO/错误预算 | 偏**建设向**，与"查询已有日志"不对口；只有可观测性概念章节适合摘做 references |

## 3. requirements —— 需求管理 Agent

现有职责：澄清背景/目标/边界/验收 → `requirements.saveDraft` 结构化草稿 → 界面导入为待办。

| 来源 | 内容 | 评估 |
|---|---|---|
| [Jeffallan] `skills/feature-forge` | 需求工作坊：PM/Dev 双视角提问、用户故事、**EARS 格式功能需求、验收标准、需求矩阵** | **首选**。与现有提示词同一套方法论且更结构化；接入时砍掉"产出文档/checklist 文件"部分，产物映射到 `saveDraft` 的 note + taskDrafts |
| [alirezarezvani] `product-team/skills/product-discovery` | 机会解决方案树（OST）、假设映射、问题验证访谈 | 适合更前置的探索型对话，作进阶参考 |
| [alirezarezvani] `product-team/code-to-prd`、`.gemini/skills/prd` | 从代码/对话反推 PRD | 参考价值中等：产出的是文档文件，而本 agent 只产出草稿；方法论可用、产物形式要改 |

## 4. works —— 工作排期 Agent

现有职责：读 `works_context`（服务器时间/时区/待办/排期）→ 排序取舍 → `works_schedule` 落排期（带 entryKey 与乐观锁）。

- 搜过 "daily planning / task scheduling / sprint planning" 等口径，**没有单人排期助理的现成高质量 skill**。
- 最接近的两个都不对口：[alirezarezvani] `project-management/skills/scrum-master`（面向敏捷团队，依赖 Jira JSON 导出 + Python 分析脚本）、`business-operations/skills/capacity-planner`（客服运营团队排班的 Erlang-C 数学，纯团队头寸规划）。
- 结论：**维持自有提示词**（时区计算、冲突与超载提示、乐观锁等已比外来货贴合工具契约）。若要补，从 `feature-forge` 借"依赖/工作量估算"的提问方式，而不是搬整个 skill。

## 5. 生活秘书 —— 规划中的方向

没有找到成体系的"生活秘书"高质量 skill 集合；材料分两类，建议自建拼装。

### 5.1 人设提示词库（中文现成，量大）

- **[PlexPt/awesome-chatgpt-prompts-zh](https://github.com/PlexPt/awesome-chatgpt-prompts-zh)**（62.8k★，2026-04 仍在更新）：数百条中文角色提示词，覆盖营养师、健身教练、医生、旅行指南、美食家、理财顾问等生活角色；`prompts-zh.json` 单文件约 62KB，可按角色挑选摘录。
- [f/prompts.chat](https://github.com/f/prompts.chat)（171.5k★）：同源英文版（f.k.a. Awesome ChatGPT Prompts），act-as 人设库。

用法：不是整库挂载，而是按生活秘书要覆盖的场景挑 5-10 个角色，把"人设 + 回答口径"改写成 agent 提示词段落或 SKILL.md。

### 5.2 格式对口的专项 skill（SKILL.md，可直接改挂）

| 仓库 | 内容 | 值得借的点 |
|---|---|---|
| [HEXACT-INC/second-brain-claude-skills](https://github.com/HEXACT-INC/second-brain-claude-skills)（2★，2026-06） | 第二大脑 5 件套：second-brain（本地 SQLite 知识库读写）、save-and-categorize、quick-lookup、weekly-review、meeting-prep | "先 `kb_schema` 探明结构再查询、写操作受控"的模式，与本项目数据源纪律一致；weekly-review 可做生活秘书的周回顾骨架 |
| [zyrobbie/travel-planner-skill](https://github.com/zyrobbie/travel-planner-skill)（1★，中文） | 海外旅行规划师 SOP：需求分析→路线骨架→风险审计→交付确认，"只给预订建议不执行交易" | 中文、分阶段收敛、角色分工（需求分析师/路线规划师/风险审计员/交付设计师）写法很规范，是"建议型生活 skill"的好范本 |
| [dungnotnull/travel-planner-agent-skill](https://github.com/dungnotnull/travel-planner-agent-skill) 及 `smart-travel-planner-agent-skill`（各 4★） | 行程/打包清单/预算/安全提示生成 | 同类备选 |
| [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)（75.8k★）"Productivity & Organization" 分区 | invoice-organizer（票据整理）、file-organizer、tapestry（文档互链知识网络）、[google-workspace-skills](https://github.com/sanjay3290/ai-skills)（Gmail/Calendar 套件） | 单项可用；Calendar 类只可参考思路——本项目生活秘书暂无日历工具，且提示词约束"不得声称已创建系统日历事件" |

### 5.3 空白点与建议

- habit/健康/记账方向只有 0★ 玩具仓库，无可收内容。
- 建议骨架：人设与边界取自自家 works/requirements 提示词的写法（时区、不假称已保存/已提醒），场景 skill（旅行、票据、周回顾）从上表专项改挂，角色语气从 prompts-zh 摘录。

## 6. 统一接入注意事项

1. **挂载方式**：SKILL.md（含 references 子目录）放 `config/agents/skills/<agent>/<name>/`，在对应 `config/agents/<agent>.yaml` 的 `skills:` 列表加路径——参照 logs.yaml 现行写法；codes.yaml 目前 `skills: []`。
2. **frontmatter 兼容**：本项目约定只有 `name` + `description`（见 log-analysis）。外来 skill 普遍带 `metadata`/`triggers`/`license` 等字段，接入前对照 `server/module-agents/` 的 SKILL 解析器确认是否容忍未知字段，否则裁成两字段。
3. **工具白名单裁剪**：外来 skill 普遍假设能写文件、跑脚本、调外部 SaaS。各 agent 工具很窄（requirements 仅 `saveDraft`、works 仅 `context/schedule`、logs 只读），只保留方法论章节，产物一律映射到各自工具契约。
4. **脚本类 skill 不可用**：alirezarezvani 的 scrum-master / capacity-planner 等依赖 Python 脚本，本项目 skill 机制是纯 SKILL.md（`skills.read` 只读），脚本部分直接丢弃。
5. **并行会话**：工作树常有多个会话并行改动，动手前 `git status` 并重读目标文件，别覆盖他人未提交改动。

## 7. 检索口径存档（可复跑）

```bash
# 找 skill 集合库
gh search repos "claude skills" --sort stars --limit 12
gh search repos "awesome cursorrules" / "awesome copilot" --sort stars

# 钻进库里按主题筛文件（含 SKILL.md 全量枚举）
gh api "repos/<owner>/<repo>/git/trees/<default_branch>?recursive=1" --jq '.tree[] | select(.type=="blob") | .path' | grep -iE '<关键词>'

# 抽查质量：直接读文件
gh api "repos/<owner>/<repo>/contents/<path>" --jq .content | base64 -d

# code search（对 SKILL.md 的内容检索命中率低，优先枚举树 + grep）
gh search code 'filename:SKILL.md' --limit 5
```

已确认无货的搜索（避免复跑）：`java microservices prompt`、`spring cloud alibaba prompt`、`incident response claude skill`、`prd skill claude`、`daily planning claude skill`、`habit tracker claude`、`meal planner claude skill`、`微服务 规范 ai`。
