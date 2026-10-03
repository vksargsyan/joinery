import { catchUp, nextRun } from '@querybara/core';
import type { ScheduleRecord, ScheduleRepository, ScheduleRun } from '@querybara/storage';

/**
 * The scheduler (spec: scheduler and automation): runs each enabled schedule when it is due,
 * while Querybara is open. It keeps `nextRunAt` on every schedule, wakes at the soonest one (and at
 * least every minute, so a sleep or a clock change is noticed), and runs what is due through the
 * task executor. A run missed by more than a couple of minutes (Querybara closed, the computer
 * asleep) is caught up once or skipped, as the schedule says; a schedule still running when it
 * is due again skips that run. Every run, skipped ones included, is recorded. Timers and the
 * clock are injected, so the tests drive it.
 */

export interface TaskOutcome {
  readonly status: 'success' | 'failed' | 'cancelled';
  readonly message: string | null;
  readonly outputs: readonly string[];
  readonly jobId: string | null;
  /** Worth a notification even when it succeeded (a comparison that found differences). */
  readonly attention?: boolean;
}

export interface SchedulerOptions {
  readonly store: Pick<
    ScheduleRepository,
    'list' | 'get' | 'setNextRun' | 'startRun' | 'finishRun' | 'abandonRunning'
  >;
  /** Runs a schedule's task; resolves when it is done, never rejects for a task failure. */
  readonly execute: (schedule: ScheduleRecord) => Promise<TaskOutcome>;
  /** Tells the user about a finished run, as the schedule's `notify` says. */
  readonly notify?: (schedule: ScheduleRecord, run: ScheduleRun, outcome: TaskOutcome) => void;
  /** Something changed (for the Schedules panel). */
  readonly onEvent?: (event: SchedulerEvent) => void;
  readonly now?: () => Date;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface SchedulerEvent {
  readonly scheduleId: string | null;
  readonly kind: 'changed' | 'run-started' | 'run-finished';
}

/** Later than this, a due run counts as missed. */
export const MISSED_AFTER_MS = 2 * 60_000;
/** The longest the scheduler sleeps between checks. */
export const CHECK_EVERY_MS = 60_000;

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #now: () => Date;
  readonly #running = new Map<string, Promise<void>>();
  #timer: unknown;
  #started = false;
  #paused = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get paused(): boolean {
    return this.#paused;
  }

  isRunning(scheduleId: string): boolean {
    return this.#running.has(scheduleId);
  }

  /** Enabled schedules exist: Querybara should stay open in the background to run them. */
  hasEnabled(): boolean {
    return this.#options.store.list().some((schedule) => schedule.enabled);
  }

  /** Starts scheduling: runs a previous session left going are failed, missed runs handled. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#options.store.abandonRunning('Querybara closed while the run was going');
    this.reconcile();
    this.#tick();
  }

  stop(): void {
    this.#started = false;
    this.#clear();
  }

  /** Stops starting runs (runs going carry on), or starts again. */
  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#emit({ scheduleId: null, kind: 'changed' });
    if (!paused) this.#tick();
  }

  /**
   * Brings `nextRunAt` in line with each schedule (after a save, a delete, an enable): enabled
   * schedules without one are planned from now, disabled ones have none. Then re-arms.
   */
  reconcile(scheduleId?: string): void {
    const now = this.#now();
    const schedules =
      scheduleId === undefined
        ? this.#options.store.list()
        : [this.#options.store.get(scheduleId)].filter((s): s is ScheduleRecord => s !== undefined);
    for (const schedule of schedules) {
      if (!schedule.enabled) {
        if (schedule.nextRunAt !== null) this.#options.store.setNextRun(schedule.id, null);
        continue;
      }
      if (schedule.nextRunAt === null) {
        this.#options.store.setNextRun(schedule.id, nextRun(schedule.rule, now, now).toISOString());
      }
    }
    this.#emit({ scheduleId: scheduleId ?? null, kind: 'changed' });
    if (this.#started) this.#arm();
  }

  /** The computer woke up or the clock moved: check at once. */
  wake(): void {
    if (this.#started) this.#tick();
  }

  /** Runs a schedule now, as a manual run; refused while it is running. */
  runNow(scheduleId: string): ScheduleRun {
    const schedule = this.#options.store.get(scheduleId);
    if (!schedule) throw new Error(`There is no schedule ${scheduleId}`);
    if (this.#running.has(scheduleId)) {
      throw new Error('The schedule is running already');
    }
    return this.#run(schedule, 'manual');
  }

  /** Waits for the runs going (tests, and a quit that lets them finish). */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running.values());
  }

  #tick(): void {
    this.#clear();
    if (!this.#started) return;
    if (!this.#paused) {
      const now = this.#now();
      for (const schedule of this.#options.store.list()) {
        if (!schedule.enabled || schedule.nextRunAt === null) continue;
        const dueAt = new Date(schedule.nextRunAt);
        if (dueAt.getTime() > now.getTime()) continue;
        this.#due(schedule, dueAt, now);
      }
    }
    this.#arm();
  }

  #due(schedule: ScheduleRecord, dueAt: Date, now: Date): void {
    const missed = now.getTime() - dueAt.getTime() > MISSED_AFTER_MS;
    const { next, missed: count } = catchUp(schedule.rule, dueAt, now, schedule.missed, dueAt);
    this.#options.store.setNextRun(schedule.id, next.toISOString());
    if (this.#running.has(schedule.id)) {
      this.#record(schedule, 'schedule', 'The previous run was still going');
      return;
    }
    if (missed && schedule.missed === 'skip') {
      this.#record(
        schedule,
        'catch-up',
        `Missed ${count === 1 ? 'a run' : `${count} runs`} while Querybara was closed or the computer asleep`,
      );
      return;
    }
    this.#run(schedule, missed ? 'catch-up' : 'schedule');
  }

  /** A run that did not happen, recorded as skipped. */
  #record(schedule: ScheduleRecord, trigger: 'schedule' | 'catch-up', message: string): void {
    this.#options.store.startRun({ scheduleId: schedule.id, trigger, status: 'skipped', message });
    this.#emit({ scheduleId: schedule.id, kind: 'run-finished' });
  }

  #run(schedule: ScheduleRecord, trigger: 'schedule' | 'catch-up' | 'manual'): ScheduleRun {
    const run = this.#options.store.startRun({ scheduleId: schedule.id, trigger });
    // Marked running before the task starts, so nothing can see it idle meanwhile.
    let settle!: () => void;
    this.#running.set(schedule.id, new Promise<void>((resolve) => (settle = resolve)));
    this.#emit({ scheduleId: schedule.id, kind: 'run-started' });
    void (async () => {
      let outcome: TaskOutcome;
      try {
        outcome = await this.#options.execute(schedule);
      } catch (error) {
        outcome = {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
          outputs: [],
          jobId: null,
        };
      }
      try {
        const finished = this.#options.store.finishRun(run.id, {
          status: outcome.status,
          message: outcome.message,
          outputs: [...outcome.outputs],
          jobId: outcome.jobId,
        });
        this.#options.notify?.(this.#options.store.get(schedule.id) ?? schedule, finished, outcome);
      } catch {
        // A run whose schedule was deleted meanwhile, or a notification that cannot show.
      } finally {
        this.#running.delete(schedule.id);
        settle();
        this.#emit({ scheduleId: schedule.id, kind: 'run-finished' });
      }
    })();
    return run;
  }

  #arm(): void {
    this.#clear();
    if (!this.#started) return;
    const now = this.#now().getTime();
    const soonest = Math.min(
      ...this.#options.store
        .list()
        .filter((s) => s.enabled && s.nextRunAt !== null)
        .map((s) => new Date(s.nextRunAt!).getTime()),
    );
    const delay = Number.isFinite(soonest)
      ? Math.max(0, Math.min(CHECK_EVERY_MS, soonest - now))
      : CHECK_EVERY_MS;
    const setTimer = this.#options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#timer = setTimer(() => this.#tick(), delay);
  }

  #clear(): void {
    if (this.#timer === undefined) return;
    const clearTimer =
      this.#options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #emit(event: SchedulerEvent): void {
    this.#options.onEvent?.(event);
  }
}
