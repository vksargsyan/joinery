import type { ScheduleRule } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS, RUNS_KEPT } from '../src';
import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

/**
 * Schedules and their runs: a schedule runs on a connection or a saved comparison and goes with
 * it; edits are versioned; the scheduler moves `nextRunAt` without a version bump; runs keep
 * the history, newest first, up to a limit.
 */

const daily: ScheduleRule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['02:00'] };
const task = { job: { kind: 'backup', profileId: 'x', output: '/backups/shop-{date}.dump' } };

describe('schedules', () => {
  it('is a migration of its own', () => {
    expect(MIGRATIONS.find((m) => m.name === 'schedules')?.version).toBe(6);
  });

  it('creates, reads, updates with version bumps and deletes', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile({ name: 'Shop' }));
    const created = store.schedules.create({
      name: '  Nightly backup  ',
      kind: 'backup',
      profileId: profile.id,
      task,
      rule: daily,
      nextRunAt: '2026-10-01T00:00:00.000Z',
    });
    expect(created).toEqual({
      id: expect.any(String),
      name: 'Nightly backup',
      enabled: true,
      kind: 'backup',
      profileId: profile.id,
      comparisonId: null,
      task,
      rule: daily,
      missed: 'run-once',
      notify: 'failures',
      nextRunAt: '2026-10-01T00:00:00.000Z',
      lastRunAt: null,
      lastStatus: null,
      version: 1,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    expect(store.schedules.list()).toEqual([created]);
    expect(store.schedules.list({ profileId: 'other' })).toEqual([]);

    clock.advance();
    const updated = store.schedules.update(created.id, {
      enabled: false,
      rule: { kind: 'interval', every: 6, unit: 'hours' },
      notify: 'always',
    });
    expect(updated).toMatchObject({
      enabled: false,
      rule: { kind: 'interval', every: 6, unit: 'hours' },
      notify: 'always',
      version: 2,
      updatedAt: clock.iso(),
    });
    expect(
      thrown(() => store.schedules.update(created.id, { name: 'x' }, { expectedVersion: 1 })),
    ).toMatchObject({ code: 'CONFLICT' });

    store.schedules.setNextRun(created.id, '2026-10-02T00:00:00.000Z');
    expect(store.schedules.get(created.id)).toMatchObject({
      nextRunAt: '2026-10-02T00:00:00.000Z',
      version: 2,
    });

    expect(store.schedules.delete(created.id)).toBe(true);
    expect(store.schedules.delete(created.id)).toBe(false);
  });

  it('runs on a connection or a saved comparison, and goes with it', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile({ name: 'Shop' }));
    const comparison = store.comparisons.create({
      name: 'Dev vs prod',
      kind: 'structure',
      sourceProfileId: profile.id,
      targetProfileId: profile.id,
    });
    const base = { name: 'x', task, rule: daily };
    expect(thrown(() => store.schedules.create({ ...base, kind: 'backup' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(
      thrown(() =>
        store.schedules.create({
          ...base,
          kind: 'comparison',
          profileId: profile.id,
          comparisonId: comparison.id,
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      thrown(() => store.schedules.create({ ...base, kind: 'sql', profileId: 'nobody' })),
    ).toMatchObject({ code: 'NOT_FOUND' });

    const onComparison = store.schedules.create({
      ...base,
      kind: 'comparison',
      comparisonId: comparison.id,
    });
    const onProfile = store.schedules.create({ ...base, kind: 'sql', profileId: profile.id });
    // Deleting the connection takes its schedule; the comparison's stays (its sides clear).
    store.profiles.delete(profile.id);
    expect(store.schedules.get(onProfile.id)).toBeUndefined();
    expect(store.schedules.get(onComparison.id)).toBeDefined();
    store.comparisons.delete(comparison.id);
    expect(store.schedules.get(onComparison.id)).toBeUndefined();
  });

  it('keeps the runs, newest first, up to a limit', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile({ name: 'Shop' }));
    const schedule = store.schedules.create({
      name: 'Export',
      kind: 'export',
      profileId: profile.id,
      task,
      rule: daily,
    });

    const run = store.schedules.startRun({ scheduleId: schedule.id, trigger: 'schedule' });
    expect(run).toEqual({
      id: expect.any(String),
      scheduleId: schedule.id,
      trigger: 'schedule',
      status: 'running',
      startedAt: clock.iso(),
      finishedAt: null,
      message: null,
      outputs: [],
      jobId: null,
    });
    expect(store.schedules.get(schedule.id)).toMatchObject({
      lastRunAt: clock.iso(),
      lastStatus: 'running',
    });
    clock.advance();
    const finished = store.schedules.finishRun(run.id, {
      status: 'success',
      outputs: ['/exports/orders-2026-09-30.csv'],
      jobId: 'job-1',
    });
    expect(finished).toMatchObject({
      status: 'success',
      finishedAt: clock.iso(),
      outputs: ['/exports/orders-2026-09-30.csv'],
      jobId: 'job-1',
    });
    expect(store.schedules.get(schedule.id)?.lastStatus).toBe('success');

    // A skipped run is recorded finished at once.
    clock.advance();
    const skipped = store.schedules.startRun({
      scheduleId: schedule.id,
      trigger: 'catch-up',
      status: 'skipped',
      message: 'The last run is still going',
    });
    expect(skipped.finishedAt).toBe(clock.iso());
    expect(store.schedules.runs(schedule.id).map((r) => r.status)).toEqual(['skipped', 'success']);

    for (let i = 0; i < RUNS_KEPT + 5; i++) {
      clock.advance();
      store.schedules.startRun({ scheduleId: schedule.id, trigger: 'schedule', status: 'skipped' });
    }
    expect(store.schedules.runs(schedule.id, 1000)).toHaveLength(RUNS_KEPT);
  });

  it('marks runs left going by an earlier session as failed', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile({ name: 'Shop' }));
    const schedule = store.schedules.create({
      name: 'SQL',
      kind: 'sql',
      profileId: profile.id,
      task,
      rule: daily,
    });
    const run = store.schedules.startRun({ scheduleId: schedule.id, trigger: 'schedule' });
    expect(store.schedules.abandonRunning('Joinery closed during the run')).toBe(1);
    expect(store.schedules.getRun(run.id)).toMatchObject({
      status: 'failed',
      message: 'Joinery closed during the run',
    });
    expect(store.schedules.get(schedule.id)?.lastStatus).toBe('failed');
    expect(store.schedules.abandonRunning('again')).toBe(0);
  });

  it('refuses rules that cannot run', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile({ name: 'Shop' }));
    expect(
      thrown(() =>
        store.schedules.create({
          name: 'x',
          kind: 'sql',
          profileId: profile.id,
          task,
          rule: { kind: 'weekly', days: [], times: ['02:00'] },
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
