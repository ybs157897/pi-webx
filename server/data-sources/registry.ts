import type { WorkbenchStore } from '../workbench/store';
import { SourceError, type DataSource, type SourceAdapter, type SourceConfig, type SourceKind } from './contracts';
import { httpJsonAdapter } from './http-json';
import { workbenchAdapter } from './workbench';

/** Code adapters are explicitly registered by the composition root, never imported from model/YAML input. */
export class DataSourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();
  constructor(adapters: readonly SourceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new SourceError('invalid_config', `重复适配器：${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }
  create(kind: SourceKind, config: SourceConfig): DataSource {
    const adapter = this.adapters.get(config.adapter);
    if (!adapter) throw new SourceError('invalid_config', `未注册数据源适配器：${config.adapter}`);
    return Object.assign(adapter.create({ kind, config: structuredClone(config) }), { sourceId: config.id });
  }
}
export function createDataSourceRegistry(store: WorkbenchStore, custom: readonly SourceAdapter[] = []): DataSourceRegistry {
  return new DataSourceRegistry([workbenchAdapter(store), httpJsonAdapter, ...custom]);
}
