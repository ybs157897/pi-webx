/** Isolated browser acceptance uses real SQLite/Pi tools and an offline scripted model. */
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { createWorkbenchRouter } from '../server/workbench/router';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { createModuleAgentSessionService } from '../server/module-agents/session-service';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { profileRevision } from '../server/module-agents/snapshots';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createChatroomRouter } from '../server/modules/chatroom/router';
import { createModuleAgentChatroomRuntime } from '../server/modules/chatroom/runtime';
import { createApiRouter } from '../server/routes';
import { attachWebSocketGateway } from '../server/ws';
import { sandbox, memorySettings } from './subagent-check-fixtures';

const env = await sandbox();
const root = await realpath(process.env.PI_WEBX_CHATROOM_FIXTURE_DIR
  ?? await mkdtemp(join(tmpdir(), 'pi-webx-chatroom-browser-')));
process.env.PI_CODING_AGENT_DIR = env.agentDir;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(root, 'workspaces');
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
for (const [agentId, loaded] of profiles) {
  if (!loaded.ok) continue;
  const profile = structuredClone(loaded.profile);
  const workspace = join(root, 'workspaces', agentId);
  await mkdir(workspace, { recursive: true });
  profile.config.workspace = workspace; profile.effectiveWorkspace = workspace;
  profile.profileRevision = profileRevision(profile);
  profiles.set(agentId, { ok: true, profile });
}
env.runtime.hasConfiguredAuth = () => true;
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
const host = new PiHost({ modelRuntimeFactory: async () => env.runtime, settingsManagerFactory: memorySettings,
  sessionDir: join(root, 'sessions'), teamJournalDir: join(root, 'teams'), definitions: {
    read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'defs.json'), agents: [] }),
  } });
const chatroom = getChatroomService(store);
const originalCreate = host.create.bind(host);
host.create = async options => {
  const hosted = await originalCreate({ ...options, provider: env.model.provider, model: env.model.id });
  hosted.session.agent.getApiKey = () => 'offline-browser-fixture';
  hosted.session.agent.streamFunction = (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const latestUser = context.messages.findLastIndex(message => message.role === 'user');
    const text = JSON.stringify(context.messages[latestUser]);
    const recent = context.messages.slice(latestUser + 1);
    const delivery = chatroom.getDelivery(hosted.id);
    const taskId = delivery?.context.collaborationTaskId;
    const isContinuation = text.includes('继续验证');
    const workResults = recent.filter(message => message.role === 'toolResult' && message.toolName === 'chatroom_work');
    const hasWrite = recent.some(message => message.role === 'toolResult' && message.toolName === 'write');
    const hasRead = recent.some(message => message.role === 'toolResult' && message.toolName === 'read');
    const call = (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'toolCall' as const, id: `${name}-${recent.length}`, name, arguments: args }], stopReason: 'toolUse' as const,
    });
    let response: Pick<AssistantMessage, 'content' | 'stopReason'>;
    if (hosted.session.getActiveToolNames().length === 0) {
      response = { content: [{ type: 'text', text: JSON.stringify({ claim: options.moduleAgent?.scope.agentId === 'codes' }) }], stopReason: 'stop' };
    } else if (!taskId && !workResults.length) {
      response = call('chatroom_work', { action: 'accept', title: text.includes('长任务') ? '可取消的长任务' : '验证群聊持续工作', entryKey: `accept:${delivery?.id}` });
    } else if (isContinuation && !hasRead) {
      response = call('read', { path: 'chatroom-evidence.txt' });
    } else if (!isContinuation && !hasWrite) {
      response = call('write', { path: 'chatroom-evidence.txt', content: '真实 SDK 工具写入；后续从原 Session 继续验证。\n' });
    } else if (!text.includes('长任务') && workResults.length < (isContinuation ? 1 : 2)) {
      response = call('chatroom_work', { action: 'update', taskId: chatroom.getDelivery(hosted.id)?.context.collaborationTaskId,
        status: isContinuation ? 'completed' : 'waiting_for_user',
        summary: isContinuation ? '已读取文件核对写入结果，原会话工具记录仍可用。' : '文件已写入，等待用户补充验证要求。',
        entryKey: `state:${delivery?.id}` });
    } else {
      response = { content: [{ type: 'text', text: isContinuation ? '已从原任务继续，读取文件验证完成。' : '已写入文件，等待补充。请点击继续并发送“继续验证”。' }], stopReason: 'stop' };
    }
    const message: AssistantMessage = { role: 'assistant', ...response, api: env.model.api,
      provider: env.model.provider, model: env.model.id, timestamp: Date.now(), usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } };
    let settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      stream.end(message);
    };
    const timer = setTimeout(finish, text.includes('长任务') && hasWrite ? 30_000 : 50);
    streamOptions?.signal?.addEventListener('abort', () => { clearTimeout(timer); message.stopReason = 'aborted'; finish(); }, { once: true });
    return stream;
  };
  return hosted;
};
const sessionService = createModuleAgentSessionService({ host, store, profiles, workspaceKey: 'default' });
const runtime = createModuleAgentChatroomRuntime({ host, profiles, workspaceKey: 'default', chatroom, sessionService });
const app = express(); app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(store));
app.use('/api/chatroom', createChatroomRouter(chatroom));
app.use('/api/module-agents', createModuleAgentsRouter({ host, store, profiles, workspaceKey: 'default', sessionService }));
app.use('/api', createApiRouter(host));
const vite = await createServer({ configFile: false, root: process.cwd(), appType: 'spa',
  server: { middlewareMode: true, hmr: { port: 21000 + Math.floor(Math.random() * 20000) } }, plugins: [(await import('@vitejs/plugin-react')).default()] });
app.use(vite.middlewares);
const server = app.listen(Number(process.env.PI_WEBX_CHATROOM_FIXTURE_PORT ?? 18880), '127.0.0.1', () => {
  console.log(JSON.stringify({ url: 'http://127.0.0.1:18880/#/chatroom', fixtureRoot: root, model: 'offline-scripted-real-sdk' }));
});
attachWebSocketGateway(server, host);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await runtime.stop(); await host.disposeAll(); await vite.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close(); await env.close(); process.exit(0);
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
