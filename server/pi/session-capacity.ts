/** A shared, synchronous reservation budget for hosted and worker sessions. */
export interface SessionReservation { release(): void; }

export class SessionCapacity {
  private used = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly limit: number) {}

  get size(): number { return this.used; }
  get full(): boolean { return this.used >= this.limit; }

  reserve(): SessionReservation | undefined {
    if (this.full) return undefined;
    this.used += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.used -= 1;
        for (const listener of this.listeners) listener();
      },
    };
  }

  onRelease(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
