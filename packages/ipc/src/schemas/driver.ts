import {
  BROWSE_NODE_KINDS,
  CONNECTION_CHECK_STEPS,
  EXPLAIN_FORMATS,
  SCHEMA_OBJECT_KINDS,
  type BrowseNode,
  type Capabilities,
  type ConnectionCheckResult,
  type ExplainFormat,
  type ExplainOptions,
  type IntrospectScope,
  type PlanNode,
} from '@joinery/core';
import { z } from 'zod';

import { queryParamsSchema } from './results';

/**
 * Zod schemas for the driver-facing types in @joinery/core (driver.ts, capabilities.ts), each
 * annotated with the core type so a drift between the two fails to compile.
 */

export const explainFormatSchema: z.ZodType<ExplainFormat, ExplainFormat> = z.enum(EXPLAIN_FORMATS);

export const capabilitiesSchema: z.ZodType<Capabilities, Capabilities> = z.object({
  transactionalDdl: z.boolean(),
  schemas: z.boolean(),
  serverSideCursors: z.boolean(),
  explainFormats: z.array(explainFormatSchema),
  queryCancel: z.boolean(),
  transactions: z.boolean(),
  storedRoutines: z.boolean(),
  events: z.boolean(),
  sequences: z.boolean(),
  materializedViews: z.boolean(),
  partitions: z.boolean(),
  changeStreams: z.boolean(),
  clusterMode: z.boolean(),
  returning: z.boolean(),
});

export const introspectScopeSchema: z.ZodType<IntrospectScope, IntrospectScope> = z.object({
  database: z.string().min(1).optional(),
  schemas: z.array(z.string().min(1)).optional(),
  include: z.array(z.enum(SCHEMA_OBJECT_KINDS)).optional(),
});

export const browseNodeSchema: z.ZodType<BrowseNode, BrowseNode> = z.object({
  kind: z.enum(BROWSE_NODE_KINDS),
  name: z.string(),
  path: z.array(z.string()),
  hasChildren: z.boolean(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
});

export const explainOptionsSchema: z.ZodType<ExplainOptions, ExplainOptions> = z.object({
  format: explainFormatSchema.optional(),
  analyze: z.boolean().optional(),
  buffers: z.boolean().optional(),
  params: queryParamsSchema.optional(),
});

export const planNodeSchema: z.ZodType<PlanNode, PlanNode> = z.object({
  id: z.string(),
  operation: z.string(),
  relation: z.string().optional(),
  index: z.string().optional(),
  startupCost: z.number().optional(),
  totalCost: z.number().optional(),
  estimatedRows: z.number().optional(),
  actualRows: z.number().optional(),
  actualTimeMs: z.number().optional(),
  loops: z.number().optional(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  get children(): z.ZodArray<z.ZodType<PlanNode, PlanNode>> {
    return z.array(planNodeSchema);
  },
});

export const connectionCheckResultSchema: z.ZodType<ConnectionCheckResult, ConnectionCheckResult> =
  z.object({
    step: z.enum(CONNECTION_CHECK_STEPS),
    status: z.enum(['ok', 'failed', 'skipped']),
    durationMs: z.number().nonnegative(),
    message: z.string().optional(),
    hint: z.string().optional(),
  });
