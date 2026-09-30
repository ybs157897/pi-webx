import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { WorkbenchStore } from '../../workbench/store';
import { WorkbenchInputError } from '../../workbench/store';
import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import {
  CHATROOM_ID, CHATROOM_MAX_BODY_CHARS, CHATROOM_MAX_DEPTH,
  CHATROOM_MAX_THREAD_MESSAGES, CHATROOM_MEMBER_NAMES, CHATROOM_NAME, CHATROOM_USER_NAME,
  type ChatroomContext, type ChatroomMessage, type ChatroomPublicMessage,
  type ChatroomReadResult, type ChatroomRunner, type ChatroomSendInput, type ChatroomUserSendInput,
  type ConsumptionStatus, type ChatroomConsumption,
} from './contracts';
import { ChatroomStore, publicMessage } from './store';
import { parseChatroomMentions } from '../../../src/shared/chatroom-mentions.mjs';

const services = new WeakMap<WorkbenchStore, Map<string, ChatroomService>>();
const SEND_KEYS = new Set(['to', 'body', 'entryKey', 'requirementId', 'expectedUpdatedAt', 'taskIds']);
const USER_SEND_KEYS = new Set(['body', 'entryKey', 'replyTo']);

function validAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

function bad(message: string, status = 400): never {
  throw new WorkbenchInputError(message, status);
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > CHATROOM_MAX_THREAD_MESSAGES
    || value.some(id => typeof id !== 'string' || id.trim() === '' || id.length > 200)) {
    return bad('待办 ID 列表不合法');
  }
  const unique = [...new Set(value as string[])];
  if (unique.length !== value.length) return bad('待办 ID 不能重复');
  return unique;
}

function normalizeInput(raw: ChatroomSendInput): ChatroomSendInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !SEND_KEYS.has(key))) return bad('群消息参数包含未知字段');
  if (typeof raw.body !== 'string') return bad('群消息正文必须是文本');
  const body = raw.body.trim();
  if (!body || body.length > CHATROOM_MAX_BODY_CHARS) return bad('群消息正文须为 1 到 12000 字');
  if (typeof raw.entryKey !== 'string' || !raw.entryKey.trim() || raw.entryKey.length > 200) {
    return bad('entryKey 须为 1 到 200 字');
  }
  if (raw.to !== undefined && !validAgentId(raw.to)) return bad('未知收件 Agent');
  if (raw.requirementId !== undefined && (typeof raw.requirementId !== 'string' || !raw.requirementId.trim())) {
    return bad('需求 ID 不合法');
  }
  if (raw.expectedUpdatedAt !== undefined && (typeof raw.expectedUpdatedAt !== 'string' || !raw.expectedUpdatedAt.trim())) {
    return bad('需求版本不合法');
  }
  return {
    ...(raw.to === undefined ? {} : { to: raw.to }), body, entryKey: raw.entryKey.trim(),
    ...(raw.requirementId === undefined ? {} : { requirementId: raw.requirementId }),
    ...(raw.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: raw.expectedUpdatedAt }),
    ...(raw.taskIds === undefined ? {} : { taskIds: ids(raw.taskIds) }),
  };
}

function recipientFromBody(body: string): AgentId | null {
  const parsed = parseChatroomMentions(body);
  if (parsed.unknownMentions.length > 0) bad(`未知 @成员：${parsed.unknownMentions.join('、')}`);
  if (parsed.multipleRecipients) bad('一条群消息只能 @ 一位接收成员');
  const recipient = parsed.recipientId;
  if (recipient !== null && !validAgentId(recipient)) bad('未知收件 Agent');
  return recipient;
}

function routedAgentInput(input: ChatroomSendInput): ChatroomSendInput {
  const mentioned = recipientFromBody(input.body);
  if (input.to && mentioned && input.to !== mentioned) bad('正文 @成员与 to 指定的接收成员不一致');
  const to = input.to ?? mentioned;
  if (!to) return input;
  const body = mentioned ? input.body : `@${CHATROOM_MEMBER_NAMES[to]} ${input.body}`;
  if (body.length > CHATROOM_MAX_BODY_CHARS) bad('群消息正文须为 1 到 12000 字');
  return { ...input, to, body };
}

function normalizeUserInput(raw: ChatroomUserSendInput): ChatroomUserSendInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !USER_SEND_KEYS.has(key))) return bad('用户群消息包含未知字段');
  if (typeof raw.body !== 'string') return bad('群消息正文必须是文本');
  const body = raw.body.trim();
  if (!body || body.length > CHATROOM_MAX_BODY_CHARS) return bad('群消息正文须为 1 到 12000 字');
  if (typeof raw.entryKey !== 'string' || !raw.entryKey.trim() || raw.entryKey.length > 200) {
    return bad('entryKey 须为 1 到 200 字');
  }
  if (raw.replyTo !== undefined && (typeof raw.replyTo !== 'string' || !raw.replyTo.trim() || raw.replyTo.length > 200)) {
    return bad('回复目标消息 ID 不合法');
  }
  return { body, entryKey: raw.entryKey.trim(), ...(raw.replyTo === undefined ? {} : { replyTo: raw.replyTo }) };
}

function requestHash(input: ChatroomSendInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.to ?? null, input.body, input.requirementId ?? null,
    input.expectedUpdatedAt ?? null, input.taskIds ?? null,
  ])).digest('hex');
}

function userRequestHash(input: ChatroomUserSendInput, recipientId: AgentId | null): string {
  return createHash('sha256').update(JSON.stringify([input.body, recipientId, input.replyTo ?? null])).digest('hex');
}

export class ChatroomService {
  readonly storage: ChatroomStore;
  private readonly active = new Map<string, ChatroomMessage>();
  private readonly revokedSessions = new Set<string>();
  private runner: ChatroomRunner | undefined;
  private worker: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly store: WorkbenchStore, readonly workspaceKey = 'default') {
    if (!workspaceKey.trim()) bad('聊天室工作区标识缺失');
    this.storage = new ChatroomStore(store, workspaceKey);
  }

  getDelivery(sessionId: string): ChatroomMessage | undefined {
    return this.active.get(sessionId);
  }

  prepareConsumptions(messageId: string, agents: readonly AgentId[]): ChatroomConsumption[] {
    const existed = this.storage.consumptions.list(messageId).length > 0;
    const receipts = this.storage.consumptions.prepare(messageId, agents);
    if (!existed) {
      for (const receipt of receipts) this.logConsumption(messageId, receipt);
    }
    return receipts;
  }

  updateConsumption(messageId: string, agentId: AgentId, status: Exclude<ConsumptionStatus, 'pending'>, error?: string): void {
    const previous = this.storage.consumptions.list(messageId).find(item => item.agentId === agentId);
    this.storage.consumptions.update(messageId, agentId, status, error);
    const receipt = this.storage.consumptions.list(messageId).find(item => item.agentId === agentId);
    if (receipt && receipt.status !== previous?.status) this.logConsumption(messageId, receipt);
  }

  private logConsumption(messageId: string, receipt: ChatroomConsumption): void {
    console.info('[pi-webx:chatroom]', JSON.stringify({
      event: 'consumption', messageId, agentId: receipt.agentId, status: receipt.status,
      ...(receipt.error ? { error: receipt.error } : {}),
    }));
  }

  private failOutstandingConsumptions(messageId: string, error: string): number {
    const active = new Set(this.storage.consumptions.list(messageId)
      .filter(item => ['pending', 'evaluating', 'processing'].includes(item.status)).map(item => item.agentId));
    const changed = this.storage.consumptions.failOutstanding(messageId, error);
    if (changed) {
      for (const receipt of this.storage.consumptions.list(messageId)) {
        if (active.has(receipt.agentId)) this.logConsumption(messageId, receipt);
      }
    }
    return changed;
  }

  /** A server-issued, durable browser key scopes idempotency; arbitrary cookie values are ignored. */
  ensureUserSession(existing?: string): string {
    if (existing && this.storage.hasUserSession(existing)) return existing;
    const created = randomBytes(32).toString('hex');
    this.storage.createUserSession(created);
    return created;
  }

  /** Publications fan out to every other enabled member; the active copy is bound to the claiming agent. */
  async withDelivery<T>(sessionId: string, message: ChatroomMessage, agentId: AgentId, fn: () => Promise<T>): Promise<T> {
    if (!sessionId || this.active.has(sessionId) || this.revokedSessions.has(sessionId)) {
      return bad('目标会话投递身份冲突', 409);
    }
    const current = this.storage.byId(message.id);
    if (!current || current.deliveryStatus !== 'running') {
      return bad('群消息不在可投递状态', 409);
    }
    const authorized = current.recipientId === agentId
      || (current.recipientId === null && current.claimants.includes(agentId));
    if (!authorized) return bad('该成员无权投递这条群消息', 403);
    const bound = message.recipientId === null ? { ...message, recipientId: agentId } : message;
    this.active.set(sessionId, bound);
    try {
      return await fn();
    } finally {
      this.active.delete(sessionId);
      this.revokedSessions.add(sessionId);
    }
  }

  /** The fan-out runner records self-claimed members before their full turn; routing fact only. */
  recordClaimants(messageId: string, claimants: readonly AgentId[]): void {
    const unique = [...new Set(claimants)];
    if (unique.some(id => !validAgentId(id))) bad('认领成员不合法');
    const current = this.storage.byId(messageId);
    if (!current || current.deliveryStatus !== 'running' || current.recipientId !== null) {
      bad('群消息不在可认领状态', 409);
    }
    this.storage.setClaimants(messageId, unique);
  }

  /** A receiving domain Agent may attach only tasks that now exist at these exact versions. */
  attachTasks(sessionId: string, tasks: readonly { id: string; updatedAt?: unknown }[]): void {
    const delivery = this.active.get(sessionId);
    if (!delivery || (delivery.recipientId !== 'assistant' && delivery.recipientId !== 'requirements')) {
      bad('只有投递中的需求或助理会话可绑定待办', 403);
    }
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > CHATROOM_MAX_THREAD_MESSAGES) bad('待办列表不合法');
    const taskIds = ids(tasks.map(task => task.id));
    const records = new Map(this.store.listRecords('tasks').map(task => [task.id, task]));
    const taskVersions: Record<string, string> = {};
    for (const task of tasks) {
      const row = records.get(task.id);
      if (!row || typeof task.updatedAt !== 'string' || row.updatedAt !== task.updatedAt) {
        bad('待办不存在或版本已变化', 409);
      }
      taskVersions[task.id] = task.updatedAt;
    }
    delivery.context = { ...delivery.context, taskIds, taskVersions };
    this.storage.updateContext(delivery.id, delivery.context);
  }

  /** Bind the requirement saved by this receiving requirements session, never a caller-supplied reference. */
  attachRequirement(sessionId: string, requirement: { id: string; updatedAt?: unknown }): void {
    const delivery = this.active.get(sessionId);
    if (!delivery || delivery.recipientId !== 'requirements') bad('只有投递中的需求会话可绑定需求', 403);
    if (!requirement || typeof requirement.id !== 'string' || typeof requirement.updatedAt !== 'string') {
      bad('需求记录及版本不合法');
    }
    const row = this.store.sqlite.prepare("SELECT payload FROM workbench_records WHERE module = 'requirements' AND id = ?")
      .get(requirement.id) as { payload: string } | undefined;
    const saved = row ? JSON.parse(row.payload) as Record<string, unknown> : undefined;
    const currentSession = saved?.sourceSessionId === sessionId;
    const inheritedSource = delivery.context.requirementId === requirement.id;
    if (!saved || (!currentSession && !inheritedSource)) bad('需求不属于当前交接上下文', 403);
    if (saved.updatedAt !== requirement.updatedAt) bad('需求版本已变化', 409);
    delivery.context = { ...delivery.context, requirementId: requirement.id, expectedUpdatedAt: requirement.updatedAt };
    this.storage.updateContext(delivery.id, delivery.context);
  }

  send(senderId: AgentId, sessionId: string, raw: ChatroomSendInput): ChatroomMessage {
    if (!validAgentId(senderId)) bad('未知发言 Agent');
    if (typeof sessionId !== 'string' || !sessionId.trim()) bad('发言会话身份缺失');
    if (this.revokedSessions.has(sessionId)) bad('接收会话已结束，不能再发送群消息', 409);
    const input = routedAgentInput(normalizeInput(raw));
    const hash = requestHash(input);
    const saved = this.storage.transaction(() => {
      const existing = this.storage.byEntry(sessionId, input.entryKey);
      if (existing) {
        if (existing.senderId !== senderId || existing.requestHash !== hash) bad('entryKey 已用于其他群消息', 409);
        return existing;
      }
      const parent = this.active.get(sessionId);
      if (parent && parent.recipientId !== senderId) bad('发言会话与接收 Agent 不一致', 403);
      if (parent && input.to === senderId) bad('投递中的 Agent 不能再点名自己', 409);
      const context = this.contextFor(senderId, sessionId, input, parent);
      const id = randomUUID();
      const threadId = parent?.threadId ?? id;
      const depth = parent ? parent.depth + 1 : 0;
      if (depth > CHATROOM_MAX_DEPTH) bad('内部群消息自动接力次数已达上限', 409);
      if (this.storage.countSinceUserAnchor(threadId) >= CHATROOM_MAX_THREAD_MESSAGES) bad('该群话题自动消息数已达上限', 409);
      return this.storage.insert({
        id, threadId, replyTo: parent?.id ?? null, senderId,
        senderName: CHATROOM_MEMBER_NAMES[senderId], recipientId: input.to ?? null,
        senderSessionId: sessionId, entryKey: input.entryKey, requestHash: hash,
        body: input.body, createdAt: new Date().toISOString(),
        deliveryStatus: 'pending', error: null, depth, context, claimants: [],
      });
    });
    if (saved.deliveryStatus === 'pending') this.kick();
    return saved;
  }

  /** Runtime-only fallback for a final answer. Quoted @text is visible but never routes work. */
  publishReply(senderId: AgentId, sessionId: string, raw: { body: string; entryKey: string }): ChatroomMessage {
    if (!validAgentId(senderId)) bad('未知发言 Agent');
    if (typeof sessionId !== 'string' || !sessionId.trim()) bad('发言会话身份缺失');
    if (this.revokedSessions.has(sessionId)) bad('接收会话已结束，不能再发送群消息', 409);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => key !== 'body' && key !== 'entryKey')) bad('回合正文参数不合法');
    const input = normalizeInput(raw);
    const hash = createHash('sha256').update(JSON.stringify(['runtime-reply', input.body])).digest('hex');
    return this.storage.transaction(() => {
      const existing = this.storage.byEntry(sessionId, input.entryKey);
      if (existing) {
        if (existing.senderId !== senderId || existing.requestHash !== hash) bad('entryKey 已用于其他群消息', 409);
        return existing;
      }
      const parent = this.active.get(sessionId);
      if (!parent || parent.recipientId !== senderId) bad('只能在当前群投递会话记录回合正文', 403);
      const depth = parent.depth + 1;
      if (depth > CHATROOM_MAX_DEPTH) bad('内部群消息自动接力次数已达上限', 409);
      if (this.storage.countSinceUserAnchor(parent.threadId) >= CHATROOM_MAX_THREAD_MESSAGES) {
        bad('该群话题自动消息数已达上限', 409);
      }
      return this.storage.insert({
        id: randomUUID(), threadId: parent.threadId, replyTo: parent.id,
        senderId, senderName: CHATROOM_MEMBER_NAMES[senderId], recipientId: null,
        senderSessionId: sessionId, entryKey: input.entryKey, requestHash: hash,
        body: input.body, createdAt: new Date().toISOString(),
        deliveryStatus: 'none', error: null, depth,
        context: this.contextFor(senderId, sessionId, input, parent), claimants: [],
      });
    });
  }

  /** Browser submissions are always the human member; mention text is the only recipient input. */
  sendUser(userSessionKey: string, raw: ChatroomUserSendInput): ChatroomMessage {
    if (!userSessionKey || !this.storage.hasUserSession(userSessionKey)) bad('用户群聊会话无效', 403);
    const input = normalizeUserInput(raw);
    const recipientId = recipientFromBody(input.body);
    const hash = userRequestHash(input, recipientId);
    const senderSessionId = `user:${userSessionKey}`;
    const saved = this.storage.transaction(() => {
      const existing = this.storage.byEntry(senderSessionId, input.entryKey);
      if (existing) {
        if (existing.senderId !== 'user' || existing.requestHash !== hash) bad('entryKey 已用于其他群消息', 409);
        return existing;
      }
      const parent = input.replyTo ? this.storage.byId(input.replyTo) : undefined;
      if (input.replyTo && !parent) bad('回复目标消息不存在', 404);
      const id = randomUUID();
      const context = { ...(parent?.context ?? {}) };
      delete context.reportedTaskIds;
      return this.storage.insert({
        id, threadId: parent?.threadId ?? id, replyTo: parent?.id ?? null,
        senderId: 'user', senderName: CHATROOM_USER_NAME, recipientId,
        senderSessionId, entryKey: input.entryKey, requestHash: hash,
        body: input.body, createdAt: new Date().toISOString(),
        deliveryStatus: 'pending', error: null,
        depth: 0, context, claimants: [],
      });
    });
    if (saved.deliveryStatus === 'pending') this.kick();
    return saved;
  }

  private contextFor(senderId: AgentId, sessionId: string, input: ChatroomSendInput, parent?: ChatroomMessage): ChatroomContext {
    if (parent) {
      const inherited = parent.context;
      if (input.requirementId !== undefined && input.requirementId !== inherited.requirementId) bad('不能改写继承的需求引用', 403);
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== inherited.expectedUpdatedAt) bad('不能改写继承的需求版本', 403);
      if (input.taskIds !== undefined && input.taskIds.some(id => !inherited.taskIds?.includes(id))) {
        bad('只能转交当前群话题内的待办', 403);
      }
      const taskIds = input.taskIds ?? inherited.taskIds;
      const baseContext = { ...inherited };
      delete baseContext.reportedTaskIds;
      return {
        ...baseContext,
        ...(taskIds === undefined ? {} : { taskIds, taskVersions: Object.fromEntries(taskIds.map(id => [id, inherited.taskVersions?.[id] ?? ''])) }),
        ...(senderId === 'codes' && input.to === 'assistant' ? { reportedTaskIds: input.taskIds ?? [] } : {}),
      };
    }
    if (input.requirementId !== undefined || input.expectedUpdatedAt !== undefined) {
      if (senderId !== 'requirements' || !input.requirementId || !input.expectedUpdatedAt) {
        bad('只有需求会话可引用自己保存的需求及版本', 403);
      }
      const row = this.store.sqlite.prepare("SELECT payload FROM workbench_records WHERE module = 'requirements' AND id = ?")
        .get(input.requirementId) as { payload: string } | undefined;
      const requirement = row ? JSON.parse(row.payload) as Record<string, unknown> : undefined;
      if (!requirement || requirement.sourceSessionId !== sessionId) bad('需求不属于当前会话', 403);
      if (requirement.updatedAt !== input.expectedUpdatedAt) bad('需求已更新，请重新读取版本', 409);
      if (input.taskIds !== undefined) bad('需求会话不能伪造待办引用', 403);
      return { requirementId: input.requirementId, expectedUpdatedAt: input.expectedUpdatedAt };
    }
    if (input.taskIds !== undefined) {
      if (senderId !== 'assistant') bad('只有助理可首次引用现有待办', 403);
      const taskVersions: Record<string, string> = {};
      const records = new Map(this.store.listRecords('tasks').map(task => [task.id, task]));
      for (const id of input.taskIds) {
        const task = records.get(id);
        if (!task || typeof task.updatedAt !== 'string') bad('引用的待办不存在', 404);
        taskVersions[id] = task.updatedAt;
      }
      return { taskIds: input.taskIds, taskVersions };
    }
    return {};
  }

  read(options: { after?: number; limit?: number; watch?: readonly number[] } = {}): ChatroomReadResult {
    const after = options.after ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return bad('群消息分页参数不合法');
    }
    const watch = options.watch ?? [];
    if (!Array.isArray(watch) || watch.length > 100 || watch.some(seq => !Number.isSafeInteger(seq) || seq < 1)) {
      return bad('群消息状态观察参数不合法');
    }
    const rows = this.storage.list(after, limit + 1);
    const page = rows.slice(0, limit).map(publicMessage);
    return {
      room: { id: CHATROOM_ID, name: CHATROOM_NAME },
      members: [{ id: 'user' as const, name: CHATROOM_USER_NAME }, ...AGENT_IDS.map(id => ({ id, name: CHATROOM_MEMBER_NAMES[id] }))],
      messages: page,
      nextCursor: page.at(-1)?.seq ?? after,
      hasMore: rows.length > limit,
      updates: this.storage.watchSeq(watch).map(publicMessage),
    };
  }

  history(threadId: string, limit = CHATROOM_MAX_THREAD_MESSAGES): ChatroomPublicMessage[] {
    if (!threadId || !Number.isSafeInteger(limit) || limit < 1 || limit > CHATROOM_MAX_THREAD_MESSAGES) {
      return bad('群话题读取参数不合法');
    }
    return this.storage.history(threadId, limit).map(publicMessage);
  }

  hasReply(messageId: string, senderId: AgentId): boolean {
    return this.storage.hasReply(messageId, senderId);
  }

  registerRunner(runner: ChatroomRunner): () => void {
    if (this.runner && this.runner !== runner) bad('聊天室投递运行器已经注册', 409);
    this.runner = runner;
    this.stopped = false;
    this.kick();
    return () => { if (this.runner === runner) this.runner = undefined; };
  }

  private kick(): void {
    if (this.worker || !this.runner || this.stopped) return;
    this.worker = Promise.resolve().then(async () => {
      while (this.runner && !this.stopped) {
        const next = this.storage.nextPending();
        if (!next) break;
        const claimed = this.storage.claim(next.id);
        if (!claimed) continue;
        try {
          await this.runner(claimed);
          if (this.failOutstandingConsumptions(claimed.id, '消费运行器退出时尚未完成处理')) {
            throw new Error('部分成员消费未完成');
          }
          const finalized = this.storage.consumptions.finalizedDelivery(claimed.id);
          if (!finalized || finalized.status !== 'delivered') {
            throw new Error(finalized?.error ?? '没有成员确认这条消息的消费');
          }
          this.storage.settle(claimed.id, finalized.status, finalized.error);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.failOutstandingConsumptions(claimed.id, reason);
          this.storage.settle(claimed.id, 'failed', reason.slice(0, 500));
        }
      }
    }).finally(() => {
      this.worker = undefined;
      if (this.runner && !this.stopped && this.storage.nextPending()) this.kick();
    });
  }

  async drain(): Promise<void> {
    this.kick();
    while (this.worker) await this.worker;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.runner = undefined;
    if (this.worker) await this.worker;
  }
}

export function getChatroomService(store: WorkbenchStore, workspaceKey = 'default'): ChatroomService {
  let keyed = services.get(store);
  if (!keyed) {
    keyed = new Map();
    services.set(store, keyed);
  }
  let service = keyed.get(workspaceKey);
  if (!service) {
    service = new ChatroomService(store, workspaceKey);
    keyed.set(workspaceKey, service);
  }
  return service;
}
