import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { validateFields } from '../../workbench/schema.mjs';
import { normalizeTaskDrafts } from './schema.mjs';

type RecordRow = Record<string, unknown> & { id: string };
export type RequirementTaskDraft = { title: string; priority: 'low' | 'normal' | 'high'; due: string | null; tag: string };
export type ImportTasksResult = { requirement: RecordRow; tasks: RecordRow[]; alreadyImported: boolean };
export type NormalizedRequirementDraftInput = { params: Record<string, unknown>; fingerprint: Record<string, unknown> };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function drafts(value: unknown): RequirementTaskDraft[] {
  try {
    return normalizeTaskDrafts(value) as RequirementTaskDraft[];
  } catch (error) {
    throw new WorkbenchInputError(error instanceof Error ? error.message : '待办草稿不合法');
  }
}

/** Canonical save fields for an idempotency receipt; entry keys stay outside the record schema. */
export function normalizeRequirementDraftForIdempotency(
  sourceSessionId: string,
  raw: unknown,
): NormalizedRequirementDraftInput {
  if (!sourceSessionId) throw new WorkbenchInputError('需求会话身份缺失');
  if (!object(raw)) throw new WorkbenchInputError('需求草稿需要是对象');
  const { id, title, note, priority, taskDrafts } = raw;
  if (id !== undefined && (typeof id !== 'string' || id === '')) throw new WorkbenchInputError('需求 ID 不合法');
  if (id === undefined && drafts(taskDrafts).length === 0) throw new WorkbenchInputError('请至少拆出一条待办草稿');

  let normalized: Record<string, unknown>;
  try {
    normalized = validateFields('requirements', { title, note, priority, taskDrafts, sourceSessionId },
      id === undefined ? undefined : { partial: true });
  } catch (error) {
    throw new WorkbenchInputError(error instanceof Error ? error.message : String(error));
  }
  const params: Record<string, unknown> = {};
  if (id !== undefined) params.id = id;
  for (const key of ['title', 'note', 'priority', 'taskDrafts']) {
    if (Object.hasOwn(normalized, key)) params[key] = normalized[key];
  }
  return {
    params,
    fingerprint: { operation: id === undefined ? 'create' : 'update', params },
  };
}

function requirement(store: WorkbenchStore, id: string): RecordRow {
  const row = store.sqlite.prepare("SELECT payload FROM workbench_records WHERE module = 'requirements' AND id = ?")
    .get(id) as { payload: string } | undefined;
  if (!row) throw new WorkbenchInputError('需求不存在', 404);
  return JSON.parse(row.payload) as RecordRow;
}

function linkedTasks(store: WorkbenchStore, id: string): RecordRow[] {
  return store.listRecords('tasks').filter(task => Array.isArray(task.refs) && task.refs.some(ref =>
    object(ref) && ref.type === 'requirements' && ref.id === id));
}

/** Agent 只保存可审阅草稿；来源会话由服务端 SDK 上下文提供。 */
export function saveRequirementDraft(store: WorkbenchStore, sourceSessionId: string, raw: unknown): RecordRow {
  if (!sourceSessionId) throw new WorkbenchInputError('需求会话身份缺失');
  if (!object(raw)) throw new WorkbenchInputError('需求草稿需要是对象');
  const { id, title, note, priority, taskDrafts } = raw;
  const fields = { title, note, priority, taskDrafts, sourceSessionId };
  if (id === undefined) {
    if (drafts(taskDrafts).length === 0) throw new WorkbenchInputError('请至少拆出一条待办草稿');
    return store.addRecord('requirements', fields);
  }
  if (typeof id !== 'string' || id === '') throw new WorkbenchInputError('需求 ID 不合法');
  const previous = requirement(store, id);
  if (previous.sourceSessionId !== sourceSessionId) throw new WorkbenchInputError('只能修订本会话的需求草稿', 403);
  if (previous.importedAt) throw new WorkbenchInputError('已导入的需求不能由 Agent 重写草稿', 409);
  return store.updateRecord('requirements', id, fields);
}

/** 显式确认后整批导入，任务与需求的导入标记在同一 SQLite 事务内提交。 */
export function importRequirementTasks(store: WorkbenchStore, id: string, raw: unknown): ImportTasksResult {
  if (!object(raw) || Object.keys(raw).some(key => key !== 'expectedUpdatedAt' && key !== 'tasks')) {
    throw new WorkbenchInputError('导入请求字段不合法');
  }
  if (typeof raw.expectedUpdatedAt !== 'string' || raw.expectedUpdatedAt === '') {
    throw new WorkbenchInputError('导入需要预览时的 updatedAt');
  }
  const requestedTasks = raw.tasks === undefined ? undefined : drafts(raw.tasks);
  return store.sqlite.transaction(() => {
    const current = requirement(store, id);
    if (current.importedAt) {
      const savedDrafts = drafts(current.taskDrafts ?? []);
      if (requestedTasks && JSON.stringify(requestedTasks) !== JSON.stringify(savedDrafts)) {
        throw new WorkbenchInputError('需求已导入，不能用不同待办重复导入', 409);
      }
      const ids = Array.isArray(current.importedTaskIds) ? current.importedTaskIds : [];
      const existing = new Map(store.listRecords('tasks').map(task => [task.id, task]));
      return {
        requirement: current,
        tasks: ids.map(taskId => existing.get(taskId)).filter((task): task is RecordRow => task !== undefined),
        alreadyImported: true,
      };
    }
    if (current.updatedAt !== raw.expectedUpdatedAt) {
      throw new WorkbenchInputError('需求已更新，请重新预览再导入', 409);
    }
    if (linkedTasks(store, id).length > 0) {
      throw new WorkbenchInputError('需求已有待办关联，请先检查现有待办', 409);
    }
    const selected = requestedTasks ?? drafts(current.taskDrafts ?? []);
    if (selected.length === 0) throw new WorkbenchInputError('请先选择至少一条待办草稿');
    const created = selected.map(draft => {
      const clean = validateFields('tasks', draft);
      return store.addRecord('tasks', { ...clean, refs: [{ type: 'requirements', id }] });
    });
    const now = new Date().toISOString();
    const previous = Date.parse(String(current.updatedAt ?? ''));
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    const imported: RecordRow = {
      ...current,
      taskDrafts: selected,
      importedAt: now,
      importedTaskIds: created.map(task => task.id),
      updatedAt,
    };
    store.sqlite.prepare("UPDATE workbench_records SET payload = ? WHERE module = 'requirements' AND id = ?")
      .run(JSON.stringify(imported), id);
    return { requirement: imported, tasks: created, alreadyImported: false };
  })();
}
