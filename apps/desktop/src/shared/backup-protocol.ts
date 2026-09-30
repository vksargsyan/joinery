import { backupInspectInputSchema, restoreJobSchema } from '@joinery/ipc';
import { z } from 'zod';

import { resolvedProfileSchema } from './host-protocol';

/**
 * The backup and restore wizards' quick requests to the job runner (spec §14), part of the
 * runner protocol in job-protocol.ts: reading a backup file's manifest, planning a restore on
 * its target (which needs a session, hence the resolved profile, main → runner only, as with
 * `start`), and finding the native tools.
 */

export const backupInspectRequestSchema = z.object({
  kind: z.literal('backup-inspect'),
  input: backupInspectInputSchema,
});

export const restorePlanRequestSchema = z.object({
  kind: z.literal('restore-plan'),
  input: restoreJobSchema,
  resolved: resolvedProfileSchema,
});

export const nativeToolsRequestSchema = z.object({ kind: z.literal('native-tools') });

export type BackupRunnerRequest =
  | z.infer<typeof backupInspectRequestSchema>
  | z.infer<typeof restorePlanRequestSchema>
  | z.infer<typeof nativeToolsRequestSchema>;
