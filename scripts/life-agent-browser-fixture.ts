/** Isolated, restartable Life Agent acceptance server with a scripted model and real Pi SDK tools. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { parse, stringify } from 'yaml';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { PiHost } from '../server/pi/host';
import { createApiRouter } from '../server/routes';
import { attachWebSocketGateway } from '../server/ws';
import { WorkbenchStore } from '../server/workbench/store';
import { createWorkbenchRouter } from '../server/workbench/router';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { ProfileSnapshots } from '../server/module-agents/snapshots';
import { ModuleAgentSettingsService } from '../server/module-agents/settings/service';
import { createModuleAgentSettingsRouter } from '../server/module-agents/settings/router';
import { responseErrorMessage, statusFromError } from '../server/http-errors';
import type { StoredSession } from '../src/shared/protocol';
import { todayISO } from '../server/workbench/schema.mjs';
import { memorySettings } from './subagent-check-fixtures';

const fixtureRoot = process.env.PI_WEBX_LIFE_FIXTURE_DIR || join(tmpdir(), `pi-webx-life-agent-fixture-${process.getuid?.() ?? 'local'}`);
const agentDir = join(fixtureRoot, 'agent');
const sessionDir = join(fixtureRoot, 'sessions');
const configRoot = join(fixtureRoot, 'config', 'agents');
const workspaceRoot = join(fixtureRoot, 'workspaces');
const dbPath = join(fixtureRoot, 'workbench.sqlite');
const port = Number(process.env.PI_WEBX_LIFE_FIXTURE_PORT ?? 18880);
const tomorrow = todayISO(new Date(Date.now() + 86_400_000));
const nextFriday = (() => {
  const day = new Date();
  day.setDate(day.getDate() + ((5 - day.getDay() + 7) % 7 || 7));
  return todayISO(day);
})();
const sourceConfigRoot = defaultAgentsConfigRoot();

await mkdir(agentDir, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEBX_AGENT_CONFIG_DIR = configRoot;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = workspaceRoot;

await cp(sourceConfigRoot, configRoot, { recursive: true, force: true });
for (const file of (await readdir(configRoot)).filter(name => name.endsWith('.yaml'))) {
  const path = join(configRoot, file);
  const config = parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const id = String(config.id);
  const workspace = join(workspaceRoot, id);
  await mkdir(workspace, { recursive: true });
  config.workspace = workspace;
  config.enabled = id === 'life';
  await writeFile(path, stringify(config), 'utf8');
}

const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
});
const model = runtime.getModels('deepseek')[0];
assert.ok(model, 'fixture SDK catalogue needs an offline model');
runtime.hasConfiguredAuth = () => true;
runtime.streamSimple = () => { throw new Error('network is forbidden in Life fixture'); };

const store = new WorkbenchStore(dbPath);
const profiles = await loadAgentProfiles(configRoot);
const life = profiles.get('life');
assert.ok(life?.ok && life.profile.config.enabled, `life Agent config unavailable: ${life && !life.ok ? life.error : 'missing'}`);

const host = new PiHost({
  definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(fixtureRoot, 'definitions.json'), agents: [] }) },
  modelRuntimeFactory: async () => runtime,
  settingsManagerFactory: memorySettings,
  sessionDir,
});
const originalCreate = host.create.bind(host);
host.create = async options => {
  const hosted = await originalCreate({ ...options, provider: model.provider, model: model.id });
  hosted.session.agent.getApiKey = () => 'life-fixture-no-provider';
  hosted.session.agent.streamFunction = (_model, context, options) => {
    const messages = context.messages;
    const users = messages.filter(message => message.role === 'user');
    const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
    const userText = JSON.stringify(messages[lastUserIndex] ?? '');
    const sinceUser = messages.slice(lastUserIndex + 1);
    const contextResult = sinceUser.find(message => message.role === 'toolResult' && message.toolName === 'life_context');
    const captureResult = sinceUser.find(message => message.role === 'toolResult' && message.toolName === 'life_capture');
    const proposalResult = sinceUser.find(message => message.role === 'toolResult' && message.toolName === 'life_propose_plan');
    let content: AssistantMessage['content'];
    let stopReason: AssistantMessage['stopReason'] = 'stop';
    if (users.length < 2 && !['猫粮', '物业费', '洗牙'].every(word => userText.includes(word))) {
      content = [{ type: 'text', text: '这个验收场景请先说：买猫粮、周五前交物业费、找时间预约洗牙。' }];
    } else if (users.length >= 2 && !userText.includes('安排') && !userText.includes('规划')) {
      content = [{ type: 'text', text: '这个验收场景请接着说：安排一下明天。' }];
    } else if (!contextResult) {
      stopReason = 'toolUse';
      content = [{ type: 'toolCall', id: `life-context-${Date.now()}`, name: 'life_context', arguments: {} }];
    } else if (contextResult.isError) {
      content = [{ type: 'text', text: '读取生活事项失败，请稍后重试。' }];
    } else if (users.length < 2 && !captureResult) {
      stopReason = 'toolUse';
      content = [{ type: 'toolCall', id: `life-capture-${Date.now()}`, name: 'life_capture', arguments: {
        entries: [
          { entryKey: 'cat-food', originalText: '买猫粮', title: '买猫粮', tag: '购物' },
          { entryKey: 'property-fee', originalText: '周五前交物业费', title: '交物业费', due: nextFriday, tag: '缴费' },
          { entryKey: 'dental', originalText: '找时间预约洗牙', title: '预约洗牙', tag: '医疗' },
        ],
      } }];
    } else if (users.length < 2) {
      content = [{ type: 'text', text: captureResult?.isError
        ? '收集事项失败，请重试。'
        : `已记下买猫粮、${nextFriday} 前交物业费和预约洗牙。买猫粮与洗牙没有截止日。你可以告诉我哪天有空，我会拟一份安排供你确认。` }];
    } else if (!proposalResult) {
      const data = toolData(contextResult);
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const cat = tasks.find((item: any) => item.title === '买猫粮');
      const fee = tasks.find((item: any) => item.title === '交物业费');
      if (!cat || !fee) {
        content = [{ type: 'text', text: '待办中还没有找到买猫粮和交物业费，请先告诉我这两件事。' }];
      } else {
        stopReason = 'toolUse';
        content = [{ type: 'toolCall', id: `life-propose-${Date.now()}`, name: 'life_propose_plan', arguments: {
          planKey: 'fixture-next-day',
          note: '留出路程、休息与临时事项的余量；点击确认后才正式安排。',
          entries: [
            { taskId: fee.id, expectedUpdatedAt: fee.updatedAt, plannedDate: tomorrow,
              startTime: '09:00', endTime: '09:30', kind: 'flexible', reason: '有截止日，先完成缴费' },
            { taskId: cat.id, expectedUpdatedAt: cat.updatedAt, plannedDate: tomorrow,
              startTime: '10:00', endTime: '10:30', kind: 'flexible', reason: '预留出门与休息时间' },
          ],
        } }];
      }
    } else {
      content = [{ type: 'text', text: proposalResult.isError
        ? '安排草稿保存失败，请稍后重试。'
        : `我拟了一份 ${tomorrow} 的安排：09:00 交物业费，10:00 买猫粮，中间留半小时余量。请在今日规划中确认或调整；现在还没有正式排期。` }];
    }
    const message: AssistantMessage = {
      role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      stopReason, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      options?.signal?.removeEventListener('abort', abort);
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: stopReason as 'stop' | 'toolUse', message });
      stream.end(message);
    };
    const timer = setTimeout(finish, 35);
    const abort = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      message.stopReason = 'aborted';
      message.content = [];
      stream.push({ type: 'error', reason: 'aborted', error: message });
      stream.end(message);
    };
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
    return stream;
  };
  return hosted;
};

const app = express();
app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use('/api/module-agents', createModuleAgentSettingsRouter(new ModuleAgentSettingsService({
  root: configRoot, profiles, validateModel: async () => true,
})));
app.use('/api/module-agents', createModuleAgentsRouter({
  host, store, profiles, workspaceKey: 'default',
  snapshots: new ProfileSnapshots(join(fixtureRoot, 'profile-snapshots')),
  storedSessions: async options => storedSessions(sessionDir, options.limit ?? 200),
}));
app.use('/api', createApiRouter(host));
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  response.status(statusFromError(error)).json({ error: responseErrorMessage(error, false) });
});
const server = app.listen(port, '127.0.0.1');
await once(server, 'listening');
const detach = attachWebSocketGateway(server, host);
console.log(`Life Agent fixture: http://127.0.0.1:${(server.address() as { port: number }).port}`);
console.log(`Data: ${fixtureRoot}; try "买猫粮、周五前交物业费、找时间预约洗牙" then "安排一下明天"`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  detach();
  await host.disposeAll();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());

function toolData(message: unknown): Record<string, any> {
  const content = (message as { content?: Array<{ type: string; text?: string }> })?.content;
  const text = content?.find(item => item.type === 'text')?.text;
  try { return text ? JSON.parse(text) as Record<string, any> : {}; }
  catch { return {}; }
}

async function storedSessions(root: string, limit: number): Promise<StoredSession[]> {
  const result: StoredSession[] = [];
  const rootEntries = await readdir(root, { withFileTypes: true });
  const dirs = [root, ...rootEntries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name))];
  for (const dir of dirs) {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const full = join(dir, file.name);
      try {
        const info = await stat(full);
        const header = JSON.parse((await readFile(full, 'utf8')).split('\n')[0] ?? '{}') as { id?: string; cwd?: string; timestamp?: string };
        if (!header.id || !header.cwd || !header.timestamp) continue;
        result.push({ path: full, id: header.id, cwd: header.cwd, startedAt: header.timestamp,
          updatedAt: info.mtimeMs, sizeBytes: info.size, preview: null });
      } catch { /* a partial or removed fixture file cannot block resume */ }
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
