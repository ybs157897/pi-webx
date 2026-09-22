/** Dispatch orchestration: owns runs and leases, delegates SDK, UI and loop work. */
import { randomUUID } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SUBAGENT_TOOL_NAME } from '../../src/shared/agent-definitions';
import { isRestrictedAgentTool } from '../agent-definitions';
import { SubagentCapacity, SubagentCapacityError, type WorkerSlot } from './subagent-capacity';
import { SubagentRunError } from './subagent-error';
import { executeWorkerSession, type WorkerSessionLike } from './subagent-execution';
import { SubagentLifecycle } from './subagent-lifecycle';
import { createWorkerSession, disposeWorkerSession, resolveWorkerModel, type SubagentParentContext, type WorkerSessionOptions } from './subagent-session';
import type { ExtensionUiScope } from './extension-ui';
import type { SubagentDispatchOutcome, SubagentDispatchRequest } from './subagent-tool';

export const DEFAULT_WORKER_TIMEOUT_MS = 120_000;

export interface WorkerSessionHandle extends WorkerSessionLike {
  getActiveToolNames(): string[];
  dispose(): void;
}

export interface SubagentWorkerDeps {
  readonly modelRuntime: () => Promise<ModelRuntime>;
  readonly capacity: SubagentCapacity;
  readonly createSession?: (options: WorkerSessionOptions) => Promise<WorkerSessionHandle>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface SubagentWorkerRunner {
  dispatch(parent: SubagentParentContext, request: SubagentDispatchRequest): Promise<SubagentDispatchOutcome>;
  /** Bounded cancellation; uncooperative work stays owned and charged until it exits. */
  cancelParent(parentId: string): Promise<void>;
  /** Close admission and cancel all calls during host shutdown. */
  cancelAll(): Promise<void>;
}

interface LiveRun {
  readonly parentId: string;
  readonly lifecycle: SubagentLifecycle;
  readonly responded: Promise<void>;
}

function runError(error: unknown, runId: string): SubagentRunError {
  if (error instanceof SubagentRunError) return error.withRunId(runId);
  if (error instanceof SubagentCapacityError) {
    return new SubagentRunError('capacity-full', error.message, undefined, runId);
  }
  return new SubagentRunError('model-error', `子智能体启动或执行失败：${error instanceof Error ? error.message : String(error)}`, undefined, runId);
}

export function createSubagentWorkerDispatch(deps: SubagentWorkerDeps): SubagentWorkerRunner {
  const runs = new Map<string, LiveRun>();
  const now = deps.now ?? Date.now;
  let accepting = true;

  const cancel = async (select: (run: LiveRun) => boolean): Promise<void> => {
    const selected = [...runs.values()].filter(select);
    for (const run of selected) run.lifecycle.cancel();
    await Promise.all(selected.map((run) => run.responded));
  };

  return {
    async dispatch(parent, request) {
      if (!accepting || request.signal?.aborted) {
        throw new SubagentRunError('parent-aborted', '父会话已取消或宿主正在关闭，未启动子智能体。');
      }
      const runId = randomUUID();
      const startedAt = now();
      const lifecycle = new SubagentLifecycle(request.signal, deps.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
      let respond!: () => void;
      const responded = new Promise<void>((resolve) => { respond = resolve; });
      runs.set(runId, { parentId: parent.sessionId, lifecycle, responded });
      // Keep cancelled startup/execution owned until late resources are disposed.
      void lifecycle.drained.then(() => runs.delete(runId));
      try {
        return await lifecycle.run(async (signal) => {
          let slot: WorkerSlot | undefined;
          let session: WorkerSessionHandle | undefined;
          let ui: ExtensionUiScope | undefined;
          try {
            const wait = await deps.capacity.acquire({
              parentId: parent.sessionId,
              definitionId: request.definition.id,
              definitionLimit: request.definition.maxConcurrentInstances,
            }, { signal, timeoutMs: deps.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS });
            if (wait.kind === 'timeout') throw new SubagentRunError('capacity-timeout', '子智能体等待并发槽位超时。');
            if (wait.kind === 'aborted') throw signal.reason ?? new SubagentRunError('parent-aborted', '子智能体排队已取消。');
            slot = wait.slot;
            lifecycle.enter('startup');
            const runtime = await deps.modelRuntime();
            signal.throwIfAborted();
            const model = resolveWorkerModel(request.definition, parent.session, runtime);
            ui = parent.createUiScope?.({
              kind: 'subagent', runId, agentId: request.definition.id,
              agentName: request.definition.name, toolCallId: request.toolCallId,
            }, signal);
            session = await (deps.createSession ?? createWorkerSession)({
              definition: request.definition, parent, model, runtime, signal,
              uiContext: ui?.context,
              toolNames: request.surface.toolNames,
              denied: [...new Set([SUBAGENT_TOOL_NAME, ...parent.session.getAllTools()
                .map((tool) => tool.name).filter(isRestrictedAgentTool)])],
            });
            signal.throwIfAborted();
            const effectiveTools = session.getActiveToolNames();
            const unavailable = [...new Set([
              ...request.surface.unavailable,
              ...request.surface.toolNames.filter((name) => !effectiveTools.includes(name)),
            ])];
            if (request.definition.tools.mode === 'selected' && unavailable.length > 0) {
              throw new SubagentRunError('unavailable-tools', `子智能体「${request.definition.name}」缺少定义要求的工具：${unavailable.join('、')}。`);
            }
            lifecycle.enter('running');
            const outcome = await executeWorkerSession(session, { ...request, signal });
            signal.throwIfAborted();
            return {
              ...outcome, runId, model: { provider: model.provider, id: model.id }, effectiveTools,
              durationMs: now() - startedAt,
              ...(unavailable.length === 0 ? {} : { unavailableTools: unavailable }),
            };
          } finally {
            try { if (session !== undefined) await disposeWorkerSession(session); }
            finally {
              try { ui?.dispose(); }
              finally { slot?.release(); }
            }
          }
        });
      } catch (error) {
        throw runError(error, runId);
      } finally {
        respond();
      }
    },
    cancelParent: (parentId) => cancel((run) => run.parentId === parentId),
    cancelAll: () => { accepting = false; return cancel(() => true); },
  };
}
