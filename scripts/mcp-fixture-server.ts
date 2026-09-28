/**
 * MCP fixture server（stdio）：check-module-agent-mcp.ts 的受控对端。
 *
 * 环境变量契约：
 * - `FIXTURE_SENTINEL`：search_logs 的回显哨兵（每个连接各一个，验证不串线）。
 * - `FIXTURE_REQUIRE_TOKEN`：若设置，要求进程环境里的 `FIXTURE_TOKEN` 等值，
 *   否则退出码 3（验证 envRefs 注入与父进程环境不透传）。
 */
import { setTimeout as delay } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const required = process.env.FIXTURE_REQUIRE_TOKEN;
if (required !== undefined && process.env.FIXTURE_TOKEN !== required) {
  process.exit(3);
}

const server = new McpServer({ name: 'pi-webx-mcp-fixture', version: '0.0.1' });

server.registerTool('search_logs', {
  description: 'fixture log search',
  inputSchema: { q: z.string() },
}, ({ q }) => ({
  ...(q === 'fixture-error' ? { isError: true } : {}),
  content: [{ type: 'text', text: `sentinel:${process.env.FIXTURE_SENTINEL ?? 'unset'}:${q}` }],
}));

server.registerTool('get_log', {
  description: 'fixture log read',
  inputSchema: { id: z.string() },
}, ({ id }) => ({
  content: [{ type: 'text', text: `log:${id}` }],
}));

server.registerTool('slow', {
  description: 'sleeps ms then answers; exercises timeout/cancel paths',
  inputSchema: { ms: z.number() },
}, async ({ ms }) => {
  await delay(ms);
  return { content: [{ type: 'text', text: `slow:${ms}` }] };
});

server.registerTool('env_probe', {
  description: 'reports whether the named env var exists in this process',
  inputSchema: { name: z.string() },
}, ({ name }) => ({
  content: [{ type: 'text', text: `env:${name}=${process.env[name] === undefined ? 'absent' : 'present'}` }],
}));

// 服务端有但配置不列的工具：验证「只注册配置列出的」。
server.registerTool('extra_tool', {
  description: 'never listed in config',
}, () => ({ content: [{ type: 'text', text: 'extra' }] }));

await server.connect(new StdioServerTransport());
