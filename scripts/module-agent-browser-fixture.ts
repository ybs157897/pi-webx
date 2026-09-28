/** Local browser acceptance server; scripted model, temporary database, no provider traffic. */
import express from 'express';
import { once } from 'node:events';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { PiHost } from '../server/pi/host';
import { createApiRouter } from '../server/routes';
import { attachWebSocketGateway } from '../server/ws';
import { WorkbenchStore } from '../server/workbench/store';
import { createWorkbenchRouter } from '../server/workbench/router';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { sandbox, memorySettings } from './subagent-check-fixtures';
const env = await sandbox(); process.env.PI_CODING_AGENT_DIR = env.agentDir;
env.runtime.hasConfiguredAuth = () => true;
const store = new WorkbenchStore(join(env.root, 'workbench.sqlite'));
store.addRecord('logs', { text: '浏览器验收日志', level: 'info', source: 'fixture', date: '2026-09-28' });
const host = new PiHost({ definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(env.root, 'defs.json'), agents: [] }) }, modelRuntimeFactory: async () => env.runtime, settingsManagerFactory: memorySettings, sessionDir: join(env.root, 'sessions') });
const original = host.create.bind(host);
host.create = async options => {
  const hosted = await original({ ...options, cwd: env.cwd, provider: env.model.provider, model: env.model.id });
  hosted.session.agent.getApiKey = () => 'fixture-no-network';
  let turn = 0;
  hosted.session.agent.streamFunction = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const lastUser = [...context.messages].reverse().find(message => message.role === 'user');
    const slow = JSON.stringify(lastUser).includes('等待');
    turn += 1;
    const tool = turn === 1 ? { type: 'toolCall' as const, id: 'skill-fixture', name: 'skills_read', arguments: { name: 'log-analysis' } }
      : turn === 2 ? { type: 'toolCall' as const, id: 'logs-fixture', name: 'logs_search', arguments: { limit: 1 } } : null;
    const message: AssistantMessage = {
      role: 'assistant', content: tool ? [tool] : [{ type: 'text', text: '已完成统一数据源查询（本地模型夹具）' }],
      api: env.model.api, provider: env.model.provider, model: env.model.id, stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    let ended = false;
    const done = () => { if (ended) return; ended = true; options?.signal?.removeEventListener('abort', abort); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(message); };
    const timer = setTimeout(done, !tool && slow ? 60_000 : 30);
    const abort = () => { if (ended) return; ended = true; clearTimeout(timer); message.stopReason = 'aborted'; message.content = []; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(message); };
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
    return stream;
  };
  return hosted;
};
const app = express(); app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use('/api/module-agents', createModuleAgentsRouter({ host, store, profiles: await loadAgentProfiles(defaultAgentsConfigRoot()), workspaceKey: 'default' }));
app.use('/api', createApiRouter(host));
const server = app.listen(Number(process.env.PI_WEBX_FIXTURE_PORT ?? 18878), '127.0.0.1'); await once(server, 'listening');
const detach = attachWebSocketGateway(server, host);
console.log(`Module Agent browser fixture: http://127.0.0.1:${(server.address() as any).port}; temporary data only`);
let closing = false;
const close = async () => { if (closing) return; closing = true; detach(); await host.disposeAll(); server.closeAllConnections(); server.close(); store.close(); await env.close(); process.exit(0); };
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
