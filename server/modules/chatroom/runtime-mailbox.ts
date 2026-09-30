import type { AgentId } from '../../module-agents/contracts';

/** Each member owns an ordered mailbox; unrelated members can make progress independently. */
export class AgentMailbox {
  private readonly tails = new Map<AgentId, Promise<void>>();
  private readonly waiters: Array<() => void> = [];
  private running = 0;

  constructor(private readonly maxConcurrent: number, private readonly signal: AbortSignal) {}

  async run<T>(agentId: AgentId, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    let releaseTail!: () => void;
    const tail = new Promise<void>(resolve => { releaseTail = resolve; });
    this.tails.set(agentId, tail);
    await previous;
    try {
      await this.acquire();
      try { return await task(); }
      finally { this.release(); }
    } finally {
      if (this.tails.get(agentId) === tail) this.tails.delete(agentId);
      releaseTail();
    }
  }

  private async acquire(): Promise<void> {
    if (this.signal.aborted) throw new Error('聊天室执行器正在关闭');
    if (this.running < this.maxConcurrent) { this.running += 1; return; }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        this.signal.removeEventListener('abort', cancel);
        this.running += 1;
        resolve();
      };
      const cancel = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('聊天室执行器正在关闭'));
      };
      this.waiters.push(grant);
      this.signal.addEventListener('abort', cancel, { once: true });
    });
  }

  private release(): void {
    this.running -= 1;
    this.waiters.shift()?.();
  }
}
