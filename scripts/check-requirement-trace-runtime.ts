/** Real offline Pi SDK requirement trace, reviewed delivery and recovery acceptance. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { contextFor } from '../server/modules/chatroom/service-context';
import { getRequirementVersion, readRequirementTrace, reviewRequirementDelivery,
  submitRequirementDelivery } from '../server/modules/requirements/lifecycle';
import { saveRequirementDraft } from '../server/modules/requirements/import-tasks';
import { within } from './subagent-check-fixtures';
import { createRequirementTraceFixture } from './requirement-trace-fixture';

const fixture = await createRequirementTraceFixture();
try {
  const { requirementId, requirementVersion, roomTaskId, requestMessageId, requestThreadId,
    codeRunId, writeToolCallId, deliveryId, deliveryUpdatedAt, userSessionKey } = fixture;
  const requirement = fixture.store.listRecords('requirements').find(item => item.id === requirementId)!;
  const request = fixture.chatroom.storage.byId(requestMessageId)!;
  assert.equal(request.context.requirementId, requirementId);
  assert.equal(request.context.requirementVersion, requirementVersion);
  assert.equal(request.inputRequirementVersion, null,
    '需求生成前的用户输入保留未知版本，不伪造后来的修订');
  const messages = fixture.chatroom.read({ limit: 100 }).messages;
  const codeHandoff = messages.find(item => item.recipientId === 'codes');
  const assistantHandoff = messages.find(item => item.recipientId === 'assistant');
  assert.ok(codeHandoff && assistantHandoff);
  assert.ok(fixture.store.listRecords('tasks').every(item => item.done === true));
  assert.equal(await readFile(join(fixture.codeDir, 'result.txt'), 'utf8'), 'trace fixture verified\n');

  const trace = readRequirementTrace(fixture.store, requirementId);
  assert.equal(trace.requirementVersion, requirementVersion);
  assert.ok(trace.links.messages.some(item => item.id === requestMessageId && item.requirementVersion === null));
  assert.ok(trace.links.collaborationTasks.some(item => item.id === roomTaskId && item.requirementVersion === null));
  const originalMessageLink = fixture.store.sqlite.prepare(`SELECT occurred_at FROM requirement_lifecycle_links
    WHERE requirement_id = ? AND kind = 'chatroom_message' AND entity_id = ?`)
    .get(requirementId, requestMessageId) as { occurred_at: string };
  assert.equal(originalMessageLink.occurred_at, request.createdAt,
    '延后绑定需求根时保留原始消息时间');
  assert.ok(['requirements', 'codes', 'assistant'].every(agent =>
    trace.links.assignments.some(item => item.agentId === agent)));
  const codeRun = trace.links.runs.find(item => item.id === codeRunId);
  assert.ok(codeRun);
  assert.equal(codeRun.requirementVersion, requirementVersion);
  const write = trace.links.tools.find(item => item.runId === codeRunId && item.toolCallId === writeToolCallId);
  assert.ok(write);
  assert.equal(write.status, 'succeeded');
  assert.match(String(write.resultHash), /^[a-f0-9]{64}$/);
  assert.ok(Number(write.resultBytes) > 0);
  assert.equal(write.exitCode, null);
  const verification = trace.links.tools.find(item => item.runId === codeRunId && item.toolCallId === 'bash-verify');
  assert.ok(verification);
  assert.equal(verification.status, 'succeeded');
  assert.equal(verification.exitCode, 0);
  assert.ok(!JSON.stringify(trace).includes('trace fixture verified'),
    '公开追溯不保存工具原始内容或参数');
  const handoffs = fixture.store.sqlite.prepare(`SELECT entity_id FROM requirement_lifecycle_links
    WHERE requirement_id = ? AND kind = 'chatroom_handoff'`).all(requirementId) as Array<{ entity_id: string }>;
  assert.ok(handoffs.some(item => item.entity_id === codeHandoff.id));
  assert.ok(handoffs.some(item => item.entity_id === assistantHandoff.id));
  assert.ok(trace.links.runs.some(item => item.agentId === 'requirements' && item.requirementVersion === null));
  assert.ok(trace.events.some(item => item.type === 'chatroom_tool_finished' && item.refs.toolCallId === writeToolCallId));
  const submitted = trace.deliveries.find(item => item.id === deliveryId)!;
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.evidence[0]?.verification, 'observed');
  assert.equal(trace.acceptanceReady, true, trace.blockers.join('; '));

  const accepted = reviewRequirementDelivery(fixture.store, requirementId, deliveryId, {
    decision: 'accept', expectedUpdatedAt: deliveryUpdatedAt, entryKey: 'human-accept',
  });
  assert.equal(accepted.delivery.status, 'accepted');
  assert.equal(accepted.trace.stage, 'delivered');

  fixture.setPhase('cancel');
  const personalProfile = fixture.profiles.get('requirements');
  assert.ok(personalProfile?.ok);
  const personal = await fixture.sessionService.openOrCreate('requirements', personalProfile.profile);
  const secondRequirement = saveRequirementDraft(fixture.store, personal.id, {
    title: '取消与错误追溯验收', note: '独立根：验证取消、失败和旧修订拦截事件。',
    priority: 'normal', taskDrafts: [{ title: '核对独立根日志', priority: 'normal' }],
  });
  const secondRootId = secondRequirement.id;
  const secondVersion = getRequirementVersion(fixture.store, secondRootId)!;
  const cancelMessage = fixture.chatroom.send('requirements', personal.id, {
    to: 'codes', body: '@代码开发 接手一项可取消的独立需求。',
    entryKey: 'trace-cancel-task', requirementId: secondRootId,
    requirementVersion: secondVersion,
    expectedUpdatedAt: secondRequirement.updatedAt,
  });
  await fixture.host.kill(personal.id);
  await within(fixture.chatroom.drain(), 5000);
  assert.equal(fixture.chatroom.storage.byId(cancelMessage.id)?.deliveryStatus, 'delivered');
  const cancellationTask = fixture.chatroom.work.publicTasks().find(item => item.title === '验证取消事件留存');
  assert.ok(cancellationTask);
  fixture.setPhase('branch');
  const branchInput = fixture.chatroom.sendUser(userSessionKey, {
    body: '@需求管理 当前话题另建独立新需求，不改旧任务。',
    entryKey: 'branch-input', replyTo: cancelMessage.id,
  });
  await within(fixture.chatroom.drain(), 10000);
  const branchRequirement = fixture.store.listRecords('requirements').find(item =>
    item.id !== requirementId && item.id !== secondRootId);
  assert.ok(branchRequirement);
  const branchRootId = branchRequirement.id;
  const branchMessage = fixture.chatroom.storage.byId(branchInput.id)!;
  assert.equal(branchMessage.inputRequirementId, secondRootId,
    '分叉入口原始输入根不可被改写');
  assert.equal(branchMessage.context.requirementId, branchRootId,
    '同一话题后续交接使用新根');
  assert.equal(fixture.chatroom.work.publicTask(cancellationTask.id)?.status, 'running',
    '分叉不自动结束或改写旧任务');
  const oldTrace = readRequirementTrace(fixture.store, secondRootId);
  const branchTrace = readRequirementTrace(fixture.store, branchRootId);
  const originRun = oldTrace.links.runs.find(item => item.messageId === branchInput.id);
  assert.ok(originRun);
  assert.equal(originRun.requirementVersion, secondVersion);
  assert.ok(!branchTrace.links.runs.some(item => item.id === originRun.id));
  assert.ok(oldTrace.links.messages.some(item => item.id === branchInput.id));
  assert.ok(!branchTrace.links.messages.some(item => item.id === branchInput.id));
  assert.ok(branchTrace.events.some(item => item.type === 'chatroom_requirement_branch'
    && item.refs.fromRequirementId === secondRootId && item.refs.originatingRunId === originRun.id));
  const branchRun = branchTrace.links.runs.find(item => item.agentId === 'codes' && item.status === 'succeeded');
  assert.ok(branchRun);
  assert.equal(branchRun.requirementVersion, getRequirementVersion(fixture.store, branchRootId));
  assert.ok(!oldTrace.links.runs.some(item => item.id === branchRun.id));
  const branchHandoff = fixture.store.sqlite.prepare(`SELECT refs FROM requirement_lifecycle_links
    WHERE requirement_id = ? AND kind = 'chatroom_handoff'`)
    .get(branchRootId) as { refs: string } | undefined;
  assert.ok(branchHandoff);
  assert.equal(JSON.parse(branchHandoff.refs).parentRunId, originRun.id,
    '跨根交接保留旧根父 Run 引用，新消息归新根');
  assert.equal(await readFile(join(fixture.codeDir, 'branch-result.txt'), 'utf8'), 'independent root\n');
  await fixture.chatroom.taskAction(userSessionKey, cancellationTask.id, {
    action: 'cancel', entryKey: 'trace-cancel', expectedVersion: fixture.chatroom.work.publicTask(cancellationTask.id)!.version,
  });
  const cancelled = readRequirementTrace(fixture.store, secondRootId);
  assert.ok(cancelled.events.some(item => item.type === 'chatroom_user_action'
    && item.refs.taskId === cancellationTask.id && item.refs.action === 'cancel'));

  fixture.setPhase('error');
  const errorMessage = fixture.chatroom.sendUser(userSessionKey, {
    body: '@日志查询 查找不存在的验证文件，并如实报告读取失败。',
    entryKey: 'trace-error', replyTo: cancelMessage.id,
  });
  await within(fixture.chatroom.drain(), 5000);
  assert.equal(fixture.chatroom.storage.byId(errorMessage.id)?.deliveryStatus, 'delivered');
  const errored = readRequirementTrace(fixture.store, secondRootId);
  assert.ok(errored.events.some(item => item.type === 'chatroom_tool_finished'
    && item.refs.toolCallId === 'read-missing' && item.refs.status === 'failed'));

  fixture.store.updateRecord('requirements', secondRootId, {
    note: `${String(secondRequirement.note)}\n补充新修订，旧输入不得继续执行。`,
  });
  const revisedVersion = getRequirementVersion(fixture.store, secondRootId)!;
  assert.ok(revisedVersion > secondVersion);
  const staleMessage = fixture.chatroom.sendUser(userSessionKey, {
    body: '@日志查询 按旧消息执行应被修订门禁拒绝。',
    entryKey: 'stale-revision', replyTo: cancelMessage.id,
  });
  await within(fixture.chatroom.drain(), 5000);
  assert.equal(fixture.chatroom.storage.byId(staleMessage.id)?.deliveryStatus, 'failed');
  const versionTrace = readRequirementTrace(fixture.store, secondRootId);
  assert.ok(versionTrace.events.some(item => item.type === 'chatroom_revision_blocked'
    && item.refs.messageId === staleMessage.id && item.refs.currentVersion === revisedVersion));
  const latestSecond = fixture.store.listRecords('requirements').find(item => item.id === secondRootId)!;
  const latestStamp = String(latestSecond.updatedAt);
  fixture.store.sqlite.prepare("UPDATE workbench_records SET payload = ? WHERE module = 'requirements' AND id = ?")
    .run(JSON.stringify({ ...latestSecond, note: '同时间戳的另一版内容' }), secondRootId);
  assert.ok(getRequirementVersion(fixture.store, secondRootId)! > revisedVersion);
  assert.equal(getRequirementVersion(fixture.store, secondRootId, latestStamp), undefined,
    '同一 updatedAt 指向多个内容修订时不可猜版本');
  assert.throws(() => contextFor(fixture.store, 'default', 'requirements', personal.id, {
    to: 'codes', body: '旧时间戳交接', entryKey: 'ambiguous-stamp',
    requirementId: secondRootId, expectedUpdatedAt: latestStamp,
  }), /修订不可验证/, '相同时间戳的旧交接应拒绝而非贴上当前版本');
  const currentNumeric = getRequirementVersion(fixture.store, secondRootId)!;
  const explicitCurrent = contextFor(fixture.store, 'default', 'requirements', personal.id, {
    to: 'codes', body: '显式当前修订交接', entryKey: 'numeric-current',
    requirementId: secondRootId, requirementVersion: currentNumeric, expectedUpdatedAt: latestStamp,
  });
  assert.equal(explicitCurrent.requirementVersion, currentNumeric,
    '相同时间戳下显式可信当前 numeric 修订允许交接');
  assert.throws(() => contextFor(fixture.store, 'default', 'requirements', personal.id, {
    to: 'codes', body: '显式旧修订交接', entryKey: 'numeric-old',
    requirementId: secondRootId, requirementVersion: revisedVersion, expectedUpdatedAt: latestStamp,
  }), /修订不可验证/, '显式旧 numeric 修订也不能冒充当前版本');
  assert.throws(() => contextFor(fixture.store, 'default', 'requirements', personal.id, {
    to: 'codes', body: '改写父消息修订', entryKey: 'numeric-parent',
    requirementVersion: currentNumeric,
  }, fixture.chatroom.storage.byId(cancelMessage.id)!), /继承的需求修订号/,
  '有父消息时不能通过参数改写继承修订');

  const mainEventCount = readRequirementTrace(fixture.store, requirementId).events.length;
  assert.equal(readRequirementTrace(fixture.store, requirementId).stage, 'delivered',
    '独立需求根的取消与失败不改变已接受主链');
  const secondEventCount = readRequirementTrace(fixture.store, secondRootId).events.length;
  const secondHumanId = readRequirementTrace(fixture.store, secondRootId).humanId;
  await fixture.restart();
  const restored = readRequirementTrace(fixture.store, trace.humanId, 'human');
  assert.equal(restored.requirementId, requirementId);
  assert.equal(restored.events.length, mainEventCount);
  assert.equal(restored.deliveries.find(item => item.id === deliveryId)?.status, 'accepted');
  const restoredSecond = readRequirementTrace(fixture.store, secondHumanId, 'human');
  assert.equal(restoredSecond.requirementId, secondRootId);
  assert.equal(restoredSecond.events.length, secondEventCount);
  assert.ok(restoredSecond.events.some(item => item.type === 'chatroom_user_action'
    && item.refs.action === 'cancel'));
  assert.ok(restoredSecond.events.some(item => item.type === 'chatroom_tool_finished'
    && item.refs.toolCallId === 'read-missing' && item.refs.status === 'failed'));
  assert.ok(restoredSecond.events.some(item => item.type === 'chatroom_revision_blocked'
    && item.refs.messageId === staleMessage.id));
  const retried = submitRequirementDelivery(fixture.store, requirementId, {
    entryKey: 'delivery-submit', expectedUpdatedAt: requirement.updatedAt,
    expectedRequirementVersion: requirementVersion,
    summary: '文件与关联待办已完成，见执行证据。',
    evidence: [{ kind: 'file', ref: 'result.txt', runId: codeRunId, toolCallId: writeToolCallId }],
  });
  assert.equal(retried.delivery.id, deliveryId, '重试不会创建第二个交付根');
  assert.equal(readRequirementTrace(fixture.store, requirementId).events.length, mainEventCount);
  console.log('PASS requirement trace runtime: real SDK root propagation, immutable versions, tool facts, handoffs, delivery review and cold retry');
} finally {
  await fixture.close();
}
