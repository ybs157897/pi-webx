import { checkCancelled, checkQuery, QUERY_KEYS, SourceError, type SourceAdapter } from './contracts';
import { atPath, normalizeRecord, type FieldMappings } from './mapping';

type Operation = { method: 'GET' | 'POST'; path: string; query?: Record<string, unknown>; body?: Record<string, unknown>; resultPath?: string };
interface HttpOptions {
  baseUrl: string; headerRefs?: Record<string, string>; timeoutMs?: number; maxResponseBytes?: number;
  search: Operation & { itemsPath: string; totalPath?: string; nextCursorPath?: string };
  read: Operation; fields: FieldMappings;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: unknown, allowed: string[], where: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new SourceError('invalid_config', `${where} 字段不合法`);
}
function validate(value: unknown): HttpOptions {
  keys(value, ['baseUrl', 'headerRefs', 'timeoutMs', 'maxResponseBytes', 'search', 'read', 'fields'], 'http-json options');
  let url: URL;
  try { url = new URL(String(value.baseUrl)); } catch { throw new SourceError('invalid_config', 'baseUrl 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SourceError('invalid_config', 'baseUrl 必须为不含凭据、查询和片段的 HTTP(S) 地址');
  for (const key of ['timeoutMs', 'maxResponseBytes']) {
    const n = value[key];
    if (n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > (key === 'timeoutMs' ? 120_000 : 10_000_000))) throw new SourceError('invalid_config', `${key} 超出允许范围`);
  }
  if (value.headerRefs !== undefined && (!object(value.headerRefs) || Object.entries(value.headerRefs).some(([key, ref]) => !/^[A-Za-z0-9-]+$/.test(key) || typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)))) throw new SourceError('invalid_config', 'headerRefs 必须引用环境变量名称');
  for (const name of ['search', 'read']) {
    const op = value[name];
    keys(op, ['method', 'path', 'query', 'body', 'resultPath', ...(name === 'search' ? ['itemsPath', 'totalPath', 'nextCursorPath'] : [])], name);
    if (!['GET', 'POST'].includes(String(op.method)) || typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.startsWith('//') || op.path.includes('\\') || op.path.includes('#')) throw new SourceError('invalid_config', `${name} 必须配置 GET/POST 和同源绝对路径`);
    if (op.query !== undefined && !object(op.query)) throw new SourceError('invalid_config', `${name}.query 必须是对象`);
    if (op.body !== undefined && (!object(op.body) || op.method !== 'POST')) throw new SourceError('invalid_config', `${name}.body 仅限 POST 对象`);
    for (const key of ['itemsPath', 'totalPath', 'nextCursorPath', 'resultPath']) if (op[key] !== undefined && typeof op[key] !== 'string') throw new SourceError('invalid_config', `${name}.${key} 必须是路径字符串`);
    if (name === 'search' && typeof op.itemsPath !== 'string') throw new SourceError('invalid_config', 'search.itemsPath 必填');
    const tokens = [...JSON.stringify(op).matchAll(/\{([A-Za-z]+)\}/g)].map(match => match[1]);
    if (tokens.some(token => !(name === 'read' ? ['id'] : QUERY_KEYS as readonly string[]).includes(token!))) throw new SourceError('invalid_config', `${name} 包含未知模板参数`);
  }
  if (!object(value.fields)) throw new SourceError('invalid_config', 'fields 必须是对象');
  const allowed = ['id', 'occurredAt', 'level', 'message', 'service', 'traceId', 'title', 'description', 'status', 'priority', 'createdAt', 'updatedAt', 'url', 'attributes'];
  keys(value.fields, allowed, 'fields');
  for (const rule of Object.values(value.fields)) {
    if (typeof rule === 'string') continue;
    keys(rule, ['path', 'values', 'unit'], '字段映射');
    if (typeof rule.path !== 'string' || (rule.unit !== undefined && !['seconds', 'milliseconds'].includes(String(rule.unit))) || (rule.values !== undefined && (!object(rule.values) || Object.values(rule.values).some(item => typeof item !== 'string')))) throw new SourceError('invalid_config', '字段映射格式不合法');
  }
  return value as unknown as HttpOptions;
}
function render(value: unknown, args: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{([A-Za-z]+)\}$/.exec(value);
    if (whole) return args[whole[1]!];
    return value.replace(/\{([A-Za-z]+)\}/g, (_, key: string) => String(args[key] ?? ''));
  }
  if (Array.isArray(value)) return value.map(item => render(item, args));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, render(val, args)]).filter(([, val]) => val !== undefined));
  return value;
}
async function readJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new SourceError('invalid_response', '数据源响应为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > limit) throw new SourceError('invalid_response', '数据源响应超过大小上限');
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SourceError('invalid_response', '数据源未返回有效 JSON'); }
  } finally { await reader.cancel().catch(() => undefined); }
}
export const httpJsonAdapter: SourceAdapter = {
  id: 'http-json',
  create({ kind, config }) {
    const options = validate(config.options);
    for (const field of ['id', kind === 'logs' ? 'message' : 'title']) if (!options.fields[field]) throw new SourceError('invalid_config', `缺少 ${field} 字段映射`);
    const disposed = new AbortController();
    const supported = [...new Set([...JSON.stringify({ query: options.search.query, body: options.search.body, path: options.search.path }).matchAll(/\{([A-Za-z]+)\}/g)].map(match => match[1]!))];
    if (!supported.includes('limit')) throw new SourceError('invalid_config', 'search 必须映射 {limit}，保证有界分页');
    const request = async (op: Operation, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
      checkCancelled(signal); checkCancelled(disposed.signal);
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const combined = AbortSignal.any([disposed.signal, timeout, ...(signal ? [signal] : [])]);
      const headers: Record<string, string> = { Accept: 'application/json' };
      for (const [name, ref] of Object.entries(options.headerRefs ?? {})) {
        const secret = process.env[ref];
        if (secret === undefined) throw new SourceError('invalid_config', `数据源凭据引用 ${ref} 未设置`);
        headers[name] = secret;
      }
      const base = new URL(options.baseUrl);
      const pathname = op.path.replace(/\{([A-Za-z]+)\}/g, (_, key: string) => encodeURIComponent(String(args[key] ?? '')));
      const url = new URL(pathname, base);
      if (url.origin !== base.origin) throw new SourceError('invalid_config', '请求路径不能改变数据源 origin');
      const query = render(op.query ?? {}, args) as Record<string, unknown>;
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      try {
        const response = await fetch(url, { method: op.method, headers: { ...headers, ...(op.body ? { 'Content-Type': 'application/json' } : {}) }, ...(op.body ? { body: JSON.stringify(render(op.body, args)) } : {}), signal: combined, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel();
          throw new SourceError(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable', `数据源请求失败（HTTP ${response.status}）`);
        }
        return await readJson(response, options.maxResponseBytes ?? 2_000_000);
      } catch (error) {
        if (signal?.aborted || disposed.signal.aborted) throw new SourceError('cancelled', '数据源请求已取消');
        if (timeout.aborted) throw new SourceError('timeout', '数据源请求超时');
        if (error instanceof SourceError) throw error;
        throw new SourceError('unavailable', '数据源连接失败');
      }
    };
    return {
      async search(input, signal) {
        const query = checkQuery(input, supported);
        const raw = await request(options.search, query as Record<string, unknown>, signal);
        const items = atPath(raw, options.search.itemsPath);
        if (!Array.isArray(items) || items.length > query.limit!) throw new SourceError('invalid_response', '数据源列表格式错误或未遵守分页上限');
        const total = options.search.totalPath === undefined ? undefined : atPath(raw, options.search.totalPath);
        const cursor = options.search.nextCursorPath === undefined ? undefined : atPath(raw, options.search.nextCursorPath);
        if (total !== undefined && (!Number.isSafeInteger(total) || Number(total) < 0)) throw new SourceError('invalid_response', 'total 必须是非负整数');
        if (cursor !== undefined && cursor !== null && !['string', 'number'].includes(typeof cursor)) throw new SourceError('invalid_response', 'nextCursor 必须是字符串或数字');
        return { items: items.map(item => normalizeRecord(kind, config.id, item, options.fields)), ...(total === undefined ? {} : { total: total as number }), ...(cursor === undefined || cursor === null || cursor === '' ? {} : { nextCursor: String(cursor) }), source: { id: config.id, kind, adapter: 'http-json' }, query };
      },
      async read(id, signal) {
        if (!id) throw new SourceError('invalid_query', 'id 不能为空');
        try {
          const raw = await request(options.read, { id }, signal);
          const item = atPath(raw, options.read.resultPath ?? '$');
          if (item === null) return null;
          const record = normalizeRecord(kind, config.id, item, options.fields);
          if (record.id !== id) throw new SourceError('invalid_response', '返回记录 id 与请求不一致');
          return record;
        } catch (error) { if (error instanceof SourceError && error.code === 'not_found') return null; throw error; }
      },
      async dispose() { disposed.abort(); },
    };
  },
};
