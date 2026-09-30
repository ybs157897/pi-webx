import type { PiAssistantMessage, PiCommandEnvelope, PiRpcResponse } from '../../../src/shared/protocol';
import { AGENT_IDS, type AgentId, type ProfileLoadResult } from '../../module-agents/contracts';
import type { ModuleAgentSessionService } from '../../module-agents/session-service';
import type { PiHost } from '../../pi/host';
import type { HostSubscriber, HostedSession } from '../../pi/host-contract';
import { CHATROOM_MEMBER_NAMES, type ChatroomConsumption, type ChatroomMessage, type ChatroomPublicMessage, type ConsumptionStatus } from './contracts';
import { formatChatroomPrompt, formatClaimPrompt, parseClaimVerdict } from './runtime-prompts';

export { formatChatroomPrompt, formatClaimPrompt, parseClaimVerdict } from './runtime-prompts';
export type { ClaimVerdict } from './runtime-prompts';

const DEFAULT_ADMISSION_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 250;

export interface ChatroomRuntimeService {
  registerRunner(run: (message: ChatroomMessage) => Promise<void>): () => void;
  withDelivery<T>(sessionId: string, message: ChatroomMessage, agentId: AgentId, run: () => Promise<T>): Promise<T>;
  history(threadId: string, limit?: number): ChatroomPublicMessage[];
  hasReply(messageId: string, senderId: AgentId): boolean;
  publishReply(senderId: AgentId, sessionId: string, input: { body: string; entryKey: string }): ChatroomMessage;
  recordClaimants(messageId: string, claimants: readonly AgentId[]): void;
  prepareConsumptions(messageId: string, agents: readonly AgentId[]): ChatroomConsumption[];
  updateConsumption(messageId: string, agentId: AgentId, status: Exclude<ConsumptionStatus, 'pending'>, error?: string): void;
  stop(): Promise<void>;
}

export interface ChatroomRuntimeDeps {
  host: Pick<PiHost, 'sessions' | 'command' | 'subscribe' | 'unsubscribe' | 'kill'>;
  profiles: Map<AgentId, ProfileLoadResult>;
  workspaceKey: string;
  sessionService: Pick<ModuleAgentSessionService, 'openOrCreate'>;
  chatroom: ChatroomRuntimeService;
  admissionTimeoutMs?: number;
  turnTimeoutMs?: number;
  claimTimeoutMs?: number;
  pollMs?: number;
}

function textOnly(message: PiAssistantMessage): string {
  return message.content.flatMap((block) => block.type === 'text' && typeof block.text === 'string'
    ? [block.text] : []).join('\n').trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('聊天室执行器正在关闭'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('聊天室执行器正在关闭'));
    };
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function isBusyResponse(response: PiRpcResponse): boolean {
  return !response.success && typeof response.error === 'string' && response.error.includes('该模块已有会话正在运行');
}

async function bestEffortAbort(host: ChatroomRuntimeDeps['host'], sessionId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      host.command(sessionId, { type: 'abort' }).then(() => undefined, () => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Runs queued room deliveries in isolated, short-lived module SDK sessions. */
export function createModuleAgentChatroomRuntime(deps: ChatroomRuntimeDeps): { stop(): Promise<void> } {
  const admissionTimeoutMs = deps.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const claimTimeoutMs = deps.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const abort = new AbortController();
  const active = new Set<string>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  async function waitForCapacity(agentId: AgentId, maxRunning: number, deadline: number): Promise<void> {
    while (true) {
      if (stopping) throw new Error('聊天室执行器正在关闭');
      const running = [...deps.host.sessions.values()].filter((item) => item.alive
        && item.moduleAgent?.agentId === agentId && item.moduleAgent.workspaceKey === deps.workspaceKey
        && (item.preparing || item.streaming || item.session.isStreaming)).length;
      if (running < maxRunning) return;
      if (Date.now() >= deadline) throw new Error(`模块 Agent「${agentId}」忙碌，等待超时`);
      await delay(Math.min(pollMs, deadline - Date.now()), abort.signal);
    }
  }

  async function runTurn(hosted: HostedSession, deadline: number, prompt: string, commandId: string): Promise<string> {
    let answer = '';
    let modelError: string | null = null;
    let settled = false;
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    // A rejected preflight can bypass the wait below; keep its promise observed.
    void completion.catch(() => undefined);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(answer);
    };
    const subscriber: HostSubscriber = {
      frame(entry) {
        const frame = entry.frame;
        if (frame.t === 'error') { modelError = frame.message; return; }
        if (frame.t === 'exit') { finish(new Error('模块 Agent 会话已结束')); return; }
        const event = frame.event;
        if (event.type === 'agent_start') modelError = null;
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const candidate = event.message;
          if (candidate.stopReason === 'error' || candidate.stopReason === 'aborted') {
            modelError = candidate.errorMessage ?? `模型返回 ${candidate.stopReason}`;
          } else if (candidate.stopReason !== 'toolUse') {
            const text = textOnly(candidate);
            if (text) { answer = text; modelError = null; }
          }
        }
        if (event.type === 'agent_settled') {
          finish(modelError ? new Error(modelError) : undefined);
        }
      },
      close() { finish(new Error('模块 Agent 会话已关闭')); },
    };
    deps.host.subscribe(hosted, subscriber);
    let rejectControl!: (error: Error) => void;
    const control = new Promise<never>((_, reject) => { rejectControl = reject; });
    const timeout = () => {
      const error = new Error('模块 Agent 回复超时');
      finish(error);
      rejectControl(error);
    };
    const timer = setTimeout(timeout, Math.max(1, deadline - Date.now()));
    const onAbort = () => {
      const error = new Error('聊天室执行器正在关闭');
      finish(error);
      rejectControl(error);
    };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
    try {
      const command: PiCommandEnvelope = { type: 'prompt', id: commandId, message: prompt };
      const response = await Promise.race([deps.host.command(hosted.id, command), control]);
      if (!response.success || (typeof response.data === 'object' && response.data !== null
        && 'accepted' in response.data && response.data.accepted === false)) {
        throw new Error(response.error ?? (typeof response.data === 'object' && response.data !== null
          && 'reason' in response.data ? String(response.data.reason) : '模块 Agent 未接受消息'));
      }
      return await Promise.race([completion, control]);
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      deps.host.unsubscribe(hosted, subscriber);
    }
  }

  interface AgentBudget {
    agentId: AgentId;
    maxRunning: number;
    admissionDeadline: number;
  }

  async function runTurnWithRetry(hosted: HostedSession, budget: AgentBudget, timeoutMs: number, prompt: string, commandId: string): Promise<string> {
    while (true) {
      try { return await runTurn(hosted, Date.now() + timeoutMs, prompt, commandId); }
      catch (error) {
        if (!isBusyResponse({ type: 'response', command: 'prompt', success: false, error: errorText(error) })
          || Date.now() >= budget.admissionDeadline) throw error;
        await waitForCapacity(budget.agentId, budget.maxRunning, budget.admissionDeadline);
      }
    }
  }

  async function runClaimTurn(hosted: HostedSession, budget: AgentBudget, message: ChatroomMessage, agentId: AgentId): Promise<string> {
    const enabledTools = hosted.session.getActiveToolNames();
    hosted.session.setActiveToolsByName([]);
    let settled = false;
    try {
      const answer = await runTurnWithRetry(hosted, budget, claimTimeoutMs,
        formatClaimPrompt(message, deps.chatroom.history(message.threadId, 10)),
        `chatroom-claim:${message.id}:${agentId}`);
      settled = true;
      return answer;
    } finally {
      // A timed-out turn may still be unwinding; its tools stay disabled until the session is killed.
      if (settled) hosted.session.setActiveToolsByName(enabledTools);
    }
  }

  async function openSession(budget: AgentBudget): Promise<HostedSession> {
    const result = deps.profiles.get(budget.agentId);
    if (!result?.ok || !result.profile.config.enabled) throw new Error(`模块 Agent「${budget.agentId}」不可用`);
    await waitForCapacity(budget.agentId, budget.maxRunning, budget.admissionDeadline);
    const timeoutError = () => new Error(`模块 Agent「${budget.agentId}」创建会话等待超时`);
    if (Date.now() >= budget.admissionDeadline) throw timeoutError();
    const opening = deps.sessionService.openOrCreate(budget.agentId, result.profile);
    let cancelOpen!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      cancelOpen = () => reject(new Error('聊天室执行器正在关闭'));
      abort.signal.addEventListener('abort', cancelOpen, { once: true });
      if (abort.signal.aborted) cancelOpen();
      timer = setTimeout(() => reject(timeoutError()), Math.max(1, budget.admissionDeadline - Date.now()));
    });
    let hosted: HostedSession;
    try { hosted = await Promise.race([opening, interrupted]); }
    catch (error) {
      void opening.then(item => deps.host.kill(item.id)).catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      abort.signal.removeEventListener('abort', cancelOpen);
    }
    if (stopping || Date.now() >= budget.admissionDeadline) {
      await deps.host.kill(hosted.id).catch(() => undefined);
      throw stopping ? new Error('聊天室执行器正在关闭') : timeoutError();
    }
    return hosted;
  }

  /** Publications are pushed to every other enabled member; new module Agents join without room-side changes. */
  function subscribers(senderId: ChatroomMessage['senderId']): AgentId[] {
    const order = [...AGENT_IDS, ...[...deps.profiles.keys()].filter(id => !AGENT_IDS.includes(id))];
    const enabled = new Set<AgentId>();
    for (const [id, result] of deps.profiles) {
      if (result.ok && result.profile.config.enabled) enabled.add(id);
    }
    return order.filter(id => id !== senderId && enabled.has(id));
  }

  async function runFullTurn(hosted: HostedSession, budget: AgentBudget, message: ChatroomMessage, commandId: string): Promise<void> {
    await deps.chatroom.withDelivery(hosted.id, message, budget.agentId, async () => {
      const answer = await runTurnWithRetry(hosted, budget, turnTimeoutMs,
        formatChatroomPrompt(message, deps.chatroom.history(message.threadId, 40)), commandId);
      if (!deps.chatroom.hasReply(message.id, budget.agentId)) {
        if (!answer) throw new Error('模块 Agent 未产生可展示的正文');
        deps.chatroom.publishReply(budget.agentId, hosted.id, { body: answer, entryKey: `answer:${message.id}` });
      }
    });
  }

  async function deliverPublication(message: ChatroomMessage): Promise<void> {
    const roster = message.consumptions.length
      ? message.consumptions.map(receipt => receipt.agentId)
      : subscribers(message.senderId);
    if (roster.length === 0) throw new Error('聊天室没有启用中的成员可认领这条广播');
    const receipts = deps.chatroom.prepareConsumptions(message.id, roster);
    const claimants = new Set(message.claimants);
    const notes: string[] = [];
    let replies = receipts.filter(receipt => receipt.status === 'consumed').length;
    for (const receipt of receipts) {
      const agentId = receipt.agentId;
      if (receipt.status === 'consumed' || receipt.status === 'skipped' || receipt.status === 'failed') {
        if (receipt.status === 'failed') notes.push(`「${CHATROOM_MEMBER_NAMES[agentId] ?? agentId}」处理失败：${receipt.error ?? '未知错误'}`);
        continue;
      }
      if (stopping) throw new Error('聊天室执行器正在关闭');
      const loaded = deps.profiles.get(agentId);
      let hosted: HostedSession | undefined;
      try {
        deps.chatroom.updateConsumption(message.id, agentId, 'evaluating');
        if (!loaded?.ok || !loaded.profile.config.enabled) throw new Error(`模块 Agent「${agentId}」不可用`);
        const budget: AgentBudget = {
          agentId, maxRunning: loaded.profile.config.limits.maxRunningSessions,
          admissionDeadline: Date.now() + admissionTimeoutMs,
        };
        hosted = await openSession(budget);
        const gate = await runClaimTurn(hosted, budget, message, agentId);
        const verdict = parseClaimVerdict(gate);
        if (verdict === 'pass') {
          deps.chatroom.updateConsumption(message.id, agentId, 'skipped');
          continue;
        }
        if (verdict === 'unreadable') throw new Error('未给出可解析的认领判断');
        claimants.add(agentId);
        deps.chatroom.recordClaimants(message.id, [...claimants]);
        deps.chatroom.updateConsumption(message.id, agentId, 'processing');
        active.add(hosted.id);
        try {
          await runFullTurn(hosted, budget, message, `chatroom:${message.id}`);
          deps.chatroom.updateConsumption(message.id, agentId, 'consumed');
          replies += 1;
        } finally { active.delete(hosted.id); }
      } catch (error) {
        if (hosted) await bestEffortAbort(deps.host, hosted.id);
        deps.chatroom.updateConsumption(message.id, agentId, 'failed', errorText(error));
        notes.push(`「${CHATROOM_MEMBER_NAMES[agentId] ?? agentId}」处理失败：${errorText(error)}`);
        if (stopping) throw error;
      } finally {
        if (hosted) await deps.host.kill(hosted.id).catch(() => undefined);
      }
    }
    if (replies === 0) {
      const detail = notes.length ? `（${notes.join('；').slice(0, 300)}）` : '';
      throw new Error(claimants.size
        ? `认领成员未完成公开回复${detail}`
        : `没有成员认领这条广播${detail}；可 @指定成员后重发`);
    }
  }

  async function deliverAddressed(message: ChatroomMessage): Promise<void> {
    const agentId = message.recipientId;
    if (agentId === null) return;
    const [receipt] = deps.chatroom.prepareConsumptions(message.id, [agentId]);
    if (receipt?.status === 'consumed') return;
    if (receipt?.status === 'failed' || receipt?.status === 'skipped') {
      throw new Error(receipt.error ?? `模块 Agent「${agentId}」未完成消费`);
    }
    let hosted: HostedSession | undefined;
    try {
      deps.chatroom.updateConsumption(message.id, agentId, 'processing');
      const result = deps.profiles.get(agentId);
      if (!result?.ok || !result.profile.config.enabled) throw new Error(`模块 Agent「${agentId}」不可用`);
      const budget: AgentBudget = {
        agentId, maxRunning: result.profile.config.limits.maxRunningSessions,
        admissionDeadline: Date.now() + admissionTimeoutMs,
      };
      hosted = await openSession(budget);
      active.add(hosted.id);
      await runFullTurn(hosted, budget, message, `chatroom:${message.id}`);
      deps.chatroom.updateConsumption(message.id, agentId, 'consumed');
    } catch (error) {
      if (hosted) await bestEffortAbort(deps.host, hosted.id);
      deps.chatroom.updateConsumption(message.id, agentId, 'failed', errorText(error));
      throw error;
    } finally {
      if (hosted) {
        active.delete(hosted.id);
        await deps.host.kill(hosted.id).catch(() => undefined);
      }
    }
  }

  async function deliver(message: ChatroomMessage): Promise<void> {
    if (message.recipientId === null) await deliverPublication(message);
    else await deliverAddressed(message);
  }

  const unregister = deps.chatroom.registerRunner(deliver);
  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopping = true;
        abort.abort();
        unregister();
        await Promise.allSettled([...active].map(async (id) => {
          await bestEffortAbort(deps.host, id);
          await deps.host.kill(id);
        }));
        await deps.chatroom.stop();
      })();
      return stopPromise;
    },
  };
}
