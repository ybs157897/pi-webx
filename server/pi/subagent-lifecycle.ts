import { SubagentRunError } from './subagent-error';

/** Allow cooperative cancellation to unwind before handing control back. */
export const WORKER_CLEANUP_GRACE_MS = 100;

/**
 * One cancellation authority for queueing, initialization and execution.
 * A caller can stop waiting without abandoning the owned operation: `drained`
 * settles only after its finally block disposes resources and releases capacity.
 */
export class SubagentLifecycle {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private stop!: (reason: SubagentRunError) => void;
  private readonly stopped = new Promise<SubagentRunError>((resolve) => { this.stop = resolve; });
  private phase: 'queue' | 'startup' | 'running' = 'queue';
  private drain!: () => void;
  readonly drained = new Promise<void>((resolve) => { this.drain = resolve; });
  private readonly onParentAbort = (): void => this.cancel();

  constructor(private readonly parentSignal: AbortSignal | undefined, timeoutMs: number) {
    this.timer = setTimeout(() => {
      const queued = this.phase === 'queue';
      this.abort(new SubagentRunError(
        queued ? 'capacity-timeout' : 'timeout',
        queued ? '子智能体等待并发槽位超时。' : '子智能体调用超时，已请求停止；仍在退出的资源继续计入容量。',
      ));
    }, timeoutMs);
    parentSignal?.addEventListener('abort', this.onParentAbort, { once: true });
    if (parentSignal?.aborted) this.cancel();
  }

  get signal(): AbortSignal { return this.controller.signal; }

  enter(phase: 'startup' | 'running'): void {
    this.signal.throwIfAborted();
    this.phase = phase;
  }

  cancel(): void {
    this.abort(new SubagentRunError('parent-aborted', '父会话取消了子智能体调用。'));
  }

  private abort(reason: SubagentRunError): void {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    this.stop(reason);
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const work = (async () => {
      try {
        this.signal.throwIfAborted();
        const result = await operation(this.signal);
        this.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (this.signal.aborted && !(error instanceof SubagentRunError && error.code === this.signal.reason?.code)) {
          throw this.signal.reason;
        }
        throw error;
      } finally {
        clearTimeout(this.timer);
        this.parentSignal?.removeEventListener('abort', this.onParentAbort);
        this.drain();
      }
    })();
    const cancellation = this.stopped.then(async (reason) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.drained,
          new Promise<void>((resolve) => { grace = setTimeout(resolve, WORKER_CLEANUP_GRACE_MS); }),
        ]);
        throw reason;
      } finally {
        if (grace !== undefined) clearTimeout(grace);
      }
    });
    try {
      return await Promise.race([work, cancellation]);
    } finally {
      // The owned work remains observed by Promise.race even after cancellation.
      // It may return much later; the owner retains its lease until then.
      clearTimeout(this.timer);
      this.parentSignal?.removeEventListener('abort', this.onParentAbort);
    }
  }
}
