import type { ScheduleRule } from '@querybara/core';
import { openStore, type ScheduleRecord, type SecretSealer, type Store } from '@querybara/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHECK_EVERY_MS, Scheduler, type TaskOutcome } from '../src/main/scheduler';
import { flush, profileInput } from './helpers';

/**
 * The scheduler against a real (in-memory) store, a clock the test moves and timers it fires:
 * plans the next runs, runs what is due, catches a missed run up once or skips it, skips a run
 * while the last is still going, runs on demand, and records every run.
 */

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

const everyDayAt2: ScheduleRule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['02:00'] };

interface Harness {
  store: Store;
  scheduler: Scheduler;
  clock: { now: Date };
  timers: { callback: () => void; ms: number }[];
  execute: ReturnType<typeof vi.fn<(schedule: ScheduleRecord) => Promise<TaskOutcome>>>;
  notify: ReturnType<typeof vi.fn>;
  events: string[];
  add(overrides?: Partial<Parameters<Store['schedules']['create']>[0]>): ScheduleRecord;
  /** Moves the clock and fires the pending timer. */
  advanceTo(date: Date): Promise<void>;
}

let open: Store[] = [];

function harness(start: Date): Harness {
  const store = openStore(':memory:', { sealer });
  open.push(store);
  const profile = store.profiles.save(profileInput());
  const clock = { now: start };
  const timers: { callback: () => void; ms: number }[] = [];
  const execute = vi.fn<(schedule: ScheduleRecord) => Promise<TaskOutcome>>(async () => ({
    status: 'success',
    message: 'Done',
    outputs: ['/out/file'],
    jobId: 'job',
  }));
  const notify = vi.fn();
  const events: string[] = [];
  const scheduler = new Scheduler({
    store: store.schedules,
    execute,
    notify,
    onEvent: (event) => events.push(event.kind),
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    store,
    scheduler,
    clock,
    timers,
    execute,
    notify,
    events,
    add: (overrides = {}) =>
      store.schedules.create({
        name: 'Nightly',
        kind: 'backup',
        profileId: profile.id,
        task: {},
        rule: everyDayAt2,
        ...overrides,
      }),
    advanceTo: async (date) => {
      clock.now = date;
      const pending = timers.splice(0);
      for (const timer of pending) timer.callback();
      await flush();
      await scheduler.settled();
    },
  };
}

beforeEach(() => {
  open = [];
});

afterEach(() => {
  for (const store of open) store.close();
});

describe('the scheduler', () => {
  it('plans enabled schedules, and sleeps at most a minute', () => {
    const h = harness(new Date(2026, 8, 30, 12, 0));
    const on = h.add();
    const off = h.add({ name: 'Off', enabled: false, nextRunAt: '2026-10-01T00:00:00.000Z' });
    h.scheduler.start();
    expect(h.store.schedules.get(on.id)?.nextRunAt).toBe(new Date(2026, 9, 1, 2, 0).toISOString());
    expect(h.store.schedules.get(off.id)?.nextRunAt).toBeNull();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(CHECK_EVERY_MS);
    expect(h.scheduler.hasEnabled()).toBe(true);
  });

  it('runs a schedule when it is due, records it and plans the next', async () => {
    const h = harness(new Date(2026, 9, 1, 1, 59, 30));
    const schedule = h.add();
    h.scheduler.start();
    // Due in 30 seconds: the timer is set for then.
    expect(h.timers[0]!.ms).toBe(30_000);
    await h.advanceTo(new Date(2026, 9, 1, 2, 0));
    expect(h.execute).toHaveBeenCalledTimes(1);
    const [run] = h.store.schedules.runs(schedule.id);
    expect(run).toMatchObject({
      trigger: 'schedule',
      status: 'success',
      message: 'Done',
      outputs: ['/out/file'],
      jobId: 'job',
    });
    expect(h.store.schedules.get(schedule.id)).toMatchObject({
      nextRunAt: new Date(2026, 9, 2, 2, 0).toISOString(),
      lastStatus: 'success',
    });
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: schedule.id }),
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    );
    expect(h.events).toEqual(expect.arrayContaining(['run-started', 'run-finished']));
  });

  it('catches a missed run up once, or skips it, as the schedule says', async () => {
    const h = harness(new Date(2026, 9, 5, 9, 0));
    const once = h.add({ name: 'Once', nextRunAt: new Date(2026, 9, 1, 2, 0).toISOString() });
    const skip = h.add({
      name: 'Skip',
      missed: 'skip',
      nextRunAt: new Date(2026, 9, 1, 2, 0).toISOString(),
    });
    h.scheduler.start();
    await flush();
    await h.scheduler.settled();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![0].id).toBe(once.id);
    expect(h.store.schedules.runs(once.id)[0]).toMatchObject({
      trigger: 'catch-up',
      status: 'success',
    });
    expect(h.store.schedules.runs(skip.id)[0]).toMatchObject({
      trigger: 'catch-up',
      status: 'skipped',
      message: 'Missed 5 runs while Querybara was closed or the computer asleep',
    });
    // Both plan from now, not from the missed time.
    for (const id of [once.id, skip.id]) {
      expect(h.store.schedules.get(id)?.nextRunAt).toBe(new Date(2026, 9, 6, 2, 0).toISOString());
    }
  });

  it('skips a run while the last one is still going', async () => {
    const h = harness(new Date(2026, 9, 1, 1, 0));
    let finish!: (outcome: TaskOutcome) => void;
    h.execute.mockImplementationOnce(
      () => new Promise<TaskOutcome>((resolve) => (finish = resolve)),
    );
    const schedule = h.add({ rule: { kind: 'interval', every: 1, unit: 'hours' } });
    h.scheduler.start();
    const due = new Date(h.store.schedules.get(schedule.id)!.nextRunAt!);
    h.clock.now = due;
    h.timers.splice(0).forEach((t) => t.callback());
    expect(h.scheduler.isRunning(schedule.id)).toBe(true);
    expect(() => h.scheduler.runNow(schedule.id)).toThrow('running already');
    h.clock.now = new Date(due.getTime() + 3_600_000);
    h.timers.splice(0).forEach((t) => t.callback());
    expect(h.store.schedules.runs(schedule.id)[0]).toMatchObject({
      status: 'skipped',
      message: 'The previous run was still going',
    });
    finish({ status: 'failed', message: 'Boom', outputs: [], jobId: null });
    await h.scheduler.settled();
    expect(h.store.schedules.runs(schedule.id).map((r) => r.status)).toEqual(['skipped', 'failed']);
    expect(h.store.schedules.get(schedule.id)?.lastStatus).toBe('failed');
  });

  it('runs on demand, and counts a task that throws as failed', async () => {
    const h = harness(new Date(2026, 9, 1, 12, 0));
    const schedule = h.add();
    h.scheduler.start();
    h.execute.mockImplementationOnce(() => {
      throw new Error('Nothing to run');
    });
    const run = h.scheduler.runNow(schedule.id);
    expect(run).toMatchObject({ trigger: 'manual', status: 'running' });
    await h.scheduler.settled();
    expect(h.store.schedules.getRun(run.id)).toMatchObject({
      status: 'failed',
      message: 'Nothing to run',
    });
    expect(h.scheduler.isRunning(schedule.id)).toBe(false);
    // Its planned run does not move.
    expect(h.store.schedules.get(schedule.id)?.nextRunAt).toBe(
      new Date(2026, 9, 2, 2, 0).toISOString(),
    );
  });

  it('fails the runs an earlier session left going, and pauses', async () => {
    const h = harness(new Date(2026, 9, 1, 12, 0));
    const schedule = h.add({ nextRunAt: new Date(2026, 9, 1, 11, 59).toISOString() });
    const stuck = h.store.schedules.startRun({ scheduleId: schedule.id, trigger: 'schedule' });
    h.scheduler.setPaused(true);
    h.scheduler.start();
    expect(h.store.schedules.getRun(stuck.id)).toMatchObject({
      status: 'failed',
      message: 'Querybara closed while the run was going',
    });
    // Paused: the due run waits.
    await flush();
    expect(h.execute).not.toHaveBeenCalled();
    h.scheduler.setPaused(false);
    await flush();
    await h.scheduler.settled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('replans on reconcile: turned off, it has no next run; on again, one from now', () => {
    const h = harness(new Date(2026, 9, 1, 12, 0));
    const schedule = h.add();
    h.scheduler.start();
    h.store.schedules.update(schedule.id, { enabled: false });
    h.scheduler.reconcile(schedule.id);
    expect(h.store.schedules.get(schedule.id)?.nextRunAt).toBeNull();
    expect(h.scheduler.hasEnabled()).toBe(false);
    h.store.schedules.update(schedule.id, { enabled: true, nextRunAt: null });
    h.scheduler.reconcile(schedule.id);
    expect(h.store.schedules.get(schedule.id)?.nextRunAt).toBe(
      new Date(2026, 9, 2, 2, 0).toISOString(),
    );
  });

  it('keeps an interval on its minute', async () => {
    const h = harness(new Date(2026, 9, 1, 10, 7));
    const schedule = h.add({ rule: { kind: 'interval', every: 15, unit: 'minutes' } });
    h.scheduler.start();
    expect(h.store.schedules.get(schedule.id)?.nextRunAt).toBe(
      new Date(2026, 9, 1, 10, 22).toISOString(),
    );
    // A late tick (the process was busy) still plans on the same minute.
    await h.advanceTo(new Date(2026, 9, 1, 10, 23, 10));
    expect(h.store.schedules.get(schedule.id)?.nextRunAt).toBe(
      new Date(2026, 9, 1, 10, 37).toISOString(),
    );
  });
});
