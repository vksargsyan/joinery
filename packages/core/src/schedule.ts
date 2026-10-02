import { z } from 'zod';

/**
 * When a scheduled job runs (spec: scheduler and automation): every N minutes or hours, at
 * times of day on chosen weekdays, or at a time on chosen days of the month. Times are the
 * computer's local time, so "every day at 02:00" stays at 02:00 across daylight-saving changes:
 * a time that does not exist that day (the spring-forward gap) runs at the first minute after
 * it, and a time that happens twice (fall-back) runs once. A day of the month a month does not
 * have (the 31st in April) is skipped; `last` means the month's last day. Pure.
 */

/** "HH:MM", 24-hour. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time is HH:MM, from 00:00 to 23:59');

/** 0 is Sunday, as `Date.getDay()` counts. */
export const weekdaySchema = z.number().int().min(0).max(6);

export const scheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    every: z.number().int().min(1).max(10_080),
    unit: z.enum(['minutes', 'hours']),
  }),
  z.object({
    kind: z.literal('weekly'),
    /** The weekdays it runs on; all seven for every day. */
    days: z.array(weekdaySchema).min(1).max(7),
    times: z.array(timeOfDaySchema).min(1).max(48),
  }),
  z.object({
    kind: z.literal('monthly'),
    days: z
      .array(z.union([z.number().int().min(1).max(31), z.literal('last')]))
      .min(1)
      .max(32),
    time: timeOfDaySchema,
  }),
]);
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

/** What happens to runs missed while Joinery was closed or the computer slept. */
export const missedRunPolicySchema = z.enum([
  /** One catch-up run as soon as possible, however many were missed. */
  'run-once',
  /** Nothing: the next run is the next time due. */
  'skip',
]);
export type MissedRunPolicy = z.infer<typeof missedRunPolicySchema>;

const MINUTE = 60_000;
/** An interval rule may not fire faster than this, whatever it says. */
export const MIN_INTERVAL_MS = MINUTE;

function parseTime(time: string): { hours: number; minutes: number } {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return { hours, minutes };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** The local moment of `time` on a date; the first valid minute after it in a DST gap. */
function at(year: number, month: number, day: number, time: string): Date {
  const { hours, minutes } = parseTime(time);
  return new Date(year, month, day, hours, minutes, 0, 0);
}

function intervalMs(rule: Extract<ScheduleRule, { kind: 'interval' }>): number {
  return Math.max(MIN_INTERVAL_MS, rule.every * (rule.unit === 'hours' ? 60 : 1) * MINUTE);
}

/**
 * The first time the rule is due strictly after `after`. Interval rules count from `anchor`
 * (the schedule's creation, or its last run), so every hour stays on the same minute; without
 * one they count from `after`.
 */
export function nextRun(rule: ScheduleRule, after: Date, anchor?: Date): Date {
  const from = after.getTime();
  switch (rule.kind) {
    case 'interval': {
      const step = intervalMs(rule);
      const start = anchor?.getTime() ?? from;
      if (start > from) return new Date(start);
      const steps = Math.floor((from - start) / step) + 1;
      return new Date(start + steps * step);
    }
    case 'weekly': {
      const days = new Set(rule.days);
      const times = [...new Set(rule.times)].sort();
      // A week and a day covers every weekday after any moment.
      for (let offset = 0; offset <= 8; offset++) {
        const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
        if (!days.has(day.getDay())) continue;
        for (const time of times) {
          const candidate = at(day.getFullYear(), day.getMonth(), day.getDate(), time);
          if (candidate.getTime() > from) return candidate;
        }
      }
      throw new Error('A weekly rule has a day and a time');
    }
    case 'monthly': {
      // Four years covers any day of the month the rule can name (29 February included).
      for (let offset = 0; offset <= 48; offset++) {
        const year = after.getFullYear();
        const month = after.getMonth() + offset;
        const first = new Date(year, month, 1);
        const length = daysInMonth(first.getFullYear(), first.getMonth());
        const dates = [
          ...new Set(rule.days.map((d) => (d === 'last' ? length : d)).filter((d) => d <= length)),
        ].sort((a, b) => a - b);
        for (const date of dates) {
          const candidate = at(first.getFullYear(), first.getMonth(), date, rule.time);
          if (candidate.getTime() > from) return candidate;
        }
      }
      throw new Error('A monthly rule has a day that some month has');
    }
  }
}

/** The next `count` times the rule is due after `after`, for the schedule editor's preview. */
export function upcomingRuns(
  rule: ScheduleRule,
  after: Date,
  count: number,
  anchor?: Date,
): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextRun(rule, cursor, anchor);
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Where a schedule stands at `now`, given when it was next due: whether a run is due now (a
 * missed one counts once, under `run-once`), how many were missed, and when it is next due
 * after that.
 */
export function catchUp(
  rule: ScheduleRule,
  dueAt: Date,
  now: Date,
  policy: MissedRunPolicy,
  anchor?: Date,
): { readonly runNow: boolean; readonly missed: number; readonly next: Date } {
  if (dueAt.getTime() > now.getTime()) return { runNow: false, missed: 0, next: dueAt };
  // Count what was missed, bounded: a schedule every minute left for a year is "many".
  let missed = 0;
  let cursor = dueAt;
  while (cursor.getTime() <= now.getTime() && missed < 10_000) {
    missed++;
    cursor = nextRun(rule, cursor, anchor);
  }
  return { runNow: policy === 'run-once', missed, next: nextRun(rule, now, anchor) };
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}

/** "Every 15 minutes", "Every day at 02:00", "Mon and Thu at 09:00", "On the 1st at 03:00". */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.kind) {
    case 'interval': {
      const unit = rule.unit === 'hours' ? 'hour' : 'minute';
      return rule.every === 1 ? `Every ${unit}` : `Every ${rule.every} ${unit}s`;
    }
    case 'weekly': {
      const days = [...new Set(rule.days)].sort((a, b) => a - b);
      const times = listOf([...new Set(rule.times)].sort());
      if (days.length === 7) return `Every day at ${times}`;
      const weekdays = [1, 2, 3, 4, 5];
      if (days.length === 5 && weekdays.every((d) => days.includes(d))) {
        return `Weekdays at ${times}`;
      }
      if (days.length === 2 && days.includes(0) && days.includes(6)) return `Weekends at ${times}`;
      // Monday first, as people read a week.
      const named = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)].map(
        (d) => WEEKDAY_NAMES[d]!,
      );
      return `${listOf(named)} at ${times}`;
    }
    case 'monthly': {
      const numbered = [...new Set(rule.days.filter((d): d is number => d !== 'last'))].sort(
        (a, b) => a - b,
      );
      const days = [
        ...numbered.map((d) => `the ${ordinal(d)}`),
        ...(rule.days.includes('last') ? ['the last day'] : []),
      ];
      return `Monthly on ${listOf(days)} at ${rule.time}`;
    }
  }
}
