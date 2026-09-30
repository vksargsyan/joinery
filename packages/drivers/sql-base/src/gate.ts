/**
 * Serialises work on one driver connection. A connection runs one thing at a time, and a
 * result set whose consumer has paused keeps the connection busy, so any other operation on
 * the session first closes that open result ("preempts" it) and then runs. Short operations
 * (browse, ping, commit) simply queue.
 */
export class SessionGate {
  private holder: GateLease | null = null;
  private readonly waiting: Array<(lease: GateLease) => void> = [];

  /** Waits for exclusive use of the connection. Always release the lease. */
  acquire(): Promise<GateLease> {
    return new Promise((resolve) => {
      if (this.holder === null) {
        this.holder = new GateLease(this);
        resolve(this.holder);
        return;
      }
      this.waiting.push(resolve);
      this.holder.requestPreempt();
    });
  }

  /** Runs `fn` with exclusive use of the connection. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await fn();
    } finally {
      lease.release();
    }
  }

  /** True while an operation or an open result holds the connection. */
  get busy(): boolean {
    return this.holder !== null;
  }

  /** True while the holder is an open result set (which the next operation will close). */
  get holdsOpenResult(): boolean {
    return this.holder?.preemptible === true;
  }

  /** @internal */
  get hasWaiters(): boolean {
    return this.waiting.length > 0;
  }

  /** @internal */
  handOver(from: GateLease): void {
    if (this.holder !== from) return;
    const next = this.waiting.shift();
    if (next === undefined) {
      this.holder = null;
      return;
    }
    this.holder = new GateLease(this);
    next(this.holder);
  }
}

/** Exclusive use of a session's connection, from `SessionGate.acquire`. */
export class GateLease {
  private released = false;
  private preemptHandler: (() => Promise<void>) | undefined;
  private preempting = false;

  constructor(private readonly gate: SessionGate) {}

  /**
   * Marks the lease as held by an open result. When another operation needs the connection,
   * `handler` runs (it must wait for in-flight driver work, then close the result) and the
   * lease is released afterwards.
   */
  setPreemptHandler(handler: (() => Promise<void>) | undefined): void {
    this.preemptHandler = handler;
    if (handler !== undefined && this.gate.hasWaiters) this.requestPreempt();
  }

  get preemptible(): boolean {
    return this.preemptHandler !== undefined && !this.released;
  }

  /** @internal */
  requestPreempt(): void {
    const handler = this.preemptHandler;
    if (handler === undefined || this.preempting || this.released) return;
    this.preempting = true;
    void handler()
      .catch(() => undefined)
      .finally(() => this.release());
  }

  /** Idempotent. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.preemptHandler = undefined;
    this.gate.handOver(this);
  }
}
