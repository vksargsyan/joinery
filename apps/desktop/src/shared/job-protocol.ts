import { errorDataSchema } from '@querybara/core';
import {
  autoMatchInputSchema,
  hostKeyInfoSchema,
  idSchema,
  jobProgressSchema,
  jobRowErrorSchema,
  jobSpecSchema,
  jobSummarySchema,
  newTablePlanInputSchema,
  rdbAnalyzeInputSchema,
  rdbAnalyzeProgressSchema,
  transferJobSchema,
  transferPreviewInputSchema,
} from '@querybara/ipc';
import { z } from 'zod';

import {
  backupInspectRequestSchema,
  nativeToolsRequestSchema,
  restorePlanRequestSchema,
} from './backup-protocol';
import { resolvedProfileSchema } from './host-protocol';
import { syncJobSpecSchema, syncRunnerRequestSchemas } from './sync-jobs';

/**
 * Control messages between main and the job runner over the utility process's parent port
 * (spec §3: long jobs run in their own process). Both ends validate with these schemas.
 *
 * `start` carries a ResolvedProfile, i.e. unsealed secrets: main → runner only. What the runner
 * sends back (progress, log lines, summaries, previews) never holds a secret, and main relays
 * only that to the renderer.
 *
 * Like a connection host, the runner has no window: SSH host keys of a job's tunnel are checked
 * by main (`host-key` → `host-key-decision`, spec §4).
 */

/**
 * Quick work for the wizards, with no job record: file previews, and for the data transfer
 * wizard a connection's objects and a transfer's plan. Like `start`, the transfer requests
 * carry resolved profiles, towards the runner only.
 */
export const runnerRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preview'), input: transferPreviewInputSchema }),
  z.object({ kind: z.literal('auto-match'), input: autoMatchInputSchema }),
  z.object({ kind: z.literal('plan-table'), input: newTablePlanInputSchema }),
  ...syncRunnerRequestSchemas,
  z.object({
    kind: z.literal('transfer-inspect'),
    input: z.object({
      database: z.string().max(256).optional(),
      schema: z.string().max(256).optional(),
    }),
    resolved: resolvedProfileSchema,
  }),
  z.object({
    kind: z.literal('transfer-plan'),
    job: transferJobSchema,
    resolved: resolvedProfileSchema,
    resolvedTarget: resolvedProfileSchema,
  }),
  backupInspectRequestSchema,
  restorePlanRequestSchema,
  nativeToolsRequestSchema,
  /** A Redis or Valkey RDB file read to its end and summed; long, with progress. */
  z.object({ kind: z.literal('rdb-analyze'), input: rdbAnalyzeInputSchema }),
]);
export type RunnerRequest = z.infer<typeof runnerRequestSchema>;

/** Any job the runner runs: a transfer job, or a structure or data sync job. */
export const runnerJobSpecSchema = z.union([jobSpecSchema, syncJobSpecSchema]);
export type RunnerJobSpec = z.infer<typeof runnerJobSpecSchema>;

export const mainToRunnerSchema = z.discriminatedUnion('type', [
  /** Run a job with its own driver session, opened with this profile. */
  z.object({
    type: z.literal('start'),
    jobId: idSchema,
    job: runnerJobSpecSchema,
    resolved: resolvedProfileSchema,
    /** A comparison's source connection; `resolved` is then its target. */
    source: resolvedProfileSchema.optional(),
    /** Transfers between databases: the target's profile. */
    resolvedTarget: resolvedProfileSchema.optional(),
  }),
  /** Stop a job: its signal aborts, and an import rolls back. */
  z.object({ type: z.literal('cancel'), jobId: idSchema }),
  z.object({ type: z.literal('request'), requestId: idSchema, request: runnerRequestSchema }),
  /** Stop a long request (an RDB analysis): it answers with a CANCELLED error. */
  z.object({ type: z.literal('cancel-request'), requestId: idSchema }),
  z.object({
    type: z.literal('host-key-decision'),
    requestId: z.string().min(1).max(128),
    decision: z.enum(['trust', 'reject']),
    error: errorDataSchema.optional(),
  }),
  /** Cancel every job and exit. */
  z.object({ type: z.literal('shutdown') }),
]);
export type MainToRunner = z.infer<typeof mainToRunnerSchema>;

export const runnerToMainSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), jobId: idSchema, progress: jobProgressSchema }),
  z.object({
    type: z.literal('log'),
    jobId: idSchema,
    level: z.enum(['info', 'warning', 'error']),
    message: z.string().max(10_000),
  }),
  /**
   * The job ended. `summary` is absent when it failed before any work (no connection, a
   * missing table); `error` then says why.
   */
  z.object({
    type: z.literal('done'),
    jobId: idSchema,
    summary: jobSummarySchema.optional(),
    errors: z.array(jobRowErrorSchema),
    error: errorDataSchema.optional(),
    /** A sync job's result (main checks it against the sync result schema). */
    result: z.unknown().optional(),
  }),
  /** A long request's progress (an RDB analysis: bytes read of the file's size). */
  z.object({
    type: z.literal('request-progress'),
    requestId: idSchema,
    progress: rdbAnalyzeProgressSchema,
  }),
  /** The answer to a `request`: `result` (checked by main against the method's schema) or `error`. */
  z.object({
    type: z.literal('response'),
    requestId: idSchema,
    result: z.unknown().optional(),
    error: errorDataSchema.optional(),
  }),
  /** An SSH server on a job's route presented this host key: may the tunnel trust it? */
  z.object({
    type: z.literal('host-key'),
    requestId: z.string().min(1).max(128),
    jobId: idSchema,
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    key: hostKeyInfoSchema,
  }),
]);
export type RunnerToMain = z.infer<typeof runnerToMainSchema>;
