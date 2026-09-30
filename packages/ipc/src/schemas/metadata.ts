import { engineIdSchema, schemaSnapshotSchema } from '@joinery/core';
import { z } from 'zod';

import { idSchema } from './common';

/**
 * Schemas for the local metadata cache (spec §5: a metadata cache per connection in SQLite feeds
 * autocomplete) and the snippet library (spec §6), as they cross between main and the renderer.
 * They mirror `@joinery/storage`'s records; this package does not depend on storage.
 */

const timestampSchema = z.iso.datetime({ offset: true });

/** One cached snapshot's identity: which profile and database, and how old it is. */
export const cachedSnapshotInfoSchema = z.object({
  profileId: idSchema,
  database: z.string(),
  /** When the snapshot was introspected (the snapshot's own `capturedAt`). */
  capturedAt: z.string(),
  /** When it was written to the cache. */
  storedAt: z.string(),
});
export type CachedSnapshotInfo = z.infer<typeof cachedSnapshotInfoSchema>;

export const cachedSnapshotSchema = cachedSnapshotInfoSchema.extend({
  snapshot: schemaSnapshotSchema,
});
export type CachedSnapshot = z.infer<typeof cachedSnapshotSchema>;

export const metadataGetInputSchema = z.object({
  profileId: idSchema,
  /** Only these databases; every cached database of the profile when absent. */
  databases: z.array(z.string()).max(10_000).optional(),
});

export const metadataPutInputSchema = z.object({
  profileId: idSchema,
  snapshot: schemaSnapshotSchema,
});

export const metadataInvalidateInputSchema = z.object({
  profileId: idSchema,
  /** One database; every database of the profile when absent. */
  database: z.string().optional(),
});

/**
 * A snippet from the user's library. `body` uses editor snippet syntax (`${1:table}`); `prefix`
 * is the autocomplete trigger word.
 */
export const snippetSchema = z.object({
  id: idSchema,
  name: z.string(),
  prefix: z.string().nullable(),
  description: z.string().nullable(),
  body: z.string(),
  /** Engines the snippet applies to; empty means every engine. */
  engines: z.array(engineIdSchema),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Snippet = z.infer<typeof snippetSchema>;

export const snippetListInputSchema = z
  .object({
    /** Only the snippets that apply to this engine. */
    engine: engineIdSchema.optional(),
  })
  .prefault({});
