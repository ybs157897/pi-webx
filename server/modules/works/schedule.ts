import { randomUUID } from 'node:crypto';
import { validateFields } from '../../workbench/schema.mjs';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { assertWorkScheduleRecord } from './validation';

type WorkRecord = Record<string, unknown> & { id: string };
type WorkEntry = {
  entryKey: string;
  id?: string;
  expectedUpdatedAt?: string;
  title: string;
  note?: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  taskIds?: string[];
};
type Binding = { work_id: string; request_json: string };
type Planned = { entry: WorkEntry; record: WorkRecord; requestJson: string; alreadyApplied: boolean };

const ENTRY_KEYS = new Set(['entryKey', 'id', 'expectedUpdatedAt', 'title', 'note', 'scheduledDate', 'startTime', 'endTime', 'taskIds']);
const ID_RE = /^[\w-]{8,64}$/;
const ENTRY_KEY_RE = /^[\w.:-]{1,80}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEntries(raw: unknown): WorkEntry[] {
  if (!object(raw) || Object.keys(raw).some(key => key !== 'entries') || !Array.isArray(raw.entries)
    || raw.entries.length < 1 || raw.entries.length > 20) {
    throw new WorkbenchInputError('请提供 1 至 20 条工作排期');
  }
  const keys = new Set<string>();
  return raw.entries.map((value: unknown) => {
    if (!object(value) || Object.keys(value).some(key => !ENTRY_KEYS.has(key))) {
      throw new WorkbenchInputError('工作排期含未知字段');
    }
    const { entryKey, id, expectedUpdatedAt, title, note, scheduledDate, startTime, endTime, taskIds } = value;
    if (typeof entryKey !== 'string' || !ENTRY_KEY_RE.test(entryKey) || keys.has(entryKey)) {
      throw new WorkbenchInputError('entryKey 需要在本批次唯一，且只含字母、数字、点、冒号、下划线或连字符');
    }
    keys.add(entryKey);
    if (id !== undefined && (typeof id !== 'string' || !ID_RE.test(id))) throw new WorkbenchInputError('工作 ID 不合法');
    if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt)))) {
      throw new WorkbenchInputError('expectedUpdatedAt 不合法');
    }
    if (typeof title !== 'string' || typeof scheduledDate !== 'string' || typeof startTime !== 'string' || typeof endTime !== 'string'
      || (note !== undefined && typeof note !== 'string')) {
      throw new WorkbenchInputError('工作排期的标题、日期或时间不合法');
    }
    if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.length > 20
      || taskIds.some(taskId => typeof taskId !== 'string' || !ID_RE.test(taskId))
      || new Set(taskIds).size !== taskIds.length)) {
      throw new WorkbenchInputError('taskIds 必须是不重复的待办 ID（最多 20 条）');
    }
    return {
      entryKey,
      ...(id === undefined ? {} : { id }),
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      title: title.trim(),
      ...(note === undefined ? {} : { note }),
      scheduledDate, startTime, endTime,
      ...(taskIds === undefined ? {} : { taskIds: taskIds as string[] }),
    };
  });
}

function nextStamp(previous: unknown, now: number): string {
  const parsed = Date.parse(String(previous ?? ''));
  return new Date(Math.max(now, Number.isFinite(parsed) ? parsed + 1 : 0)).toISOString();
}

function matchesAppliedEntry(entry: WorkEntry, record: WorkRecord): boolean {
  if (record.status === 'done' || record.title !== entry.title
    || record.scheduledDate !== entry.scheduledDate || record.startTime !== entry.startTime
    || record.endTime !== entry.endTime || (entry.note !== undefined && record.note !== entry.note)) return false;
  if (entry.taskIds === undefined) return true;
  const refs = Array.isArray(record.refs) ? record.refs : [];
  const linked = refs.filter(ref => object(ref) && ref.type === 'tasks').map(ref => (ref as { id: string }).id);
  return JSON.stringify(linked) === JSON.stringify(entry.taskIds);
}

function localClock(now: Date): { iso: string; timeZone: string; localDate: string; localTime: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  return {
    iso: now.toISOString(), timeZone,
    localDate: `${value('year')}-${value('month')}-${value('day')}`,
    localTime: `${value('hour')}:${value('minute')}`,
  };
}

function taskContext(row: WorkRecord): WorkRecord {
  return {
    id: row.id, title: row.title, done: row.done, due: row.due,
    priority: row.priority, tag: row.tag, refs: row.refs, updatedAt: row.updatedAt,
  };
}

function workContext(row: WorkRecord): WorkRecord {
  return {
    id: row.id, title: row.title, note: typeof row.note === 'string' ? row.note.slice(0, 300) : '',
    status: row.status, scheduledDate: row.scheduledDate ?? null,
    startTime: row.startTime ?? null, endTime: row.endTime ?? null,
    refs: row.refs, updatedAt: row.updatedAt,
  };
}

export function readWorksContext(store: WorkbenchStore, raw: unknown = {}, now = new Date()): {
  now: ReturnType<typeof localClock>;
  tasks: WorkRecord[];
  works: WorkRecord[];
  schedule: WorkRecord[];
  totals: { tasks: number; works: number; schedule: number };
  returned: { tasks: number; works: number; schedule: number };
  offset: number;
  hasMore: boolean;
  truncated: boolean;
} {
  if (!object(raw) || Object.keys(raw).some(key => key !== 'query' && key !== 'limit' && key !== 'offset')) {
    throw new WorkbenchInputError('上下文查询字段不合法');
  }
  const query = raw.query === undefined ? '' : raw.query;
  const limit = raw.limit === undefined ? 100 : raw.limit;
  const offset = raw.offset === undefined ? 0 : raw.offset;
  if (typeof query !== 'string' || query.length > 100 || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new WorkbenchInputError('上下文查询或条数不合法');
  }
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new WorkbenchInputError('上下文起始位置不合法');
  }
  const match = (row: WorkRecord): boolean => `${String(row.title ?? '')} ${String(row.note ?? '')}`.toLowerCase().includes(query.trim().toLowerCase());
  const tasks = store.listRecords('tasks').filter(row => row.done !== true && match(row))
    .sort((a, b) => String(a.due ?? '9999-12-31').localeCompare(String(b.due ?? '9999-12-31'))
      || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const activeWorks = store.listRecords('works').filter(row => row.status !== 'done');
  const works = activeWorks.filter(match)
    .sort((a, b) => String(a.scheduledDate ?? '9999-12-31').localeCompare(String(b.scheduledDate ?? '9999-12-31'))
      || String(a.startTime ?? '99:99').localeCompare(String(b.startTime ?? '99:99')));
  const schedule = activeWorks.filter(row => row.scheduledDate && row.startTime && row.endTime)
    .sort((a, b) => `${a.scheduledDate} ${a.startTime}`.localeCompare(`${b.scheduledDate} ${b.startTime}`));
  return {
    now: localClock(now),
    totals: { tasks: tasks.length, works: works.length, schedule: schedule.length },
    returned: {
      tasks: Math.max(0, Math.min(tasks.length - offset, limit)),
      works: Math.max(0, Math.min(works.length - offset, limit)),
      schedule: Math.max(0, Math.min(schedule.length - offset, limit)),
    },
    offset,
    hasMore: tasks.length > offset + limit || works.length > offset + limit || schedule.length > offset + limit,
    truncated: offset > 0 || tasks.length > offset + limit || works.length > offset + limit || schedule.length > offset + limit,
    tasks: tasks.slice(offset, offset + limit).map(taskContext),
    works: works.slice(offset, offset + limit).map(workContext),
    schedule: schedule.slice(offset, offset + limit).map(workContext),
  };
}

/** 一批安排的最终状态先校验再写入；重复 entryKey 永远绑定同一条工作。 */
export function scheduleWorks(store: WorkbenchStore, sessionId: string, raw: unknown): {
  entries: Array<{ entryKey: string; record: WorkRecord; alreadyApplied: boolean }>;
} {
  if (!sessionId) throw new WorkbenchInputError('工作助理会话身份缺失');
  const entries = normalizeEntries(raw);
  store.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS works_schedule_entries (
      session_id TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      work_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      PRIMARY KEY (session_id, entry_key)
    )
  `);
  return store.sqlite.transaction(() => {
    const now = Date.now();
    const existing = store.listRecords('works');
    const byId = new Map(existing.map(row => [row.id, row]));
    const tasks = new Map(store.listRecords('tasks').map(row => [row.id, row]));
    const bindingQuery = store.sqlite.prepare('SELECT work_id, request_json FROM works_schedule_entries WHERE session_id = ? AND entry_key = ?');
    const planned: Planned[] = [];
    const seenIds = new Set<string>();

    for (const entry of entries) {
      const requestJson = JSON.stringify(entry);
      const binding = bindingQuery.get(sessionId, entry.entryKey) as Binding | undefined;
      if (binding && entry.id && entry.id !== binding.work_id) {
        throw new WorkbenchInputError('entryKey 已绑定另一条工作记录', 409);
      }
      const id = binding?.work_id ?? entry.id ?? randomUUID();
      if (seenIds.has(id)) throw new WorkbenchInputError('同一批次不能重复修改同一条工作', 409);
      seenIds.add(id);
      const previous = byId.get(id);
      if (binding && !previous) throw new WorkbenchInputError('entryKey 关联的工作已删除，不能重复创建', 409);
      if (entry.id && !previous) throw new WorkbenchInputError('要修改的工作不存在', 404);
      if (binding?.request_json === requestJson && previous) {
        if (!matchesAppliedEntry(entry, previous)) {
          throw new WorkbenchInputError('已保存工作后来被修改，请重新读取上下文再安排', 409);
        }
        planned.push({ entry, record: previous, requestJson, alreadyApplied: true });
        continue;
      }
      if (previous?.status === 'done') throw new WorkbenchInputError('已完成工作不能由工作助理重新排期，请先恢复为待办', 409);
      if (previous && (entry.expectedUpdatedAt === undefined || entry.expectedUpdatedAt !== previous.updatedAt)) {
        throw new WorkbenchInputError('工作已更新，请重新读取上下文再调整排期', 409);
      }
      if (entry.taskIds) {
        for (const taskId of entry.taskIds) {
          const task = tasks.get(taskId);
          if (!task || task.done === true) throw new WorkbenchInputError(`待办 ${taskId} 不存在或已经完成`, 409);
        }
      }
      const oldRefs = Array.isArray(previous?.refs) ? previous.refs : [];
      const refs = entry.taskIds === undefined
        ? oldRefs
        : [
          ...oldRefs.filter(ref => object(ref) && ref.type !== 'tasks'),
          ...entry.taskIds.map(taskId => ({ type: 'tasks', id: taskId })),
        ];
      const fields = {
        title: entry.title,
        ...(entry.note === undefined ? {} : { note: entry.note }),
        scheduledDate: entry.scheduledDate,
        startTime: entry.startTime,
        endTime: entry.endTime,
        ...(entry.taskIds === undefined ? {} : { refs }),
      };
      let clean: Record<string, unknown>;
      try {
        clean = validateFields('works', fields, { partial: previous !== undefined });
      } catch (error) {
        throw new WorkbenchInputError(error instanceof Error ? error.message : String(error));
      }
      const record: WorkRecord = previous
        ? { ...previous, ...clean, updatedAt: nextStamp(previous.updatedAt, now) }
        : { id, ...clean, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      planned.push({ entry, record, requestJson, alreadyApplied: false });
    }

    const final = new Map(byId);
    for (const item of planned) final.set(item.record.id, item.record);
    for (const item of planned) {
      if (!item.alreadyApplied) assertWorkScheduleRecord(item.record, [...final.values()]);
    }

    const insert = store.sqlite.prepare("INSERT INTO workbench_records (module, id, payload) VALUES ('works', ?, ?)");
    const update = store.sqlite.prepare("UPDATE workbench_records SET payload = ? WHERE module = 'works' AND id = ?");
    const bind = store.sqlite.prepare(`
      INSERT INTO works_schedule_entries (session_id, entry_key, work_id, request_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, entry_key) DO UPDATE SET request_json = excluded.request_json
    `);
    for (const item of planned) {
      if (item.alreadyApplied) continue;
      if (byId.has(item.record.id)) update.run(JSON.stringify(item.record), item.record.id);
      else insert.run(item.record.id, JSON.stringify(item.record));
      bind.run(sessionId, item.entry.entryKey, item.record.id, item.requestJson);
    }
    return { entries: planned.map(item => ({ entryKey: item.entry.entryKey, record: item.record, alreadyApplied: item.alreadyApplied })) };
  })();
}
