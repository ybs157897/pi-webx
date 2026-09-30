import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { WorkbenchStore } from '../../workbench/store';
import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import {
  CHATROOM_ID, CHATROOM_MAX_DEPTH,
  CHATROOM_MAX_THREAD_MESSAGES, CHATROOM_MEMBER_NAMES, CHATROOM_NAME, CHATROOM_USER_NAME,
  type ChatroomContext, type ChatroomMessage, type ChatroomPublicMessage,
  type ChatroomReadResult, type ChatroomRunner, type ChatroomSendInput, type ChatroomUserSendInput,
  type ConsumptionStatus, type ChatroomConsumption,
} from './contracts';
import { ChatroomStore, publicMessage } from './store';
import { ChatroomWorkStore } from './work-store';
import { ChatroomWorkService } from './work-service';
import type { WorkTaskActionInput } from './work-contracts';
import { bad, normalizeInput, normalizeUserInput, recipientFromBody, requestHash, routedAgentInput, userRequestHash, validAgentId } from './service-input';
import { contextFor } from './service-context';
import { attachRequirement as attachRequirementContext, attachTasks as attachTaskContext } from './service-provenance';
import { nextEligibleDelivery } from './service-scheduler';

const services = new WeakMap<WorkbenchStore, Map<string, ChatroomService>>();
const MAX_PARALLEL_DELIVERIES = 4;

export class ChatroomService {
  readonly storage: ChatroomStore;
  readonly work: ChatroomWorkService;
  private readonly active = new Map<string, ChatroomMessage>();
  private readonly knownDeliverySessions = new Set<string>();
  private runner: ChatroomRunner | undefined;
  private readonly workers = new Set<Promise<void>>();
  private readonly activeClaimed = new Map<string, ChatroomMessage>();
  private stopped = false;

  constructor(private readonly store: WorkbenchStore, readonly workspaceKey = 'default') {
    if (!workspaceKey.trim()) bad('聊天室工作区标识缺失');
    this.storage = new ChatroomStore(store, workspaceKey);
    this.work = new ChatroomWorkService(new ChatroomWorkStore(store.sqlite, workspaceKey),
      sessionId => this.active.get(sessionId), store);
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
    if (receipt && ['consumed', 'skipped', 'failed'].includes(receipt.status)) this.kick();
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
    if (!sessionId || this.active.has(sessionId)) {
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
    this.knownDeliverySessions.add(sessionId);
    try {
      return await fn();
    } finally {
      this.active.delete(sessionId);
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
    attachTaskContext(this.store, this.storage, this.work, this.active.get(sessionId), tasks);
  }

  /** Bind the requirement saved by this receiving requirements session, never a caller-supplied reference. */
  attachRequirement(sessionId: string, requirement: { id: string; updatedAt?: unknown },
    options: { newRequirement?: boolean } = {}): void {
    attachRequirementContext(this.store, this.storage, this.work, this.active.get(sessionId),
      sessionId, requirement, options);
  }

  send(senderId: AgentId, sessionId: string, raw: ChatroomSendInput): ChatroomMessage {
    if (!validAgentId(senderId)) bad('未知发言 Agent');
    if (typeof sessionId !== 'string' || !sessionId.trim()) bad('发言会话身份缺失');
    if (this.knownDeliverySessions.has(sessionId) && !this.active.has(sessionId)) bad('接收会话已结束，不能再发送群消息', 409);
    this.work.assertSessionWritable(sessionId);
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
      const context = contextFor(this.store, this.workspaceKey, senderId, sessionId, input, parent);
      const id = randomUUID();
      const threadId = parent?.threadId ?? id;
      const depth = parent ? parent.depth + 1 : 0;
      if (depth > CHATROOM_MAX_DEPTH) bad('内部群消息自动接力次数已达上限', 409);
      if (this.storage.countSinceUserAnchor(threadId) >= CHATROOM_MAX_THREAD_MESSAGES) bad('该群话题自动消息数已达上限', 409);
      const message = this.storage.insert({
        id, threadId, replyTo: parent?.id ?? null, senderId,
        senderName: CHATROOM_MEMBER_NAMES[senderId], recipientId: input.to ?? null,
        senderSessionId: sessionId, entryKey: input.entryKey, requestHash: hash,
        body: input.body, createdAt: new Date().toISOString(),
        deliveryStatus: 'pending', error: null, depth, context, claimants: [],
      });
      this.work.recordHandoff(sessionId, message.id);
      return message;
    });
    if (saved.deliveryStatus === 'pending') this.kick();
    return saved;
  }

  /** Runtime-only fallback for a final answer. Quoted @text is visible but never routes work. */
  publishReply(senderId: AgentId, sessionId: string, raw: { body: string; entryKey: string }): ChatroomMessage {
    if (!validAgentId(senderId)) bad('未知发言 Agent');
    if (typeof sessionId !== 'string' || !sessionId.trim()) bad('发言会话身份缺失');
    if (this.knownDeliverySessions.has(sessionId) && !this.active.has(sessionId)) bad('接收会话已结束，不能再发送群消息', 409);
    this.work.assertSessionWritable(sessionId);
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
        context: contextFor(this.store, this.workspaceKey, senderId, sessionId, input, parent), claimants: [],
      });
    });
  }

  /** Browser submissions are always the human member; mention text is the only recipient input. */
  sendUser(userSessionKey: string, raw: ChatroomUserSendInput): ChatroomMessage {
    if (!userSessionKey || !this.storage.hasUserSession(userSessionKey)) bad('用户群聊会话无效', 403);
    const input = normalizeUserInput(raw);
    const mentionedRecipient = recipientFromBody(input.body);
    const hash = userRequestHash(input, mentionedRecipient);
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
      const explicitTask = input.collaborationTaskId ? this.work.storage.task(input.collaborationTaskId) : undefined;
      if (input.collaborationTaskId && !explicitTask) bad('协作任务不存在', 404);
      if (parent && input.threadId && input.threadId !== parent.threadId) bad('回复目标与指定群话题不一致', 409);
      if (parent?.context.collaborationTaskId && input.collaborationTaskId
        && parent.context.collaborationTaskId !== input.collaborationTaskId) bad('不能把回复改绑其他协作任务', 409);
      const threadId = parent?.threadId ?? input.threadId ?? explicitTask?.thread_id ?? id;
      if ((input.threadId && !this.storage.hasThread(input.threadId))
        || (explicitTask && explicitTask.thread_id !== threadId)) bad('协作任务与群话题不匹配', 409);
      const inheritedTaskId = parent?.context.collaborationTaskId;
      const taskId = input.collaborationTaskId ?? inheritedTaskId;
      const task = taskId ? this.work.storage.task(taskId) : undefined;
      const activeTask = task && ['waiting', 'running', 'waiting_for_user', 'waiting_for_agent'].includes(task.status);
      if (input.collaborationTaskId && !activeTask) bad('该任务须先通过继续任务操作恢复', 409);
      const inherited = !explicitTask || parent?.context.collaborationTaskId === taskId ? parent?.context : undefined;
      const context = { ...(task ? JSON.parse(task.source_context) as ChatroomContext : {}), ...inherited };
      delete context.reportedTaskIds;
      if (activeTask) context.collaborationTaskId = taskId;
      else delete context.collaborationTaskId;
      let recipientId = mentionedRecipient;
      if (!recipientId && activeTask) {
        const assignments = this.work.storage.assignments(taskId!);
        if (assignments.length === 1) recipientId = assignments[0]!.agent_id;
        else if (assignments.length > 1) bad('多个成员分工时须 @ 指定接收成员');
      }
      return this.storage.insert({
        id, threadId, replyTo: parent?.id ?? null,
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
      tasks: this.work.publicTasks(),
    };
  }

  history(threadId: string, limit = CHATROOM_MAX_THREAD_MESSAGES): ChatroomPublicMessage[] {
    if (!threadId || !Number.isSafeInteger(limit) || limit < 1 || limit > CHATROOM_MAX_THREAD_MESSAGES) {
      return bad('群话题读取参数不合法');
    }
    return this.storage.history(threadId, limit).map(publicMessage);
  }

  historySince(threadId: string, afterSeq: number, beforeSeq = Number.MAX_SAFE_INTEGER, limit = 200): ChatroomPublicMessage[] {
    if (!threadId || !Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(beforeSeq)
      || beforeSeq < afterSeq || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) bad('群话题增量读取参数不合法');
    return this.storage.historySince(threadId, afterSeq, beforeSeq, limit).map(publicMessage);
  }

  async taskAction(userSessionKey: string, taskId: string, input: WorkTaskActionInput): Promise<{
    task: ChatroomReadResult['tasks'][number]; message?: ChatroomMessage;
  }> {
    if (!userSessionKey || !this.storage.hasUserSession(userSessionKey)) bad('用户群聊会话无效', 403);
    return this.work.performUserAction(userSessionKey, taskId, input,
      (agentId, body) => {
        const task = this.work.storage.task(taskId)!;
        const prefix = `@${CHATROOM_MEMBER_NAMES[agentId]}`;
        const text = body.startsWith(prefix) ? body : `${prefix} ${body}`;
        return this.sendUser(userSessionKey, { body: text, entryKey: input.entryKey,
          threadId: task.thread_id, collaborationTaskId: taskId });
      }, id => this.storage.byId(id));
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
    if (!this.runner || this.stopped) return;
    while (this.workers.size < MAX_PARALLEL_DELIVERIES) {
      const next = nextEligibleDelivery(this.storage, this.activeClaimed);
      if (!next) break;
      const claimed = this.storage.claim(next.id);
      if (!claimed) continue;
      this.activeClaimed.set(claimed.id, claimed);
      const worker = Promise.resolve().then(() => this.processClaimed(claimed));
      this.workers.add(worker);
      void worker.finally(() => { this.activeClaimed.delete(claimed.id); this.workers.delete(worker); this.kick(); });
    }
  }

  private async processClaimed(claimed: ChatroomMessage): Promise<void> {
    try {
      await this.runner!(claimed);
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

  async drain(): Promise<void> {
    this.kick();
    while (this.workers.size) await Promise.all([...this.workers]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.runner = undefined;
    if (this.workers.size) await Promise.all([...this.workers]);
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
