import { createHash } from 'node:crypto';
import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import type { HostedSession } from '../../pi/host-contract';
import { CHATROOM_MEMBER_NAMES, type ChatroomMessage, type ChatroomPublicMessage } from './contracts';
import type { ChatroomRuntimeDeps, ChatroomSessionBinding } from './runtime-contract';
import { AgentMailbox } from './runtime-mailbox';
import { formatChatroomPrompt, formatClaimPrompt, parseClaimVerdict } from './runtime-prompts';
import { bestEffortAbort, ChatroomTurnEngine, errorText, type AgentBudget } from './runtime-turn';

const DEFAULT_ADMISSION_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 250;

function priorMessages(deps: ChatroomRuntimeDeps, message: ChatroomMessage,
  binding: ChatroomSessionBinding): { messages: ChatroomPublicMessage[]; omitted: number } {
  const after = binding.sessionId ? binding.lastProcessedSeq : 0;
  const found: ChatroomPublicMessage[] = [];
  let cursor = after;
  while (true) {
    const page = deps.chatroom.historySince(message.threadId, cursor, message.seq - 1, 200);
    if (page.length === 0) break;
    found.push(...page);
    const last = page.at(-1)!.seq;
    if (last <= cursor || page.length < 200) break;
    cursor = last;
  }
  const scoped = binding.scope === 'assignment'
    ? found.filter(item => item.collaborationTaskId === binding.taskId) : found;
  const maxPromptHistory = 40;
  return { messages: scoped.slice(-maxPromptHistory), omitted: Math.max(0, scoped.length - maxPromptHistory) };
}

/** Runs each member's inbox in order, while separate members can progress concurrently. */
export function createModuleAgentChatroomRuntime(deps: ChatroomRuntimeDeps): { stop(): Promise<void> } {
  const admissionTimeoutMs = deps.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const claimTimeoutMs = deps.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  const abort = new AbortController();
  const engine = new ChatroomTurnEngine(deps, abort.signal, deps.pollMs ?? DEFAULT_POLL_MS);
  const mailbox = new AgentMailbox(deps.maxConcurrentAgents ?? 4, abort.signal);
  const activeSessions = new Set<string>();
  const activeRuns = new Map<string, { sessionId: string; abort: AbortController }>();
  let stopPromise: Promise<void> | undefined;

  function budgetFor(agentId: AgentId): AgentBudget {
    const loaded = deps.profiles.get(agentId);
    if (!loaded?.ok || !loaded.profile.config.enabled) throw new Error(`模块 Agent「${agentId}」不可用`);
    return { agentId, maxRunning: loaded.profile.config.limits.maxRunningSessions,
      admissionDeadline: Date.now() + admissionTimeoutMs };
  }

  async function runClaim(message: ChatroomMessage, agentId: AgentId, budget: AgentBudget): Promise<'claim' | 'pass'> {
    const hosted = await engine.openSession(budget);
    try {
      const enabledTools = hosted.session.getActiveToolNames();
      hosted.session.setActiveToolsByName([]);
      const answer = await engine.runTurnWithRetry(hosted, budget, claimTimeoutMs,
        formatClaimPrompt(message, deps.chatroom.history(message.threadId, 10)),
        `chatroom-claim:${message.id}:${agentId}`);
      const verdict = parseClaimVerdict(answer);
      if (verdict === 'unreadable') throw new Error('未给出可解析的认领判断');
      // A claim verdict is never part of the durable work conversation.
      if (verdict === 'pass') hosted.session.setActiveToolsByName(enabledTools);
      return verdict;
    } catch (error) {
      await bestEffortAbort(deps.host, hosted.id);
      throw error;
    } finally {
      await deps.host.kill(hosted.id).catch(() => undefined);
    }
  }

  async function fullTurn(message: ChatroomMessage, agentId: AgentId, budget: AgentBudget): Promise<void> {
    const binding = deps.chatroom.work.getBinding(message, agentId);
    if (binding.needsReview) throw new Error('此前执行可能已产生副作用，请先核对运行记录再继续');
    let hosted: HostedSession | undefined;
    let runId: string | undefined;
    const runAbort = new AbortController();
    const onStop = () => runAbort.abort(new Error('聊天室执行器正在关闭'));
    abort.signal.addEventListener('abort', onStop, { once: true });
    if (abort.signal.aborted) onStop();
    let touchedTool = false;
    try {
      hosted = await engine.openSession(budget, binding.sessionId ?? undefined);
      activeSessions.add(hosted.id);
      const profile = deps.profiles.get(agentId);
      deps.chatroom.work.bindSession(message, agentId, hosted.id,
        profile?.ok ? profile.profile.profileRevision : undefined);
      const run = deps.chatroom.work.beginRun(message, agentId, hosted.id);
      runId = run.id;
      activeRuns.set(runId, { sessionId: hosted.id, abort: runAbort });
      deps.chatroom.updateConsumption(message.id, agentId, 'processing');
      const { messages, omitted } = priorMessages(deps, message, binding);
      await deps.chatroom.withDelivery(hosted.id, message, agentId, async () => {
        const answer = await engine.runTurnWithRetry(hosted!, budget, turnTimeoutMs,
          formatChatroomPrompt(message, messages, { omitted, scope: binding.scope,
            taskId: binding.taskId, assignmentId: binding.assignmentId }),
          `chatroom:${message.id}:${agentId}`, runAbort.signal, event => {
            if (event.type === 'tool_execution_start') {
              touchedTool = true;
              deps.chatroom.work.markToolStart(run.id, event.toolCallId, event.toolName);
            } else if (event.type === 'tool_execution_end') {
              const serialized = JSON.stringify(event.result ?? null);
              const output = event.result?.content?.flatMap(block => block.type === 'text'
                && typeof block.text === 'string' ? [block.text] : []).join('\n') ?? '';
              const exitMatch = event.toolName === 'bash' && event.isError
                ? /Command exited with code (\d+)\s*$/.exec(output) : null;
              deps.chatroom.work.markToolEnd(run.id, event.toolCallId, !!event.isError, {
                resultHash: createHash('sha256').update(serialized).digest('hex'),
                resultBytes: Buffer.byteLength(serialized),
                exitCode: event.toolName === 'bash'
                  ? event.isError ? exitMatch ? Number(exitMatch[1]) : null : 0 : null,
              });
            }
          });
        if (!deps.chatroom.hasReply(message.id, agentId)) {
          if (!answer) throw new Error('模块 Agent 未产生可展示的正文');
          deps.chatroom.publishReply(agentId, hosted!.id,
            { body: answer, entryKey: `answer:${message.id}` });
        }
      });
      deps.chatroom.work.finishRun(run.id, 'succeeded', { lastProcessedSeq: message.seq });
      deps.chatroom.updateConsumption(message.id, agentId, 'consumed');
    } catch (error) {
      if (hosted) await bestEffortAbort(deps.host, hosted.id);
      if (runId) {
        const status = touchedTool ? 'needs_review' : runAbort.signal.aborted ? 'cancelled' : 'failed';
        deps.chatroom.work.finishRun(runId, status, { error: errorText(error) });
      }
      deps.chatroom.updateConsumption(message.id, agentId, 'failed', errorText(error));
      throw error;
    } finally {
      if (runId) activeRuns.delete(runId);
      if (hosted) {
        activeSessions.delete(hosted.id);
        await deps.host.kill(hosted.id).catch(() => undefined);
      }
      abort.signal.removeEventListener('abort', onStop);
    }
  }

  function subscribers(senderId: ChatroomMessage['senderId']): AgentId[] {
    const order = [...AGENT_IDS, ...[...deps.profiles.keys()].filter(id => !AGENT_IDS.includes(id))];
    const enabled = new Set<AgentId>();
    for (const [id, result] of deps.profiles) {
      if (result.ok && result.profile.config.enabled) enabled.add(id);
    }
    return order.filter(id => id !== senderId && enabled.has(id));
  }

  async function broadcastMember(message: ChatroomMessage, agentId: AgentId, claimants: Set<AgentId>): Promise<void> {
    const receipt = deps.chatroom.prepareConsumptions(message.id, [agentId])[0];
    if (receipt?.status === 'consumed' || receipt?.status === 'skipped') return;
    if (receipt?.status === 'failed') throw new Error(receipt.error ?? '成员消费已失败');
    try {
      deps.chatroom.updateConsumption(message.id, agentId, 'evaluating');
      const budget = budgetFor(agentId);
      const verdict = await runClaim(message, agentId, budget);
      if (verdict === 'pass') {
        deps.chatroom.updateConsumption(message.id, agentId, 'skipped');
        return;
      }
      claimants.add(agentId);
      deps.chatroom.recordClaimants(message.id, [...claimants]);
      await fullTurn(message, agentId, budgetFor(agentId));
    } catch (error) {
      deps.chatroom.updateConsumption(message.id, agentId, 'failed', errorText(error));
      throw error;
    }
  }

  async function deliverPublication(message: ChatroomMessage): Promise<void> {
    const roster = message.consumptions.length
      ? message.consumptions.map(receipt => receipt.agentId)
      : subscribers(message.senderId);
    if (!roster.length) throw new Error('聊天室没有启用中的成员可认领这条广播');
    deps.chatroom.prepareConsumptions(message.id, roster);
    const claimants = new Set(message.claimants);
    const results = await Promise.allSettled(roster.map(agentId => mailbox.run(agentId,
      () => broadcastMember(message, agentId, claimants))));
    const receipts = deps.chatroom.prepareConsumptions(message.id, roster);
    const replies = receipts.filter(receipt => receipt.status === 'consumed').length;
    if (replies > 0) return;
    const notes = results.flatMap((result, index) => result.status === 'rejected'
      ? [`「${CHATROOM_MEMBER_NAMES[roster[index]!] ?? roster[index]}」处理失败：${errorText(result.reason)}`] : []);
    const detail = notes.length ? `（${notes.join('；').slice(0, 300)}）` : '';
    throw new Error(claimants.size
      ? `认领成员未完成公开回复${detail}`
      : `没有成员认领这条广播${detail}；可 @指定成员后重发`);
  }

  async function deliverAddressed(message: ChatroomMessage): Promise<void> {
    const agentId = message.recipientId;
    if (!agentId) return;
    return mailbox.run(agentId, async () => {
      const [receipt] = deps.chatroom.prepareConsumptions(message.id, [agentId]);
      if (receipt?.status === 'consumed') return;
      if (receipt?.status === 'failed' || receipt?.status === 'skipped') {
        throw new Error(receipt.error ?? `模块 Agent「${agentId}」未完成消费`);
      }
      await fullTurn(message, agentId, budgetFor(agentId));
    });
  }

  const unregisterCancel = deps.chatroom.work.registerCancelRun(async runId => {
    const active = activeRuns.get(runId);
    if (!active) return;
    active.abort.abort(new Error('运行已取消'));
    await bestEffortAbort(deps.host, active.sessionId);
  });
  const unregister = deps.chatroom.registerRunner(message => message.recipientId === null
    ? deliverPublication(message) : deliverAddressed(message));
  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        abort.abort();
        unregister();
        if (typeof unregisterCancel === 'function') unregisterCancel();
        await Promise.allSettled([...activeSessions].map(async id => {
          await bestEffortAbort(deps.host, id);
          await deps.host.kill(id);
        }));
        await deps.chatroom.stop();
      })();
      return stopPromise;
    },
  };
}
