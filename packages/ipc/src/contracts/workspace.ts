import { z } from 'zod';

import { idSchema } from '../schemas/common';
import {
  autosaveRestoreSchema,
  autosaveSaveInputSchema,
  gridViewSaveInputSchema,
  gridViewSchema,
  gridViewTableSchema,
} from '../schemas/workspace';

/**
 * The `gridViews.*` namespace of the main contract: saved table views (spec §7, "save views per
 * table"), the column layout, sort and filter per profile and table in the local store.
 */
export const gridViewsMainContractShape = {
  /** The table's views, its default first. */
  list: { input: gridViewTableSchema, output: z.array(gridViewSchema) },
  /**
   * Creates or updates a view; names are unique per table (VALIDATION_FAILED otherwise).
   * `isDefault` moves the table's default to it. NOT_FOUND for an unknown profile.
   */
  save: { input: gridViewSaveInputSchema, output: gridViewSchema },
  /** Makes a view the table's default, or clears the default with `id: null`. */
  setDefault: {
    input: z.object({ table: gridViewTableSchema, id: idSchema.nullable() }),
    output: z.void(),
  },
  /** Unknown ids are ignored. */
  delete: { input: z.object({ id: idSchema }), output: z.void() },
} as const;

/**
 * The `autosave.*` namespace of the main contract (spec §18): unsaved SQL, MongoDB and Redis
 * editor buffers written every few seconds, and restored at start with how the previous run
 * ended. Buffers carry text and context only, never results or secrets.
 */
export const autosaveMainContractShape = {
  /** The saved buffers in tab order, and whether the previous run of the app crashed. */
  restore: { input: z.void(), output: autosaveRestoreSchema },
  /** Writes and removes buffers in one transaction. */
  save: { input: autosaveSaveInputSchema, output: z.void() },
} as const;
