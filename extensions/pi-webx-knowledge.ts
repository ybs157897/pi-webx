/**
 * pi extension: 把工作台知识库 REST 包成一个 knowledge 工具，供 AI 会话检索与沉淀结论。
 * 只调用现有 HTTP 协议；字段校验、时间戳与 [[标题]] 双链仍由服务端负责，避免第二套写入语义。
 *
 * 部署：cp extensions/pi-webx-knowledge.ts ~/.pi/agent/extensions/pi-webx-knowledge.ts
 * 默认连接 127.0.0.1:8790；仓库服务端若按默认 8787 启动，需设置
 * PI_WEBX_WORKBENCH_URL=http://127.0.0.1:8787。
 */

// @ts-nocheck — 与 pi-webx-todo.ts 一样，由 pi 运行时加载 typebox。
import { Type } from 'typebox';

const ACTIONS = ['search', 'read', 'create', 'update'];
const ActionSchema = Type.Unsafe({
  type: 'string', enum: ACTIONS,
  description: 'search 检索知识 | read 读取全文 | create 沉淀结论 | update 修订知识',
});

const KnowledgeParams = Type.Object({
  action: ActionSchema,
  q: Type.Optional(Type.String({ description: 'search 用：要检索的关键词' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'search 用：最多返回多少条，1–20；服务端全库检索上限为 20' })),
  id: Type.Optional(Type.String({ description: 'read/update 用：知识条目 id' })),
  title: Type.Optional(Type.String({ description: 'create 必填，update 可选：一句话结论式标题' })),
  body: Type.Optional(Type.String({ description: '正文可用 [[已有标题]] 引用知识，服务端自动解析双链' })),
  tags: Type.Optional(Type.Array(Type.String(), { description: '来源模块名或类别，最多 8 个' })),
  refs: Type.Optional(Type.Array(Type.Object({
    type: Type.String({ description: '来源模块 key，如 requirements、fixes、logs' }),
    id: Type.String({ description: '来源记录 id' }),
  }), { description: 'create 用：尽量带来源记录，最多 20 条' })),
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const trim = value => (typeof value === 'string' ? value.trim() : '');
const result = (action, data) => ({
  content: [{ type: 'text', text: data.ok ? JSON.stringify(data, null, 2) : `knowledge ${action} 未完成：${data.error}` }],
  details: { action, ...data },
});
const reject = (action, error) => result(action, { ok: false, error });

function validate(params) {
  const action = params?.action;
  if (!ACTIONS.includes(action)) return { error: 'action 只能是 search、read、create 或 update' };
  if (action === 'search') {
    const q = trim(params.q);
    if (q === '') return { action, error: 'search 需要非空关键词 q' };
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 20)) {
      return { action, error: 'limit 需要是 1–20 的整数' };
    }
    return { action, q, limit: params.limit ?? 20 };
  }
  if (action === 'read' || action === 'update') {
    if (trim(params.id) === '') return { action, error: `${action} 需要知识条目 id` };
  }
  if (action === 'create' && trim(params.title) === '') return { action, error: 'create 需要非空的一句话结论标题 title' };
  if (action === 'create' || action === 'update') {
    if (params.title !== undefined && (typeof params.title !== 'string' || trim(params.title) === '')) {
      return { action, error: 'title 需要是非空字符串' };
    }
    if (params.body !== undefined && typeof params.body !== 'string') return { action, error: 'body 需要是字符串' };
    if (params.tags !== undefined && !Array.isArray(params.tags)) return { action, error: 'tags 需要是字符串数组' };
    if (action === 'create' && params.refs !== undefined && !Array.isArray(params.refs)) {
      return { action, error: 'refs 需要是 { type, id } 数组' };
    }
    if (action === 'update' && !['title', 'body', 'tags'].some(key => params[key] !== undefined)) {
      return { action, error: 'update 至少要提供 title、body 或 tags 中的一项' };
    }
  }
  return { action, id: trim(params.id) };
}

function baseUrl() {
  const base = (process.env.PI_WEBX_WORKBENCH_URL?.trim() || 'http://127.0.0.1:8790').replace(/\/+$/, '');
  return base.endsWith('/api/workbench') ? base : `${base}/api/workbench`;
}

async function request(path, init, signal) {
  let response;
  try {
    response = await fetch(`${baseUrl()}${path}`, { ...init, signal });
  } catch (error) {
    throw new Error(`无法连接工作台：${error instanceof Error ? error.message : String(error)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`工作台返回了无法读取的响应（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `工作台请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

export default function piWebxKnowledgeExtension(pi) {
  pi.registerTool({
    name: 'knowledge',
    label: '知识库',
    description: '检索、读取、沉淀或修订工作台知识。写入走现有 REST，正文中的 [[标题]] 由服务端解析为双链。',
    promptSnippet: 'knowledge: search/read/create/update 工作台知识；title 写一句话结论，body 可用 [[已有标题]] 关联旧知识。',
    promptGuidelines: [
      'create 的 title 写一句话结论，直接说清场景与做法，不只写主题词。',
      'body 用 [[已有标题]] 关联旧知识；先 search 查到精确标题再引用。',
      'create 时 refs 尽量带产出本知识的来源记录 { type, id }，type 用模块 key。',
      'tags 用来源模块名或类别，便于后续检索。',
    ],
    parameters: KnowledgeParams,

    async execute(_toolCallId, params, signal) {
      const checked = validate(params);
      const action = checked.action ?? String(params?.action ?? 'unknown');
      if (checked.error) return reject(action, checked.error);
      try {
        if (action === 'search') {
          const payload = await request(`/search?q=${encodeURIComponent(checked.q)}`, undefined, signal);
          if (!Array.isArray(payload?.results)) throw new Error('工作台检索响应缺少 results 数组');
          const hits = payload.results.filter(hit => hit?.module === 'knowledge').slice(0, checked.limit);
          return result(action, { ok: true, hits });
        }
        if (action === 'read') {
          const payload = await request('/state', undefined, signal);
          if (!Array.isArray(payload?.data?.knowledge)) throw new Error('工作台状态响应缺少 knowledge 数组');
          const record = payload.data.knowledge.find(row => row?.id === checked.id);
          if (!record) return reject(action, `找不到 id 为 ${checked.id} 的知识条目`);
          return result(action, { ok: true, record });
        }
        const fields = {};
        for (const key of action === 'create' ? ['title', 'body', 'tags', 'refs'] : ['title', 'body', 'tags']) {
          if (params[key] !== undefined) fields[key] = params[key];
        }
        const path = action === 'create' ? '/knowledge' : `/knowledge/${encodeURIComponent(checked.id)}`;
        const payload = await request(path, {
          method: action === 'create' ? 'POST' : 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
        }, signal);
        if (!isRecord(payload?.record)) throw new Error('工作台写入响应缺少 record 对象');
        return result(action, { ok: true, record: payload.record });
      } catch (error) {
        return reject(action, error instanceof Error ? error.message : String(error));
      }
    },
  });
}
