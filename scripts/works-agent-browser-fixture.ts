/** Isolated, restartable Works Agent acceptance server with a scripted model and real Pi SDK tools. */
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

const fixtureRoot = process.env.PI_WEBX_WORKS_FIXTURE_DIR || join(tmpdir(), `pi-webx-works-agent-fixture-${process.getuid?.() ?? 'local'}`);
const agentDir = join(fixtureRoot, 'agent');
const sessionDir = join(fixtureRoot, 'sessions');
const configRoot = join(fixtureRoot, 'config', 'agents');
const workspaceRoot = join(fixtureRoot, 'workspaces');
const dbPath = join(fixtureRoot, 'workbench.sqlite');
const port = Number(process.env.PI_WEBX_WORKS_FIXTURE_PORT ?? 18879);
const tomorrow = todayISO(new Date(Date.now() + 86_400_000));
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
  config.enabled = id === 'works';
  await writeFile(path, stringify(config), 'utf8');
}

const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
});
const model = runtime.getModels('deepseek')[0];
assert.ok(model, 'fixture SDK catalogue needs an offline model');
runtime.hasConfiguredAuth = () => true;
runtime.streamSimple = () => { throw new Error('network is forbidden in Works fixture'); };

const store = new WorkbenchStore(dbPath);
const seedTitles = ['工作助理验收：整理需求', '工作助理验收：核对待办'];
const taskIds = seedTitles.map(title => {
  const existing = store.listRecords('tasks').find(row => row.title === title);
  return existing?.id ?? store.addRecord('tasks', { title, priority: 'normal' }).id;
});
const profiles = await loadAgentProfiles(configRoot);
const works = profiles.get('works');
assert.ok(works?.ok && works.profile.config.enabled, `works Agent config unavailable: ${works && !works.ok ? works.error : 'missing'}`);

const host = new PiHost({
  definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(fixtureRoot, 'definitions.json'), agents: [] }) },
  modelRuntimeFactory: async () => runtime,
  settingsManagerFactory: memorySettings,
  sessionDir,
});
const originalCreate = host.create.bind(host);
host.create = async options => {
  const hosted = await originalCreate({ ...options, provider: model.provider, model: model.id });
  hosted.session.agent.getApiKey = () => 'works-fixture-no-provider';
  hosted.session.agent.streamFunction = (_model, context, options) => {
    const messages = context.messages;
    const users = messages.filter(message => message.role === 'user');
    const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
    const lastUser = lastUserIndex < 0 ? undefined : messages[lastUserIndex];
    const userText = JSON.stringify(lastUser ?? '');
    const sinceUser = messages.slice(lastUserIndex + 1);
    const contextResult = sinceUser.find(message => message.role === 'toolResult' && message.toolName === 'works_context');
    const scheduleResult = sinceUser.find(message => message.role === 'toolResult' && message.toolName === 'works_schedule');
    const available = availability(userText);
    let content: AssistantMessage['content'];
    let stopReason: AssistantMessage['stopReason'] = 'stop';
    if (users.length < 2) {
      content = [{ type: 'text', text: `我来帮你安排工作。请告诉我 ${tomorrow} 的两个可用时段，用“${tomorrow} 09:00-11:00、14:00-16:00 可用”这样的格式回复。` }];
    } else if (!available) {
      content = [{ type: 'text', text: '请给出同一天至少两个各不短于一小时的可用时段，例如 09:00-11:00、14:00-16:00。' }];
    } else if (!contextResult) {
      stopReason = 'toolUse';
      content = [{ type: 'toolCall', id: `works-context-${Date.now()}`, name: 'works_context', arguments: {} }];
    } else if (contextResult.isError) {
      content = [{ type: 'text', text: '读取工作上下文失败，请稍后重试。' }];
    } else if (!scheduleResult) {
      stopReason = 'toolUse';
      content = [{ type: 'toolCall', id: `works-schedule-${Date.now()}`, name: 'works_schedule', arguments: {
        entries: available.slots.slice(0, 2).map((slot, index) => ({
          entryKey: `fixture-work-${index + 1}`,
          title: index === 0 ? '整理需求' : '核对待办',
          note: '由工作助理固定模型流验收创建',
          scheduledDate: available.date,
          startTime: slot.start,
          endTime: plusHour(slot.start),
          taskIds: [taskIds[index]!],
        })),
      } }];
    } else {
      content = [{ type: 'text', text: scheduleResult.isError
        ? '排期保存失败，请检查时段冲突后重试。'
        : `已将两项工作安排在 ${available.date} ${available.slots[0]!.start}-${plusHour(available.slots[0]!.start)} 和 ${available.slots[1]!.start}-${plusHour(available.slots[1]!.start)}，可在工作助理列表核对。` }];
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
console.log(`Works Agent fixture: http://127.0.0.1:${(server.address() as { port: number }).port}`);
console.log(`Data: ${fixtureRoot}; expected availability: ${tomorrow} 09:00-11:00、14:00-16:00`);
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

function availability(text: string): { date: string; slots: Array<{ start: string; end: string }> } | null {
  const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? tomorrow;
  const slots = [...text.matchAll(/(\d{1,2}):([0-5]\d)\s*[-–—~至到]\s*(\d{1,2}):([0-5]\d)/g)].map(match => {
    const start = `${match[1]!.padStart(2, '0')}:${match[2]}`;
    const end = `${match[3]!.padStart(2, '0')}:${match[4]}`;
    return { start, end };
  });
  if (slots.length < 2 || !slots.every(slot => timeMinutes(slot.start) >= 0 && timeMinutes(slot.end) - timeMinutes(slot.start) >= 60)) return null;
  if (slots[0]!.start >= slots[1]!.end || slots[1]!.start < slots[0]!.end) return null;
  return { date, slots };
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour !== undefined && minute !== undefined && hour < 24 ? hour * 60 + minute : -1;
}

function plusHour(value: string): string {
  const total = timeMinutes(value) + 60;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
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
