# 可替换的日志与问题数据源

状态：首版已实现并完成本地验证。2026-09-28 用户要求建设框架，由使用方接入和替换非标准日志、问题清单接口。

## 边界

Agent 工具 → 统一领域契约 → 数据源适配器 → 工作台 SQLite / 外部接口。

工具不解析供应商字段。日志和问题分别使用独立记录类型，统一查询、分页、来源、错误与取消语义。第一版提供只读 search/read；不把问题状态写回外部系统，不自动同步或复制外部数据。现有工作台 CRUD 页面仍管理本地记录。

数据源配置与 Agent 配置一起放在 `config/agents/*.yaml` 的 `dataSources` 中。普通 HTTP JSON 接口通过请求参数、响应路径、字段与枚举映射接入；复杂签名、多步查询或非 HTTP 协议实现代码适配器，通过显式注册注入。YAML 不执行脚本或任意 import。

旧会话固定配置、Skill 文本与数据源配置快照；替换配置并重启服务后新会话使用新源，旧会话继续原快照。凭据只存环境变量引用。缺失快照拒绝继续执行并提示新建，不静默切换数据源。

## 验收

- 两个字段、请求方式和分页格式不同的 HTTP fixture 经适配后返回同一种记录；上层工具和提示词不改。
- 同一外部 id 在不同 sourceId 下不混淆；时间统一为 ISO 8601，缺失时间为 null；未知枚举归入 unknown 并保留原始值属性。
- 不支持的查询明确拒绝；字段缺失、鉴权失败、超时、取消、异常响应有稳定错误码，不泄露响应正文或凭据。
- 日志、问题均有实际工具调用路径；本地 SQLite 适配器保留可用默认源。
- 全局 SYSTEM.md 不混入模块提示词；Skill 可由模型发现并经受限工具读取；旧快照可恢复。
- 运行中恢复不被容量检查拦截；创建/恢复并发合并；停止只作用于当前会话；草稿按标签页和 Agent 保存。
- 模块门禁、工作台服务/UI 门禁与类型检查通过，浏览器验证停止和草稿恢复。

## 统一记录与查询（v1）

| 类型 | 字段 |
| --- | --- |
| 共同身份 | `kind`、`sourceId`、`id`。id 仅在一个 sourceId 内唯一；read 必须携带两者 |
| 日志 | `occurredAt: ISO8601|null`、`level: trace/debug/info/warn/error/fatal/unknown`、`message`；可选 `service`、`traceId`、`attributes` |
| 问题 | `title`、`status: open/in_progress/resolved/closed/unknown`、`createdAt/updatedAt: ISO8601|null`；可选 `description`、`priority`、`url`、`attributes` |
| 查询 | `q`、`from/to`、`limit: 1..100`（默认 20）、`cursor`；日志支持 `level/service`，问题支持 `status/priority`，具体支持范围由适配器声明 |
| 分页 | `items`、可选 `total/nextCursor`、`source: {id,kind,adapter}`、`query`。无 total 就保持未知，不填假数 |
| 错误 | `invalid_config/invalid_query/unsupported_query/invalid_response/unauthorized/not_found/timeout/cancelled/unavailable` |

Agent 调用 `logs_search/logs_read/issues_search/issues_read`，成功返回 `{ok:true,data}`，失败返回 `{ok:false,error:{code,message}}`。文本结果有长度上限。记录 read 的不存在结果为 null，HTTP 404 同义。

接口和插件类型的唯一代码契约在 `server/data-sources/contracts.ts`。本地问题源读取 `fixes`，将 `todo/doing/done` 转成 `open/in_progress/resolved`。本地日志的 `source` 映射为 `service`；日志日期是工作台日期，原始 time 保存在 attributes 中，不伪造精确事件时刻。

## 用 YAML 接入 HTTP JSON

在 `config/agents/logs.yaml` 中替换 `dataSources.logs`，其余 Agent 提示词和工具名称保持不变：

```yaml
dataSources:
  logs:
    id: company-logs-v2
    adapter: http-json
    options:
      baseUrl: https://logs.example.invalid
      headerRefs:
        Authorization: COMPANY_LOGS_AUTHORIZATION
      timeoutMs: 15000
      maxResponseBytes: 2000000
      search:
        method: POST
        path: /v2/query
        body:
          filter:
            keyword: '{q}'
            start: '{from}'
            end: '{to}'
          pageSize: '{limit}'
          pageToken: '{cursor}'
        itemsPath: data.records
        totalPath: data.total
        nextCursorPath: data.nextToken
      read:
        method: GET
        path: /v2/records/{id}
        resultPath: data
      fields:
        id: event_id
        message: payload.text
        occurredAt:
          path: epoch
          unit: seconds
        level:
          path: severity
          values:
            ERROR: error
            WARNING: warn
            INFO: info
        service: app_name
        traceId: trace_id
  issues:
    id: local-issues
    adapter: workbench
    options: {}
```

- 环境变量存完整请求头值，例如 `Bearer ...`，框架不把 token 写入 YAML、快照或浏览器能力卡。
- GET 查询使用 `query: { keyword: '{q}', size: '{limit}' }`；POST 使用嵌套 `body`。缺失参数从对象中省略，完整占位符保留数字类型。常量请求参数可以直接写值。
- `path` 相对 origin，必须以 `/` 开头；`{id}` 等路径参数逐项编码。拒绝跨 origin 路径、自动重定向，避免凭据被转发到另一服务。
- 字段路径为点分 own-property 路径，`$` 表示响应根。仅支持路径、枚举映射、秒/毫秒时间转换；无 JavaScript、表达式求值或 JSONPath。
- 未映射的查询条件返回 unsupported_query。必需的 `limit` 必须映射给远端；返回超过请求上限视为接口契约错误，不能悄悄丢掉后续页。
- 未知枚举转 unknown，原枚举保存在 attributes 中。必需的 id/message/title 缺失会使当前调用失败，不静默跳过坏数据。
- HTTP 错误不输出上游响应正文、认证头或完整请求 URL；不自动重试请求，包括 POST 查询。时间单位、分页参数变换超出映射能力时使用代码适配器。
- 这份配置是示例，不代表接通了生产接口。修改配置后重启服务，新建对话验证；旧对话继续使用原源。切换供应商时使用新的 sourceId。

问题清单使用 `dataSources.issues`，字段映射换成 id/title/status/createdAt/updatedAt 等。`tools` 白名单中启用 `issues.search`、`issues.read`；禁用时不创建相应适配器。

## 编写代码适配器

复杂签名认证、SQL、SDK、非 JSON、多步请求或特殊分页应写独立 TypeScript 适配器，实现 `SourceAdapter`。`create({kind,config})` 返回 `search(query,signal)`、`read(id,signal)` 和可选 `dispose()`。配置、连接、缓存和取消控制器由每个创建实例独占；不要保存模块级“当前源”。

在应用组合根 `server/index.ts` 显式注入：

```ts
import { createDataSourceRegistry } from './data-sources/registry';
import { companyAdapter } from './integrations/company-adapter';

createModuleAgentsRouter({
  host: manager, store: workbench, profiles: agentProfiles,
  workspaceKey: 'default',
  dataSourceRegistry: createDataSourceRegistry(workbench, [companyAdapter]),
});
```

随后在 YAML 填 `adapter: company`（与插件 id 一致）。不得改 Agent 工具实现。重复注册、未知 adapter 都报错；不回退到本地或其他用户的数据源。

代码适配器应遵守同一契约，落实 signal 取消、有界结果、查询条件校验及 SourceError；factory 只组装对象，连接在具体请求中创建，dispose 幂等。代码适配器是服务端受信代码，不是沙箱脚本。示例外部模块路径需使用方自行实现，不会由框架自动下载。

## 配置快照与限制

profileRevision 覆盖 YAML 规范化配置（含数据源）、提示词及所选 Skill 目录中的文本资源。快照位于工作台 SQLite 同目录的 `module-agent-profiles/`，原子发布；凭据值始终在请求时按环境引用获取。Skill 不直接读取运行时磁盘，全局 SYSTEM.md/Skills/扩展不自动混入。

旧会话没有快照或快照损坏时返回 409，保留恢复指针并提示显式新建，不自动冒用最新配置。该版本没有配置热重载、适配器市场、外部写操作、旧版插件代码归档或原生沙箱。更新插件代码仍需要相应迁移与回归。

## 验证与本地演示

`npm run check:module-agents` 包括两种异构 HTTP 日志源、问题源、本地源、自定义代码插件、错误/超时/取消，以及真实 PiHost 的 HTTP 幂等、并发恢复和快照恢复测试。模型回合为本地脚本流，不消耗供应商调用。

浏览器验证使用隔离 fixture（临时数据，不接触真实工作台数据库）：

```sh
npx tsx scripts/module-agent-browser-fixture.ts
PI_WEBX_PORT=18878 npm run dev:web -- --port 15173 --strictPort
```

打开 `http://127.0.0.1:15173`，进入日志模块。带“等待”的消息保持运行，便于验证关闭/重新打开、刷新与停止；其他消息快速完成。退出 fixture 会清理临时数据。


2026-09-28 实际验收：全量 `npm run check`、`npm run typecheck`、`npm run build` 通过；浏览器验证草稿关闭重开、运行中关闭/重开及刷新后同 session 恢复、停止、多标签页恢复指针隔离；390px 页面无横向溢出，输入框点击命中正确（修复 ThemeProvider 隔离层使底部导航覆盖输入框的问题）。外部接口为本地 HTTP fixture，模型为脚本流；真实生产 API 与供应商模型调用未运行。
