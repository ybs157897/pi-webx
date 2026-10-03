import { Type } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { buildRequirementsWorkbenchContext, getPublicRequirementVersion } from './context';
import { saveRequirementDraftIdempotently } from './draft-idempotency';

export const REQUIREMENTS_TOOL_NAMES: Readonly<Record<string, string>> = {
  'requirements.context': 'requirements_context',
  'requirements.saveDraft': 'requirements_save_draft',
};

function result(data: unknown, maxChars: number): AgentToolResult<unknown> {
  const raw = JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text: raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…（结果已截断）` : raw }],
    details: { data },
  };
}

export function createRequirementsTools(deps: { store: WorkbenchStore; limits: { maxToolOutputChars: number } }): ToolDefinition[] {
  const maxChars = deps.limits.maxToolOutputChars;
  return [
    {
      name: REQUIREMENTS_TOOL_NAMES['requirements.saveDraft']!,
      label: '保存需求草稿',
      description: '保存当前对话梳理出的需求与可审阅待办草稿。此操作不会创建待办；用户在界面确认后才导入。传 id 可修订本会话的草稿。可选 entryKey 是同一逻辑保存的稳定幂等键；重试时保持 key 和参数不变，不同需求使用新 key。省略时使用 toolCallId 处理 SDK 重放。返回 alreadySaved:true 表示复用了原回执，结果中的记录和版本可能是历史快照；交接前用 requirements_context 核对当前记录。',
      promptSnippet: 'requirements_save_draft: 保存可审阅草稿，不创建待办。重试同一逻辑保存时复用相同 entryKey 和参数；省略 key 时 SDK toolCallId 只保障同一工具调用重放。不同需求使用新 key，不按相同标题或内容合并。alreadySaved:true 时先用 requirements_context 核对当前记录和版本。',
      parameters: Type.Object({
        entryKey: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: '同一逻辑保存重试时保持不变的幂等键；新需求使用新键' })),
        id: Type.Optional(Type.String({ description: '修订已有草稿时传返回的需求 id' })),
        title: Type.String({ description: '需求标题，最多 200 字' }),
        note: Type.Optional(Type.String({ description: '背景、范围、约束和验收标准，最多 5000 字' })),
        priority: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')])),
        taskDrafts: Type.Array(Type.Object({
          title: Type.String({ description: '可执行的待办标题' }),
          priority: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')])),
          due: Type.Optional(Type.Union([Type.String({ description: 'YYYY-MM-DD' }), Type.Null()])),
          tag: Type.Optional(Type.String()),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }),
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        return result(saveRequirementDraftIdempotently(
          deps.store, ctx.sessionManager.getSessionId(), toolCallId, params,
        ), maxChars);
      },
    },
    {
      name: REQUIREMENTS_TOOL_NAMES['requirements.context']!,
      label: '读取工作台与需求上下文',
      description: '读取 AI 指挥台的有限产品事实或当前工作台公开需求记录。宿主应用不等于用户想处理的目标；指代不清时先澄清。可按真实需求 id 读取单条，或按标题/备注搜索；使用 limit/offset 分页。',
      promptSnippet: 'requirements_context: 读取当前工作台的有限事实；已有需求记录只说明工作台内的内容，不能推断用户的目标。沿用本轮或同话题中已经明确的对象；“这个”等指代仍不清时先询问，不通过通用文件、会话或 SQL 搜索扩大范围。',
      parameters: Type.Object({
        requirementId: Type.Optional(Type.String({ description: '按真实需求记录 id 读取一条公开需求及待办草稿' })),
        query: Type.Optional(Type.String({ description: '在工作台需求标题和备注中搜索，最多 200 字' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: '每页最多 10 条；不传时默认 5 条' })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, description: '搜索/摘要页或指定需求待办草稿的起始位置' })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return requirementsContextResult(deps.store, params, maxChars);
      },
    },
  ];
}

type ContextParams = { requirementId?: string; query?: string; limit?: number; offset?: number };
type RequirementRow = Record<string, unknown> & { id: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseContextParams(raw: unknown): ContextParams {
  if (!isObject(raw) || Object.keys(raw).some(key => !['requirementId', 'query', 'limit', 'offset'].includes(key))) {
    throw new WorkbenchInputError('需求上下文查询字段不合法');
  }
  const { requirementId, query, limit, offset } = raw;
  if ((requirementId !== undefined && (typeof requirementId !== 'string' || requirementId.trim() === ''))
    || (query !== undefined && (typeof query !== 'string' || query.length > 200))
    || (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10))
    || (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10000))
    || (requirementId !== undefined && query !== undefined)) {
    throw new WorkbenchInputError('需求上下文查询参数不合法');
  }
  return { requirementId: requirementId as string | undefined, query: query as string | undefined,
    limit: limit as number | undefined, offset: offset as number | undefined };
}

function orderedRequirements(store: WorkbenchStore): RequirementRow[] {
  return (store.listRecords('requirements') as RequirementRow[])
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
}

function publicSummary(store: WorkbenchStore, row: RequirementRow): Record<string, unknown> {
  return {
    id: row.id,
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    ...(typeof row.status === 'string' ? { status: row.status } : {}),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    currentVersion: getPublicRequirementVersion(store, row.id),
  };
}

function counts(rows: RequirementRow[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    if (typeof row.status === 'string' && row.status !== '') result[row.status] = (result[row.status] ?? 0) + 1;
  }
  return result;
}

function noteExcerpt(note: string, query: string, maxChars: number): string {
  if (maxChars < 1) return '';
  const index = note.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = index < 0 ? 0 : Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(note.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${note.slice(start, end)}${end < note.length ? '…' : ''}`;
}

function publicTaskDraft(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  return {
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.priority === 'string' ? { priority: value.priority } : {}),
    ...(typeof value.due === 'string' || value.due === null ? { due: value.due } : {}),
    ...(typeof value.tag === 'string' ? { tag: value.tag } : {}),
  };
}

function contextData(store: WorkbenchStore, params: ContextParams, pageLimit: number, excerptLimit: number): Record<string, unknown> {
  const base = buildRequirementsWorkbenchContext(store);
  const rows = orderedRequirements(store);
  const offset = params.offset ?? 0;

  if (params.requirementId !== undefined) {
    const row = rows.find(item => item.id === params.requirementId);
    if (!row) throw new WorkbenchInputError('需求不存在', 404);
    const rawDrafts = Array.isArray(row.taskDrafts) ? row.taskDrafts : [];
    const note = typeof row.note === 'string' ? row.note : '';
    const drafts = rawDrafts.slice(offset, offset + pageLimit).map(publicTaskDraft);
    const overview = base.requirements as { total: number; statusCounts: Record<string, number> };
    return {
      hostApplication: base.hostApplication,
      target: base.target,
      dataScope: base.dataScope,
      requirements: { total: overview.total, statusCounts: overview.statusCounts, items: [] },
      record: {
        id: row.id,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
        ...(typeof row.status === 'string' ? { status: row.status } : {}),
        ...(typeof row.priority === 'string' ? { priority: row.priority } : {}),
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
        note: noteExcerpt(note, '', excerptLimit),
        noteLength: note.length,
        noteTruncated: note.length > excerptLimit,
        taskDrafts: drafts,
        taskDraftsTotal: rawDrafts.length,
        taskDraftsOffset: offset,
        taskDraftsHasMore: offset + drafts.length < rawDrafts.length,
        currentVersion: getPublicRequirementVersion(store, row.id),
      },
      truncated: note.length > excerptLimit || offset + drafts.length < rawDrafts.length,
    };
  }

  const query = params.query?.trim() ?? '';
  const matches = query === '' ? rows : rows.filter(row =>
    `${String(row.title ?? '')}\n${String(row.note ?? '')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const page = matches.slice(offset, offset + pageLimit);
  const items = page.map(row => ({
    ...publicSummary(store, row),
    ...(query !== '' && typeof row.note === 'string' && row.note.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      ? { noteExcerpt: noteExcerpt(row.note, query, excerptLimit), noteTruncated: row.note.length > excerptLimit } : {}),
  }));
  const overview = base.requirements as { total: number; statusCounts: Record<string, number> };
  return {
    hostApplication: base.hostApplication,
    target: base.target,
    dataScope: base.dataScope,
    ...(query === '' ? {} : { query }),
    requirements: {
      total: query === '' ? overview.total : matches.length,
      statusCounts: query === '' ? overview.statusCounts : counts(matches),
      items,
      offset,
      limit: pageLimit,
      returned: items.length,
      hasMore: offset + items.length < matches.length,
    },
    ...(query !== '' && page.some(row => typeof row.note === 'string' && row.note.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      ? { truncated: items.some(item => item.noteTruncated === true) } : {}),
  };
}

function compactResult(data: Record<string, unknown>, maxChars: number): AgentToolResult<unknown> {
  const serialized = JSON.stringify(data);
  if (serialized.length <= maxChars) return { content: [{ type: 'text', text: serialized }], details: { data } };
  const fallback = { truncated: true, message: '结果超过长度限制；请减小 limit 或使用 offset 分页。' };
  const text = JSON.stringify(fallback);
  if (text.length <= maxChars) return { content: [{ type: 'text', text }], details: { data: fallback } };
  const minimal = maxChars >= 18 ? '{"truncated":true}' : '{}';
  return { content: [{ type: 'text', text: minimal }], details: { data: JSON.parse(minimal) } };
}

function requirementsContextResult(store: WorkbenchStore, raw: unknown, maxChars: number): AgentToolResult<unknown> {
  const params = parseContextParams(raw);
  let pageLimit = params.limit ?? 5;
  let excerptLimit = params.requirementId === undefined ? 240 : 5000;
  while (true) {
    const data = contextData(store, params, pageLimit, excerptLimit);
    if (JSON.stringify(data).length <= maxChars) return compactResult(data, maxChars);
    if (excerptLimit > 0) {
      excerptLimit = Math.floor(excerptLimit / 2);
      continue;
    }
    if (pageLimit > 0) {
      pageLimit = Math.floor(pageLimit / 2);
      continue;
    }
    return compactResult({ truncated: true, message: '结果超过长度限制；请减小 limit 或使用 offset 分页。' }, maxChars);
  }
}
