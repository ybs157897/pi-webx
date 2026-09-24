/** Credential-backed Team acceptance. Only a disposable workspace is writable. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  captureAndIsolateAgentDir, createTestBootstrap, projectRootFromModule,
} from './subagents-test-server';

async function waitFor(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Team live acceptance timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const runDir = process.env.RUN_DIR ?? mkdtempSync(join(tmpdir(), 'pi-webx-team-live-'));
process.env.RUN_DIR = runDir;
const { realAgentDir, agentDir } = await captureAndIsolateAgentDir(runDir);
const bootstrap = await createTestBootstrap(process.env, projectRootFromModule(), realAgentDir, agentDir);
const { AgentDefinitionStore } = await import('../server/agent-definitions');
const store = new AgentDefinitionStore({ filePath: bootstrap.environment.definitionsFile });
const shell = process.platform === 'win32' ? 'powershell' : 'bash';
const marker = `TEAM_LIVE_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const file = join(bootstrap.environment.fixtureRoot, 'team-live.txt');
let hosted: Awaited<ReturnType<typeof bootstrap.host.create>> | undefined;

try {
  const saved = await store.create({
    expectedRevision: 0,
    definition: {
      name: 'live-flash-member',
      description: 'Temporary Agent Team acceptance member',
      systemPrompt: 'You are a coding worker. Follow the requested tool sequence exactly. Use the write tool for the file and send_team_message for the lead. Report only what you actually did.',
      model: { mode: 'inherit' },
      tools: { mode: 'selected', names: ['read', 'write', shell] },
      maxTurns: 5,
      maxConcurrentInstances: 1,
      enabled: true,
    },
  });
  const definition = saved.agents.find((item) => item.name === 'live-flash-member');
  assert.ok(definition);
  hosted = await bootstrap.host.create({
    cwd: bootstrap.environment.fixtureRoot,
    provider: bootstrap.environment.model.providerId,
    model: bootstrap.environment.model.modelId,
    teamMode: true,
    toolNames: ['read', 'write', shell],
  });
  const dispatch = hosted.session.getToolDefinition('dispatch_agent') as ToolDefinition | undefined;
  assert.ok(dispatch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  let result: Awaited<ReturnType<ToolDefinition['execute']>>;
  try {
    result = await dispatch.execute('team-live-dispatch', {
      definitionId: definition.id,
      expectedDefinitionRevision: definition.revision,
      instruction: `Use write to create team-live.txt with exactly ${marker}. Then call send_team_message with kind result and payload exactly ${marker}. Finally say you completed both actions.`,
    }, controller.signal, undefined, {} as never);
  } finally {
    clearTimeout(timer);
  }
  const details = result.details as { memberStatus?: string; model?: { provider?: string; id?: string }; effectiveTools?: string[] };
  assert.equal(details.memberStatus, 'idle');
  assert.deepEqual(details.model, {
    provider: bootstrap.environment.model.providerId,
    id: bootstrap.environment.model.modelId,
  });
  assert.ok(details.effectiveTools?.includes('write'));
  assert.ok(details.effectiveTools?.includes('send_team_message'));
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8'), marker);
  await waitFor(() => bootstrap.host.teamSnapshot(hosted!.id)?.messages.some((item) => (
    item.origin === 'member-message' && item.untrustedPayload === marker
  )) ?? false);
  const team = bootstrap.host.teamSnapshot(hosted.id);
  const note = team?.messages.find((item) => item.origin === 'member-message' && item.untrustedPayload === marker);
  assert.ok(note, 'the worker used send_team_message');
  await waitFor(() => hosted!.session.messages.some((item) => (
    item.role === 'custom' && item.details?.messageId === note.messageId
  )));
  await hosted.session.waitForIdle();
  const copies = () => hosted!.session.messages.filter((item) => (
    item.role === 'custom' && item.details?.messageId === note.messageId
  ));
  assert.equal(copies().length, 1);
  const nextTurnStart = hosted.session.messages.length;
  await hosted.session.prompt('请只回复刚收到的团队消息中的 TEAM_LIVE 标记，不要调用工具。');
  const nextTurn = hosted.session.messages.slice(nextTurnStart);
  const answer = nextTurn.filter((item) => item.role === 'assistant').flatMap((item) => (
    item.content.filter((block) => block.type === 'text').map((block) => block.text)
  )).join('\n');
  assert.ok(answer.includes(marker), `the next model turn did not echo the Team marker: ${answer.slice(0, 200)}`);
  assert.equal(copies().length, 1, 'the Team message is injected once across turns');

  const streaming = await bootstrap.host.create({
    cwd: bootstrap.environment.fixtureRoot,
    provider: bootstrap.environment.model.providerId,
    model: bootstrap.environment.model.modelId,
    teamMode: true,
    toolNames: ['read', 'write', shell],
  });
  const streamTimer = setTimeout(() => { void streaming.session.abort(); }, 150_000);
  try {
    await streaming.session.prompt([
      `先调用一次 dispatch_agent：definitionId=${definition.id}，expectedDefinitionRevision=${definition.revision}。`,
      '给成员的 instruction：生成一个随机 8 位小写十六进制码，用 send_team_message(kind=result, payload=该码) 发给编排者；最终回答只能写 DONE，不得包含这个码。',
      '等 dispatch_agent 返回后，你最终只回复从团队消息收到的码。不要从成员最终回答猜测。',
    ].join('\n'));
  } finally {
    clearTimeout(streamTimer);
  }
  const streamingTeam = bootstrap.host.teamSnapshot(streaming.id);
  assert.ok(streamingTeam);
  const streamed = streamingTeam.messages.find((item) => item.origin === 'member-message');
  assert.ok(streamed, 'the streaming member sent a Team message');
  assert.equal(streamed.deliveryMode, 'steered');
  assert.equal(typeof streamed.untrustedPayload, 'string');
  const streamedCode = streamed.untrustedPayload as string;
  assert.match(streamedCode, /^[0-9a-f]{8}$/u);
  const streamedCopies = streaming.session.messages.filter((item) => (
    item.role === 'custom' && item.details?.messageId === streamed.messageId
  ));
  assert.equal(streamedCopies.length, 1);
  const toolText = streaming.session.messages.filter((item) => item.role === 'toolResult')
    .map((item) => JSON.stringify(item.content)).join('\n');
  assert.ok(!toolText.includes(streamedCode), 'the worker tool result did not leak the code to the lead');
  const streamAnswer = streaming.session.messages.filter((item) => item.role === 'assistant')
    .flatMap((item) => item.content.filter((block) => block.type === 'text').map((block) => block.text))
    .at(-1) ?? '';
  assert.ok(streamAnswer.includes(streamedCode), 'the lead read the injected Team message on the next model request');
  console.log(JSON.stringify({
    verdict: 'PASS', os: process.platform, runDir, teamId: team?.teamId,
    model: details.model, memberStatus: details.memberStatus,
    deliveryState: bootstrap.host.teamSnapshot(hosted.id)?.messages.find((item) => item.messageId === note.messageId)?.deliveryState,
    nextTurnSawMarker: true, streamedTeamId: streamingTeam.teamId,
    streamedDeliveryMode: streamed.deliveryMode, streamedCustomCopies: streamedCopies.length,
    streamedNextRequestSawMessage: true,
  }));
} finally {
  await bootstrap.host.disposeAll();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
}
