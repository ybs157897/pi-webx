/** Browser runs against real offline SDK seed data, not handcrafted lifecycle rows. */
import express from 'express';
import { createServer } from 'vite';
import { createWorkbenchRouter } from '../server/workbench/router';
import { createChatroomRouter } from '../server/modules/chatroom/router';
import { createModuleAgentsRouter } from '../server/module-agents/router';
import { createApiRouter } from '../server/routes';
import { attachWebSocketGateway } from '../server/ws';
import { readRequirementTrace } from '../server/modules/requirements/lifecycle';
import { createRequirementTraceFixture } from './requirement-trace-fixture';
import { writeFile } from 'node:fs/promises';

const fixture = await createRequirementTraceFixture();
const app = express(); app.use(express.json());
app.use('/api/workbench', createWorkbenchRouter(fixture.store));
app.use('/api/chatroom', createChatroomRouter(fixture.chatroom));
app.use('/api/module-agents', createModuleAgentsRouter({ host: fixture.host, store: fixture.store,
  profiles: fixture.profiles, workspaceKey: 'default', sessionService: fixture.sessionService }));
app.use('/api', createApiRouter(fixture.host));
const vite = await createServer({ configFile: false, root: process.cwd(), appType: 'spa',
  server: { middlewareMode: true }, plugins: [(await import('@vitejs/plugin-react')).default()] });
app.use(vite.middlewares);
const port = Number(process.env.PI_WEBX_REQUIREMENT_TRACE_PORT ?? 18881);
const server = app.listen(port, '127.0.0.1', () => {
  console.log('TRACE_BROWSER_FIXTURE', JSON.stringify({ url: `http://127.0.0.1:${port}`,
    root: fixture.root, requirementId: fixture.requirementId, codeRunId: fixture.codeRunId,
    deliveryId: fixture.deliveryId, model: 'offline-scripted-real-sdk' }));
});
attachWebSocketGateway(server, fixture.host);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await writeFile('/tmp/pi-webx-requirement-trace-browser-result.json',
    JSON.stringify(readRequirementTrace(fixture.store, fixture.requirementId), null, 2));
  await vite.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fixture.close(); process.exit(0);
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
