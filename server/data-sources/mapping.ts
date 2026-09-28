import { isoTime, SourceError, type SourceKind, type SourceRecord } from './contracts';
export type FieldMapping = string | { path: string; values?: Record<string, string>; unit?: 'seconds' | 'milliseconds' };
export type FieldMappings = Record<string, FieldMapping>;
/** Dot-separated own-property paths only; no expressions, wildcards or prototype access. */
export function atPath(value: unknown, path: string): unknown {
  if (path === '' || path === '$') return value;
  for (const part of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new SourceError('invalid_config', '不允许的字段路径');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function normalizeRecord(kind: SourceKind, sourceId: string, raw: unknown, fields: FieldMappings): SourceRecord {
  const mapped: Record<string, unknown> = {};
  const original: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(fields)) {
    const spec = typeof rule === 'string' ? { path: rule } : rule;
    let value = atPath(raw, spec.path);
    if (spec.values) { original[key] = value; value = Object.hasOwn(spec.values, String(value)) ? spec.values[String(value)] : 'unknown'; }
    if (['occurredAt', 'createdAt', 'updatedAt'].includes(key)) value = isoTime(value, spec.unit);
    if (value !== undefined) mapped[key] = value;
  }
  for (const key of ['id', kind === 'logs' ? 'message' : 'title']) {
    if (!['string', 'number'].includes(typeof mapped[key]) || String(mapped[key]) === '') throw new SourceError('invalid_response', `数据源缺少必需字段：${key}`);
    mapped[key] = String(mapped[key]);
  }
  if (kind === 'logs') {
    mapped.occurredAt ??= null;
    if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(String(mapped.level))) { original.level ??= mapped.level; mapped.level = 'unknown'; }
  } else {
    mapped.createdAt ??= null; mapped.updatedAt ??= null;
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(String(mapped.status))) { original.status ??= mapped.status; mapped.status = 'unknown'; }
  }
  for (const key of ['service', 'traceId', 'description', 'priority', 'url']) {
    if (mapped[key] !== undefined && typeof mapped[key] !== 'string') throw new SourceError('invalid_response', `数据源字段 ${key} 必须是字符串`);
  }
  if (mapped.attributes !== undefined && (mapped.attributes === null || typeof mapped.attributes !== 'object' || Array.isArray(mapped.attributes))) throw new SourceError('invalid_response', 'attributes 必须是对象');
  return { ...mapped, kind, sourceId, attributes: { ...(mapped.attributes as object ?? {}), ...original } } as unknown as SourceRecord;
}
