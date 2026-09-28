/**
 * 模块 Agent 的知识访问：绑定表 + 受限四操作。
 *
 * 绑定只存 `(workspaceKey, agentId) → homeBaseId + 共享只读库`，正文留在原有
 * workbench_records；`KnowledgeAccess` 在装配时把可读集闭包进方法里，模型参数
 * 不带身份——越界的 read/update 返回统一拒绝，不泄露目标条目的标题或存在性。
 */
import type { WorkbenchStore } from '../workbench/store';
import type { AgentId } from './contracts';

export interface KnowledgeBinding {
  workspaceKey: string;
  agentId: AgentId;
  homeBaseId: string;
  sharedReadBaseIds: string[];
}

export type KnowledgeResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; error: string };

export interface KnowledgeAccess {
  search(query: string, limit: number): { ok: true; hits: Array<{ id: string; title: string; snippet: string; knowledgeBaseId: string }> };
  read(id: string): KnowledgeResult;
  create(fields: { title: string; body?: string; tags?: string[]; refs?: Array<{ type: string; id: string }> }): KnowledgeResult;
  update(id: string, patch: { title?: string; body?: string; tags?: string[] }): KnowledgeResult;
}

/** 不存在与越界同文案：存在性探测不能靠两种报错区分出别库 id 是否真实存在。 */
const NOT_FOUND_OR_OUT_OF_SCOPE = '找不到该知识条目或它不在本 Agent 可访问范围';

function ensureTable(db: WorkbenchStore['sqlite']): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_agent_knowledge_bindings (
      workspace_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      home_base_id TEXT NOT NULL,
      shared_read_base_ids_json TEXT NOT NULL,
      PRIMARY KEY (workspace_key, agent_id)
    )
  `);
}

/** 只读查找绑定：能力展示用，不为查询而创建知识库。 */
export function readBinding(
  store: WorkbenchStore,
  workspaceKey: string,
  agentId: AgentId,
): KnowledgeBinding | null {
  const db = store.sqlite;
  ensureTable(db);
  const row = db.prepare(
    'SELECT home_base_id, shared_read_base_ids_json FROM module_agent_knowledge_bindings WHERE workspace_key = ? AND agent_id = ?',
  ).get(workspaceKey, agentId) as { home_base_id: string; shared_read_base_ids_json: string } | undefined;
  if (row === undefined) return null;
  return {
    workspaceKey,
    agentId,
    homeBaseId: row.home_base_id,
    sharedReadBaseIds: JSON.parse(row.shared_read_base_ids_json) as string[],
  };
}

/**
 * 幂等建立或读回绑定。已有绑定原样返回——homeBinding 是逻辑名，重绑语义不在
 * 这里；没有时在同一事务里先建知识库再落绑定，并发首轮也只会有一个结果。
 */
export function ensureBinding(
  store: WorkbenchStore,
  workspaceKey: string,
  agentId: AgentId,
  homeBinding: string,
): KnowledgeBinding {
  const db = store.sqlite;
  ensureTable(db);
  const select = db.prepare(
    'SELECT home_base_id, shared_read_base_ids_json FROM module_agent_knowledge_bindings WHERE workspace_key = ? AND agent_id = ?',
  );
  const insert = db.prepare(
    'INSERT INTO module_agent_knowledge_bindings (workspace_key, agent_id, home_base_id, shared_read_base_ids_json) VALUES (?, ?, ?, ?)',
  );

  const existing = select.get(workspaceKey, agentId) as { home_base_id: string; shared_read_base_ids_json: string } | undefined;
  if (existing !== undefined) {
    return {
      workspaceKey,
      agentId,
      homeBaseId: existing.home_base_id,
      sharedReadBaseIds: JSON.parse(existing.shared_read_base_ids_json) as string[],
    };
  }

  return db.transaction((): KnowledgeBinding => {
    const raced = select.get(workspaceKey, agentId) as { home_base_id: string; shared_read_base_ids_json: string } | undefined;
    if (raced !== undefined) {
      return {
        workspaceKey,
        agentId,
        homeBaseId: raced.home_base_id,
        sharedReadBaseIds: JSON.parse(raced.shared_read_base_ids_json) as string[],
      };
    }
    const base = store.addRecord('knowledgeBases', {
      title: `${agentId} Agent 知识库`,
      description: `模块 Agent「${homeBinding}」的专属知识库`,
    });
    const binding: KnowledgeBinding = {
      workspaceKey,
      agentId,
      homeBaseId: String(base.id),
      sharedReadBaseIds: [],
    };
    insert.run(workspaceKey, agentId, binding.homeBaseId, '[]');
    return binding;
  })();
}

/**
 * 受限知识口。可读集 = home ∪ sharedRead；写集只有 home。create 的归属库由
 * 服务端填，调用方给的 knowledgeBaseId/folderId 一律忽略；update 同理剔除，
 * 不能借字段把条目挪出作用域。
 */
export function createKnowledgeAccess(store: WorkbenchStore, binding: KnowledgeBinding): KnowledgeAccess {
  const readable = new Set([binding.homeBaseId, ...binding.sharedReadBaseIds]);

  return {
    search(query, limit) {
      const hits = store.searchKnowledge([...readable], query, limit);
      return { ok: true, hits };
    },

    read(id) {
      const record = store.readKnowledge(id);
      if (record === null) return { ok: false, error: NOT_FOUND_OR_OUT_OF_SCOPE };
      if (!readable.has(String(record.knowledgeBaseId))) return { ok: false, error: NOT_FOUND_OR_OUT_OF_SCOPE };
      return { ok: true, record };
    },

    create(fields) {
      try {
        const record = store.addRecord('knowledge', {
          title: fields.title,
          ...(fields.body === undefined ? {} : { body: fields.body }),
          ...(fields.tags === undefined ? {} : { tags: fields.tags }),
          ...(fields.refs === undefined ? {} : { refs: fields.refs }),
          knowledgeBaseId: binding.homeBaseId,
        });
        return { ok: true, record };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    update(id, patch) {
      const record = store.readKnowledge(id);
      if (record === null) return { ok: false, error: NOT_FOUND_OR_OUT_OF_SCOPE };
      if (String(record.knowledgeBaseId) !== binding.homeBaseId) return { ok: false, error: NOT_FOUND_OR_OUT_OF_SCOPE };
      try {
        const updated = store.updateRecord('knowledge', id, {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        });
        return { ok: true, record: updated };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
