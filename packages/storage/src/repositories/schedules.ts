import { JoineryError, missedRunPolicySchema, newId, scheduleRuleSchema } from '@joinery/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { corruptRow, notFound, parseOrThrow } from '../internal/errors';
import { readJson, readNullableText, readNumber, readText } from '../internal/rows';
import { checkVersion, definedOnly, type WriteOptions } from '../internal/versioning';
import type { SqlRow, SqlValue, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });
const nameSchema = z.string().trim().min(1).max(200);
const taskSchema = z.record(z.string(), z.json());

/** What a schedule runs; the task's shape for each kind is validated by the desktop app. */
export const SCHEDULE_KINDS = ['backup', 'sql', 'export', 'comparison'] as const;
export const scheduleKindSchema = z.enum(SCHEDULE_KINDS);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

export const scheduleNotifySchema = z.enum(['failures', 'always', 'never']);

export const RUN_STATUSES = ['running', 'success', 'failed', 'cancelled', 'skipped'] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runTriggerSchema = z.enum(['schedule', 'catch-up', 'manual']);

/** Runs kept per schedule; the oldest go first. */
export const RUNS_KEPT = 200;

/**
 * A scheduled job (spec: scheduler and automation): what to run (`kind` and `task`), when
 * (`rule`, `missed`), whether it is on, and where it stands (`nextRunAt`, the last run). A
 * schedule on one connection goes with it; comparison schedules name their saved comparison.
 */
export const scheduleRecordSchema = z.object({
  id: z.string().min(1),
  name: nameSchema,
  enabled: z.boolean(),
  kind: scheduleKindSchema,
  /** The connection it runs on; null for a comparison (its saved comparison names two). */
  profileId: z.string().min(1).nullable(),
  comparisonId: z.string().min(1).nullable(),
  task: taskSchema,
  rule: scheduleRuleSchema,
  missed: missedRunPolicySchema,
  notify: scheduleNotifySchema,
  nextRunAt: timestampSchema.nullable(),
  lastRunAt: timestampSchema.nullable(),
  lastStatus: runStatusSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;

const createSchema = z.object({
  id: z.string().min(1).optional(),
  name: nameSchema,
  enabled: z.boolean().default(true),
  kind: scheduleKindSchema,
  profileId: z.string().min(1).nullable().default(null),
  comparisonId: z.string().min(1).nullable().default(null),
  task: taskSchema,
  rule: scheduleRuleSchema,
  missed: missedRunPolicySchema.default('run-once'),
  notify: scheduleNotifySchema.default('failures'),
  nextRunAt: timestampSchema.nullable().default(null),
});
export type ScheduleCreateInput = z.input<typeof createSchema>;

const patchSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  task: taskSchema.optional(),
  rule: scheduleRuleSchema.optional(),
  missed: missedRunPolicySchema.optional(),
  notify: scheduleNotifySchema.optional(),
  nextRunAt: timestampSchema.nullable().optional(),
});
export type SchedulePatch = z.input<typeof patchSchema>;

/** One run of a schedule, kept for its history. */
export const scheduleRunSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  trigger: runTriggerSchema,
  status: runStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  /** What happened, for the history: an error, "Skipped: the last run is still going"... */
  message: z.string().max(10_000).nullable(),
  /** Files the run wrote (a backup, an export, a report). */
  outputs: z.array(z.string().max(4096)).max(1000),
  /** The job it ran as, when it ran as one. */
  jobId: z.string().nullable(),
});
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

const runStartSchema = scheduleRunSchema.pick({ scheduleId: true, trigger: true }).extend({
  status: runStatusSchema.default('running'),
  message: z.string().max(10_000).nullable().default(null),
  jobId: z.string().nullable().default(null),
});
export type ScheduleRunStart = z.input<typeof runStartSchema>;

const runFinishSchema = z.object({
  status: z.enum(['success', 'failed', 'cancelled', 'skipped']),
  message: z.string().max(10_000).nullable().default(null),
  outputs: z.array(z.string().max(4096)).max(1000).default([]),
  jobId: z.string().nullable().optional(),
});
export type ScheduleRunFinish = z.input<typeof runFinishSchema>;

export class ScheduleRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  get(id: string): ScheduleRecord | undefined {
    const row = this.#db.get('SELECT * FROM schedules WHERE id = ?', [id]);
    return row ? toSchedule(row) : undefined;
  }

  /** Schedules by name; of one connection when given. */
  list(filter: { readonly profileId?: string } = {}): ScheduleRecord[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.profileId !== undefined) {
      where.push('profile_id = ?');
      params.push(filter.profileId);
    }
    return this.#db
      .all(
        `SELECT * FROM schedules ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY name COLLATE NOCASE, id`,
        params,
      )
      .map(toSchedule);
  }

  create(input: ScheduleCreateInput): ScheduleRecord {
    const schedule = parseOrThrow(createSchema, input, 'schedule');
    return this.#db.transaction(() => {
      const id = schedule.id ?? newId();
      if (this.get(id)) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: `Schedule ${id} already exists`,
        });
      }
      this.#requireTarget(schedule.profileId, schedule.comparisonId);
      const now = this.#now();
      this.#db.run(
        `INSERT INTO schedules (id, name, enabled, kind, profile_id, comparison_id, task, rule,
           missed, notify, next_run_at, last_run_at, last_status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
        [
          id,
          schedule.name,
          schedule.enabled ? 1 : 0,
          schedule.kind,
          schedule.profileId,
          schedule.comparisonId,
          JSON.stringify(schedule.task),
          JSON.stringify(schedule.rule),
          schedule.missed,
          schedule.notify,
          schedule.nextRunAt,
          now,
          now,
        ],
      );
      return this.#require(id);
    });
  }

  /** Changes the given fields and bumps the version. The kind and target never change. */
  update(id: string, patch: SchedulePatch, options: WriteOptions = {}): ScheduleRecord {
    const changes = parseOrThrow(patchSchema, patch, 'schedule');
    return this.#db.transaction(() => {
      const current = this.#require(id);
      checkVersion('Schedule', id, options.expectedVersion, current.version);
      const next = { ...current, ...definedOnly(changes) };
      this.#db.run(
        `UPDATE schedules SET name = ?, enabled = ?, task = ?, rule = ?, missed = ?, notify = ?,
           next_run_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [
          next.name,
          next.enabled ? 1 : 0,
          JSON.stringify(next.task),
          JSON.stringify(next.rule),
          next.missed,
          next.notify,
          next.nextRunAt,
          this.#now(),
          id,
        ],
      );
      return this.#require(id);
    });
  }

  /** Where the scheduler has put it: when it is next due. Not a user edit: no version bump. */
  setNextRun(id: string, nextRunAt: string | null): void {
    parseOrThrow(timestampSchema.nullable(), nextRunAt, 'next run');
    this.#db.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [nextRunAt, id]);
  }

  delete(id: string): boolean {
    return this.#db.run('DELETE FROM schedules WHERE id = ?', [id]).changes > 0;
  }

  // -------------------------------------------------------------------------------------------
  // Runs

  /** Records a run starting (or skipped: a finished status is kept as given). */
  startRun(input: ScheduleRunStart): ScheduleRun {
    const run = parseOrThrow(runStartSchema, input, 'schedule run');
    return this.#db.transaction(() => {
      this.#require(run.scheduleId);
      const id = newId();
      const now = this.#now();
      const finished = run.status === 'running' ? null : now;
      this.#db.run(
        `INSERT INTO schedule_runs (id, schedule_id, trigger, status, started_at, finished_at,
           message, outputs, job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
        [id, run.scheduleId, run.trigger, run.status, now, finished, run.message, run.jobId],
      );
      this.#db.run('UPDATE schedules SET last_run_at = ?, last_status = ? WHERE id = ?', [
        now,
        run.status,
        run.scheduleId,
      ]);
      // The oldest runs beyond the kept number go.
      this.#db.run(
        `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
           SELECT id FROM schedule_runs WHERE schedule_id = ?
           ORDER BY started_at DESC, rowid DESC LIMIT ?)`,
        [run.scheduleId, run.scheduleId, RUNS_KEPT],
      );
      return this.#requireRun(id);
    });
  }

  finishRun(id: string, input: ScheduleRunFinish): ScheduleRun {
    const finish = parseOrThrow(runFinishSchema, input, 'schedule run');
    return this.#db.transaction(() => {
      const run = this.#requireRun(id);
      this.#db.run(
        `UPDATE schedule_runs SET status = ?, finished_at = ?, message = ?, outputs = ?,
           job_id = COALESCE(?, job_id)
         WHERE id = ?`,
        [
          finish.status,
          this.#now(),
          finish.message,
          JSON.stringify(finish.outputs),
          finish.jobId ?? null,
          id,
        ],
      );
      this.#db.run('UPDATE schedules SET last_status = ? WHERE id = ?', [
        finish.status,
        run.scheduleId,
      ]);
      return this.#requireRun(id);
    });
  }

  getRun(id: string): ScheduleRun | undefined {
    const row = this.#db.get('SELECT * FROM schedule_runs WHERE id = ?', [id]);
    return row ? toRun(row) : undefined;
  }

  /** A schedule's runs, newest first. */
  runs(scheduleId: string, limit = 50): ScheduleRun[] {
    return this.#db
      .all(
        `SELECT * FROM schedule_runs WHERE schedule_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        [scheduleId, Math.max(1, Math.min(limit, RUNS_KEPT))],
      )
      .map(toRun);
  }

  /**
   * Runs left `running` by a previous app session that ended mid-run (a crash, a forced quit):
   * marked failed, so the history does not show them going forever.
   */
  abandonRunning(message: string): number {
    return this.#db.transaction(() => {
      const stuck = this.#db.all(
        "SELECT id, schedule_id FROM schedule_runs WHERE status = 'running'",
      );
      const now = this.#now();
      for (const row of stuck) {
        this.#db.run(
          "UPDATE schedule_runs SET status = 'failed', finished_at = ?, message = ? WHERE id = ?",
          [now, message, readText(row, 'id')],
        );
        this.#db.run("UPDATE schedules SET last_status = 'failed' WHERE id = ?", [
          readText(row, 'schedule_id'),
        ]);
      }
      return stuck.length;
    });
  }

  #require(id: string): ScheduleRecord {
    const schedule = this.get(id);
    if (!schedule) throw notFound('Schedule', id);
    return schedule;
  }

  #requireRun(id: string): ScheduleRun {
    const run = this.getRun(id);
    if (!run) throw notFound('Schedule run', id);
    return run;
  }

  #requireTarget(profileId: string | null, comparisonId: string | null): void {
    if ((profileId === null) === (comparisonId === null)) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'A schedule runs on a connection or a saved comparison',
      });
    }
    if (
      profileId !== null &&
      !this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [profileId])
    ) {
      throw notFound('Profile', profileId);
    }
    if (
      comparisonId !== null &&
      !this.#db.get('SELECT 1 AS found FROM saved_comparisons WHERE id = ?', [comparisonId])
    ) {
      throw notFound('Saved comparison', comparisonId);
    }
  }
}

function toSchedule(row: SqlRow): ScheduleRecord {
  const id = readText(row, 'id');
  const parsed = scheduleRecordSchema.safeParse({
    id,
    name: readText(row, 'name'),
    enabled: readNumber(row, 'enabled') === 1,
    kind: readText(row, 'kind'),
    profileId: readNullableText(row, 'profile_id'),
    comparisonId: readNullableText(row, 'comparison_id'),
    task: readJson(row, 'task'),
    rule: readJson(row, 'rule'),
    missed: readText(row, 'missed'),
    notify: readText(row, 'notify'),
    nextRunAt: readNullableText(row, 'next_run_at'),
    lastRunAt: readNullableText(row, 'last_run_at'),
    lastStatus: readNullableText(row, 'last_status'),
    version: readNumber(row, 'version'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
  });
  if (!parsed.success) throw corruptRow('schedule', id, parsed.error);
  return parsed.data;
}

function toRun(row: SqlRow): ScheduleRun {
  const id = readText(row, 'id');
  const parsed = scheduleRunSchema.safeParse({
    id,
    scheduleId: readText(row, 'schedule_id'),
    trigger: readText(row, 'trigger'),
    status: readText(row, 'status'),
    startedAt: readText(row, 'started_at'),
    finishedAt: readNullableText(row, 'finished_at'),
    message: readNullableText(row, 'message'),
    outputs: readJson(row, 'outputs'),
    jobId: readNullableText(row, 'job_id'),
  });
  if (!parsed.success) throw corruptRow('schedule run', id, parsed.error);
  return parsed.data;
}
