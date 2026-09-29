import { engineIdSchema, schemaSnapshotSchema } from '@joinery/core';
import { z } from 'zod';

import { defineContract } from '../contract';
import { idSchema, stringListSchema, taskProgressSchema } from '../schemas/common';
import {
  browseNodeSchema,
  capabilitiesSchema,
  explainOptionsSchema,
  introspectScopeSchema,
  planNodeSchema,
} from '../schemas/driver';
import { pageSizeSchema, queryParamsSchema, resultChunkSchema } from '../schemas/results';

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

  begin: { input: sessionRef, output: z.void() },
  commit: { input: sessionRef, output: z.void() },
  rollback: { input: sessionRef, output: z.void() },

  /** Checks the connection is alive: one session's, or the host's metadata session. */
  ping: {
    input: z.object({ sessionId: idSchema.optional() }).optional(),
    output: z.void(),
  },
  serverInfo: { input: z.void(), output: serverInfoSchema },
});

export type ConnectionHostContract = typeof connectionHostContract;
