import { schemaSnapshotSchema, type SchemaSnapshot } from '@querybara/core';
import {
  dataActionsSchema,
  dataCompareOptionsSchema,
  dataResultSchema,
  dataTableResultSchema,
  dataTableSettingsSchema,
  diffSummarySchema,
  idSchema,
  schemaDiffSchema,
  structureCompareOptionsSchema,
  structureResultSchema,
  structureScriptSchema,
  syncSideInfoSchema,
  syncSideSchema,
} from '@querybara/ipc';
import type { SchemaDiff } from '@querybara/sync';
import { z } from 'zod';

/**
 * Structure and data sync (spec §13) as the job runner sees it: the job specs main sends in
 * `start`, the quick requests (scripts, exports), and the results the runner sends back with
 * `done`. None of this reaches the renderer as is: main keeps the results (the diff, the
 * source structure, the spool folder) and serves the page the `sync.*` contract.
 *
 * A sync job's `profileId` is its target connection, the one the job list shows it under; a
 * compare also names the source connection, whose resolved profile travels in `start.source`.
 */

/** A side without its connection (that is the job's `profileId` or `sourceProfileId`). */
export const jobSideSchema = syncSideSchema.omit({ profileId: true });
export type JobSide = z.infer<typeof jobSideSchema>;

const pathSchema = z.string().min(1).max(4096);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const structureCompareJobSchema = z.object({
  kind: z.literal('structure-compare'),
  profileId: idSchema,
  sourceProfileId: idSchema,
  source: jobSideSchema,
  target: jobSideSchema,
  options: structureCompareOptionsSchema,
});
export type StructureCompareJob = z.infer<typeof structureCompareJobSchema>;

/**
 * Applies a selection of a comparison to the target, then re-compares against the source
 * structure the comparison read (spec §13, steps 7-8). The runner generates the script again
 * and refuses to run it unless its SHA-256 is the one the user reviewed.
 */
export const structureApplyJobSchema = z.object({
  kind: z.literal('structure-apply'),
  profileId: idSchema,
  target: jobSideSchema,
  diff: schemaDiffSchema,
  selected: z.array(z.string()),
  sourceSnapshot: schemaSnapshotSchema,
  scriptSha256: sha256Schema,
  /** The user confirmed the write (production and confirm-writes profiles need it). */
  confirmed: z.boolean(),
});
export type StructureApplyJob = z.infer<typeof structureApplyJobSchema>;

export const dataCompareJobSchema = z.object({
  kind: z.literal('data-compare'),
  profileId: idSchema,
  sourceProfileId: idSchema,
  source: jobSideSchema,
  target: jobSideSchema,
  options: dataCompareOptionsSchema,
  tables: z.array(dataTableSettingsSchema).optional(),
  /** A folder main made for this job: row pages and sync statements are spooled into it. */
  spoolDir: pathSchema,
});
export type DataCompareJob = z.infer<typeof dataCompareJobSchema>;

/** Runs the spooled sync statements of some tables and actions, in batched transactions. */
export const dataApplyJobSchema = z.object({
  kind: z.literal('data-apply'),
  profileId: idSchema,
  target: jobSideSchema,
  spoolDir: pathSchema,
  tables: z.array(z.number().int().nonnegative()).min(1),
  actions: dataActionsSchema,
  confirmed: z.boolean(),
});
export type DataApplyJob = z.infer<typeof dataApplyJobSchema>;

export const syncJobSpecSchema = z.discriminatedUnion('kind', [
  structureCompareJobSchema,
  structureApplyJobSchema,
  dataCompareJobSchema,
  dataApplyJobSchema,
]);
export type SyncJobSpec = z.infer<typeof syncJobSpecSchema>;

/** Quick sync work for the page: no database, no job record. */
export const syncRunnerRequestSchemas = [
  z.object({
    kind: z.literal('sync-script'),
    input: z.object({ diff: schemaDiffSchema, selected: z.array(z.string()) }),
  }),
  z.object({
    kind: z.literal('sync-export'),
    input: z.object({
      diff: schemaDiffSchema,
      selected: z.array(z.string()),
      format: z.enum(['sql', 'html']),
      path: pathSchema,
      sourceLabel: z.string().max(1000),
      targetLabel: z.string().max(1000),
      generatedAt: z.string().max(100),
    }),
  }),
  z.object({
    kind: z.literal('sync-data-script'),
    input: z.object({
      spoolDir: pathSchema,
      tables: z.array(z.number().int().nonnegative()).min(1),
      actions: dataActionsSchema,
      /** Write the script here; without it, answer with its first `limit` statements. */
      path: pathSchema.optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
    }),
  }),
] as const;

/** A structure compare's (or apply's) result, before main adds what it keeps from the compare. */
export const structureJobResultSchema = z.object({
  kind: z.literal('structure'),
  /** Absent on an apply: main takes it from the comparison the apply came from. */
  source: syncSideInfoSchema.optional(),
  target: syncSideInfoSchema,
  diff: schemaDiffSchema,
  /** Absent on an apply, which re-compares against the comparison's source structure. */
  sourceSnapshot: schemaSnapshotSchema.optional(),
  summary: diffSummarySchema,
  script: structureScriptSchema,
  applied: structureResultSchema.shape.applied,
});
/** As the runner builds it: the engine's own (readonly) diff. */
export type StructureJobResult = Omit<
  z.infer<typeof structureJobResultSchema>,
  'diff' | 'sourceSnapshot'
> & { readonly diff: SchemaDiff; readonly sourceSnapshot?: SchemaSnapshot };

export const dataJobResultSchema = z.object({
  kind: z.literal('data'),
  source: syncSideInfoSchema,
  target: syncSideInfoSchema,
  tables: z.array(dataTableResultSchema),
  skipped: dataResultSchema.shape.skipped,
  pageSize: z.number().int().positive(),
});
export type DataJobResult = z.infer<typeof dataJobResultSchema>;

export const syncJobResultSchema = z.discriminatedUnion('kind', [
  structureJobResultSchema,
  dataJobResultSchema,
]);
export type SyncJobResult = StructureJobResult | DataJobResult;
