/**
 * 日志查询领域服务：在 workbench 的 `logs` 记录上提供有界只读检索。
 *
 * 结果固定带 `source: 'workbench.logs'`——它回答的是工作台里记录的日志，不是
 * 已经接上了外部日志平台；接入日志 MCP 后这条来源标识用于区分。
 */
import type { WorkbenchStore } from '../../workbench/store';

export interface LogsQuery {
  q?: string;
  level?: string;
  source?: string;
  /** ISO 日期 YYYY-MM-DD，闭区间。 */
  from?: string;
  to?: string;
  limit?: number;
}

export interface LogsSearchResult {
  source: 'workbench.logs';
  items: Array<Record<string, unknown>>;
  total: number;
  query: { q: string | null; level: string | null; source: string | null };
  range: { from: string | null; to: string | null };
}

const MAX_LIMIT = 50;

export function createLogsQuery(store: WorkbenchStore) {
  return {
    search(query: LogsQuery): LogsSearchResult {
      const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
      const level = typeof query.level === 'string' && query.level !== '' ? query.level : null;
      const source = typeof query.source === 'string' && query.source !== '' ? query.source : null;
      const from = typeof query.from === 'string' && query.from !== '' ? query.from : null;
      const to = typeof query.to === 'string' && query.to !== '' ? query.to : null;
      const limit = Math.min(Math.max(Math.floor(query.limit ?? MAX_LIMIT), 1), MAX_LIMIT);

      const matched = store.listRecords('logs').filter((record) => {
        if (level !== null && record.level !== level) return false;
        if (source !== null && record.source !== source) return false;
        const date = typeof record.date === 'string' ? record.date : '';
        if (from !== null && date < from) return false;
        if (to !== null && date > to) return false;
        if (q !== '') {
          const hay = [record.text, record.source, record.level]
            .filter((value): value is string => typeof value === 'string')
            .join('\n')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      // 最新在前：date 为主键，createdAt 兜底次序。
      matched.sort((a, b) =>
        String(b.date ?? '').localeCompare(String(a.date ?? ''))
        || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

      return {
        source: 'workbench.logs',
        items: matched.slice(0, limit),
        total: matched.length,
        query: { q: q === '' ? null : q, level, source },
        range: { from, to },
      };
    },

    read(id: string): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } {
      const record = store.listRecords('logs').find((row) => row.id === id);
      if (record === undefined) return { ok: false, error: `找不到 id 为 ${id} 的日志记录` };
      return { ok: true, record };
    },
  };
}

export type LogsQueryService = ReturnType<typeof createLogsQuery>;
