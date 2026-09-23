/** Worker FIFO scheduling; all held sessions reserve the shared host budget. */
import type { SessionCapacity, SessionReservation } from './session-capacity';

/** Hard ceiling on concurrently running workers for one host process. */
export const MAX_WORKERS = 2;

/** Why an admission was refused outright (never for capacity pressure). */
export type SubagentCapacityCode = 'host-full';

/** An admission refusal. The caller turns these into a failed dispatch. */
export class SubagentCapacityError extends Error {
  readonly code: SubagentCapacityCode;

  constructor(code: SubagentCapacityCode, message: string) {
    super(message);
    this.name = 'SubagentCapacityError';
    this.code = code;
  }
}

/** One held slot. The caller keeps it for the lifetime of the worker session. */
export interface WorkerLease {
  readonly id: string;
  readonly parentId: string;
  readonly definitionId: string;
}

export interface SubagentCapacityLimits {
  readonly maxWorkers: number;
  readonly budget: SessionCapacity;
}

/** What a caller must declare to be admitted. */
export interface WorkerSlotRequest {
  readonly parentId: string;
  readonly definitionId: string;
  /** `definition.maxConcurrentInstances`, already validated by the store. */
  readonly definitionLimit: number;
}

/** A held slot: releasing it invites the next waiter. */
export interface WorkerSlot {
  readonly lease: WorkerLease;
  /** Idempotent: releasing twice frees one slot, not two. */
  release(): void;
}

/** How a wait ended. `acquired` is the only case that holds a slot. */
export type SlotWait =
  | { readonly kind: 'acquired'; readonly slot: WorkerSlot }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'timeout' };

export interface SlotWaitOptions {
  /** Cancellation of the *wait*: the queued request is removed immediately. */
  readonly signal?: AbortSignal;
  /** Whole budget for waiting, in milliseconds. */
  readonly timeoutMs: number;
}

interface Waiter {
  readonly request: WorkerSlotRequest;
  resolve(wait: SlotWait): void;
  /** Clears the timer and abort listener once the wait is settled. */
  cleanup(): void;
}

/**
 * The live worker slots and the FIFO queue behind them.
 *
 * @example
 * ```ts
 * const wait = await capacity.acquire(request, { signal, timeoutMs: 5_000 });
 * if (wait.kind !== 'acquired') return;      // aborted or timed out
 * try { await runWorker(); } finally { wait.slot.release(); }
 * ```
 */
export class SubagentCapacity {
  private readonly held = new Map<string, { lease: WorkerLease; reservation: SessionReservation }>();
  private readonly waiting: Waiter[] = [];
  private nextId = 1;

  constructor(private readonly limits: SubagentCapacityLimits) {
    limits.budget.onRelease(() => this.pump());
  }

  /** Slots currently held, i.e. workers that have started. */
  get size(): number {
    return this.held.size;
  }

  /** Requests waiting for a slot. They hold no capacity. */
  get queued(): number {
    return this.waiting.length;
  }

  /** Whether this parent has a worker that has started. */
  hasWorkers(parentId: string): boolean {
    for (const { lease } of this.held.values()) {
      if (lease.parentId === parentId) return true;
    }
    return false;
  }

  /** Whether this parent has anything in flight — running or still queued. */
  hasPending(parentId: string): boolean {
    return this.hasWorkers(parentId) || this.waiting.some((waiter) => waiter.request.parentId === parentId);
  }

  /** Lease ids held by one parent, for cancellation. */
  leasesFor(parentId: string): WorkerLease[] {
    return this.all().filter((lease) => lease.parentId === parentId);
  }

  /** Every lease, for shutdown. */
  all(): WorkerLease[] {
    return [...this.held.values()].map(({ lease }) => lease);
  }

  /**
   * Start now, or wait in line for a slot.
   *
   * The admission decision for a free slot is synchronous, so a caller that can
   * start does start in the same tick it asked — two dispatches cannot both
   * observe the same free slot.
   *
   * @param request - who is asking and which limit applies.
   * @param options - cancellation of the wait and its whole budget.
   * @returns how the wait ended; only `acquired` holds a slot.
   * @throws {SubagentCapacityError} `host-full` — no room for a new session reservation.
   */
  async acquire(request: WorkerSlotRequest, options: SlotWaitOptions): Promise<SlotWait> {
    if (options.signal?.aborted === true) return { kind: 'aborted' };
    if (this.limits.budget.full) {
      throw new SubagentCapacityError(
        'host-full',
        `会话数已达上限 ${this.limits.budget.limit}（含创建中和子智能体实例），请先关闭部分会话。`,
      );
    }
    const immediate = this.admit(request);
    if (immediate !== undefined) return { kind: 'acquired', slot: this.slotFor(immediate) };
    if (options.timeoutMs <= 0) return { kind: 'timeout' };

    return await new Promise<SlotWait>((resolve) => {
      let settled = false;
      const finish = (wait: SlotWait): void => {
        if (settled) return;
        settled = true;
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        cleanup();
        resolve(wait);
      };
      const onAbort = (): void => finish({ kind: 'aborted' });
      const timer = setTimeout(() => finish({ kind: 'timeout' }), options.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = { request, resolve: finish, cleanup };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // A signal that fired between the check above and the listener landing
      // must not leave the request queued forever.
      if (options.signal?.aborted === true) {
        finish({ kind: 'aborted' });
        return;
      }
      this.waiting.push(waiter);
      this.pump();
    });
  }

  /** Take a slot if one is free for this request. */
  private admit(request: WorkerSlotRequest): WorkerLease | undefined {
    if (this.held.size >= this.limits.maxWorkers) return undefined;
    if (this.countForDefinition(request.definitionId) >= request.definitionLimit) return undefined;
    const reservation = this.limits.budget.reserve();
    if (reservation === undefined) return undefined;
    const lease: WorkerLease = {
      id: `worker-${this.nextId++}`,
      parentId: request.parentId,
      definitionId: request.definitionId,
    };
    this.held.set(lease.id, { lease, reservation });
    return lease;
  }

  /** Build the release handle for one admitted request. */
  private slotFor(lease: WorkerLease): WorkerSlot {
    let released = false;
    return {
      lease,
      release: () => {
        if (released) return;
        released = true;
        const held = this.held.get(lease.id);
        this.held.delete(lease.id);
        held?.reservation.release();
      },
    };
  }

  /** Admit every waiter whose limits now allow it, in arrival order. */
  private pump(): void {
    for (let index = 0; index < this.waiting.length;) {
      const waiter = this.waiting[index];
      const lease = waiter === undefined ? undefined : this.admit(waiter.request);
      if (waiter === undefined || lease === undefined) {
        // The head of the queue stays put; a later request for a *different*
        // definition may still be admissible, so the scan continues.
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      waiter.cleanup();
      waiter.resolve({ kind: 'acquired', slot: this.slotFor(lease) });
    }
  }

  private countForDefinition(definitionId: string): number {
    let count = 0;
    for (const { lease } of this.held.values()) {
      if (lease.definitionId === definitionId) count += 1;
    }
    return count;
  }
}
