import { createHash } from 'node:crypto';
import { validateFields } from '../../workbench/schema.mjs';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { normalizePlanEntries } from './schema.mjs';
import { assertLifeTaskSchedule, assertLifeTaskShape } from './validation';

type Row = Record<string, unknown> & { id: string };
type CaptureEntry = {
  entryKey: string; originalText: string; title: string; due?: string | null;
  priority?: 'low' | 'normal' | 'high'; tag?: string; note?: string; durationMinutes?: number;
};
type PlanEntry = {
  taskId: string; expectedUpdatedAt: string; plannedDate: string;
  startTime: string | null; endTime: string | null; kind?: 'fixed' | 'flexible'; reason?: string;
};

const KEY_RE = /^[\w.:-]{1,80}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localClock(now = new Date()): { iso: string; timeZone: string; localDate: string; localTime: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  return { iso: now.toISOString(), timeZone,
    localDate: `${value('year')}-${value('month')}-${value('day')}`,
    localTime: `${value('hour')}:${value('minute')}` };
}

export function readLifeContext(store: WorkbenchStore, raw: unknown = {}, now = new Date()): {
  now: ReturnType<typeof localClock>; tasks: Row[]; plans: Row[];
  totals: { tasks: number; plans: number }; returned: { tasks: number; plans: number };
  offset: number; hasMore: boolean;
} {
  if (!object(raw) || Object.keys(raw).some(key => !['query', 'limit', 'offset'].includes(key))) {
    throw new WorkbenchInputError('生活上下文查询字段不合法');
  }
  const query = raw.query ?? '';
  const limit = raw.limit ?? 100;
  const offset = raw.offset ?? 0;
  if (typeof query !== 'string' || query.length > 100 || typeof limit !== 'number'
    || !Number.isInteger(limit) || limit < 1 || limit > 200 || typeof offset !== 'number'
    || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new WorkbenchInputError('生活上下文查询参数不合法');
  }
  const match = (row: Row): boolean => `${String(row.title ?? '')} ${String(row.note ?? '')} ${String(row.originalText ?? '')}`
    .toLowerCase().includes(query.trim().toLowerCase());
  const tasks = store.listRecords('tasks').filter(row => row.done !== true && match(row))
    .sort((a, b) => String(a.plannedDate ?? '9999-12-31').localeCompare(String(b.plannedDate ?? '9999-12-31'))
      || String(a.startTime ?? '99:99').localeCompare(String(b.startTime ?? '99:99'))
      || String(a.due ?? '9999-12-31').localeCompare(String(b.due ?? '9999-12-31')));
  const plans = store.listRecords('lifePlans').filter(row => row.appliedAt === null && match(row))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const taskPage = tasks.slice(offset, offset + limit).map(row => ({
    id: row.id, title: row.title, originalText: row.originalText ?? '', note: row.note ?? '',
    due: row.due ?? null, plannedDate: row.plannedDate ?? null,
    startTime: row.startTime ?? null, endTime: row.endTime ?? null,
    kind: row.kind ?? 'flexible', priority: row.priority, tag: row.tag,
    durationMinutes: row.durationMinutes ?? 30, refs: row.refs, updatedAt: row.updatedAt,
  })) as Row[];
  return { now: localClock(now), tasks: taskPage, plans: plans.slice(offset, offset + limit),
    totals: { tasks: tasks.length, plans: plans.length },
    returned: { tasks: taskPage.length, plans: Math.max(0, Math.min(plans.length - offset, limit)) },
    offset, hasMore: tasks.length > offset + limit || plans.length > offset + limit };
}

function normalizeCapture(raw: unknown): CaptureEntry[] {
  if (!object(raw) || Object.keys(raw).some(key => key !== 'entries')
    || !Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > 20) {
    throw new WorkbenchInputError('请提供 1 至 20 条生活事项');
  }
  const keys = new Set<string>();
  return raw.entries.map((entry: unknown) => {
    if (!object(entry) || Object.keys(entry).some(key => !['entryKey', 'originalText', 'title', 'due', 'priority', 'tag', 'note', 'durationMinutes'].includes(key))
      || typeof entry.entryKey !== 'string' || !KEY_RE.test(entry.entryKey) || keys.has(entry.entryKey)
      || typeof entry.originalText !== 'string' || entry.originalText.trim() === '') {
      throw new WorkbenchInputError('事项需要唯一 entryKey、原话和标题');
    }
    keys.add(entry.entryKey);
    const fields = { title: entry.title, originalText: entry.originalText, due: entry.due,
      priority: entry.priority, tag: entry.tag, note: entry.note, durationMinutes: entry.durationMinutes };
    try {
      const clean = validateFields('tasks', fields) as CaptureEntry;
      return { entryKey: entry.entryKey, originalText: clean.originalText,
        title: clean.title, due: clean.due, priority: clean.priority,
        tag: clean.tag, note: clean.note, durationMinutes: clean.durationMinutes };
    } catch (error) {
      throw new WorkbenchInputError(error instanceof Error ? error.message : String(error));
    }
  });
}

/** 同一会话的 entryKey 永远只创建一条任务，整批写入原子化。 */
export function captureLifeTasks(store: WorkbenchStore, sessionId: string, raw: unknown): {
  entries: Array<{ entryKey: string; record: Row; alreadyCaptured: boolean }>;
} {
  if (!sessionId) throw new WorkbenchInputError('生活秘书会话身份缺失');
  const entries = normalizeCapture(raw);
  return store.sqlite.transaction(() => {
    const existing = new Map(store.listRecords('tasks')
      .filter(row => typeof row.captureSessionId === 'string' && typeof row.captureEntryKey === 'string')
      .map(row => [JSON.stringify([row.captureSessionId, row.captureEntryKey]), row]));
    const planned: Array<{ entry: CaptureEntry; record: Row; alreadyCaptured: boolean; fingerprint: string }> = [];
    for (const entry of entries) {
      const fingerprint = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
      const record = existing.get(JSON.stringify([sessionId, entry.entryKey]));
      if (record) {
        if (record.captureFingerprint !== fingerprint) throw new WorkbenchInputError('entryKey 已记录不同事项，请使用新的标识', 409);
        planned.push({ entry, record, alreadyCaptured: true, fingerprint });
      } else {
        // 先校验整批；新增记录只在全部幂等键核对通过后发生。
        planned.push({ entry, record: null as unknown as Row, alreadyCaptured: false, fingerprint });
      }
    }
    for (const item of planned) {
      if (item.alreadyCaptured) continue;
      const { entryKey: _entryKey, ...fields } = item.entry;
      item.record = store.addRecord('tasks', { ...fields, captureSessionId: sessionId,
        captureEntryKey: item.entry.entryKey, captureFingerprint: item.fingerprint });
    }
    return { entries: planned.map(item => ({ entryKey: item.entry.entryKey, record: item.record, alreadyCaptured: item.alreadyCaptured })) };
  })();
}

function nextStamp(previous: unknown): string {
  const parsed = Date.parse(String(previous ?? ''));
  return new Date(Math.max(Date.now(), Number.isFinite(parsed) ? parsed + 1 : 0)).toISOString();
}

function planEntries(raw: unknown): PlanEntry[] {
  try { return normalizePlanEntries(raw) as PlanEntry[]; }
  catch (error) { throw new WorkbenchInputError(error instanceof Error ? error.message : String(error)); }
}

function finalPlanTasks(store: WorkbenchStore, entries: PlanEntry[], checkVersions: boolean): Row[] {
  const existing = store.listRecords('tasks');
  const final = new Map(existing.map(task => [task.id, task]));
  const changed: Row[] = [];
  for (const entry of entries) {
    const previous = final.get(entry.taskId);
    if (!previous) throw new WorkbenchInputError('规划中的待办已删除', 409);
    if (previous.done === true) throw new WorkbenchInputError('已完成待办不能重新安排', 409);
    if (checkVersions && previous.updatedAt !== entry.expectedUpdatedAt) throw new WorkbenchInputError('待办已更新，请重新规划', 409);
    if (previous.kind === 'fixed' && (previous.plannedDate !== entry.plannedDate
      || (previous.startTime ?? null) !== entry.startTime || (previous.endTime ?? null) !== entry.endTime
      || (entry.kind !== undefined && entry.kind !== 'fixed'))) {
      throw new WorkbenchInputError('固定安排不能由建议静默改动，请手动修改', 409);
    }
    const patch = { plannedDate: entry.plannedDate, startTime: entry.startTime, endTime: entry.endTime,
      ...(entry.kind === undefined ? {} : { kind: entry.kind }) };
    let clean: Record<string, unknown>;
    try { clean = validateFields('tasks', patch, { partial: true }); }
    catch (error) { throw new WorkbenchInputError(error instanceof Error ? error.message : String(error)); }
    const record = { ...previous, ...clean };
    final.set(record.id, record);
    changed.push(record);
  }
  for (const task of changed) {
    assertLifeTaskShape(task);
    assertLifeTaskSchedule(task, [...final.values()]);
  }
  return changed;
}

/** Agent 保存可审阅草稿；不会改动任何待办的排期。 */
export function proposeLifePlan(store: WorkbenchStore, sessionId: string, raw: unknown): { plan: Row; alreadyProposed: boolean } {
  if (!sessionId) throw new WorkbenchInputError('生活秘书会话身份缺失');
  if (!object(raw) || Object.keys(raw).some(key => !['planKey', 'note', 'entries'].includes(key))
    || typeof raw.planKey !== 'string' || !KEY_RE.test(raw.planKey)
    || (raw.note !== undefined && typeof raw.note !== 'string')) {
    throw new WorkbenchInputError('生活安排建议字段不合法');
  }
  const entries = planEntries(raw.entries);
  return store.sqlite.transaction(() => {
    const previous = store.listRecords('lifePlans').find(row => row.sourceSessionId === sessionId && row.planKey === raw.planKey);
    if (previous) {
      if (JSON.stringify(previous.entries) !== JSON.stringify(entries) || previous.note !== (raw.note ?? '')) {
        throw new WorkbenchInputError('planKey 已用于不同安排，请使用新的标识', 409);
      }
      return { plan: previous, alreadyProposed: true };
    }
    finalPlanTasks(store, entries, true);
    const plan = store.addRecord('lifePlans', { title: '生活安排建议', sourceSessionId: sessionId,
      planKey: raw.planKey, entries, note: raw.note ?? '', appliedAt: null });
    return { plan, alreadyProposed: false };
  })();
}

/** 只有明确调用确认接口，才会在同一事务内更新全部事项与草稿状态。 */
export function applyLifePlan(store: WorkbenchStore, id: string, raw: unknown = {}): {
  plan: Row; tasks: Row[]; alreadyApplied: boolean;
} {
  if (!object(raw) || Object.keys(raw).some(key => key !== 'expectedUpdatedAt')
    || typeof raw.expectedUpdatedAt !== 'string') throw new WorkbenchInputError('确认需要建议的 updatedAt');
  return store.sqlite.transaction(() => {
    const plan = store.listRecords('lifePlans').find(row => row.id === id);
    if (!plan) throw new WorkbenchInputError('生活安排建议不存在', 404);
    const entries = planEntries(plan.entries);
    if (plan.appliedAt) {
      const byId = new Map(store.listRecords('tasks').map(task => [task.id, task]));
      return { plan, tasks: entries.map(entry => byId.get(entry.taskId)).filter((task): task is Row => task !== undefined), alreadyApplied: true };
    }
    if (plan.updatedAt !== raw.expectedUpdatedAt) throw new WorkbenchInputError('安排建议已更新，请重新预览', 409);
    const changed = finalPlanTasks(store, entries, true);
    const update = store.sqlite.prepare("UPDATE workbench_records SET payload = ? WHERE module = 'tasks' AND id = ?");
    const saved = changed.map(task => ({ ...task, updatedAt: nextStamp(task.updatedAt) }));
    for (const task of saved) update.run(JSON.stringify(task), task.id);
    const applied = { ...plan, appliedAt: new Date().toISOString(), updatedAt: nextStamp(plan.updatedAt) };
    store.sqlite.prepare("UPDATE workbench_records SET payload = ? WHERE module = 'lifePlans' AND id = ?")
      .run(JSON.stringify(applied), id);
    return { plan: applied, tasks: saved, alreadyApplied: false };
  })();
}

export function discardLifePlan(store: WorkbenchStore, id: string): { ok: true } {
  return store.sqlite.transaction(() => {
    const plan = store.listRecords('lifePlans').find(row => row.id === id);
    if (!plan) throw new WorkbenchInputError('生活安排建议不存在', 404);
    if (plan.appliedAt) throw new WorkbenchInputError('已应用的安排不能取消', 409);
    store.removeRecord('lifePlans', id);
    return { ok: true as const };
  })();
}
