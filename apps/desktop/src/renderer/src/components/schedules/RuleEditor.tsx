import {
  describeRule,
  scheduleRuleSchema,
  upcomingRuns,
  type MissedRunPolicy,
  type ScheduleRule,
} from '@joinery/core';
import { useMemo, useState } from 'react';

import { cx } from '../ui';

/**
 * The "when" of a schedule: every N minutes or hours; at times of day on chosen weekdays; or at
 * a time on chosen days of the month. Below it, in words, what the rule says and the next runs,
 * so a rule is checked by reading it. Invalid input (no weekday, no time) is shown and not
 * passed up.
 */

type Mode = ScheduleRule['kind'];

const WEEKDAYS = [
  { day: 1, short: 'Mon' },
  { day: 2, short: 'Tue' },
  { day: 3, short: 'Wed' },
  { day: 4, short: 'Thu' },
  { day: 5, short: 'Fri' },
  { day: 6, short: 'Sat' },
  { day: 0, short: 'Sun' },
] as const;

const MODES: readonly { readonly mode: Mode; readonly label: string }[] = [
  { mode: 'interval', label: 'Every…' },
  { mode: 'weekly', label: 'Daily or weekly' },
  { mode: 'monthly', label: 'Monthly' },
];

/** A rule's editable form: every field kept, so switching modes loses nothing. */
interface Draft {
  mode: Mode;
  every: string;
  unit: 'minutes' | 'hours';
  days: number[];
  times: string[];
  monthDays: (number | 'last')[];
  monthTime: string;
}

function draftOf(rule: ScheduleRule): Draft {
  const base: Draft = {
    mode: rule.kind,
    every: '1',
    unit: 'hours',
    days: [0, 1, 2, 3, 4, 5, 6],
    times: ['02:00'],
    monthDays: [1],
    monthTime: '03:00',
  };
  if (rule.kind === 'interval') return { ...base, every: String(rule.every), unit: rule.unit };
  if (rule.kind === 'weekly') return { ...base, days: [...rule.days], times: [...rule.times] };
  return { ...base, monthDays: [...rule.days], monthTime: rule.time };
}

function ruleOf(draft: Draft): ScheduleRule | string {
  const candidate =
    draft.mode === 'interval'
      ? { kind: 'interval', every: Number(draft.every), unit: draft.unit }
      : draft.mode === 'weekly'
        ? { kind: 'weekly', days: draft.days, times: draft.times.filter((t) => t !== '') }
        : { kind: 'monthly', days: draft.monthDays, time: draft.monthTime };
  const parsed = scheduleRuleSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  if (draft.mode === 'weekly' && draft.days.length === 0) return 'Pick at least one day';
  if (draft.mode === 'monthly' && draft.monthDays.length === 0) return 'Pick at least one day';
  if (draft.mode === 'interval') return 'Every 1 to 10,080 minutes or hours, as a whole number';
  return 'Add a time';
}

const inputClass =
  'h-8 rounded border border-border bg-panel-2 px-2 text-[13px] text-fg focus:border-accent focus:outline-none';

export function RuleEditor(props: {
  readonly rule: ScheduleRule;
  readonly missed: MissedRunPolicy;
  readonly onChange: (rule: ScheduleRule | undefined) => void;
  readonly onMissedChange: (missed: MissedRunPolicy) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(props.rule));
  const result = ruleOf(draft);
  const rule = typeof result === 'string' ? undefined : result;
  const preview = useMemo(() => (rule ? upcomingRuns(rule, new Date(), 3) : []), [rule]);

  const update = (patch: Partial<Draft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    const out = ruleOf(next);
    props.onChange(typeof out === 'string' ? undefined : out);
  };

  const toggle = <T,>(list: readonly T[], item: T): T[] =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  return (
    <div className="flex flex-col gap-3" data-testid="rule-editor">
      <div
        role="radiogroup"
        aria-label="How often"
        className="flex gap-1 rounded-md bg-panel-2 p-1"
      >
        {MODES.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={draft.mode === mode}
            onClick={() => update({ mode })}
            className={cx(
              'h-7 flex-1 rounded text-xs font-medium',
              draft.mode === mode ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {draft.mode === 'interval' && (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted">Every</span>
          <input
            aria-label="Every"
            type="number"
            min={1}
            max={10_080}
            value={draft.every}
            onChange={(event) => update({ every: event.target.value })}
            className={cx(inputClass, 'w-20')}
          />
          <select
            aria-label="Unit"
            value={draft.unit}
            onChange={(event) => update({ unit: event.target.value as Draft['unit'] })}
            className={inputClass}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </div>
      )}

      {draft.mode === 'weekly' && (
        <>
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-muted">
              On
              <button
                type="button"
                className="rounded px-1 text-accent hover:bg-hover"
                onClick={() => update({ days: [0, 1, 2, 3, 4, 5, 6] })}
              >
                every day
              </button>
              <button
                type="button"
                className="rounded px-1 text-accent hover:bg-hover"
                onClick={() => update({ days: [1, 2, 3, 4, 5] })}
              >
                weekdays
              </button>
            </div>
            <div className="flex gap-1" role="group" aria-label="Days of the week">
              {WEEKDAYS.map(({ day, short }) => {
                const on = draft.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() => update({ days: toggle(draft.days, day) })}
                    className={cx(
                      'h-8 w-11 rounded border text-xs font-medium',
                      on
                        ? 'border-accent/60 bg-accent/15 text-fg'
                        : 'border-border text-muted hover:bg-hover',
                    )}
                  >
                    {short}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">At</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {draft.times.map((time, i) => (
                <span key={i} className="flex items-center">
                  <input
                    type="time"
                    aria-label={`Time ${i + 1}`}
                    value={time}
                    onChange={(event) => {
                      const times = [...draft.times];
                      times[i] = event.target.value;
                      update({ times });
                    }}
                    className={cx(inputClass, 'w-28')}
                  />
                  {draft.times.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove time ${i + 1}`}
                      className="ml-0.5 rounded px-1 text-muted hover:bg-hover hover:text-fg"
                      onClick={() => update({ times: draft.times.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {draft.times.length < 48 && (
                <button
                  type="button"
                  className="h-8 rounded border border-dashed border-border px-2 text-xs text-muted hover:border-accent hover:text-fg"
                  onClick={() => update({ times: [...draft.times, '12:00'] })}
                >
                  + Time
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {draft.mode === 'monthly' && (
        <>
          <div>
            <div className="mb-1 text-xs text-muted">On days</div>
            <div className="grid grid-cols-8 gap-1" role="group" aria-label="Days of the month">
              {[...Array.from({ length: 31 }, (_, i) => i + 1), 'last' as const].map((day) => {
                const on = draft.monthDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    title={day === 'last' ? 'The last day of the month' : undefined}
                    onClick={() => update({ monthDays: toggle(draft.monthDays, day) })}
                    className={cx(
                      'h-7 rounded border text-xs',
                      on
                        ? 'border-accent/60 bg-accent/15 font-medium text-fg'
                        : 'border-border text-muted hover:bg-hover',
                    )}
                  >
                    {day === 'last' ? 'Last' : day}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <span className="text-muted">At</span>
            <input
              type="time"
              aria-label="Time"
              value={draft.monthTime}
              onChange={(event) => update({ monthTime: event.target.value })}
              className={cx(inputClass, 'w-28')}
            />
          </label>
        </>
      )}

      <div
        className={cx(
          'rounded-md border px-3 py-2 text-xs',
          rule ? 'border-border bg-panel-2' : 'border-danger/40 bg-danger/8 text-danger',
        )}
        data-testid="rule-summary"
        aria-live="polite"
      >
        {rule ? (
          <>
            <p className="font-medium text-fg">{describeRule(rule)}</p>
            <p className="mt-0.5 text-muted">
              Next:{' '}
              {preview
                .map((d) =>
                  d.toLocaleString(undefined, {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                )
                .join(' · ')}
            </p>
          </>
        ) : (
          (result as string)
        )}
      </div>

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={props.missed === 'run-once'}
          onChange={(event) => props.onMissedChange(event.target.checked ? 'run-once' : 'skip')}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <span>
          <span className="text-fg">Catch up on a missed run</span>
          <span className="block text-muted">
            If Joinery was closed or the computer asleep when it was due, run it once when Joinery
            is back.
          </span>
        </span>
      </label>
    </div>
  );
}
