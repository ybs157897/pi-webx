/** One coding-tool call in an OS sandbox. This process never loads a model runtime. */
import {
  createBashTool, createEditTool, createFindTool, createGrepTool,
  createLsTool, createPowerShellTool, createReadTool, createWriteTool,
} from '@earendil-works/pi-coding-agent';
import { createInterface } from 'node:readline';

const PREFIX = '@pi-webx-tool:';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function send(value: unknown): void {
  process.stdout.write(`${PREFIX}${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const request = await new Promise<{ name?: string; cwd?: string; toolCallId?: string; params?: unknown }>((resolve, reject) => {
    let received = false;
    input.on('line', (line) => {
      if (!received) {
        received = true;
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
          reject(new Error('isolated tool request is too large'));
          return;
        }
        try { resolve(JSON.parse(line)); }
        catch { reject(new Error('invalid isolated tool request')); }
      } else {
        try {
          if ((JSON.parse(line) as { type?: string }).type === 'cancel') controller.abort();
        } catch { /* Only the host's cancel frame is actionable. */ }
      }
    });
    input.once('close', () => { if (!received) reject(new Error('isolated tool request was not sent')); });
  });
  if (typeof request.cwd !== 'string' || typeof request.name !== 'string' || typeof request.toolCallId !== 'string') {
    throw new Error('invalid isolated tool request');
  }
  const tools = {
    read: createReadTool(request.cwd),
    bash: createBashTool(request.cwd),
    edit: createEditTool(request.cwd),
    write: createWriteTool(request.cwd),
    grep: createGrepTool(request.cwd),
    find: createFindTool(request.cwd),
    ls: createLsTool(request.cwd),
    powershell: createPowerShellTool(request.cwd),
  };
  const tool = tools[request.name as keyof typeof tools];
  if (!tool) throw new Error(`unsupported isolated tool: ${request.name}`);
  process.once('SIGTERM', () => controller.abort());
  const execute = tool.execute as (
    id: string, params: unknown, signal: AbortSignal,
    onUpdate: (update: unknown) => void,
  ) => Promise<unknown>;
  try {
    const result = await execute(request.toolCallId, request.params, controller.signal, (update) => {
      send({ type: 'update', value: update });
    });
    send({ type: 'result', value: result });
  } finally {
    input.close();
    process.stdin.destroy();
  }
}

main().catch((cause: unknown) => {
  send({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) });
  process.stdin.destroy();
  process.exitCode = 1;
});
