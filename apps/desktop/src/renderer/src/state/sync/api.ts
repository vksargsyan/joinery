import type {
  DataApplyInput,
  DataCompareInput,
  DataExportInput,
  DataResult,
  DataRowPage,
  DataScriptPreview,
  DataSelection,
  JobInfo,
  SavedComparison,
  SavedComparisonSave,
  StructureApplyInput,
  StructureCompareInput,
  StructureExportInput,
  StructureResult,
  StructureScript,
} from '@joinery/ipc';

import { mainApi } from '../../lib/main-client';
import { profileById } from '../data';
import { askSecrets } from '../dialogs';
import { cancelJob, useJobs } from '../jobs';
import { invalidateMetadata } from '../metadata';

/**
 * What the compare panels ask of the app (spec §13), as one interface so the view models run
 * against a fake in the tests. The real one talks to main's `sync.*` contract and follows the
 * jobs on the job list; nothing here touches a driver or a file.
 */
export interface SyncApi {
  /** Starts a compare; undefined when the user dismissed a secrets prompt. */
  compareStructure(input: Omit<StructureCompareInput, 'secrets'>): Promise<string | undefined>;
  structureResult(jobId: string): Promise<StructureResult>;
  structureScript(jobId: string, selected: readonly string[]): Promise<StructureScript>;
  /** Starts an apply; `targetProfileId` is asked for its "ask every time" secrets. */
  applyStructure(
    input: Omit<StructureApplyInput, 'secrets'>,
    targetProfileId: string,
  ): Promise<string | undefined>;
  exportStructure(input: StructureExportInput): Promise<number>;
  compareData(input: Omit<DataCompareInput, 'secrets'>): Promise<string | undefined>;
  dataResult(jobId: string): Promise<DataResult>;
  dataRows(input: {
    jobId: string;
    table: number;
    action: 'insert' | 'update' | 'delete';
    page: number;
  }): Promise<DataRowPage>;
  dataPreview(selection: DataSelection): Promise<DataScriptPreview>;
  applyData(
    input: Omit<DataApplyInput, 'secrets'>,
    targetProfileId: string,
  ): Promise<string | undefined>;
  exportData(input: DataExportInput): Promise<number>;
  /** Forgets a comparison main keeps. */
  discard(jobId: string): void;
  /** Resolves with the job's record once it ends; `onUpdate` sees it while it runs. */
  waitForJob(jobId: string, onUpdate?: (job: JobInfo) => void): Promise<JobInfo>;
  cancel(jobId: string): Promise<void>;
  /** A native save dialog; null when cancelled. */
  saveFile(options: {
    readonly title: string;
    readonly defaultName: string;
    readonly extension: string;
    readonly label: string;
  }): Promise<string | null>;
  saveComparison(input: SavedComparisonSave): Promise<SavedComparison>;
  /** The structure of a connection changed (an apply ran): the explorer reloads it. */
  structureChanged(profileId: string): void;
}

/** "Ask every time" secrets of the connections a job opens, asked for once each. */
async function secretsFor(
  profileIds: readonly string[],
): Promise<Record<string, string> | undefined | null> {
  let secrets: Record<string, string> | undefined;
  for (const profileId of new Set(profileIds)) {
    const status = await mainApi().profiles.secretStatus({ profileId });
    if (status.missing.length === 0) continue;
    const profile = await profileById(profileId);
    const typed = await askSecrets(profile?.name ?? 'the connection', status.missing);
    if (typed === null) return null;
    secrets = { ...secrets, ...typed };
  }
  return secrets;
}

function waitForJob(jobId: string, onUpdate?: (job: JobInfo) => void): Promise<JobInfo> {
  return new Promise((resolve) => {
    let last: JobInfo | undefined;
    const check = (): boolean => {
      const job = useJobs.getState().jobs[jobId];
      if (!job || job === last) return false;
      last = job;
      if (job.state === 'running') {
        onUpdate?.(job);
        return false;
      }
      resolve(job);
      return true;
    };
    if (check()) return;
    const unsubscribe = useJobs.subscribe(() => {
      if (check()) unsubscribe();
    });
  });
}

/** The app's SyncApi: main's `sync.*` contract and the job list. */
export function appSyncApi(): SyncApi {
  const sync = () => mainApi().sync;
  const withSecrets = async (
    profileIds: readonly string[],
    start: (secrets: Record<string, string> | undefined) => Promise<{ jobId: string }>,
  ): Promise<string | undefined> => {
    const secrets = await secretsFor(profileIds);
    if (secrets === null) return undefined;
    return (await start(secrets)).jobId;
  };
  return {
    compareStructure: (input) =>
      withSecrets([input.source.profileId, input.target.profileId], (secrets) =>
        sync().structure.compare({ ...input, ...(secrets ? { secrets } : {}) }),
      ),
    structureResult: (jobId) => sync().structure.result({ jobId }),
    structureScript: (jobId, selected) =>
      sync().structure.script({ jobId, selected: [...selected] }),
    applyStructure: (input, targetProfileId) =>
      withSecrets([targetProfileId], (secrets) =>
        sync().structure.apply({ ...input, ...(secrets ? { secrets } : {}) }),
      ),
    exportStructure: async (input) => (await sync().structure.export(input)).bytes,
    compareData: (input) =>
      withSecrets([input.source.profileId, input.target.profileId], (secrets) =>
        sync().data.compare({ ...input, ...(secrets ? { secrets } : {}) }),
      ),
    dataResult: (jobId) => sync().data.result({ jobId }),
    dataRows: (input) => sync().data.rows(input),
    dataPreview: (selection) => sync().data.preview(selection),
    applyData: (input, targetProfileId) =>
      withSecrets([targetProfileId], (secrets) =>
        sync().data.apply({ ...input, ...(secrets ? { secrets } : {}) }),
      ),
    exportData: async (input) => (await sync().data.export(input)).bytes,
    discard: (jobId) => {
      void sync()
        .discard({ jobId })
        .catch(() => undefined);
    },
    waitForJob,
    cancel: (jobId) => cancelJob(jobId),
    saveFile: async (options) =>
      (
        await mainApi().dialogs.saveFile({
          title: options.title,
          defaultName: options.defaultName,
          filters: [{ name: options.label, extensions: [options.extension] }],
        })
      ).path,
    saveComparison: (input) => sync().saved.save(input),
    structureChanged: (profileId) => invalidateMetadata(profileId),
  };
}
