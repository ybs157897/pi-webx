/** Opt-in configured-model regression; business data and project files stay in a temporary directory. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { profileRevision } from '../server/module-agents/snapshots';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-webx-project-context-live-')));
const workspace = path.join(root, 'deepseek-harness');
await mkdir(workspace);
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
const loaded = profiles.get('requirements');
assert.ok(loaded?.ok);
const profile = structuredClone(loaded.profile);
const actualProject = profile.effectiveWorkspace!;
for (const file of ['AGENTS.md', 'README.md']) {
  await writeFile(path.join(workspace, file), await readFile(path.join(actualProject, file)));
}
profile.config.workspace = workspace;
profile.effectiveWorkspace = workspace;
profile.profileRevision = profileRevision(profile);
const store = new WorkbenchStore(path.join(root, 'workbench.sqlite'));
const host = new PiHost({ sessionDir: path.join(root, 'sessions'), teamJournalDir: path.join(root, 'teams'),
  settingsManagerFactory: () => SettingsManager.inMemory() });
const tools: Array<{ name: string; arguments: unknown }> = [];
const evidenceFile = path.join(root, 'result.json');
console.log('LIVE_PROJECT_ARTIFACTS', JSON.stringify({ root, evidenceFile }));
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const hosted = await host.create({ moduleAgent: await assembleModuleAgent({ store, agentId: 'requirements',
    workspaceKey: 'project-context-live', profile }) });
  hosted.session.subscribe((event: any) => {
    if (event.type === 'tool_execution_start') tools.push({ name: event.toolName, arguments: event.args });
  });
  const prompt = '我想要加一个贪吃蛇的小游戏到当前项目里';
  const work = hosted.session.prompt(prompt);
  await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void hosted.session.abort(); reject(new Error('Configured model exceeded 180 seconds')); }, 180_000);
  })]);
  const messages = hosted.session.agent.state.messages;
  const replies = messages.filter((message: any) => message.role === 'assistant').map((message: any) => ({
    stopReason: message.stopReason, errorMessage: message.errorMessage,
    text: message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''),
  }));
  const final = replies.filter(reply => reply.text).at(-1);
  const evidence = { sessionId: hosted.id, sessionFile: hosted.session.sessionManager.getSessionFile(),
    model: profile.config.model, boundProject: workspace, prompt, systemPrompt: hosted.session.systemPrompt,
    tools, replies, requirementCount: store.listRecords('requirements').length, taskCount: store.listRecords('tasks').length };
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  assert.ok(final && final.stopReason === 'stop', JSON.stringify(replies));
  assert.match(final.text, /DeepSeek Harness|deepseek-harness/i, 'model identifies the project without a project name in the user message');
  assert.doesNotMatch(final.text, /(?:当前项目.{0,12}(?:指哪|指哪个|是哪|是哪一个|具体指)|(?:告诉我|提供|确认).{0,12}(?:项目名|哪个项目))/,
    'model must not ask the user to repeat the bound project');
  assert.equal(store.listRecords('tasks').length, 0, 'an idea does not automatically import implementation tasks');
  console.log('LIVE_PROJECT_REPLY', final.text);
  console.log('PASS configured requirements model: current project identified, no repeated project question, no task import');
} finally {
  if (timer) clearTimeout(timer);
  await host.disposeAll();
  store.close();
}
