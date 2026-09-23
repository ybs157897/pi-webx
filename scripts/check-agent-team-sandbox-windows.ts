/** Real Windows LPAC checks. Never report a skip on the Windows acceptance lane. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createIsolatedToolDefinitions, TeamSandboxUnavailableError } from '../server/agent-team/sandbox-tools';

function appContainerAclEntries(path: string): string[] {
  const command = [
    '(Get-Acl -LiteralPath $env:PI_WEBX_ACL_PATH).Access | ForEach-Object {',
    'try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }',
    'catch { $_.IdentityReference.Value }',
    '} | Where-Object { $_ -match "^S-1-15-2-" } | Sort-Object -Unique',
  ].join(' ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, PI_WEBX_ACL_PATH: path },
  });
  return output.trim().split(/\r?\n/u).filter(Boolean);
}

if (process.platform !== 'win32') {
  console.log('SKIP Windows AppContainer runtime checks on this non-Windows host');
} else {
  const root = mkdtempSync(join(tmpdir(), 'pi-webx-team-win-check-'));
  const cwd = join(root, 'work');
  const agentDir = join(root, 'agent-dir');
  const outside = join(root, 'outside');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(outside);
  const protectedFile = join(agentDir, 'agent-definitions.json');
  writeFileSync(protectedFile, 'protected definition');
  symlinkSync(agentDir, join(cwd, 'escape'), 'junction');
  writeFileSync(join(outside, 'guard.txt'), 'outside original');
  symlinkSync(outside, join(cwd, 'outside'), 'junction');
  const initialAcls = new Map([cwd, agentDir, join(import.meta.dirname, '..', 'node_modules')]
    .map((path) => [path, appContainerAclEntries(path)]));
  const server = createServer((_req, res) => { requests += 1; res.end('management reached'); });
  let requests = 0;
  let complete = false;
  try {
    assert.throws(
      () => createIsolatedToolDefinitions(root, agentDir),
      (cause: unknown) => cause instanceof TeamSandboxUnavailableError && cause.status === 400,
      'a workspace containing the Agent store is refused',
    );
    const tools = new Map(createIsolatedToolDefinitions(cwd, agentDir).map((tool) => [tool.name, tool]));
    const call = async (name: string, params: unknown, signal?: AbortSignal) => {
      const tool = tools.get(name) as ToolDefinition | undefined;
      assert.ok(tool, `${name} is registered`);
      return tool.execute(`win-${name}`, params as never, signal, undefined, {} as never);
    };

    await call('write', { path: 'ok.txt', content: 'hello Windows Team' });
    await call('edit', { path: 'ok.txt', edits: [{ oldText: 'hello', newText: 'edited' }] });
    assert.equal(readFileSync(join(cwd, 'ok.txt'), 'utf8'), 'edited Windows Team');
    assert.ok(JSON.stringify((await call('read', { path: 'ok.txt' })).content).includes('edited Windows Team'));
    assert.ok(JSON.stringify((await call('powershell', { command: 'Get-Content ok.txt' })).content).includes('edited Windows Team'));
    assert.ok(JSON.stringify((await call('grep', { pattern: 'edited', path: 'ok.txt' })).content).includes('edited'));
    assert.ok(JSON.stringify((await call('find', { pattern: '*.txt' })).content).includes('ok.txt'));
    assert.ok(JSON.stringify((await call('ls', { path: '.' })).content).includes('ok.txt'));
    console.log('ok   Windows AppContainer keeps coding tools functional in the workspace');

    await assert.rejects(call('read', { path: protectedFile }));
    await assert.rejects(call('write', { path: protectedFile, content: 'changed' }));
    await assert.rejects(call('read', { path: 'escape\\agent-definitions.json' }));
    await assert.rejects(call('write', { path: 'outside\\guard.txt', content: 'changed' }));
    await assert.rejects(call('powershell', { command: `Set-Content -LiteralPath '${protectedFile}' -Value changed -ErrorAction Stop` }));
    assert.equal(readFileSync(protectedFile, 'utf8'), 'protected definition');
    assert.equal(readFileSync(join(outside, 'guard.txt'), 'utf8'), 'outside original');
    console.log('ok   Windows AppContainer refuses direct and junction access to the Agent store');

    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal(requests, 1);
    await assert.rejects(call('powershell', {
      command: `Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${port}/manage' -TimeoutSec 3 -ErrorAction Stop`,
    }));
    assert.equal(requests, 1, 'the AppContainer cannot reach the host management listener');
    console.log('ok   Windows AppContainer has no host loopback access');

    const hostProcess = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
    try {
      assert.ok(hostProcess.pid);
      await assert.rejects(call('powershell', { command: `Stop-Process -Id ${hostProcess.pid} -Force -ErrorAction Stop` }));
      assert.equal(hostProcess.exitCode, null, 'the AppContainer cannot stop a host process');
    } finally {
      hostProcess.kill('SIGTERM');
    }
    console.log('ok   Windows AppContainer cannot signal a host process');

    const controller = new AbortController();
    const start = Date.now();
    const pending = call('powershell', { command: 'Start-Sleep -Seconds 30' }, controller.signal);
    setTimeout(() => controller.abort(), 250);
    await assert.rejects(pending, /取消|abort/i);
    assert.ok(Date.now() - start < 5000, 'cancellation does not wait for the shell timeout');
    console.log('ok   Windows AppContainer cancellation settles promptly');
    for (const [path, before] of initialAcls) {
      assert.deepEqual(appContainerAclEntries(path), before, `AppContainer ACLs were cleaned on ${path}`);
    }
    assert.deepEqual(appContainerAclEntries(join(cwd, 'ok.txt')), appContainerAclEntries(cwd),
      'new workspace files inherit no abandoned AppContainer SID');
    console.log('ok   Windows AppContainer grants are removed after normal and cancelled calls');
    complete = true;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (complete) rmSync(root, { recursive: true, force: true });
    else console.error(`Windows sandbox evidence retained at ${root}`);
  }
}
