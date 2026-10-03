import type { StructureScript } from '@querybara/ipc';

import type { RunnerRequest } from '../shared/job-protocol';
import type { SyncJobSpec } from '../shared/sync-jobs';
import type { SyncJobContext, SyncJobOutcome } from './sync-common';
import { dataSyncScript, runDataApply, runDataCompare } from './sync-data';
import {
  exportStructure,
  runStructureApply,
  runStructureCompare,
  structureScript,
} from './sync-structure';

/**
 * The job runner's structure and data sync work (spec §13): the four sync job kinds and the
 * quick requests (a selection's script, exports, the data sync script and its preview).
 */

export type SyncRequest = Extract<
  RunnerRequest,
  { kind: 'sync-script' | 'sync-export' | 'sync-data-script' }
>;

export function isSyncRequest(request: RunnerRequest): request is SyncRequest {
  return (
    request.kind === 'sync-script' ||
    request.kind === 'sync-export' ||
    request.kind === 'sync-data-script'
  );
}

export function runSyncJob(job: SyncJobSpec, context: SyncJobContext): Promise<SyncJobOutcome> {
  switch (job.kind) {
    case 'structure-compare':
      return runStructureCompare(job, context);
    case 'structure-apply':
      return runStructureApply(job, context);
    case 'data-compare':
      return runDataCompare(job, context);
    case 'data-apply':
      return runDataApply(job, context);
  }
}

export async function answerSyncRequest(
  request: SyncRequest,
): Promise<StructureScript | { bytes: number } | Awaited<ReturnType<typeof dataSyncScript>>> {
  switch (request.kind) {
    case 'sync-script':
      return structureScript(request.input.diff, request.input.selected);
    case 'sync-export':
      return exportStructure(request.input);
    case 'sync-data-script':
      return dataSyncScript(request.input);
  }
}
