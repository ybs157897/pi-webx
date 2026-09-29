import { WorkbenchInputError } from '../../workbench/store';

type Task = Record<string, unknown> & { id: string };

function slot(task: Task): { date: string; start: string; end: string } | null {
  const date = task.plannedDate ?? null;
  const start = task.startTime ?? null;
  const end = task.endTime ?? null;
  if (date === null && start === null && end === null) return null;
  if (start === null && end === null) return null;
  if (typeof date !== 'string' || typeof start !== 'string' || typeof end !== 'string') {
    throw new WorkbenchInputError('安排时间需要同时填写日期、开始时间和结束时间');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)
    || start >= end) {
    throw new WorkbenchInputError('安排日期或时间不合法，结束时间必须晚于开始时间');
  }
  return { date, start, end };
}

/** 只让未完成事项占据时段；仅有计划日期的事项可自由安排。 */
export function assertTaskSchedule(task: Task, peers: readonly Task[]): void {
  const current = slot(task);
  if (!current || task.done === true) return;
  for (const peer of peers) {
    if (peer.id === task.id || peer.done === true) continue;
    const other = slot(peer);
    if (other && current.date === other.date && current.start < other.end && other.start < current.end) {
      throw new WorkbenchInputError(`「${String(task.title)}」与「${String(peer.title)}」的安排时间重叠`, 409);
    }
  }
}

export function assertTaskShape(task: Task): void {
  const current = slot(task);
  if (task.kind === 'fixed' && task.plannedDate != null && current === null) {
    throw new WorkbenchInputError('固定安排需要填写开始时间和结束时间');
  }
  const source = [task.captureSessionId, task.captureEntryKey, task.captureFingerprint];
  if (source.some(value => value !== undefined) && source.some(value => value === undefined)) {
    throw new WorkbenchInputError('待办收集来源字段不完整');
  }
}
