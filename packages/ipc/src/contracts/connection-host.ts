import { engineIdSchema, schemaSnapshotSchema } from '@joinery/core';
import { z } from 'zod';

import { defineContract } from '../contract';
import { mongoHostContractShape } from './mongo';
import { redisHostContractShape } from './redis';
import { serverToolsHostContractShape } from './server-tools';
import { searchHostContractShape } from './search';
import { idSchema, stringListSchema, taskProgressSchema } from '../schemas/common';
import {
  browseNodeSchema,
  capabilitiesSchema,
  explainOptionsSchema,
  explainResultSchema,
  introspectScopeSchema,
  planNodeSchema,
} from '../schemas/driver';
import { pageSizeSchema, queryParamsSchema, resultChunkSchema } from '../schemas/results';
import { applyPlanSchema, applyResultSchema } from '../schemas/table-data';

const sessionRef = z.object({ sessionId: idSchema });

export const serverInfoSchema = z.object({
  engine: engineIdSchema,
  /** The server's version banner, e.g. "16.4" or "10.11.6-MariaDB". */
  serverVersion: z.string(),
  capabilities: capabilitiesSchema,
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

/**
 * Renderer ↔ connection host (spec §3). One host serves one open connection; the renderer gets
 * a direct MessagePort to it, so result rows never pass through the main process, and it never
 * sees credentials — the host resolved them when main spawned it.
 *
 * Each query tab opens its own session, so transactions and session variables never leak
 * between tabs (spec §4); the object explorer shares one metadata session.
 */
export const connectionHostContract = defineContract({
  /** Opens a session (its own server connection) and returns its id. */
  openSession: {
    input: z.object({ database: z.string().min(1).optional() }),
    output: z.object({ sessionId: idSchema }),
  },
  closeSession: { input: sessionRef, output: z.void() },

  /**
   * Runs one statement (the renderer splits scripts) and streams its ResultChunks. The stream is
   * the server-side cursor: rows are fetched as the renderer pulls, stopping early closes it, and
   * aborting the call cancels the statement.
   */
  execute: {
    input: z.object({
      sessionId: idSchema,
      text: z.string().min(1),
      /** Caller-chosen id, so `cancel` can target this execution. */
      executionId: idSchema,
      params: queryParamsSchema.optional(),
      /** Rows per chunk, up to 1,000 (the default). */
      pageSize: pageSizeSchema.optional(),
    }),
    item: resultChunkSchema,
  },
  /** Cancels an execution from a separate control connection (KILL QUERY, pg_cancel_backend). */
  cancel: {
    input: z.object({ sessionId: idSchema, executionId: idSchema }),
    output: z.void(),
  },

  introspect: {
    input: z.object({ sessionId: idSchema, scope: introspectScopeSchema.optional() }),
    output: schemaSnapshotSchema,
    progress: taskProgressSchema,
  },
  /** Children of an explorer tree node; an empty path lists the root level. */
  browse: {
    input: z.object({ sessionId: idSchema, path: stringListSchema }),
    output: z.array(browseNodeSchema),
  },
  explain: {
    input: z.object({
      sessionId: idSchema,
      text: z.string().min(1),
      options: explainOptionsSchema.optional(),
    }),
    output: planNodeSchema,
  },
  /**
   * The visual explain (spec §6): the plan tree with the server's raw output. ANALYZE executes
   * the statement inside a transaction (a savepoint in an open one) that is rolled back; for a
   * statement that writes it is refused with READ_ONLY on a read-only profile, and needs
   * `confirmed` everywhere else (CONFIRMATION_REQUIRED without it).
   */
  explainPlan: {
    input: z.object({
      sessionId: idSchema,
      text: z.string().min(1),
      options: explainOptionsSchema.optional(),
      confirmed: z.boolean().optional(),
    }),
    output: explainResultSchema,
  },

  begin: { input: sessionRef, output: z.void() },
  commit: { input: sessionRef, output: z.void() },
  rollback: { input: sessionRef, output: z.void() },
  /**
   * Runs the table data grid's change plan (spec §7) on one session in one transaction (a
   * savepoint inside an open one): every statement must touch exactly one row, otherwise it
   * rolls back and fails with CONFLICT. Refused with READ_ONLY on a read-only profile.
   */
  applyChanges: {
    input: z.object({ sessionId: idSchema, plan: applyPlanSchema }),
    output: applyResultSchema,
  },
  /**
   * The session's transaction state as the server reports it, so the open-transaction badge
   * (spec §6) is right after a typed BEGIN or COMMIT too.
   */
  sessionState: { input: sessionRef, output: z.object({ inTransaction: z.boolean() }) },

  /** Checks the connection is alive: one session's, or the host's metadata session. */
  ping: {
    input: z.object({ sessionId: idSchema.optional() }).optional(),
    output: z.void(),
  },
  serverInfo: { input: z.void(), output: serverInfoSchema },
  /** MongoDB document, index, collection, GridFS, user and admin services (spec §9). */
  mongo: mongoHostContractShape,
  /** Redis key browser, value editors and server tools (spec §10, §15). */
  redis: redisHostContractShape,
  /** Server tools of MySQL, MariaDB, PostgreSQL and MongoDB (spec §15). */
  serverTools: serverToolsHostContractShape,
  /** Elasticsearch and OpenSearch cluster, index and document services and the console (§11). */
  search: searchHostContractShape,
});

export type ConnectionHostContract = typeof connectionHostContract;
