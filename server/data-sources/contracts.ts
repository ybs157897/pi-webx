/** Stable, read-only domain API. Supplier wire formats never cross this boundary. */
export type SourceKind = 'logs' | 'issues';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown';
export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed' | 'unknown';
export interface RecordIdentity { id: string; sourceId: string }
export interface LogRecord extends RecordIdentity {
  kind: 'logs'; occurredAt: string | null; level: LogLevel; message: string;
  service?: string; traceId?: string; attributes?: Record<string, unknown>;
}
export interface IssueRecord extends RecordIdentity {
  kind: 'issues'; title: string; description?: string; status: IssueStatus;
  priority?: string; createdAt: string | null; updatedAt: string | null;
  url?: string; attributes?: Record<string, unknown>;
}
export type SourceRecord = LogRecord | IssueRecord;
export interface SourceQuery {
  q?: string; level?: string; service?: string; status?: string; priority?: string;
  from?: string; to?: string; limit?: number; cursor?: string;
}
export interface SourcePage {
  items: SourceRecord[]; total?: number; nextCursor?: string;
  source: { id: string; kind: SourceKind; adapter: string }; query: SourceQuery;
}
export interface SourceConfig { id: string; adapter: string; options: Record<string, unknown> }
export type DataSourceConfigs = Partial<Record<SourceKind, SourceConfig>>;
export type SourceErrorCode = 'invalid_config' | 'invalid_query' | 'unsupported_query' | 'invalid_response'
  | 'unauthorized' | 'not_found' | 'timeout' | 'cancelled' | 'unavailable';
export class SourceError extends Error {
  constructor(readonly code: SourceErrorCode, message: string) { super(message); }
}
export interface DataSource {
  search(query: SourceQuery, signal?: AbortSignal): Promise<SourcePage>;
  read(id: string, signal?: AbortSignal): Promise<SourceRecord | null>;
  dispose?(): Promise<void>;
}
export interface AdapterContext { kind: SourceKind; config: SourceConfig }
export interface SourceAdapter {
  id: string;
  /** Called before opening a session, including when restoring a snapshot. */
  create(context: AdapterContext): DataSource;
}
export const DEFAULT_DATA_SOURCES: DataSourceConfigs = {
  logs: { id: 'workbench-logs', adapter: 'workbench', options: {} },
  issues: { id: 'workbench-issues', adapter: 'workbench', options: {} },
};
export const QUERY_KEYS = ['q', 'level', 'service', 'status', 'priority', 'from', 'to', 'limit', 'cursor'] as const;
export function checkQuery(query: SourceQuery, supported: readonly string[]): SourceQuery {
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_KEYS.includes(key as typeof QUERY_KEYS[number])) throw new SourceError('invalid_query', `未知查询字段：${key}`);
    if (value === undefined || value === '') continue;
    if (!supported.includes(key)) throw new SourceError('unsupported_query', `数据源不支持查询条件：${key}`);
    if (key !== 'limit' && typeof value !== 'string') throw new SourceError('invalid_query', `${key} 必须是字符串`);
  }
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SourceError('invalid_query', 'limit 必须在 1–100 之间');
  for (const key of ['from', 'to'] as const) {
    if (query[key] && !Number.isFinite(Date.parse(query[key]!))) throw new SourceError('invalid_query', `${key} 必须是有效日期`);
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new SourceError('invalid_query', '开始时间不能晚于结束时间');
  return { ...query, limit };
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SourceError('cancelled', '数据源请求已取消');
}
export function isoTime(value: unknown, unit?: 'seconds' | 'milliseconds'): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = typeof value === 'number' ? new Date(value * (unit === 'seconds' ? 1000 : 1)) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new SourceError('invalid_response', '数据源返回无效时间');
  return date.toISOString();
}
