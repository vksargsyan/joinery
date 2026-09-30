import { z } from 'zod';

import { idSchema } from '../schemas/common';
import {
  accessDetailsSchema,
  accessOverviewSchema,
  accountRefSchema,
  actionPreviewSchema,
  actionResultSchema,
  grantMatrixSchema,
  maintenanceTargetsSchema,
  monitorSnapshotSchema,
  serverActionSchema,
  serverToolsInfoSchema,
  sessionListOptionsSchema,
  sessionListSchema,
  settingListSchema,
  topQueriesSchema,
  topQueryOptionsSchema,
} from '../schemas/server-tools';

/**
 * The `serverTools.*` namespace of the connection host contract (spec §15): the monitoring
 * view, sessions, top queries, users, maintenance and settings of MySQL, MariaDB, PostgreSQL
 * and MongoDB, on a session the page opened with `openSession`. Reads never change the server.
 *
 * Changes are actions: `preview` returns the exact statements or commands an action runs (with
 * passwords masked) and `run` runs it. The host checks the profile's write rules whatever the
 * page sends: a read-only profile refuses every change (READ_ONLY); kills, maintenance,
 * settings, drops and revokes need `confirmed` on every profile, and every change needs it on
 * production profiles and profiles that confirm writes (CONFIRMATION_REQUIRED otherwise). Parts
 * an engine lacks answer NOT_SUPPORTED (MongoDB users have their own editor).
 */

const sessionId = idSchema;
const sessionRef = z.object({ sessionId });
const name = z.string().min(1).max(512);

export const serverToolsHostContractShape = {
  /** Engine, version, account, databases and what each tab can do here. */
  info: { input: sessionRef, output: serverToolsInfoSchema },
  /** One poll of the monitoring view; the page keeps the history. */
  monitor: { input: sessionRef, output: monitorSnapshotSchema },
  sessions: {
    input: z.object({ sessionId, options: sessionListOptionsSchema.optional() }),
    output: sessionListSchema,
  },
  /** pg_stat_statements, performance_schema digests or the MongoDB profiler. */
  topQueries: {
    input: z.object({ sessionId, options: topQueryOptionsSchema.optional() }),
    output: topQueriesSchema,
  },
  accounts: { input: sessionRef, output: accessOverviewSchema },
  /** The grants matrix of one account over a schema (PostgreSQL) or database (MySQL). */
  grants: {
    input: z.object({ sessionId, grantee: accountRefSchema, scope: name.optional() }),
    output: grantMatrixSchema,
  },
  /** Default privileges and row-level security of a schema (PostgreSQL). */
  accessDetails: {
    input: z.object({ sessionId, schema: name.optional() }),
    output: accessDetailsSchema,
  },
  maintenanceTargets: {
    input: z.object({ sessionId, container: name.optional() }),
    output: maintenanceTargetsSchema,
  },
  settings: { input: sessionRef, output: settingListSchema },
  preview: {
    input: z.object({ sessionId, action: serverActionSchema }),
    output: actionPreviewSchema,
  },
  /** Runs an action; aborting the call cancels a statement still running. */
  run: {
    input: z.object({
      sessionId,
      action: serverActionSchema,
      confirmed: z.boolean().optional(),
    }),
    output: actionResultSchema,
  },
} as const;
