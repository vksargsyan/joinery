import { describe, expect, it } from 'vitest';

import {
  catchUp,
  describeRule,
  nextRun,
  scheduleRuleSchema,
  upcomingRuns,
  type ScheduleRule,
} from '../src';

/**
 * Schedule rules in local time. The package's tests run in Europe/Berlin: summer time starts on
 * 29 March 2026 (02:00 → 03:00) and ends on 25 October 2026 (03:00 → 02:00).
 */

const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date =>
  new Date(y, mo - 1, d, h, mi);

function shown(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe('schedule rules', () => {
  it('run in the zone the tests pin', () => {
    expect(local(2026, 3, 29, 2, 30).getHours()).toBe(3);
  });

  it('repeat an interval from their anchor, on the same minute', () => {
    const rule: ScheduleRule = { kind: 'interval', every: 15, unit: 'minutes' };
    const anchor = local(2026, 9, 30, 10, 7);
    expect(shown(nextRun(rule, local(2026, 9, 30, 10, 7), anchor))).toBe('2026-09-30 10:22');
    expect(shown(nextRun(rule, local(2026, 9, 30, 11, 0), anchor))).toBe('2026-09-30 11:07');
    // Before the anchor, the anchor itself.
    expect(shown(nextRun(rule, local(2026, 9, 30, 9, 0), anchor))).toBe('2026-09-30 10:07');
    // Without an anchor, from the moment asked.
    expect(
      shown(nextRun({ kind: 'interval', every: 2, unit: 'hours' }, local(2026, 9, 30, 10, 7))),
    ).toBe('2026-09-30 12:07');
  });

  it('run at times of day on the chosen weekdays', () => {
    // Weekdays at 09:00 and 17:30; 30 September 2026 is a Wednesday.
    const rule: ScheduleRule = { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['17:30', '09:00'] };
    expect(upcomingRuns(rule, local(2026, 9, 30, 12, 0), 4).map(shown)).toEqual([
      '2026-09-30 17:30',
      '2026-10-01 09:00',
      '2026-10-01 17:30',
      '2026-10-02 09:00',
    ]);
    // Friday evening: next is Monday morning.
    expect(shown(nextRun(rule, local(2026, 10, 2, 18, 0)))).toBe('2026-10-05 09:00');
    // Exactly at a run: the next one.
    expect(shown(nextRun(rule, local(2026, 10, 5, 9, 0)))).toBe('2026-10-05 17:30');
  });

  it('keep local time across daylight saving', () => {
    const daily: ScheduleRule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['02:30'] };
    // The spring-forward day has no 02:30: it runs at 03:30, the minute the gap ends.
    expect(upcomingRuns(daily, local(2026, 3, 28, 12, 0), 3).map(shown)).toEqual([
      '2026-03-29 03:30',
      '2026-03-30 02:30',
      '2026-03-31 02:30',
    ]);
    // The fall-back day has 02:30 twice: it runs once.
    const runs = upcomingRuns(daily, local(2026, 10, 24, 12, 0), 3);
    expect(runs.map(shown)).toEqual(['2026-10-25 02:30', '2026-10-26 02:30', '2026-10-27 02:30']);
    // 25 hours between the fall-back run and the next.
    expect((runs[1]!.getTime() - runs[0]!.getTime()) / 3_600_000).toBe(25);
    // Intervals are real time: every hour across the fall-back hour runs in both 02:xx hours.
    const hourly = upcomingRuns(
      { kind: 'interval', every: 1, unit: 'hours' },
      new Date('2026-10-24T23:15:00Z'),
      3,
      new Date('2026-10-24T23:15:00Z'),
    );
    expect(hourly.map((d) => d.toISOString())).toEqual([
      '2026-10-25T00:15:00.000Z',
      '2026-10-25T01:15:00.000Z',
      '2026-10-25T02:15:00.000Z',
    ]);
  });

  it('run on days of the month, skipping months without the day', () => {
    const rule: ScheduleRule = { kind: 'monthly', days: [31, 1], time: '03:00' };
    expect(upcomingRuns(rule, local(2026, 3, 31, 12, 0), 4).map(shown)).toEqual([
      '2026-04-01 03:00',
      '2026-05-01 03:00',
      '2026-05-31 03:00',
      '2026-06-01 03:00',
    ]);
    const last: ScheduleRule = { kind: 'monthly', days: ['last'], time: '23:00' };
    expect(upcomingRuns(last, local(2028, 1, 31, 23, 0), 3).map(shown)).toEqual([
      '2028-02-29 23:00',
      '2028-03-31 23:00',
      '2028-04-30 23:00',
    ]);
    // 29 February, from a year that has none: the next leap year.
    expect(shown(nextRun({ kind: 'monthly', days: [29], time: '00:00' }, local(2026, 2, 1)))).toBe(
      '2026-03-29 00:00',
    );
  });

  it('catch up once, or skip, what was missed', () => {
    const rule: ScheduleRule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['02:00'] };
    const due = local(2026, 9, 27, 2, 0);
    const now = local(2026, 9, 30, 8, 0);
    expect(catchUp(rule, due, now, 'run-once')).toEqual({
      runNow: true,
      missed: 4,
      next: local(2026, 10, 1, 2, 0),
    });
    expect(catchUp(rule, due, now, 'skip')).toMatchObject({ runNow: false, missed: 4 });
    // Not due yet: nothing to catch up.
    expect(catchUp(rule, local(2026, 10, 1, 2, 0), now, 'run-once')).toEqual({
      runNow: false,
      missed: 0,
      next: local(2026, 10, 1, 2, 0),
    });
  });

  it('describe themselves', () => {
    expect(describeRule({ kind: 'interval', every: 1, unit: 'hours' })).toBe('Every hour');
    expect(describeRule({ kind: 'interval', every: 15, unit: 'minutes' })).toBe('Every 15 minutes');
    expect(describeRule({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['02:00'] })).toBe(
      'Every day at 02:00',
    );
    expect(describeRule({ kind: 'weekly', days: [5, 1, 2, 3, 4], times: ['17:30', '09:00'] })).toBe(
      'Weekdays at 09:00 and 17:30',
    );
    expect(describeRule({ kind: 'weekly', days: [6, 0], times: ['10:00'] })).toBe(
      'Weekends at 10:00',
    );
    expect(describeRule({ kind: 'weekly', days: [0, 4, 1], times: ['08:15'] })).toBe(
      'Mon, Thu and Sun at 08:15',
    );
    expect(describeRule({ kind: 'monthly', days: ['last', 1, 22, 13], time: '03:00' })).toBe(
      'Monthly on the 1st, the 13th, the 22nd and the last day at 03:00',
    );
  });

  it('refuse what cannot run', () => {
    for (const bad of [
      { kind: 'interval', every: 0, unit: 'minutes' },
      { kind: 'weekly', days: [], times: ['02:00'] },
      { kind: 'weekly', days: [7], times: ['02:00'] },
      { kind: 'weekly', days: [1], times: ['24:00'] },
      { kind: 'weekly', days: [1], times: ['9:00'] },
      { kind: 'monthly', days: [32], time: '03:00' },
      { kind: 'monthly', days: [], time: '03:00' },
      { kind: 'cron', expression: '* * * * *' },
    ]) {
      expect(scheduleRuleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
