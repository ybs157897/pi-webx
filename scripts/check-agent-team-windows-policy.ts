/** Windows policy construction is checked on every host; runtime checks run on Windows. */
import assert from 'node:assert/strict';

import { assertWindowsAppContainerStatus, windowsAppContainerPolicy } from '../server/agent-team/windows-appcontainer';
import { TeamSandboxUnavailableError } from '../server/agent-team/isolation-contract';

const workspace = 'C:\\work\\project';
const agentDir = 'C:\\Users\\owner\\.pi\\agent';
const scratch = 'C:\\Users\\owner\\AppData\\Local\\Temp\\pi-webx-team';
const policy = windowsAppContainerPolicy({
  workspace, agentDir, scratch,
  nodeBin: 'C:\\Program Files\\nodejs',
  dependencies: 'C:\\app\\node_modules',
  searchBinDir: 'C:\\app\\node_modules\\.cache\\pi-webx-team-tools',
});

assert.deepEqual(policy.filesystem.allowWrite, [workspace, scratch]);
assert.ok(policy.filesystem.allowRead.includes(workspace));
assert.ok(policy.filesystem.allowRead.includes(scratch));
assert.ok(policy.filesystem.allowRead.includes('C:\\app\\node_modules'));
assert.ok(!policy.filesystem.allowRead.includes(agentDir));
assert.deepEqual(policy.filesystem.denyRead, [agentDir]);
assert.deepEqual(policy.filesystem.denyWrite, [agentDir]);
assert.deepEqual(policy.network, { allowNetwork: false });
assert.deepEqual(policy.windows, { appContainerMode: 'lpac', allowLoopback: false });
assert.doesNotThrow(() => assertWindowsAppContainerStatus({ active: 'appContainer', installed: false, healthy: true }));
for (const report of [
  { active: 'restrictedUser', installed: true, healthy: true },
  { active: 'appContainer', installed: false, healthy: false },
  { active: 'appContainer', installed: true, healthy: true },
  null,
]) {
  assert.throws(() => assertWindowsAppContainerStatus(report), TeamSandboxUnavailableError);
}
console.log('PASS Windows Team policy: explicit read roots, workspace-only writes, no network or loopback, LPAC');
