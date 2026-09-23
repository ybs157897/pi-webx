/** Browser acceptance for Team creation, projection, reload and narrow layout. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runDir = process.env.RUN_DIR ?? join(tmpdir(), `pi-webx-team-browser-${randomUUID()}`);
const agentDir = join(runDir, 'agent-dir');
const cwd = join(runDir, 'workspace');
const sessionDir = join(runDir, 'sessions');
const evidenceDir = join(runDir, 'evidence');
for (const dir of [agentDir, cwd, sessionDir, evidenceDir]) mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const require = createRequire(join(process.env.PI_WEBX_PLAYWRIGHT_ROOT ?? root, 'package.json'));
const { chromium } = require('playwright-core');
const { ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
const { TeamJournal } = await import('../server/agent-team/team-journal.ts');
const { AgentTeamRuntime } = await import('../server/agent-team/team-runtime.ts');
const { freezeDefinition } = await import('../server/pi/subagent-tool.ts');
const { PiHost } = await import('../server/pi/host.ts');
const { createApiRouter } = await import('../server/routes.ts');
const { attachWebSocketGateway } = await import('../server/ws.ts');
const { default: express } = await import('express');

const sessionId = randomUUID();
const sessionPath = join(sessionDir, `2026-09-23T00-00-00-000Z_${sessionId}.jsonl`);
writeFileSync(sessionPath, [
  JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-09-23T00:00:00.000Z', cwd }),
  JSON.stringify({
    type: 'message', id: 'e0000001', parentId: null, timestamp: '2026-09-23T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '团队准备完毕。' }], timestamp: 1 },
  }),
].join('\n') + '\n');
const journalDir = join(agentDir, 'pi-webx', 'teams');
const journal = new TeamJournal({ dir: journalDir });
const teamRuntime = new AgentTeamRuntime({ journal });
const team = teamRuntime.createTeam(sessionId);
const definition = freezeDefinition({
  id: 'browser-fixture', revision: 1, name: 'browser-fixture', description: 'Browser acceptance',
  systemPrompt: 'Fixture', model: { mode: 'inherit' }, tools: { mode: 'all' },
  maxTurns: 1, maxConcurrentInstances: 1, enabled: true,
  source: 'user', readOnly: false, createdAt: '', updatedAt: '',
});
const member = teamRuntime.addMember({ teamId: team.id, definition });
teamRuntime.settleMember({ teamId: team.id, memberId: member.id, status: 'idle', text: 'BROWSER_RESULT_OK' });
const task = teamRuntime.createTask({ teamId: team.id, title: 'BROWSER_TASK_OK', description: 'Team task projection' });
teamRuntime.assignTask(team.id, task.id, member.id);
teamRuntime.updateTask({ teamId: team.id, taskId: task.id, expectedRevision: 2, patch: { status: 'completed' } });
const message = teamRuntime.appendMessage({
  teamId: team.id, from: member.id, to: 'lead', kind: 'result', payload: 'BROWSER_MESSAGE_OK',
  origin: 'member-message', deliveredAsToolResult: true,
});
teamRuntime.setMessageDeliveryState(team.id, message.id, 'fresh-reader-visible');

const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: null,
  refreshOnCreate: false, allowModelNetwork: false,
});
const host = new PiHost({
  teamJournalDir: journalDir, sessionDir,
  definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(runDir, 'definitions.json'), agents: [] }) },
  modelRuntimeFactory: async () => runtime,
  settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
});
let server;
let browser;
let stopWs;
try {
  const hosted = await host.create({ cwd, sessionPath });
  assert.equal(hosted.teamId, team.id, 'stored session reattaches the original Team');
  const app = express();
  app.use(express.json());
  app.get('/api/stored-sessions', (_req, res) => res.json({ sessions: [] }));
  app.use('/api', createApiRouter(host));
  app.use(express.static(join(root, 'dist')));
  app.use((_req, res) => res.sendFile(join(root, 'dist', 'index.html')));
  server = await new Promise((resolveServer) => {
    const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
  });
  stopWs = attachWebSocketGateway(server, host);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    ...(process.env.PI_WEBX_BROWSER_PATH
      ? { executablePath: process.env.PI_WEBX_BROWSER_PATH }
      : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((workspace) => {
    localStorage.setItem('pi-webx-prefs', JSON.stringify({ cwd: workspace }));
  }, cwd);
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}&team=1`);
  await page.getByRole('button', { name: '团队面板' }).click();
  await page.getByText('browser-fixture').waitFor();
  await page.getByText('查看成员结果').click();
  assert.ok(await page.getByText('BROWSER_RESULT_OK').isVisible());
  await page.getByRole('tab', { name: '任务' }).click();
  assert.ok(await page.getByText('BROWSER_TASK_OK').isVisible());
  await page.getByRole('tab', { name: '消息' }).click();
  assert.ok(await page.getByText('BROWSER_MESSAGE_OK').isVisible());
  await page.screenshot({ path: join(evidenceDir, 'team-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const wrapper = document.querySelector('.ant-drawer-content-wrapper');
    if (!wrapper) return false;
    const rect = wrapper.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= window.innerWidth + 1;
  });
  const mobileDrawer = await page.evaluate(() => {
    const wrapper = document.querySelector('.ant-drawer-content-wrapper');
    const title = document.querySelector('.ant-drawer-title');
    const outer = wrapper?.getBoundingClientRect();
    const heading = title?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      wrapper: outer && { left: outer.left, right: outer.right, width: outer.width },
      title: heading && { left: heading.left, right: heading.right },
    };
  });
  assert.ok(mobileDrawer.wrapper && mobileDrawer.title, 'mobile Team drawer and title exist');
  assert.ok(mobileDrawer.wrapper.left >= -1 && mobileDrawer.wrapper.right <= mobileDrawer.width + 1,
    `mobile Team drawer fits viewport: ${JSON.stringify(mobileDrawer)}`);
  assert.ok(mobileDrawer.title.left >= 0 && mobileDrawer.title.right <= mobileDrawer.width,
    `mobile Team title is in the viewport: ${JSON.stringify(mobileDrawer)}`);
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await page.screenshot({ path: join(evidenceDir, 'team-mobile.png') });
  await page.reload();
  await page.getByRole('button', { name: '团队面板' }).click();
  await page.getByRole('tab', { name: '任务' }).click();
  assert.ok(await page.getByText('BROWSER_TASK_OK').isVisible(), 'reload retains the original Team');

  const storedProjection = host.teamSnapshot(sessionId);
  assert.ok(storedProjection);
  const runningProjection = {
    ...storedProjection,
    members: storedProjection.members.map((item, index) => index === 0 ? { ...item, status: 'running' } : item),
  };
  const teamRoute = `**/api/teams/${encodeURIComponent(sessionId)}`;
  const cancelRoute = `${teamRoute}/cancel`;
  await page.route(teamRoute, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(runningProjection),
  }));
  await page.route(cancelRoute, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ teamId: team.id, cancelled: 1, reason: 'browser acceptance' }),
  }));
  await page.getByRole('button', { name: '刷新团队状态' }).click();
  await page.getByRole('button', { name: '停止成员' }).click();
  const cancelRequest = page.waitForRequest((request) => request.method() === 'POST'
    && request.url().endsWith(`/api/teams/${encodeURIComponent(sessionId)}/cancel`));
  await page.getByRole('button', { name: /^(确定|OK)$/u }).click();
  assert.ok((await cancelRequest).postDataJSON()?.reason, 'the panel sent a cooperative cancel request');
  await page.getByText('已请求停止 1 个成员', { exact: false }).waitFor();
  await page.unroute(cancelRoute);
  await page.unroute(teamRoute);

  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: '新建会话' }).last().click();
  await page.waitForURL((url) => !new URL(url).searchParams.has('session'));
  await page.getByRole('radiogroup', { name: '会话模式' }).getByText('Agent Team').click();
  const creates = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) {
      try { creates.push(request.postDataJSON()); } catch { /* Report missing body below. */ }
    }
  });
  await page.route('**/api/sessions/*/command', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ response: { type: 'response', command: 'prompt', success: true } }),
  }));
  await page.locator('textarea[placeholder="给 pi 派活…回车发送，Shift+回车换行"]').fill('Team browser acceptance');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.waitForURL(/session=/);
  assert.ok(creates.some((body) => body?.teamMode === true && body?.sessionId === undefined), 'first send created a Team session');
  const newId = new URL(page.url()).searchParams.get('session');
  assert.ok(newId);
  const response = await page.request.get(`${origin}/api/teams/${encodeURIComponent(newId)}`);
  assert.equal(response.status(), 200);
  console.log(JSON.stringify({ verdict: 'PASS', os: process.platform, teamId: team.id, newTeamId: newId, evidenceDir }));
} finally {
  await browser?.close();
  stopWs?.();
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()));
  await host.disposeAll();
}
