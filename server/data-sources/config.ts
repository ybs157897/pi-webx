import { DEFAULT_DATA_SOURCES, SourceError, type DataSourceConfigs } from './contracts';
export function parseDataSources(value: unknown): DataSourceConfigs {
  if (value === undefined) return structuredClone(DEFAULT_DATA_SOURCES);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError('invalid_config', 'dataSources 必须是对象');
  const result: DataSourceConfigs = {};
  const ids = new Set<string>();
  for (const [kind, raw] of Object.entries(value)) {
    if (!['logs', 'issues'].includes(kind) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceError('invalid_config', 'dataSources 仅支持 logs/issues');
    const cfg = raw as Record<string, unknown>;
    if (Object.keys(cfg).some(key => !['id', 'adapter', 'options'].includes(key)) || typeof cfg.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cfg.id) || typeof cfg.adapter !== 'string' || !cfg.adapter || !cfg.options || typeof cfg.options !== 'object' || Array.isArray(cfg.options)) throw new SourceError('invalid_config', `dataSources.${kind} 需要 id、adapter 和 options 对象`);
    if (ids.has(cfg.id)) throw new SourceError('invalid_config', '同一 Agent 数据源 id 不得重复');
    ids.add(cfg.id);
    result[kind as 'logs' | 'issues'] = { id: cfg.id, adapter: cfg.adapter, options: cfg.options as Record<string, unknown> };
  }
  return result;
}
