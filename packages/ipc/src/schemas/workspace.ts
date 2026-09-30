import { z } from 'zod';

import { expectedVersionSchema } from './app';
import { idSchema } from './common';

/**
 * Schemas for the workspace state kept in the local store: saved table views (spec §7, "save
 * views per table") and editor autosave for crash restore (spec §18). They mirror
 * `@joinery/storage`'s records; this package does not depend on storage.
 */

const timestampSchema = z.iso.datetime({ offset: true });

/** One column of a saved layout, keyed by column name, in display order. */
export const gridColumnStateSchema = z.object({
  name: z.string().min(1).max(1024),
  width: z.number().int().min(20).max(4000).optional(),
  hidden: z.boolean().optional(),
  /** Frozen at the left; pinned columns come first. */
  pinned: z.boolean().optional(),
});
export type GridColumnState = z.infer<typeof gridColumnStateSchema>;

export const gridLayoutSchema = z.object({ columns: z.array(gridColumnStateSchema).max(4096) });
export type GridLayout = z.infer<typeof gridLayoutSchema>;

export const gridSortTermSchema = z.object({
  column: z.string().min(1).max(1024),
  direction: z.enum(['asc', 'desc']),
  nulls: z.enum(['first', 'last']).optional(),
});

/** The table a view belongs to; `database` is null for the profile's default database. */
export const gridViewTableSchema = z.object({
  profileId: idSchema,
  database: z.string().nullable(),
  schema: z.string(),
  table: z.string().min(1),
});
export type GridViewTable = z.infer<typeof gridViewTableSchema>;

/**
 * A saved table view: column layout, server-side sort, and the filter bar's state serialised by
 * the app (which validates it when it reads it back).
 */
export const gridViewSchema = gridViewTableSchema.extend({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean(),
  layout: gridLayoutSchema,
  sort: z.array(gridSortTermSchema).max(64),
  filter: z.string().max(100_000).nullable(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type GridView = z.infer<typeof gridViewSchema>;

export const gridViewSaveInputSchema = gridViewTableSchema.extend({
  /** Updates this view; a new one is created without it. */
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean().optional(),
  layout: gridLayoutSchema,
  sort: z.array(gridSortTermSchema).max(64),
  filter: z.string().max(100_000).nullable(),
  expectedVersion: expectedVersionSchema.optional(),
});
export type GridViewSaveInput = z.input<typeof gridViewSaveInputSchema>;

/** Editors whose buffers autosave. */
export const autosaveKindSchema = z.enum([
  'sql',
  'mongo-console',
  'mongo-shell',
  'mongo-sql',
  'redis-cli',
]);
export type AutosaveKind = z.infer<typeof autosaveKindSchema>;

/** An editor tab's buffer and where it runs; never results, never secrets. */
export const autosaveEntryInputSchema = z.object({
  id: idSchema,
  kind: autosaveKindSchema,
  profileId: idSchema,
  database: z.string().max(1024).nullable(),
  title: z.string().max(500),
  text: z.string().max(8_000_000),
  cursor: z.number().int().nonnegative().nullable(),
  position: z.number().int().nonnegative(),
});
export type AutosaveEntryInput = z.infer<typeof autosaveEntryInputSchema>;

export const autosaveEntrySchema = autosaveEntryInputSchema.extend({ savedAt: timestampSchema });
export type AutosaveEntry = z.infer<typeof autosaveEntrySchema>;

/** What the app finds at start: the buffers to restore, and whether the last run crashed. */
export const autosaveRestoreSchema = z.object({
  /** How the previous run ended: `unclean` after a crash or a kill. */
  previousRun: z.enum(['none', 'clean', 'unclean']),
  entries: z.array(autosaveEntrySchema),
});
export type AutosaveRestore = z.infer<typeof autosaveRestoreSchema>;

export const autosaveSaveInputSchema = z.object({
  upsert: z.array(autosaveEntryInputSchema).max(500),
  remove: z.array(idSchema).max(500),
});
export type AutosaveSaveInput = z.infer<typeof autosaveSaveInputSchema>;
