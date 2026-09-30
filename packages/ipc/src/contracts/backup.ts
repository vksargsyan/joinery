import { z } from 'zod';

import {
  backupInspectInputSchema,
  backupInspectionSchema,
  nativeToolSchema,
  restorePlanInputSchema,
  restorePlanSchema,
} from '../schemas/backup';

/**
 * The `backup.*` namespace of the main contract (spec §14): what the backup and restore wizards
 * ask of the job runner before a job starts. Backups and restores themselves are jobs
 * (`jobs.start` with a `backup` or `restore` spec), so they share the job list's progress, log,
 * history and notifications.
 */
export const backupMainContractShape = {
  /**
   * Reads a backup file picked with `dialogs.openFile`: its format, and for an archive the
   * manifest (which needs the passphrase when it is encrypted).
   */
  inspect: { input: backupInspectInputSchema, output: backupInspectionSchema },
  /**
   * What a restore job would do on its target: the objects it restores or adds, those it
   * skips, and the existing objects it would drop or overwrite, which the user must confirm.
   */
  planRestore: { input: restorePlanInputSchema, output: restorePlanSchema },
  /** pg_dump, mysqldump and their restore clients found on this machine. */
  nativeTools: { input: z.void(), output: z.array(nativeToolSchema) },
} as const;
