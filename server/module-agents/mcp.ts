/**
 * 模块 Agent 的 MCP 连接适配：把配置里的 `mcp` 条目变成 pi 的 ToolDefinition。
 *
 * 凭据边界：stdio 子进程只拿到 `envRefs` 解析出的键值 + 最小 PATH/HOME（不透传
 * 整个 process.env）；streamable-http 的 headers 只由 `headerRefs` 解析。两处
 * 都只存「环境变量名」，真实值在连接瞬间经 `McpSecretResolver` 读取，不进配置、
 * 不进 profileRevision、不进日志。
 *
 * 工具面：只为 `cfg.tools` 里列出且服务端实际存在的工具建定义，名字规范化为
 * `mcp__${agentId}__${cfg.id}__${toolName}`；服务端有而配置没列的忽略，配置列了
 * 但服务端没有的记入 `missingTools`。`resources: false` 时不注册任何资源读取。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Type } from 'typebox';

import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { AgentId, McpConnectionConfig } from './contracts';

export interface McpSecretResolver {
  env(name: string): string | undefined;
}

const defaultSecrets: McpSecretResolver = {
  env: (name) => process.env[name],
};

export interface ConnectedMcp {
  id: string;
  /** stdio 子进程 pid（http 连接为 undefined）；用于生命周期验收。 */
  pid?: number;
  tools: ToolDefinition[];
  instructions?: string;
  /** 配置列了但服务端没有的工具名（原样记录，未规范化）。 */
  missingTools: string[];
  dispose(): Promise<void>;
}

export class McpConfigError extends Error {}

/** 子进程只拿这两件底衣：没它 fixture/多数可执行文件起不来。 */
function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
}

function resolveRefs(
  refs: Record<string, string> | undefined,
  secrets: McpSecretResolver,
  what: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, ref] of Object.entries(refs ?? {})) {
    const value = secrets.env(ref);
    if (value === undefined) {
      throw new McpConfigError(`${what} 引用的环境变量「${ref}」未设置`);
    }
    resolved[key] = value;
  }
  return resolved;
}

/** MCP 工具名 → pi 工具名片段：只留 `[A-Za-z0-9_]`，其余换 `_`。 */
function normalizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function textOfContent(result: { content?: unknown }, maxChars: number): string {
  const content = Array.isArray((result as { content?: unknown[] }).content)
    ? (result as { content: Array<{ type?: string; text?: string }> }).content
    : [];
  let text = content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（结果超出上限 ${maxChars} 字符，已截断）`;
  }
  return text;
}

/** 给 client.close 一个上限：服务端挂死时 dispose 也不能挂死宿主。 */
const DISPOSE_TIMEOUT_MS = 5_000;

export async function connectMcp(
  agentId: AgentId,
  cfg: McpConnectionConfig,
  opts: { secrets?: McpSecretResolver; signal?: AbortSignal; maxToolOutputChars?: number } = {},
): Promise<ConnectedMcp> {
  const secrets = opts.secrets ?? defaultSecrets;
  const maxChars = opts.maxToolOutputChars ?? 8_000;

  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (cfg.connection.transport === 'stdio') {
    const env = {
      ...minimalEnv(),
      ...resolveRefs(cfg.connection.envRefs, secrets, `MCP「${cfg.id}」envRefs`),
    };
    transport = new StdioClientTransport({
      command: cfg.connection.command,
      args: cfg.connection.args ?? [],
      ...(cfg.connection.cwd === undefined ? {} : { cwd: cfg.connection.cwd }),
      env,
      stderr: 'pipe',
    });
  } else {
    const headers = resolveRefs(cfg.connection.headerRefs, secrets, `MCP「${cfg.id}」headerRefs`);
    transport = new StreamableHTTPClientTransport(new URL(cfg.connection.url), {
      requestInit: { headers },
    });
  }

  const client = new Client({ name: `pi-webx-module-${agentId}`, version: '1.0.0' });
  const requestOpts = { timeout: cfg.timeoutMs, ...(opts.signal === undefined ? {} : { signal: opts.signal }) };
  try {
    await client.connect(transport, requestOpts);
    const listed = await client.listTools(undefined, requestOpts);
    const serverTools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const missingTools = cfg.tools.filter((name) => !serverTools.has(name));
    const prefix = `mcp__${agentId}__${cfg.id}__`;
    const seen = new Set<string>();
    const tools: ToolDefinition[] = [];
    for (const wanted of cfg.tools) {
      const serverTool = serverTools.get(wanted);
      if (serverTool === undefined) continue;
      const name = `${prefix}${normalizeToolName(wanted)}`;
      if (seen.has(name)) {
        throw new McpConfigError(`MCP「${cfg.id}」工具名规范化后冲突：${name}`);
      }
      seen.add(name);
      tools.push({
        name,
        label: `MCP ${cfg.id}/${wanted}`,
        description: serverTool.description ?? `MCP 工具 ${wanted}（来自 ${cfg.id}）`,
        parameters: Type.Unsafe(serverTool.inputSchema),
        async execute(_toolCallId, params, signal) {
          let text: string;
          try {
            const result = await client.callTool(
              { name: wanted, arguments: params as Record<string, unknown> },
              undefined,
              { timeout: cfg.timeoutMs, ...(signal === undefined ? {} : { signal }) },
            );
            text = textOfContent(result as { content?: unknown }, maxChars);
            if (result.isError === true) text = `MCP 工具报错：${text}`;
          } catch (error) {
            text = `MCP 调用失败：${error instanceof Error ? error.message : String(error)}`;
          }
          const result: AgentToolResult<unknown> = {
            content: [{ type: 'text', text }],
            details: { mcp: cfg.id, tool: wanted },
          };
          return result;
        },
      });
    }

    let disposed = false;
    return {
      id: cfg.id,
      pid: (transport as { _process?: { pid?: number } })._process?.pid,
      tools,
      instructions: client.getInstructions(),
      missingTools,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try {
          await Promise.race([
            client.close(),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('close timeout')), DISPOSE_TIMEOUT_MS).unref();
            }),
          ]);
        } catch {
          // 超时后兜底杀子进程；close 自身失败也只算尽力回收。
          const proc = (transport as { _process?: { kill(): void; killed?: boolean } })._process;
          if (proc !== undefined && proc.killed !== true) proc.kill();
        }
      },
    };
  } catch (error) {
    // 连接/列举失败也要尽力回收半连上的传输层与子进程。
    try { await transport.close(); } catch { /* best-effort */ }
    const proc = (transport as { _process?: { kill(): void; killed?: boolean } })._process;
    if (proc !== undefined && proc.killed !== true) proc.kill();
    throw error;
  }
}
