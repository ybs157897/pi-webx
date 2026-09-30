import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore } from '../server/workbench/store';
import { saveRequirementDraft } from '../server/modules/requirements/import-tasks';
import { dispatchRequirementTasks } from '../server/modules/requirements/dispatch';
import { getChatroomService } from '../server/modules/chatroom/service';
import { coordinateAssistantTasks } from '../server/modules/assistant/coordination';

const root = await mkdtemp(join(tmpdir(), 'pi-webx-room-coordinate-'));
const store = new WorkbenchStore(join(root, 'workbench.sqlite'));
const room = getChatroomService(store, 'default');
try {
  const user = room.ensureUserSession();
  const request = {
    entryKey: 'prepare', title: '聊天室交接验收', note: '交付可运行代码，并给出验证证据', priority: 'normal',
    taskDrafts: [{ title: '实现列表' }, { title: '实现筛选' }, { title: '补充文案' }],
  };
  const initial = room.sendUser(user, { body: '@需求管理 请整理需求并交给开发实施。', entryKey: 'handoff' });
  assert.throws(() => dispatchRequirementTasks(store, room, 'unbound', request), /只能由群里/);
  let development: ReturnType<typeof room.send>;
  await room.withDelivery('requirements-import', room.storage.claim(initial.id)!, 'requirements', async () => {
    const imported = dispatchRequirementTasks(store, room, 'requirements-import', request);
    assert.equal(imported.tasks.length, 3);
    assert.equal(store.listRecords('tasks').length, 3);
    assert.equal(dispatchRequirementTasks(store, room, 'requirements-import', request).alreadyDispatched, true);
    assert.equal(store.listRecords('requirements').length, 1);
    assert.throws(() => dispatchRequirementTasks(store, room, 'requirements-import', { ...request, title: '不同的需求' }), /entryKey/);
    assert.throws(() => coordinateAssistantTasks(store, room, 'requirements-import', { action: 'complete_tasks', taskIds: [imported.tasks[0]!.id], evidence: '不是助理会话' }), /只能在助理/);
    development = room.send('requirements', 'requirements-import', { body: '@代码开发 待办已创建，请按需求实现并回报验证。', entryKey: 'dispatch' });
  });
  const tasks = store.listRecords('tasks');
  assert.deepEqual(development!.context.taskIds, tasks.map(task => task.id));
  let report: ReturnType<typeof room.send>;
  let progress: ReturnType<typeof room.send>;
  await room.withDelivery('codes-work', room.storage.claim(development!.id)!, 'codes', async () => {
    progress = room.send('codes', 'codes-work', { to: 'assistant', body: '仍在处理中', entryKey: 'progress' });
    report = room.send('codes', 'codes-work', { to: 'assistant', body: '已实现列表和筛选，隔离测试通过。', entryKey: 'report', taskIds: tasks.map(task => task.id) });
  });
  assert.throws(() => room.send('codes', 'codes-work', { to: 'assistant', body: '迟到消息', entryKey: 'late' }), /结束|关闭|失效|撤销|投递/);
  await room.withDelivery('assistant-progress', room.storage.claim(progress!.id)!, 'assistant', async () => {
    assert.throws(() => coordinateAssistantTasks(store, room, 'assistant-progress', { action: 'complete_tasks', taskIds: [tasks[0]!.id], evidence: '只有进度没有完成 ID' }), /交接之外|完成/);
  });
  const unrelated = store.addRecord('tasks', { title: '无关事项' });
  await room.withDelivery('assistant-complete', room.storage.claim(report!.id)!, 'assistant', async () => {
    assert.throws(() => coordinateAssistantTasks(store, room, 'assistant-complete', { action: 'complete_tasks', taskIds: [unrelated.id], evidence: '尝试越权' }), /交接之外/);
    // A user edit during development must reject the entire completion batch.
    store.updateRecord('tasks', tasks[1]!.id, { title: '用户修改了筛选范围' });
    assert.throws(() => coordinateAssistantTasks(store, room, 'assistant-complete', { action: 'complete_tasks', taskIds: tasks.map(task => task.id), evidence: '旧版本结果' }), /已更新/);
    assert.equal(store.listRecords('tasks').find(task => task.id === tasks[0]!.id)?.done, false);
    const completed = coordinateAssistantTasks(store, room, 'assistant-complete', { action: 'complete_tasks', taskIds: [tasks[0]!.id], evidence: '列表文件已经实现，fixture读取断言通过' });
    assert.equal(completed.tasks[0]!.done, true);
    const repeated = coordinateAssistantTasks(store, room, 'assistant-complete', { action: 'complete_tasks', taskIds: [tasks[0]!.id], evidence: '重复确认' });
    assert.equal(repeated.tasks[0]!.updatedAt, completed.tasks[0]!.updatedAt);
    const second = coordinateAssistantTasks(store, room, 'assistant-complete', { action: 'complete_tasks', taskIds: [tasks[2]!.id], evidence: '文案亦已完成' });
    assert.equal(second.tasks[0]!.done, true, '逐项完成不会丢失剩余关联权限');
  });
  assert.equal(room.getDelivery('assistant-complete'), undefined);
  assert.equal(store.listRecords('tasks').find(task => task.id === unrelated.id)?.done, false);
  assert.equal(store.listRecords('tasks').find(task => task.id === tasks[1]!.id)?.done, false);
  assert.ok(tasks.every(task => task.plannedDate === null && task.due === null), '交接不隐式排期');
  // A draft produced in the module UI is delegated to an isolated room session without duplicating it.
  const original = saveRequirementDraft(store, 'requirements-page', {
    title: '既有需求', note: '页面已讨论清楚', taskDrafts: [{ title: '既有事项' }],
  });
  const delegated = room.send('requirements', 'requirements-page', {
    body: '@需求管理 请把页面讨论的需求加入待办并交给研发。', entryKey: 'existing',
    requirementId: original.id, expectedUpdatedAt: String(original.updatedAt),
  });
  const beforeDelegated = store.listRecords('requirements').length;
  await room.withDelivery('requirements-delegated', room.storage.claim(delegated.id)!, 'requirements', async () => {
    const result = dispatchRequirementTasks(store, room, 'requirements-delegated', {
      entryKey: 'existing', id: original.id, title: '既有需求', note: '页面已讨论清楚，验收为完成既有事项', taskDrafts: [{ title: '既有事项' }],
    });
    assert.equal(result.requirement.id, original.id);
    assert.equal(result.requirement.sourceSessionId, 'requirements-page');
    assert.equal(store.listRecords('requirements').length, beforeDelegated, '复用原需求，不重复创建');
    assert.equal(room.getDelivery('requirements-delegated')?.context.expectedUpdatedAt, result.requirement.updatedAt);
  });
  const anotherRequest = room.sendUser(user, { body: '@需求管理 再做另一个新需求', entryKey: 'another', replyTo: delegated.id });
  await room.withDelivery('requirements-another', room.storage.claim(anotherRequest.id)!, 'requirements', async () => {
    const result = dispatchRequirementTasks(store, room, 'requirements-another', {
      entryKey: 'another', title: '另一个新需求', note: '独立事项，不能覆盖之前的需求', taskDrafts: [{ title: '另一个事项' }],
    });
    assert.notEqual(result.requirement.id, original.id, '回复旧话题也能创建独立新需求');
    assert.equal(store.listRecords('requirements').find(row => row.id === original.id)?.title, '既有需求');
  });
  const stale = saveRequirementDraft(store, 'requirements-page', {
    title: '过期需求', note: '原范围', taskDrafts: [{ title: '原事项' }],
  });
  const staleMessage = room.send('requirements', 'requirements-page', {
    body: '@需求管理 请开工。', entryKey: 'stale', requirementId: stale.id, expectedUpdatedAt: String(stale.updatedAt),
  });
  store.updateRecord('requirements', stale.id, { note: '用户已改范围' });
  await room.withDelivery('requirements-stale', room.storage.claim(staleMessage.id)!, 'requirements', async () => {
    assert.throws(() => dispatchRequirementTasks(store, room, 'requirements-stale', {
      ...request, entryKey: 'stale', id: stale.id, title: '过期需求',
    }), /交接后已修改/);
  });
  const rollbackMessage = room.sendUser(user, { body: '@需求管理 回滚检查', entryKey: 'rollback' });
  const beforeRollback = store.listRecords('requirements').length;
  const beforeRollbackTasks = store.listRecords('tasks').length;
  store.sqlite.exec("CREATE TRIGGER fail_chatroom_task BEFORE INSERT ON workbench_records WHEN NEW.module = 'tasks' BEGIN SELECT RAISE(ABORT, 'fixture task failure'); END;");
  await room.withDelivery('requirements-rollback', room.storage.claim(rollbackMessage.id)!, 'requirements', async () => {
    assert.throws(() => dispatchRequirementTasks(store, room, 'requirements-rollback', { ...request, entryKey: 'rollback' }), /fixture task failure/);
    assert.deepEqual(room.getDelivery('requirements-rollback')?.context, {});
  });
  store.sqlite.exec('DROP TRIGGER fail_chatroom_task');
  assert.equal(store.listRecords('requirements').length, beforeRollback);
  assert.equal(store.listRecords('tasks').length, beforeRollbackTasks);
  console.log('PASS 聊天室待办交接：需求直接建待办、草稿复用、幂等、研发回报、部分完成、版本冲突与原子回滚');
} finally {
  await room.stop();
  store.close();
  await rm(root, { recursive: true, force: true });
}
