type WorkRecord = Record<string, unknown> & { id: string };

export class WorkScheduleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function slot(record: WorkRecord): { date: string; start: string; end: string } | null {
  const date = record.scheduledDate ?? null;
  const start = record.startTime ?? null;
  const end = record.endTime ?? null;
  if (date === null && start === null && end === null) return null;
  if (typeof date !== 'string' || typeof start !== 'string' || typeof end !== 'string') {
    throw new WorkScheduleError('排期需要同时填写日期、开始时间和结束时间');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    throw new WorkScheduleError('排期日期或时间格式不合法');
  }
  if (start >= end) throw new WorkScheduleError('结束时间必须晚于开始时间');
  return { date, start, end };
}

/** 已完成工作是历史事实；只有待办和进行中工作占据可用时段。 */
export function assertWorkScheduleRecord(record: WorkRecord, peers: readonly WorkRecord[]): void {
  const current = slot(record);
  if (!current || record.status === 'done') return;
  for (const peer of peers) {
    if (peer.id === record.id || peer.status === 'done') continue;
    const other = slot(peer);
    if (other && current.date === other.date && current.start < other.end && other.start < current.end) {
      throw new WorkScheduleError(`「${String(record.title)}」与「${String(peer.title)}」的工作时间重叠`, 409);
    }
  }
}
