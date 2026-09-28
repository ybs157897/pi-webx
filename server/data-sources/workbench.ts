import type { WorkbenchStore } from '../workbench/store';
import { checkCancelled, checkQuery, isoTime, SourceError, type SourceAdapter, type SourceRecord } from './contracts';

export function workbenchAdapter(store: WorkbenchStore): SourceAdapter {
  return {
    id: 'workbench',
    create({ kind, config }) {
      if (Object.keys(config.options).length) throw new SourceError('invalid_config', 'workbench 适配器没有 options');
      const convert = (row: Record<string, unknown>): SourceRecord => kind === 'logs' ? {
        kind, sourceId: config.id, id: String(row.id), message: String(row.text ?? ''),
        occurredAt: isoTime(row.date), level: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(String(row.level)) ? row.level as 'info' : 'unknown',
        service: String(row.source ?? ''), attributes: { originalLevel: row.level, time: row.time },
      } : {
        kind, sourceId: config.id, id: String(row.id), title: String(row.title ?? ''),
        description: String(row.note ?? row.detail ?? ''),
        status: ({ todo: 'open', doing: 'in_progress', done: 'resolved' } as const)[String(row.status) as 'todo'] ?? 'unknown',
        priority: String(row.priority ?? ''), createdAt: isoTime(row.createdAt), updatedAt: isoTime(row.updatedAt),
      };
      const rows = () => store.listRecords(kind === 'logs' ? 'logs' : 'fixes').map(convert);
      return {
        async search(input, signal) {
          checkCancelled(signal);
          const query = checkQuery(input, kind === 'logs'
            ? ['q', 'level', 'service', 'from', 'to', 'limit', 'cursor']
            : ['q', 'status', 'priority', 'from', 'to', 'limit', 'cursor']);
          const offset = query.cursor === undefined ? 0 : Number(query.cursor);
          if (!Number.isSafeInteger(offset) || offset < 0) throw new SourceError('invalid_query', '无效分页游标');
          const found = rows().filter(row => {
            const text = row.kind === 'logs' ? `${row.message}\n${row.service}` : `${row.title}\n${row.description}`;
            if (query.q && !text.toLowerCase().includes(query.q.toLowerCase())) return false;
            if (row.kind === 'logs' && ((query.level && row.level !== query.level) || (query.service && row.service !== query.service))) return false;
            if (row.kind === 'issues' && ((query.status && row.status !== query.status) || (query.priority && row.priority !== query.priority))) return false;
            const time = row.kind === 'logs' ? row.occurredAt : row.createdAt;
            if (query.from && (time === null || Date.parse(time) < Date.parse(query.from))) return false;
            const until = query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? `${query.to}T23:59:59.999Z` : query.to;
            if (until && (time === null || Date.parse(time) > Date.parse(until))) return false;
            return true;
          }).sort((a, b) => String(b.kind === 'logs' ? b.occurredAt : b.createdAt).localeCompare(String(a.kind === 'logs' ? a.occurredAt : a.createdAt)));
          const end = offset + query.limit!;
          return { items: found.slice(offset, end), total: found.length, ...(end < found.length ? { nextCursor: String(end) } : {}), source: { id: config.id, kind, adapter: 'workbench' }, query };
        },
        async read(id, signal) { checkCancelled(signal); return rows().find(row => row.id === id) ?? null; },
      };
    },
  };
}
