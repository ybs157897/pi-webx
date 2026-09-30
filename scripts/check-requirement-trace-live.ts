/** Opt-in configured-model requirement-to-delivery acceptance, isolated from product records/repositories. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiHost } from '../server/pi/host';
import { WorkbenchStore } from '../server/workbench/store';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { createModuleAgentSessionService } from '../server/module-agents/session-service';
import { profileRevision } from '../server/module-agents/snapshots';
import { getChatroomService } from '../server/modules/chatroom/service';
import { createModuleAgentChatroomRuntime } from '../server/modules/chatroom/runtime';
import { readRequirementTrace, reviewRequirementDelivery } from '../server/modules/requirements/lifecycle';

const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-webx-requirement-live-')));
const previousWorkspace = process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = join(root, 'workspaces');
const profiles = await loadAgentProfiles(defaultAgentsConfigRoot());
for (const [id, loaded] of profiles) {
  if (!loaded.ok) continue;
  const profile = structuredClone(loaded.profile), cwd = join(root, 'workspaces', id);
  await mkdir(cwd, { recursive: true });
  profile.config.workspace = cwd; profile.effectiveWorkspace = cwd; profile.profileRevision = profileRevision(profile);
  profiles.set(id, { ok: true, profile });
}
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
const host = new PiHost({ sessionDir: join(root, 'sessions'), teamJournalDir: join(root, 'teams') });
const chatroom = getChatroomService(store), userKey = chatroom.ensureUserSession();
const sessionService = createModuleAgentSessionService({ host, store, profiles, workspaceKey: 'default' });
const runtime = createModuleAgentChatroomRuntime({ host, chatroom, sessionService, profiles,
  workspaceKey: 'default', admissionTimeoutMs: 60_000, turnTimeoutMs: 240_000 });
const instructions = `@需求管理 这是隔离工作目录里的全链路验收，目标、范围、验收条件均已明确，无需追问。
请认领一个协作任务，创建一份需求和一条待办，并交给代码开发实施：只在代码开发当前临时目录创建 requirement-live.txt，内容严格为 ROOT_CHAIN_OK，读取并用 bash 校验一致，不改其它文件。
代码开发应认领原协作任务、真实写入/读取验证、明确自己的分工 completed，调用 chatroom_delivery 提交真实文件与验证引用（省略 runIds 自动关联当前执行），再把实际完成的业务 taskIds 回报给我的助理。
我的助理核对后完成对应待办和自己的协作分工，再通知需求管理；需求管理收到回报只完成原分工，不再创建需求。最终交付必须停在 submitted，等我人工审阅。工作状态与业务待办不同，不得把完成通知再次广播。`;
console.log('REQUIREMENT_LIVE_ARTIFACTS', JSON.stringify({ root }));
try {
  const request = chatroom.sendUser(userKey, { body: instructions, entryKey: 'requirement-live-root' });
  const deadline = Date.now() + 8 * 60_000;
  let requirementId = '';
  let completed = false;
  let lastStage = '';
  while (Date.now() < deadline) {
    const requirements = store.listRecords('requirements');
    assert.ok(requirements.length <= 1, 'live chain must not recreate the same requirement');
    requirementId = requirements[0]?.id ?? '';
    if (requirementId) {
      const trace = readRequirementTrace(store, requirementId);
      await writeFile(join(root, 'trace.json'), JSON.stringify(trace, null, 2));
      const summary = JSON.stringify({ stage: trace.stage, tasks: trace.links.tasks.length,
        assignments: trace.links.assignments.map(item => [item.agentId, item.status]),
        deliveries: trace.deliveries.map(item => item.status), blockers: trace.blockers });
      if (summary !== lastStage) { console.log('REQUIREMENT_LIVE_PROGRESS', summary); lastStage = summary; }
      const delivery = trace.deliveries.find(item => item.status === 'submitted');
      if (delivery && trace.acceptanceReady) {
        const accepted = reviewRequirementDelivery(store, requirementId, delivery.id, {
          decision: 'accept', expectedUpdatedAt: delivery.updatedAt, entryKey: 'live-review',
          comment: '隔离验收：核对真实文件、执行及全部业务待办后接受',
        }, `user:${userKey}`);
        assert.equal(accepted.trace.stage, 'delivered');
        assert.ok(accepted.trace.links.messages.some(item => item.id === request.id));
        assert.ok(accepted.trace.links.runs.some(item => item.agentId === 'codes' && item.status === 'succeeded'));
        assert.equal((await readFile(join(root, 'workspaces', 'codes', 'requirement-live.txt'), 'utf8')).trim(), 'ROOT_CHAIN_OK');
        await writeFile(join(root, 'result.json'), JSON.stringify(accepted.trace, null, 2));
        completed = true; break;
      }
    }
    const input = chatroom.storage.byId(request.id);
    if (input?.deliveryStatus === 'failed') throw new Error(input.error ?? '需求入口执行失败');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(completed, `configured-model chain did not reach reviewable completion; inspect ${root}/trace.json`);
  await chatroom.drain();
  console.log('PASS configured-model requirement trace: generation, development, verification, todos, delivery and explicit review');
} finally {
  await runtime.stop(); await host.disposeAll(); store.close();
  if (previousWorkspace === undefined) delete process.env.PI_WEBX_AGENT_WORKSPACE_ROOT;
  else process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = previousWorkspace;
}
