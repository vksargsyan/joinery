import { schemaDefSchema, schemaSnapshotSchema } from '@querybara/core';
import { z } from 'zod';

import { idSchema } from './common';

/**
 * ER models (spec §8, forward engineering). A model document is what a model file holds and
 * what a draft of unapplied changes keeps: the edited schema (and any other schema the model
 * changed, where foreign keys followed a renamed or dropped table), the live name each table
 * and column came from, and the layout. A draft also keeps `base`, the live database the model
 * started from, so reopening it changes only what the user changed; a file has none and is
 * applied to whichever database it is opened on.
 */

export const ER_MODEL_FORMAT = 'querybara.er-model';

const tablePlaceSchema = z.object({
  /** The table's schema, when it is not the edited one (a table of another schema). */
  schema: z.string().max(1024).optional(),
  table: z.string().max(1024),
});

export const erModelDocumentSchema = z.object({
  format: z.literal(ER_MODEL_FORMAT),
  version: z.literal(1),
  engine: z.enum(['postgres', 'mysql', 'mariadb']),
  database: z.string().max(1024),
  schema: z.string().max(1024),
  savedAt: z.string(),
  model: z.object({
    schemas: z.array(schemaDefSchema).min(1),
    tableOrigins: z.record(z.string(), z.string().nullable()),
    columnOrigins: z.record(z.string(), z.record(z.string(), z.string().nullable())),
  }),
  base: schemaSnapshotSchema.optional(),
  layout: z.object({
    positions: z.array(tablePlaceSchema.extend({ x: z.number(), y: z.number() })).max(100_000),
    hidden: z.array(tablePlaceSchema).max(100_000),
    display: z.object({ columns: z.enum(['all', 'keys', 'none']), types: z.boolean() }),
    includeViews: z.boolean(),
  }),
});
export type ErModelDocument = z.infer<typeof erModelDocumentSchema>;
export type ErModelDocumentInput = z.input<typeof erModelDocumentSchema>;

export const erModelDraftKeySchema = z.object({
  profileId: idSchema,
  /** The database's name as the server reports it. */
  database: z.string().max(1024),
  /** The PostgreSQL schema; the database again on MySQL and MariaDB. */
  schema: z.string().max(1024),
});
export type ErModelDraftKey = z.infer<typeof erModelDraftKeySchema>;

export const erModelDraftSummarySchema = erModelDraftKeySchema.extend({
  /** Changed tables, for summaries. */
  changes: z.number().int().nonnegative(),
  savedAt: z.string(),
});
export type ErModelDraftSummary = z.infer<typeof erModelDraftSummarySchema>;

export const erModelDraftSchema = erModelDraftSummarySchema.extend({
  document: erModelDocumentSchema,
});
export type ErModelDraft = z.infer<typeof erModelDraftSchema>;

export const erModelDraftPutSchema = erModelDraftKeySchema.extend({
  document: erModelDocumentSchema,
  changes: z.number().int().nonnegative(),
});
export type ErModelDraftPut = z.infer<typeof erModelDraftPutSchema>;

export const erModelDraftListSchema = z.object({
  profileId: idSchema,
  database: z.string().max(1024).optional(),
});
