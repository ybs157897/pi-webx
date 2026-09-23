/** Run the real macOS sandbox against disposable file and loopback targets. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRuntime, SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  assertTeamSandboxAvailable, createIsolatedToolDefinitions, ISOLATED_TOOL_NAMES,
  TeamSandboxUnavailableError,
} from '../server/agent-team/sandbox-tools';
import { createWorkerSession, type WorkerParentSession } from '../server/pi/subagent-session';
import { freezeDefinition } from '../server/pi/subagent-tool';

if (process.platform === 'win32') {
  console.log('SKIP macOS Seatbelt checks on Windows; Windows AppContainer checks run separately');
} else if (process.platform !== 'darwin') {
  console.log('SKIP check-agent-team-sandbox: macOS isolation backend is unavailable on this platform');
} else {
  const root = mkdtempSync(join(tmpdir(), 'pi-webx-sandbox-check-'));
  const cwd = join(root, 'work');
  const agentDir = join(root, 'agent-dir');
  const outside = join(root, 'outside');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(outside);
  assert.throws(
    () => assertTeamSandboxAvailable(root, agentDir),
    (cause: unknown) => cause instanceof TeamSandboxUnavailableError && cause.status === 400,
    'a workspace containing the Agent store is refused before any tool starts',
  );
  assert.throws(
    () => assertTeamSandboxAvailable(import.meta.dirname, agentDir),
    (cause: unknown) => cause instanceof TeamSandboxUnavailableError && cause.status === 400,
    'a workspace containing the running app source is refused',
  );
  writeFileSync(join(agentDir, 'agent-definitions.json'), 'protected definition');
  symlinkSync(agentDir, join(cwd, 'escape'));
  writeFileSync(join(outside, 'guard.txt'), 'outside original');
  symlinkSync(outside, join(cwd, 'outside'));
  const byName = new Map(createIsolatedToolDefinitions(cwd, agentDir).map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()], [...ISOLATED_TOOL_NAMES], 'every SDK coding tool has an isolated override');
  const call = async (name: string, params: unknown) => {
    const tool = byName.get(name) as ToolDefinition | undefined;
    assert.ok(tool, `isolated ${name} is registered`);
    return tool.execute(`check-${name}`, params as never, undefined, undefined, {} as never);
  };
  const server = createServer((_req, res) => { requests += 1; res.end('management API reached'); });
  let requests = 0;
  try {
    await call('write', { path: 'ok.txt', content: 'hello sandbox' });
    assert.equal(readFileSync(join(cwd, 'ok.txt'), 'utf8'), 'hello sandbox');
    const read = await call('read', { path: 'ok.txt' });
    assert.ok(JSON.stringify(read.content).includes('hello sandbox'));
    await call('edit', { path: 'ok.txt', edits: [{ oldText: 'hello', newText: 'edited' }] });
    assert.equal(readFileSync(join(cwd, 'ok.txt'), 'utf8'), 'edited sandbox');
    const bash = await call('bash', { command: 'cat ok.txt' });
    assert.ok(JSON.stringify(bash.content).includes('edited sandbox'));
    assert.ok(JSON.stringify((await call('grep', { pattern: 'edited', path: 'ok.txt' })).content).includes('edited'));
    assert.ok(JSON.stringify((await call('find', { pattern: '*.txt' })).content).includes('ok.txt'));
    assert.ok(JSON.stringify((await call('ls', { path: '.' })).content).includes('ok.txt'));
    console.log('ok   workspace read/write/edit/bash execute in the sandbox');

    const abortController = new AbortController();
    const bashTool = byName.get('bash') as ToolDefinition;
    const started = Date.now();
    const sleeping = bashTool.execute(
      'check-abort', { command: 'sleep 30' }, abortController.signal, undefined, {} as never,
    );
    setTimeout(() => abortController.abort(), 250);
    await assert.rejects(sleeping, /取消|aborted/i);
    assert.ok(Date.now() - started < 5000, 'cancellation settles without waiting for the shell timeout');
    console.log('ok   cancellation stops an in-flight sandbox tool promptly');

    await assert.rejects(call('read', { path: join(agentDir, 'agent-definitions.json') }), /Operation not permitted|permission denied/i);
    await assert.rejects(call('write', { path: join(agentDir, 'agent-definitions.json'), content: 'changed' }), /Operation not permitted|permission denied/i);
    await assert.rejects(call('read', { path: 'escape/agent-definitions.json' }), /Operation not permitted|permission denied/i);
    await assert.rejects(call('bash', { command: `cat '${join(agentDir, 'agent-definitions.json')}'` }), /Operation not permitted|permission denied/i);
    await assert.rejects(call('bash', { command: `printf changed > '${join(agentDir, 'agent-definitions.json')}'` }), /Operation not permitted|permission denied/i);
    await assert.rejects(call('write', { path: 'outside/guard.txt', content: 'changed' }), /Operation not permitted|permission denied/i);
    assert.equal(readFileSync(join(agentDir, 'agent-definitions.json'), 'utf8'), 'protected definition');
    assert.equal(readFileSync(join(outside, 'guard.txt'), 'utf8'), 'outside original');
    console.log('ok   direct and symlink access to the definition store is denied');

    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve()).on('error', reject));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, 'positive control: host API is reachable');
    assert.equal(requests, 1);
    for (const target of ['127.0.0.1', '0.0.0.0', 'localhost']) {
      await assert.rejects(
        call('bash', { command: `/usr/bin/curl --noproxy '*' --silent --show-error --max-time 3 http://${target}:${port}/manage` }),
        /Failed to connect|Operation not permitted|denied/i,
      );
      assert.equal(requests, 1, `the sandboxed shell never reached the management endpoint via ${target}`);
    }
    console.log('ok   the local management endpoint is unreachable from the sandbox');

    const hostProcess = spawn('/bin/sleep', ['30']);
    try {
      assert.ok(hostProcess.pid);
      await assert.rejects(
        call('bash', { command: `kill -TERM ${hostProcess.pid}` }),
        /Operation not permitted|permission denied/i,
      );
      assert.equal(hostProcess.exitCode, null, 'the sandboxed shell cannot signal a host process');
      console.log('ok   host processes cannot be signalled from the sandbox');
    } finally {
      hostProcess.kill('SIGTERM');
    }

    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false,
    });
    const model = runtime.getModels('deepseek')[0];
    assert.ok(model);
    const extensionsDir = join(agentDir, 'extensions');
    const extensionMarker = join(root, 'worker-extension-loaded');
    mkdirSync(extensionsDir);
    writeFileSync(join(extensionsDir, 'escape.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(extensionMarker)}, 'loaded');`,
      'export default function () {}',
    ].join('\n'));
    const definition = freezeDefinition({
      id: 'isolated', revision: 1, name: 'isolated', description: 'sandbox check',
      systemPrompt: 'Check the sandbox', model: { mode: 'inherit' },
      tools: { mode: 'all' }, maxTurns: 1, maxConcurrentInstances: 1,
      enabled: true, source: 'user', readOnly: false, createdAt: '', updatedAt: '',
    });
    const worker = await createWorkerSession({
      definition, model, runtime, isolateCodingTools: true,
      parent: {
        sessionId: 'sandbox-parent', cwd, agentDir,
        session: {
          model, thinkingLevel: 'off',
          settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
          getAllTools: () => [{ name: 'read' }, { name: 'write' }, { name: 'bash' }],
        } as WorkerParentSession,
      },
      toolNames: ['read', 'write', 'bash'], denied: ['subagent'],
    });
    try {
      assert.deepEqual(worker.getActiveToolNames().sort(), ['bash', 'read', 'write']);
      assert.equal(existsSync(extensionMarker), false, 'the member does not evaluate extension code');
      const sdkRead = worker.getToolDefinition('read');
      assert.ok(sdkRead, 'the SDK registered read');
      await assert.rejects(
        sdkRead.execute('sdk-read', { path: join(agentDir, 'agent-definitions.json') }, undefined, undefined, {} as never),
        /Operation not permitted|permission denied/i,
      );
      const sdkWrite = worker.getToolDefinition('write');
      assert.ok(sdkWrite, 'the SDK registered write');
      await sdkWrite.execute('sdk-write', { path: 'sdk-ok.txt', content: 'worker output' }, undefined, undefined, {} as never);
      assert.equal(readFileSync(join(cwd, 'sdk-ok.txt'), 'utf8'), 'worker output');
      console.log('ok   the real SDK registry uses the sandboxed coding-tool overrides');
    } finally {
      worker.dispose();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}
