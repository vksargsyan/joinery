import { missedRunPolicySchema, scheduleRuleSchema } from '@querybara/core';
import { z } from 'zod';

import { backupJobSchema, backupPassphraseSchema } from './backup';
import { idSchema } from './common';
import { exportJobSchema, runSqlFileJobSchema } from './jobs';

/**
 * Scheduled jobs (spec: scheduler and automation): backups, SQL files, exports and saved
 * comparisons that main runs on a schedule while Querybara is open. A schedule's task is the job
 * as the wizard built it, minus its output path: each run writes a new file named from the
 * schedule's template, and older ones can be pruned. Nothing here carries a secret: a backup's
 * passphrase goes to the local store's secret store when the schedule is saved.
 */

export const scheduleKindSchema = z.enum(['backup', 'sql', 'export', 'comparison']);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

/** The tokens a file name template may use. */
export const OUTPUT_TOKENS = ['{name}', '{date}', '{time}'] as const;

const outputNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !/[\\/]/.test(name), 'A file name has no folder in it')
  .refine(
    (name) => name.includes('{date}') || name.includes('{time}'),
    'Put {date} or {time} in the name, so runs do not overwrite each other',
  );

export const scheduleOutputSchema = z.object({
  /** The folder the runs write into, picked with `dialogs.openDirectory`. */
  folder: z.string().min(1).max(4096),
  /** The file (or, for an export of several tables, folder) each run writes. */
  fileName: outputNameSchema,
  /** Keep only the newest N files this schedule wrote there; null keeps them all. */
  keep: z.number().int().min(1).max(1000).nullable(),
});
export type ScheduleOutput = z.infer<typeof scheduleOutputSchema>;

export const scheduleTaskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('backup'),
    job: backupJobSchema.omit({ output: true, encryption: true }),
    /** Encrypted with the passphrase kept in the secret store for this schedule. */
    encrypted: z.boolean(),
    output: scheduleOutputSchema,
  }),
  z.object({
    kind: z.literal('sql'),
    /** The SQL file, picked with `dialogs.openFile`, runs as it is on disk at each run. */
    job: runSqlFileJobSchema,
  }),
  z.object({
    kind: z.literal('export'),
    // A scheduled query runs as written: parameters are asked for, and no one is there to ask.
    job: exportJobSchema.omit({ output: true }).extend({
      source: z.discriminatedUnion('kind', [
        exportJobSchema.shape.source.options[0],
        exportJobSchema.shape.source.options[1].omit({ params: true }),
      ]),
    }),
    /** One file, or a folder with one file per table. */
    outputKind: z.enum(['file', 'directory']),
    output: scheduleOutputSchema,
  }),
  z.object({
    kind: z.literal('comparison'),
    /** Structure: the HTML report. Data: the SQL that would sync the target. */
    output: scheduleOutputSchema,
  }),
]);
export type ScheduleTask = z.infer<typeof scheduleTaskSchema>;

export const scheduleNotifySchema = z.enum(['failures', 'always', 'never']);
export type ScheduleNotify = z.infer<typeof scheduleNotifySchema>;

export const runStatusSchema = z.enum(['running', 'success', 'failed', 'cancelled', 'skipped']);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** A schedule as the Schedules panel shows it. */
export const scheduleInfoSchema = z.object({
  id: idSchema,
  name: z.string(),
  enabled: z.boolean(),
  kind: scheduleKindSchema,
  profileId: z.string().nullable(),
  comparisonId: z.string().nullable(),
  task: scheduleTaskSchema,
  rule: scheduleRuleSchema,
  missed: missedRunPolicySchema,
  notify: scheduleNotifySchema,
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: runStatusSchema.nullable(),
  version: z.number().int().positive(),
  /** "Nightly at 02:00" as words, and what the target is ("Shop · shop"). */
  description: z.string(),
  target: z.string(),
  running: z.boolean(),
  /** Why runs would fail as it stands (a password not saved, a connection gone). */
  warnings: z.array(z.string()),
});
export type ScheduleInfo = z.infer<typeof scheduleInfoSchema>;

export const scheduleSaveInputSchema = z.object({
  /** Absent to create one. */
  id: idSchema.optional(),
  expectedVersion: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  profileId: idSchema.nullable(),
  comparisonId: idSchema.nullable(),
  task: scheduleTaskSchema,
  rule: scheduleRuleSchema,
  missed: missedRunPolicySchema,
  notify: scheduleNotifySchema,
  /** An encrypted backup's passphrase: kept in the secret store, never with the schedule. */
  passphrase: backupPassphraseSchema.optional(),
});
export type ScheduleSaveInput = z.infer<typeof scheduleSaveInputSchema>;

export const scheduleRunInfoSchema = z.object({
  id: idSchema,
  scheduleId: idSchema,
  trigger: z.enum(['schedule', 'catch-up', 'manual']),
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string().nullable(),
  outputs: z.array(z.string()),
  jobId: z.string().nullable(),
});
export type ScheduleRunInfo = z.infer<typeof scheduleRunInfoSchema>;

/** Something changed: a schedule saved, deleted, started or finished a run. */
export const scheduleEventSchema = z.object({
  scheduleId: idSchema.nullable(),
  kind: z.enum(['changed', 'run-started', 'run-finished']),
});
export type ScheduleEvent = z.infer<typeof scheduleEventSchema>;
