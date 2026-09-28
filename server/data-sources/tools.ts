import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SourceError, type DataSource, type SourceKind, type SourceQuery } from './contracts';

export function sourceTools(kind: SourceKind, source: DataSource, maxChars: number): ToolDefinition[] {
  const output = async (work: () => Promise<unknown>) => {
    try {
      let text = JSON.stringify({ ok: true, data: await work() });
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（结果已截断，请缩小 limit 或查询范围）`;
      return { content: [{ type: 'text' as const, text }], details: { kind } };
    } catch (error) {
      const code = error instanceof SourceError ? error.code : 'unavailable';
      const message = error instanceof SourceError ? error.message : '数据源暂不可用';
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, message } }) }], details: { kind, code } };
    }
  };
  return [
    {
      name: `${kind}_search`, label: kind === 'logs' ? '日志检索' : '问题检索',
      description: `查询已配置的${kind === 'logs' ? '日志' : '问题清单'}数据源。返回统一记录、source.id、分页游标和查询条件。时间为 ISO 8601，缺失时间为 null。字段和认证由适配器处理。`,
      promptSnippet: `${kind}_search: 查询当前配置的数据源。保留 sourceId 和 id 作为证据，分页使用 nextCursor。`,
      parameters: Type.Object({ q: Type.Optional(Type.String()), from: Type.Optional(Type.String()), to: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(Type.String()),
        ...(kind === 'logs' ? { level: Type.Optional(Type.String()), service: Type.Optional(Type.String()) } : { status: Type.Optional(Type.String()), priority: Type.Optional(Type.String()) }),
      }, { additionalProperties: false }),
      async execute(_id, params, signal) { return output(() => source.search(params as SourceQuery, signal)); },
    },
    {
      name: `${kind}_read`, label: kind === 'logs' ? '日志读取' : '问题读取',
      description: '读取当前已配置数据源中的一条记录。sourceId 必须与检索结果一致，防止更换数据源后误读同名 id。',
      parameters: Type.Object({ id: Type.String(), sourceId: Type.String() }, { additionalProperties: false }),
      async execute(_id, params, signal) {
        const p = params as { id: string; sourceId: string };
        return output(async () => {
          // Identity is checked by the binding wrapper before contacting the provider.
          const scoped = source as DataSource & { sourceId?: string };
          if (scoped.sourceId !== p.sourceId) throw new SourceError('invalid_query', '记录来源与当前数据源不一致，请重新检索');
          return source.read(p.id, signal);
        });
      },
    },
  ];
}
