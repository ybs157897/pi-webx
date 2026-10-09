import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import type { ChatroomService } from '../chatroom/service';
import { importRequirementTasks, saveRequirementDraft } from './import-tasks';
import type { RequirementProjection } from './projection';
import { normalizeTaskDrafts } from './schema.mjs';

type RecordRow = Record<string, unknown> & { id: string };
type DispatchResult = { requirement: RecordRow; tasks: RecordRow[]; alreadyDispatched: boolean };
const KEYS = new Set(['entryKey', 'id', 'title', 'note', 'priority', 'category', 'taskDrafts']);

/** A mentioned requirements Agent owns draft preparation and its atomic todo import. */
export function dispatchRequirementTasks(store: WorkbenchStore, chatroom: ChatroomService, sessionId: string, raw: unknown): DispatchResult {
  const delivery = chatroom.getDelivery(sessionId);
  if (!delivery || delivery.recipientId !== 'requirements') throw new WorkbenchInputError('只能由群里被点名的需求 Agent 整理并导入待办', 403);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !KEYS.has(key))) {
    throw new WorkbenchInputError('需求交接参数不合法');
  }
  const { entryKey, id, title, note, priority, category, taskDrafts } = raw as Record<string, unknown>;
  if (typeof entryKey !== 'string' || !/^[\w.:-]{1,80}$/.test(entryKey)) throw new WorkbenchInputError('需求交接需要稳定的 entryKey');
  let normalizedDrafts;
  try { normalizedDrafts = normalizeTaskDrafts(taskDrafts); }
  catch (error) { throw new WorkbenchInputError(error instanceof Error ? error.message : '待办草稿不合法'); }
  const fields = { id, title, note: note ?? '', priority: priority ?? 'normal', category, taskDrafts: normalizedDrafts };
  // 派工指纹与保存回执同一套语义等价归一化：create 的默认分类（省略或显式
  // new）不进指纹，与引入 category 前持久化的旧派工回执可比，省略与显式
  // new 互为重试；显式非默认分类（及 update 显式传分类）才改变指纹。
  const fingerprintFields = { ...fields } as typeof fields & { category?: unknown };
  if (id === undefined && (category === undefined || category === 'new')) delete fingerprintFields.category;
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintFields)).digest('hex');
  store.sqlite.exec(`CREATE TABLE IF NOT EXISTS requirement_chatroom_dispatches (
    message_id TEXT NOT NULL, entry_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(message_id, entry_key)
  )`);
  const priorContext = structuredClone(delivery.context);
  try {
    return store.sqlite.transaction(() => {
      const previous = store.sqlite.prepare('SELECT fingerprint, result FROM requirement_chatroom_dispatches WHERE message_id = ? AND entry_key = ?')
        .get(delivery.id, entryKey) as { fingerprint: string; result: string } | undefined;
      let result: DispatchResult;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new WorkbenchInputError('entryKey 已用于不同需求，不能重复导入', 409);
        result = { ...JSON.parse(previous.result) as DispatchResult, alreadyDispatched: true };
      } else {
        const targetId = id;
        let sourceSessionId = sessionId;
        if (targetId !== undefined) {
          if (typeof targetId !== 'string') throw new WorkbenchInputError('需求 ID 不合法');
          const target = store.listRecords('requirements').find(row => row.id === targetId);
          if (!target) throw new WorkbenchInputError('交接需求不存在', 404);
          if (target.sourceSessionId !== sessionId) {
            if (target.id !== delivery.context.requirementId || target.updatedAt !== delivery.context.expectedUpdatedAt) {
              throw new WorkbenchInputError('需求不属于当前交接，或交接后已修改', 409);
            }
            if (typeof target.sourceSessionId !== 'string' || !target.sourceSessionId) throw new WorkbenchInputError('需求来源缺失', 409);
            sourceSessionId = target.sourceSessionId;
          }
        }
        const requirement = saveRequirementDraft(store, sourceSessionId, { ...fields, id: targetId });
        const imported = importRequirementTasks(store, requirement.id, { expectedUpdatedAt: requirement.updatedAt });
        result = { requirement: imported.requirement, tasks: imported.tasks, alreadyDispatched: false };
        store.sqlite.prepare('INSERT INTO requirement_chatroom_dispatches(message_id, entry_key, fingerprint, result) VALUES (?, ?, ?, ?)')
          .run(delivery.id, entryKey, fingerprint, JSON.stringify(result));
      }
      chatroom.attachRequirement(sessionId, result.requirement, { newRequirement: id === undefined });
      chatroom.attachTasks(sessionId, result.tasks);
      return result;
    })();
  } catch (error) {
    delivery.context = priorContext;
    throw error;
  }
}

export function createRequirementsDispatchTool(store: WorkbenchStore, chatroom: ChatroomService, projection?: RequirementProjection): ToolDefinition {
  const priority = Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')]);
  const category = Type.Union([
    Type.Literal('new'), Type.Literal('change'), Type.Literal('fix'), Type.Literal('enhancement'),
  ], { description: '需求分类标记：new 新功能 / change 需求变更 / fix 问题修复 / enhancement 体验优化；省略时按新功能保存' });
  return {
    name: 'requirements_dispatch', label: '整理需求并加入待办',
    description: '在群聊中被 @需求管理 接到需要实施的需求后，将澄清完的需求和待办一次保存并导入。必须写清目标、范围、约束与验收条件；缺少关键条件先在群里提问。成功返回真实待办 ID，随后用 chatroom_send 发 @代码开发 并交代实施要求，引用自动随交接传递。稳定 entryKey 防止重试重复创建；不写排期。',
    parameters: Type.Object({
      entryKey: Type.String({ minLength: 1, maxLength: 80 }),
      id: Type.Optional(Type.String({ description: '复用当前交接关联的未导入草稿时显式传其 ID；新需求省略，不要用旧话题 ID 冒充新需求' })),
      title: Type.String({ minLength: 1, maxLength: 200 }),
      note: Type.String({ minLength: 1, maxLength: 5000, description: '目标、范围、约束和每项验收条件' }),
      priority: Type.Optional(priority),
      category: Type.Optional(category),
      taskDrafts: Type.Array(Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }), priority: Type.Optional(priority),
        due: Type.Optional(Type.Union([Type.String(), Type.Null()])), tag: Type.Optional(Type.String()),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new WorkbenchInputError('需求交接已取消', 409);
      const data = dispatchRequirementTasks(store, chatroom, ctx.sessionManager.getSessionId(), params);
      // 投影刷新失败只记日志，不阻塞工具结果，也不回滚已导入的待办；
      // await 保证返回结果时写盘已结束，不与调用方的目录清理竞争。
      await projection?.sync().catch((error) => console.warn('[requirements] 需求投影刷新失败', error));
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: { data } };
    },
  };
}
