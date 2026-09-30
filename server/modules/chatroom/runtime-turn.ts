import { agentFailureDetail } from '../../module-agents/failures';
import type { PiAssistantMessage, PiCommandEnvelope, PiEvent, PiRpcResponse } from '../../../src/shared/protocol';
import type { AgentId } from '../../module-agents/contracts';
import type { HostSubscriber, HostedSession } from '../../pi/host-contract';
import type { ChatroomRuntimeDeps } from './runtime-contract';

export interface AgentBudget {
  agentId: AgentId;
  maxRunning: number;
  admissionDeadline: number;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('聊天室执行器正在关闭');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function textOnly(message: PiAssistantMessage): string {
  return message.content.flatMap(block => block.type === 'text' && typeof block.text === 'string'
    ? [block.text] : []).join('\n').trim();
}

function isBusyResponse(response: PiRpcResponse): boolean {
  return !response.success && typeof response.error === 'string' && response.error.includes('该模块已有会话正在运行');
}

export async function bestEffortAbort(host: ChatroomRuntimeDeps['host'], sessionId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      host.command(sessionId, { type: 'abort' }).then(() => undefined, () => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export class ChatroomTurnEngine {
  constructor(private readonly deps: ChatroomRuntimeDeps, private readonly signal: AbortSignal,
    private readonly pollMs: number) {}

  async waitForCapacity(agentId: AgentId, maxRunning: number, deadline: number): Promise<void> {
    while (true) {
      if (this.signal.aborted) throw abortError(this.signal);
      const running = [...this.deps.host.sessions.values()].filter(item => item.alive
        && item.moduleAgent?.agentId === agentId && item.moduleAgent.workspaceKey === this.deps.workspaceKey
        && (item.preparing || item.streaming || item.session.isStreaming)).length;
      if (running < maxRunning) return;
      if (Date.now() >= deadline) throw new Error(`模块 Agent「${agentId}」忙碌，等待超时`);
      await delay(Math.min(this.pollMs, deadline - Date.now()), this.signal);
    }
  }

  async openSession(budget: AgentBudget, sessionId?: string): Promise<HostedSession> {
    const result = this.deps.profiles.get(budget.agentId);
    if (!result?.ok || !result.profile.config.enabled) throw new Error(`模块 Agent「${budget.agentId}」不可用`);
    await this.waitForCapacity(budget.agentId, budget.maxRunning, budget.admissionDeadline);
    const timeoutError = () => new Error(`模块 Agent「${budget.agentId}」创建会话等待超时`);
    if (Date.now() >= budget.admissionDeadline) throw timeoutError();
    const opening = this.deps.sessionService.openOrCreate(budget.agentId, result.profile, sessionId);
    let cancelOpen!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      cancelOpen = () => reject(abortError(this.signal));
      this.signal.addEventListener('abort', cancelOpen, { once: true });
      if (this.signal.aborted) cancelOpen();
      timer = setTimeout(() => reject(timeoutError()), Math.max(1, budget.admissionDeadline - Date.now()));
    });
    let hosted: HostedSession;
    try { hosted = await Promise.race([opening, interrupted]); }
    catch (error) {
      void opening.then(item => this.deps.host.kill(item.id)).catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.signal.removeEventListener('abort', cancelOpen);
    }
    if (this.signal.aborted || Date.now() >= budget.admissionDeadline) {
      await this.deps.host.kill(hosted.id).catch(() => undefined);
      throw this.signal.aborted ? abortError(this.signal) : timeoutError();
    }
    return hosted;
  }

  async runTurnWithRetry(hosted: HostedSession, budget: AgentBudget, timeoutMs: number, prompt: string,
    commandId: string, signal = this.signal, onEvent?: (event: PiEvent) => void): Promise<string> {
    while (true) {
      try { return await this.runTurn(hosted, Date.now() + timeoutMs, prompt, commandId, signal, onEvent); }
      catch (error) {
        if (!isBusyResponse({ type: 'response', command: 'prompt', success: false, error: errorText(error) })
          || Date.now() >= budget.admissionDeadline) throw error;
        await this.waitForCapacity(budget.agentId, budget.maxRunning, budget.admissionDeadline);
      }
    }
  }

  private async runTurn(hosted: HostedSession, deadline: number, prompt: string, commandId: string,
    signal: AbortSignal, onEvent?: (event: PiEvent) => void): Promise<string> {
    let answer = '';
    let modelError: string | null = null;
    let lastModelFailure: string | null = null;
    let settled = false;
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
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
        if (frame.t === 'error') { modelError = frame.message; lastModelFailure = agentFailureDetail(frame.message).summary; return; }
        if (frame.t === 'exit') { finish(new Error('模块 Agent 会话已结束')); return; }
        const event = frame.event;
        try { onEvent?.(event); }
        catch (error) { finish(new Error(`执行记录写入失败：${errorText(error)}`)); return; }
        if (event.type === 'agent_start') modelError = null;
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const candidate = event.message;
          if (candidate.stopReason === 'error' || candidate.stopReason === 'aborted') {
            modelError = candidate.errorMessage ?? `模型返回 ${candidate.stopReason}`;
            lastModelFailure = agentFailureDetail(modelError).summary;
          } else if (candidate.stopReason !== 'toolUse') {
            const text = textOnly(candidate);
            if (text) { answer = text; modelError = null; lastModelFailure = null; }
          }
        }
        if (event.type === 'agent_settled') finish(modelError ? new Error(modelError) : undefined);
      },
      close() { finish(new Error('模块 Agent 会话已关闭')); },
    };
    this.deps.host.subscribe(hosted, subscriber);
    let rejectControl!: (error: Error) => void;
    const control = new Promise<never>((_, reject) => { rejectControl = reject; });
    const timer = setTimeout(() => {
      const error = new Error(`模块 Agent 回复超时${lastModelFailure ? `；最近错误：${lastModelFailure}` : ''}`);
      finish(error);
      rejectControl(error);
    }, Math.max(1, deadline - Date.now()));
    const onAbort = () => {
      const error = abortError(signal);
      finish(error);
      rejectControl(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const command: PiCommandEnvelope = { type: 'prompt', id: commandId, message: prompt };
      const response = await Promise.race([this.deps.host.command(hosted.id, command), control]);
      if (!response.success || (typeof response.data === 'object' && response.data !== null
        && 'accepted' in response.data && response.data.accepted === false)) {
        throw new Error(response.error ?? (typeof response.data === 'object' && response.data !== null
          && 'reason' in response.data ? String(response.data.reason) : '模块 Agent 未接受消息'));
      }
      return await Promise.race([completion, control]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.deps.host.unsubscribe(hosted, subscriber);
    }
  }
}
