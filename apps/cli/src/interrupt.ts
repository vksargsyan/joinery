import type { SignalSource } from './context';
import { InterruptedError } from './errors';
import type { Reporter } from './reporter';

/** How long a cancelled statement may take to unwind before the CLI stops anyway. */
export const CANCEL_GRACE_MS = 5_000;

/**
 * Ctrl+C handling. The first interrupt cancels the running statement through the session's
 * `cancel` (the command registers how, with `guard`) and lets the command unwind and close its
 * sessions; with nothing to cancel, or on a second Ctrl+C, or when unwinding takes longer than
 * the grace period, `hardStop` rejects and the runner exits 130 at once.
 */
export class Interrupts {
  readonly hardStop: Promise<never>;
  #interrupted = false;
  #cancel: (() => void) | undefined;
  #rejectHard!: (error: InterruptedError) => void;
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly reporter: Reporter,
    private readonly graceMs = CANCEL_GRACE_MS,
  ) {
    this.hardStop = new Promise<never>((_resolve, reject) => {
      this.#rejectHard = reject;
    });
    this.hardStop.catch(() => undefined);
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  listen(signals: SignalSource): void {
    this.#unsubscribe = signals.onInterrupt(() => this.interrupt());
  }

  /** Handles one Ctrl+C. */
  interrupt(): void {
    if (this.#interrupted) {
      this.#rejectHard(new InterruptedError());
      return;
    }
    this.#interrupted = true;
    const cancel = this.#cancel;
    if (!cancel) {
      this.#rejectHard(new InterruptedError());
      return;
    }
    this.reporter.print('Cancelling… (press Ctrl+C again to quit now)');
    this.#timer = setTimeout(() => this.#rejectHard(new InterruptedError()), this.graceMs);
    this.#timer.unref?.();
    try {
      cancel();
    } catch {
      this.#rejectHard(new InterruptedError());
    }
  }

  /**
   * Runs `work` with `cancel` as the Ctrl+C action. When interrupted, errors from the cancelled
   * work become InterruptedError.
   */
  async guard<T>(cancel: () => void, work: () => Promise<T>): Promise<T> {
    this.throwIfInterrupted();
    const previous = this.#cancel;
    this.#cancel = cancel;
    try {
      return await work();
    } catch (error) {
      if (this.#interrupted) throw new InterruptedError();
      throw error;
    } finally {
      this.#cancel = previous;
    }
  }

  throwIfInterrupted(): void {
    if (this.#interrupted) throw new InterruptedError();
  }

  dispose(): void {
    this.#unsubscribe?.();
    if (this.#timer) clearTimeout(this.#timer);
  }
}
