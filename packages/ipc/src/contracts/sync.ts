import { z } from 'zod';

import { idSchema } from '../schemas/common';
import {
  dataApplyInputSchema,
  dataCompareInputSchema,
  dataExportInputSchema,
  dataResultSchema,
  dataRowPageSchema,
  dataRowsInputSchema,
  dataScriptPreviewSchema,
  dataSelectionSchema,
  savedComparisonSaveSchema,
  savedComparisonSchema,
  structureApplyInputSchema,
  structureCompareInputSchema,
  structureExportInputSchema,
  structureResultSchema,
  structureScriptSchema,
  structureSelectionSchema,
} from '../schemas/sync';

/**
 * The `sync.*` namespace of the main contract (spec §13): structure compare and data compare
 * between two SQL connections. Compares and applies start jobs in the job runner and return
 * the job id; the page follows them on `jobs.events` like any job and then reads the result
 * here. Scripts, reports and data sync scripts are generated in the job runner too.
 *
 * Main keeps each finished comparison (the diff, the source structure, the spooled rows) until
 * the page discards it, so later calls name the job instead of sending the diff back. Write
 * rules are checked by main and again by the job runner whatever the page sends: a read-only
 * target refuses to apply (READ_ONLY); a production target, or one that confirms every write,
 * needs `confirmed` (CONFIRMATION_REQUIRED). Files are written only where this window's
 * `dialogs.saveFile` pointed.
 */

const jobRef = z.object({ jobId: idSchema });
const started = z.object({ jobId: idSchema });
const written = z.object({ bytes: z.number().int().nonnegative() });

export const syncMainContractShape = {
  structure: {
    /** Starts a structure compare job (introspect both sides, diff, default script). */
    compare: { input: structureCompareInputSchema, output: started },
    /** A finished compare's (or apply's) comparison. NOT_FOUND once discarded. */
    result: { input: jobRef, output: structureResultSchema },
    /** The deployment script for a selection of the comparison's operations. */
    script: { input: structureSelectionSchema, output: structureScriptSchema },
    /**
     * Applies the selected operations to the target as a job, stopping at the first error
     * (PostgreSQL: one transaction), then re-compares; read the outcome with `result`.
     */
    apply: { input: structureApplyInputSchema, output: started },
    /** Writes the script (.sql) or the HTML report for a selection. */
    export: { input: structureExportInputSchema, output: written },
  },
  data: {
    /** Starts a data compare job over the paired tables (spec §13, data sync). */
    compare: { input: dataCompareInputSchema, output: started },
    result: { input: jobRef, output: dataResultSchema },
    /** One page of a table's row differences for one action. */
    rows: { input: dataRowsInputSchema, output: dataRowPageSchema },
    /** The start of the sync script for a selection, for the review before applying. */
    preview: { input: dataSelectionSchema, output: dataScriptPreviewSchema },
    /** Applies the selection's spooled changes in batched transactions, as a job. */
    apply: { input: dataApplyInputSchema, output: started },
    /** Writes the data sync script for a selection. */
    export: { input: dataExportInputSchema, output: written },
  },
  /** Forgets a finished comparison and its spooled rows (its panel closed). */
  discard: { input: jobRef, output: z.void() },
  /** Saved comparisons (spec §13: comparisons save as profiles), ordered by name. */
  saved: {
    list: { input: z.void(), output: z.array(savedComparisonSchema) },
    save: { input: savedComparisonSaveSchema, output: savedComparisonSchema },
    delete: { input: z.object({ id: idSchema }), output: z.void() },
  },
} as const;
