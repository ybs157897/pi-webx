/** Offline persistence and real-Pi-SDK replay regression for requirements_save_draft. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { parse, stringify } from 'yaml';

import { PiHost } from '../server/pi/host';
import { assembleModuleAgent } from '../server/module-agents/assemble';
import type { ResolvedAgentProfile } from '../server/module-agents/contracts';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { profileRevision } from '../server/module-agents/snapshots';
import { createRequirementsTools } from '../server/modules/requirements/tools';
import { saveRequirementDraftIdempotently } from '../server/modules/requirements/draft-idempotency';
import { getRequirementVersion } from '../server/modules/requirements/lifecycle';
import { importRequirementTasks } from '../server/modules/requirements/import-tasks';
import { WorkbenchInputError, WorkbenchStore } from '../server/workbench/store';

const root = await mkdtemp(join(tmpdir(), 'requirements-draft-idempotency-'));
const dbPath = join(root, 'workbench.sqlite');
const configRoot = join(root, 'config', 'agents');
const workspaceRoot = join(root, 'workspaces');
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const snapshotsDir = join(root, 'snapshots');

function context(sessionId: string): any {
  return { sessionManager: { getSessionId: () => sessionId } };
}

function recordSnapshot(result: any) {
  return {
    id: result.requirementId,
    title: result.record.title,
    createdAt: result.record.createdAt,
    updatedAt: result.record.updatedAt,
    requirementVersion: result.requirementVersion,
  };
}

function assertConflict(error: unknown): boolean {
  return error instanceof WorkbenchInputError && error.status === 409;
}

async function main(): Promise<void> {
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);
  await cp(defaultAgentsConfigRoot(), configRoot, { recursive: true, force: true });
  const requirementsConfig = join(configRoot, 'requirements.yaml');
  const rawConfig = parse(await readFile(requirementsConfig, 'utf8')) as Record<string, any>;
  const requirementWorkspace = join(workspaceRoot, 'requirements');
  await mkdir(requirementWorkspace, { recursive: true });
  rawConfig.enabled = true;
  rawConfig.workspace = await realpath(requirementWorkspace);
  await writeFile(requirementsConfig, stringify(rawConfig), 'utf8');

  const oldEnv = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    configRoot: process.env.PI_WEBX_AGENT_CONFIG_DIR,
    workspaceRoot: process.env.PI_WEBX_AGENT_WORKSPACE_ROOT,
    webHome: process.env.PI_WEBX_HOME,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEBX_AGENT_CONFIG_DIR = configRoot;
  process.env.PI_WEBX_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.PI_WEBX_HOME = join(root, 'pi-webx-home');
  await mkdir(process.env.PI_WEBX_HOME, { recursive: true });

  let store = new WorkbenchStore(dbPath);
  let host: PiHost | undefined;
  try {
    const tool = createRequirementsTools({ store, limits: { maxToolOutputChars: 24000 }, workspaceDir: root })
      .find(item => item.name === 'requirements_save_draft');
    assert.ok(tool, 'the requirements tool factory must provide requirements_save_draft');

    const sessionA = 'draft-session-A';
    const stableInputA = {
      entryKey: 'stable-draft-key-A',
      title: '  Canonical requirement title  ',
      note: 'Same requirement body and acceptance conditions.',
      taskDrafts: [{ title: '  Canonical task  ', tag: '  review  ' }],
    };
    const stableInputNormalized = {
      entryKey: 'stable-draft-key-A',
      title: 'Canonical requirement title',
      note: 'Same requirement body and acceptance conditions.',
      priority: 'normal',
      taskDrafts: [{ title: 'Canonical task', priority: 'normal', due: null, tag: 'review' }],
    };
    const first = await tool.execute('sdk-call-first', stableInputA, undefined, undefined, context(sessionA));
    const firstData = (first.details as any).data;
    assert.equal(firstData.alreadySaved, false);
    assert.equal(firstData.record.sourceSessionId, sessionA);
    assert.equal(Object.hasOwn(firstData.record, 'entryKey'), false, 'receipt keys stay outside the business record');
    assert.equal(Object.hasOwn(firstData.record, 'alreadySaved'), false, 'replay status stays outside the business record');
    const firstSnapshot = recordSnapshot(firstData);
    const firstVersion = getRequirementVersion(store, firstData.requirementId);
    assert.equal(firstSnapshot.requirementVersion, firstVersion);
    assert.equal(store.read().tasks.length, 0, 'draft save must not create todos');

    const replay = await tool.execute('sdk-call-retry-new-tool-id', stableInputNormalized, undefined, undefined, context(sessionA));
    const replayData = (replay.details as any).data;
    assert.equal(replayData.alreadySaved, true, 'a stable entryKey must replay under a different SDK toolCallId');
    assert.deepEqual(recordSnapshot(replayData), firstSnapshot, 'replay preserves the original id, version and timestamps');
    assert.equal(getRequirementVersion(store, firstData.requirementId), firstVersion);
    assert.equal(store.listRecords('requirements').length, 1);
    assert.equal(store.read().tasks.length, 0);

    await assert.rejects(
      async () => saveRequirementDraftIdempotently(store, sessionA, 'changed-args-call', {
        ...stableInputNormalized, title: 'Different title',
      }),
      assertConflict,
      'the same entryKey cannot be reused for different normalized business arguments',
    );
    await assert.rejects(
      async () => saveRequirementDraftIdempotently(store, sessionA, 'sdk-call-first', {
        ...stableInputNormalized, entryKey: 'other-key', title: 'Different receipt for one tool call',
      }),
      assertConflict,
      'one session/toolCallId pair cannot be rebound to another save receipt',
    );
    assert.equal(store.listRecords('requirements').length, 1);

    const sameContentDifferentKey = await saveRequirementDraftIdempotently(store, sessionA, 'different-key-call', {
      ...stableInputNormalized, entryKey: 'different-key',
    });
    assert.notEqual(sameContentDifferentKey.requirementId, firstData.requirementId,
      'equal content under a different stable key is a distinct user save');
    const sameContentDifferentSession = await saveRequirementDraftIdempotently(store, 'draft-session-B', 'other-session-call', {
      ...stableInputNormalized,
    });
    assert.notEqual(sameContentDifferentSession.requirementId, firstData.requirementId,
      'receipt scope includes the session identity');
    assert.equal(store.read().tasks.length, 0);

    // Legacy calls without entryKey use the SDK toolCallId as their replay key.
    const legacyArgs = { title: 'Legacy saved draft', note: 'legacy call args', taskDrafts: [{ title: 'Legacy task' }] };
    const legacy = await saveRequirementDraftIdempotently(store, sessionA, 'legacy-call-id', legacyArgs);
    const legacyReplay = await saveRequirementDraftIdempotently(store, sessionA, 'legacy-call-id', {
      taskDrafts: [{ tag: '', due: null, priority: 'normal', title: 'Legacy task' }],
      note: 'legacy call args', title: 'Legacy saved draft',
    });
    assert.equal(legacyReplay.requirementId, legacy.requirementId);
    assert.equal(legacyReplay.alreadySaved, true);
    const legacyNewCall = await saveRequirementDraftIdempotently(store, sessionA, 'legacy-call-id-2', legacyArgs);
    assert.notEqual(legacyNewCall.requirementId, legacy.requirementId,
      'legacy calls with no entryKey use toolCallId, not equal-content deduplication');
    assert.equal(store.read().tasks.length, 0);

    // A record imported after the original save remains bound to its receipt.
    const importArgs = {
      entryKey: 'draft-that-is-imported', title: 'Import after save', note: 'This draft is imported externally.',
      taskDrafts: [{ title: 'Imported once' }],
    };
    const importedSave = await saveRequirementDraftIdempotently(store, sessionA, 'import-save-call', importArgs);
    const importReceiptSnapshot = recordSnapshot(importedSave);
    const manualRevision = store.updateRecord('requirements', importedSave.requirementId, {
      title: 'Manually updated before import',
      note: 'A later explicit edit must not be overwritten by replay.',
      taskDrafts: [{ title: 'Manually revised todo', priority: 'high', due: null, tag: 'manual' }],
    });
    const manualVersion = getRequirementVersion(store, importedSave.requirementId);
    assert.ok(manualVersion !== importReceiptSnapshot.requirementVersion);
    const tasksBeforeManualReplay = store.listRecords('tasks').length;
    const manualReplay = await saveRequirementDraftIdempotently(store, sessionA, 'import-save-after-manual-edit', importArgs);
    assert.equal(manualReplay.alreadySaved, true);
    assert.deepEqual(recordSnapshot(manualReplay), importReceiptSnapshot,
      'a replay returns the original receipt snapshot marked as already saved');
    const currentAfterManualReplay = store.listRecords('requirements').find(row => row.id === importedSave.requirementId)!;
    assert.equal(currentAfterManualReplay.updatedAt, manualRevision.updatedAt);
    assert.equal(currentAfterManualReplay.title, manualRevision.title);
    assert.deepEqual(currentAfterManualReplay.taskDrafts, manualRevision.taskDrafts,
      'replaying an old receipt must not overwrite a later manual edit');
    assert.equal(store.listRecords('tasks').length, tasksBeforeManualReplay);
    const importedRecord = store.listRecords('requirements').find(row => row.id === importedSave.requirementId)!;
    importRequirementTasks(store, importedSave.requirementId, {
      expectedUpdatedAt: importedRecord.updatedAt,
      tasks: importedRecord.taskDrafts,
    });
    const tasksAfterImport = store.listRecords('tasks');
    const requirementsBeforeImportedReplay = store.listRecords('requirements').length;
    const importedReplay = await saveRequirementDraftIdempotently(store, sessionA, 'import-save-retry', importArgs);
    assert.equal(importedReplay.requirementId, importedSave.requirementId);
    assert.equal(importedReplay.alreadySaved, true);
    assert.deepEqual(recordSnapshot(importedReplay), importReceiptSnapshot,
      'importing later does not rewrite the original receipt snapshot');
    assert.equal(store.listRecords('requirements').length, requirementsBeforeImportedReplay,
      'an imported receipt retry must not create a replacement draft');
    assert.equal(store.listRecords('tasks').length, tasksAfterImport.length,
      'an imported receipt retry must not bypass the import guard or duplicate todos');
    assert.ok(store.listRecords('requirements').find(row => row.id === importedSave.requirementId)?.importedAt);
    assert.equal(store.listRecords('requirements').find(row => row.id === importedSave.requirementId)?.title,
      manualRevision.title, 'receipt replay cannot roll an imported record back to its old title');

    // A deleted receipt target is a tombstone, never permission to recreate a draft.
    const deletedArgs = {
      entryKey: 'draft-that-is-deleted', title: 'Delete after save', taskDrafts: [{ title: 'Must not reappear' }],
    };
    const deletedSave = await saveRequirementDraftIdempotently(store, sessionA, 'delete-save-call', deletedArgs);
    const beforeDelete = store.listRecords('requirements').length;
    assert.equal(store.removeRecord('requirements', deletedSave.requirementId), true);
    const afterDelete = store.listRecords('requirements').length;
    assert.equal(afterDelete, beforeDelete - 1);
    let deletedReplay: Awaited<ReturnType<typeof saveRequirementDraftIdempotently>> | undefined;
    try {
      deletedReplay = await saveRequirementDraftIdempotently(store, sessionA, 'delete-save-retry', deletedArgs);
    } catch (error) {
      assert.ok(error instanceof WorkbenchInputError && [404, 409].includes(error.status),
        'a deleted receipt target may be refused as missing or as a conflict');
    }
    if (deletedReplay) assert.equal(deletedReplay.requirementId, deletedSave.requirementId);
    assert.equal(store.listRecords('requirements').length, afterDelete, 'retry after deletion must not create a replacement');
    assert.equal(store.listRecords('requirements').some(row => row.id === deletedSave.requirementId), false);

    // Reopen the SQLite file and verify the receipt still resolves to the same version.
    const beforeCloseReplay = await saveRequirementDraftIdempotently(store, sessionA, 'persistent-save-call', {
      entryKey: 'persistent-key', title: 'Persistent draft', taskDrafts: [{ title: 'Persistent task' }],
    });
    const beforeClose = recordSnapshot(beforeCloseReplay);
    store.close();
    store = new WorkbenchStore(dbPath);
    const afterReopen = await saveRequirementDraftIdempotently(store, sessionA, 'persistent-reopen-call', {
      entryKey: 'persistent-key', title: 'Persistent draft', taskDrafts: [{ title: 'Persistent task' }],
    });
    assert.equal(afterReopen.alreadySaved, true);
    assert.deepEqual(recordSnapshot(afterReopen), beforeClose);
    assert.equal(store.read().tasks.length, tasksAfterImport.length);

    // The receipt and draft are one transaction: a receipt insert fault cannot
    // leave a draft without its retry record.
    const trigger = 'fixture_fail_requirement_draft_receipt_call';
    store.sqlite.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON requirements_draft_save_calls
      BEGIN SELECT RAISE(ABORT, 'fixture receipt write failed'); END;`);
    const beforeFailedReceipt = store.listRecords('requirements').length;
    const failingArgs = {
      entryKey: 'rollback-entry-key', title: 'Rollback both writes', taskDrafts: [{ title: 'Rollback task' }],
    };
    assert.throws(() => saveRequirementDraftIdempotently(store, 'rollback-session', 'rollback-call', failingArgs),
      /fixture receipt write failed/);
    assert.equal(store.listRecords('requirements').length, beforeFailedReceipt,
      'receipt write failure must roll back the new requirement');
    assert.equal(store.read().tasks.length, tasksAfterImport.length);
    store.sqlite.exec(`DROP TRIGGER ${trigger}`);
    const recovered = await saveRequirementDraftIdempotently(store, 'rollback-session', 'rollback-call', failingArgs);
    assert.ok(recovered.requirementId, 'the same call can succeed after the transaction rollback');

    // A deterministic scripted model drives two actual SDK tool calls with
    // different call IDs but the same stable entryKey. This tests tool assembly,
    // SDK execution and persistence; it does not claim to verify model policy.
    const profiles = await loadAgentProfiles(configRoot);
    const loaded = profiles.get('requirements');
    assert.ok(loaded?.ok);
    const profile: ResolvedAgentProfile = structuredClone(loaded.profile);
    profile.config.workspace = await realpath(join(workspaceRoot, 'requirements'));
    profile.effectiveWorkspace = profile.config.workspace;
    profile.profileRevision = profileRevision(profile);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const model = runtime.getModels('deepseek')[0];
    assert.ok(model);
    runtime.hasConfiguredAuth = () => true;
    runtime.streamSimple = () => { throw new Error('network is disabled in draft idempotency fixture'); };
    host = new PiHost({
      definitions: { read: async () => ({ schemaVersion: 1, revision: 1, path: join(root, 'definitions.json'), agents: [] }) },
      modelRuntimeFactory: async () => runtime,
      settingsManagerFactory: () => SettingsManager.inMemory({}, { projectTrusted: false }),
      sessionDir,
    });
    const sessionIdempotentModule = await assembleModuleAgent({
      store, workspaceKey: 'draft-idempotency-sdk', agentId: 'requirements', profile,
    });
    const hosted = await host.create({ provider: model.provider, model: model.id, moduleAgent: sessionIdempotentModule });
    const beforeSdkRequirements = store.listRecords('requirements').length;
    const beforeSdkTasks = store.listRecords('tasks').length;
    const sdkArgs = {
      entryKey: 'real-sdk-stable-entry',
      title: 'SDK saved once', note: 'Two tool calls share one stable save key.',
      taskDrafts: [{ title: 'SDK task' }],
    };
    const steps: Array<{ kind: 'tool'; id: string; name: string; args: Record<string, unknown> } | { kind: 'text'; text: string }> = [
      { kind: 'tool', id: 'sdk-save-first-call', name: 'requirements_save_draft', args: sdkArgs },
      { kind: 'tool', id: 'sdk-save-retry-call', name: 'requirements_save_draft', args: sdkArgs },
      { kind: 'text', text: 'scripted fixture finished the retry sequence' },
    ];
    const agent = hosted.session.agent as any;
    const sdkModel = agent.state.model;
    const savedStream = agent.streamFunction;
    const savedKey = agent.getApiKey;
    const savedFinish = agent.finishTurn;
    let turn = 0;
    const toolResults: Array<{ id: string; error: boolean; data?: any }> = [];
    const unsubscribe = agent.subscribe((event: any) => {
      if (event.type !== 'tool_execution_end' || event.toolName !== 'requirements_save_draft') return;
      toolResults.push({
        id: event.toolCallId,
        error: event.isError,
        data: event.result?.details?.data,
      });
    });
    agent.getApiKey = () => 'requirements-draft-sdk-no-provider';
    agent.streamFunction = (() => {
      const step = steps[turn++];
      assert.ok(step, 'scripted SDK model must not request an unexpected turn');
      const content: AssistantMessage['content'] = step.kind === 'tool'
        ? [{ type: 'toolCall', id: step.id, name: step.name, arguments: step.args }]
        : [{ type: 'text', text: step.text }];
      const message: AssistantMessage = {
        role: 'assistant', content, api: sdkModel.api, provider: sdkModel.provider, model: sdkModel.id,
        stopReason: step.kind === 'tool' ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      stream.end(message);
      return stream;
    }) as typeof agent.streamFunction;
    agent.finishTurn = (completed: { message: { stopReason: string } }) => {
      if (completed.message.stopReason === 'error' || completed.message.stopReason === 'aborted') return undefined;
      if (turn >= steps.length && completed.message.stopReason !== 'toolUse') return { action: 'end' };
      return undefined;
    };
    try {
      await agent.prompt('请保存这个需求；若第一次工具结果不确定就用同一个 entryKey 重试。');
    } finally {
      agent.streamFunction = savedStream;
      agent.getApiKey = savedKey;
      agent.finishTurn = savedFinish;
      unsubscribe();
    }
    assert.equal(turn, steps.length);
    assert.deepEqual(toolResults.map(item => item.id), ['sdk-save-first-call', 'sdk-save-retry-call']);
    assert.ok(toolResults.every(item => item.error === false));
    assert.equal(toolResults[0]?.data?.requirementId, toolResults[1]?.data?.requirementId);
    assert.equal(toolResults[1]?.data?.alreadySaved, true);
    assert.equal(store.listRecords('requirements').length, beforeSdkRequirements + 1);
    assert.equal(store.listRecords('tasks').length, beforeSdkTasks,
      'replayed SDK save calls create a single draft and no todo rows');
    await host.kill(hosted.id);

    console.log('PASS requirements draft idempotency: normalized stable-key replay, session/tool-call scope, imported/deleted guard, durable receipts, atomic rollback, scripted real SDK retry');
  } finally {
    if (host) await host.disposeAll();
    store.close();
    for (const [key, value] of Object.entries({
      PI_CODING_AGENT_DIR: oldEnv.agentDir,
      PI_WEBX_AGENT_CONFIG_DIR: oldEnv.configRoot,
      PI_WEBX_AGENT_WORKSPACE_ROOT: oldEnv.workspaceRoot,
      PI_WEBX_HOME: oldEnv.webHome,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();
