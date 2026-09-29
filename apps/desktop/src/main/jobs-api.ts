import { basename, resolve } from 'node:path';

import {
  JoineryError,
  isSqlEngine,
  newId,
  requiresWriteConfirmation,
  type ConnectionProfile,
} from '@joinery/core';
import {
  columnMappingSchema,
  isSyncJobKind,
  jobInfoSchema,
  newTablePlanSchema,
  transferPreviewSchema,
  transferProfileSchema,
  type HandlersOf,
  type JobInfo,
  type JobSpec,
  type SyncJobKind,
  type TransferProfile,
  type mainContract,
} from '@joinery/ipc';
import type { Store } from '@joinery/storage';
import { z } from 'zod';

import { jobEvents, type JobDescription, type JobHistoryStore, type JobManager } from './jobs';
import { resolveProfile } from './secrets';
import { describeTransfer, startTransferJob } from './transfer-db-api';

/**
 * The main contract's job and transfer handlers (spec §3, §12, §14), and the file grants that
 * keep the renderer away from the file system: a job reads only files the user picked with
 * `dialogs.openFile` and writes only where `dialogs.saveFile` or `dialogs.openDirectory` said,
 * in that window. Main checks the write rules again whatever the page sends: an import on a
 * read-only profile is refused, and writes a production profile (or a replace or delete
 * import) asks about need the renderer's `confirmed`.
 */

type MainHandlers = HandlersOf<typeof mainContract>;

export interface SaveFileOptions {
  readonly title?: string | undefined;
  readonly defaultName?: string | undefined;
  readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

/** The native dialogs a window offers besides "open file". */
export interface FileDialogs {
  readonly saveFile?: (options: SaveFileOptions) => Promise<string | null>;
  readonly openDirectory?: (options: {
    readonly title?: string | undefined;
  }) => Promise<string | null>;
}

/** Paths the user picked in one window's dialogs, which that window's jobs may use. */
export class FileGrants {
  readonly #read = new Set<string>();
  readonly #write = new Set<string>();
  readonly #directories = new Set<string>();

  grantRead(path: string): void {
    this.#read.add(resolve(path));
  }

  grantWrite(path: string): void {
    this.#write.add(resolve(path));
  }

  grantDirectory(path: string): void {
    this.#directories.add(resolve(path));
  }

  checkRead(path: string): void {
    if (!this.#read.has(resolve(path))) throw notPicked(path);
  }

  checkWrite(path: string): void {
    if (!this.#write.has(resolve(path))) throw notPicked(path);
  }

  checkDirectory(path: string): void {
    if (!this.#directories.has(resolve(path))) throw notPicked(path);
  }
}

function notPicked(path: string): JoineryError {
  return new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `${basename(path)} was not chosen in a file dialog`,
    hint: 'Choose the file again.',
  });
}

const HISTORY_KEY = 'jobs.history';
const PROFILES_KEY = 'transfer.profiles';

/** The job history as a settings entry of the local store. */
export function settingsJobHistory(store: Store): JobHistoryStore {
  return {
    load: () => store.settings.get(HISTORY_KEY, z.array(jobInfoSchema)) ?? [],
    // A JSON round trip drops undefined fields, which the settings store refuses.
    save: (jobs) => store.settings.set(HISTORY_KEY, JSON.parse(JSON.stringify(jobs))),
  };
}

function readTransferProfiles(store: Store): TransferProfile[] {
  return store.settings.get(PROFILES_KEY, z.array(transferProfileSchema)) ?? [];
}

/** What the job list shows: a title and the file, table and format it works on. */
export function describeJob(spec: JobSpec): JobDescription {
  const database = spec.database !== undefined ? { database: spec.database } : {};
  switch (spec.kind) {
    case 'import': {
      const table = spec.table.schema ? `${spec.table.schema}.${spec.table.name}` : spec.table.name;
      return {
        title: `Import ${basename(spec.file.path)} into ${spec.create ? 'new table ' : ''}${table}`,
        target: { file: spec.file.path, table, format: spec.file.format, ...database },
      };
    }
    case 'export': {
      const format = spec.format === 'sql-ddl' ? 'SQL with DDL' : spec.format.toUpperCase();
      const tables = spec.source.kind === 'tables' ? spec.source.tables : [];
      const what =
        spec.source.kind === 'query'
          ? 'query results'
          : tables.length === 1
            ? tables[0]!
            : `${tables.length} tables`;
      const shown = tables.join(', ');
      return {
        title: `Export ${what} to ${format}`,
        target: {
          file: spec.output.path,
          ...(tables.length > 0
            ? { table: shown.length > 200 ? `${shown.slice(0, 199)}…` : shown }
            : {}),
          format: spec.format,
          ...database,
        },
      };
    }
    case 'run-sql-file':
      return {
        title: `Run ${basename(spec.path)}`,
        target: { file: spec.path, format: 'sql', ...database },
      };
    case 'transfer':
      return describeTransfer(spec);
  }
}

/** The write rules for a job (spec §4, §6, §12), checked before it starts. */
export function checkJobSafety(spec: JobSpec, profile: ConnectionProfile): void {
  const confirmWrites = requiresWriteConfirmation(profile);
  const production = profile.presentation.environment === 'production';
  if (spec.kind === 'import') {
    if (profile.presentation.readOnly) {
      throw new JoineryError({
        code: 'READ_ONLY',
        message: `"${profile.name}" is read-only, so nothing can be imported into it`,
      });
    }
    const destructive = spec.mode === 'replace' || spec.mode === 'delete';
    if ((confirmWrites || destructive) && spec.confirmed !== true) {
      throw new JoineryError({
        code: 'CONFIRMATION_REQUIRED',
        message: destructive
          ? `The ${spec.mode} import ${spec.mode === 'replace' ? 'empties the table first' : 'deletes rows'} and needs confirmation`
          : `Importing into ${production ? 'a production connection' : `"${profile.name}"`} needs confirmation`,
      });
    }
  }
  if (spec.kind === 'run-sql-file' && confirmWrites && spec.confirmed !== true) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `Running a SQL file on ${production ? 'a production connection' : `"${profile.name}"`} needs confirmation`,
    });
  }
}

function checkPaths(spec: JobSpec, grants: FileGrants): void {
  switch (spec.kind) {
    case 'import':
      grants.checkRead(spec.file.path);
      return;
    case 'run-sql-file':
      grants.checkRead(spec.path);
      return;
    case 'export':
      if (spec.output.kind === 'file') grants.checkWrite(spec.output.path);
      else grants.checkDirectory(spec.output.path);
      return;
  }
}

function jobsUnavailable(): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message: 'Jobs cannot run here' });
}

/** Handlers of the `jobs` and `transfer` namespaces for one window. */
export function jobHandlers(
  services: { readonly store: Store; readonly jobs?: JobManager | undefined },
  grants: FileGrants,
): Pick<MainHandlers, 'jobs' | 'transfer'> {
  const { store } = services;
  const manager = (): JobManager => {
    if (!services.jobs) throw jobsUnavailable();
    return services.jobs;
  };

  return {
    jobs: {
      start: ({ job, secrets }) => {
        const jobs = manager();
        if (job.kind === 'transfer') return startTransferJob(store, jobs, job, secrets ?? {});
        const profile = store.profiles.get(job.profileId);
        if (!profile) {
          throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
        }
        if (!isSqlEngine(profile.engine)) {
          throw new JoineryError({
            code: 'NOT_SUPPORTED',
            message: 'Import and export work with SQL connections for now',
          });
        }
        checkPaths(job, grants);
        checkJobSafety(job, profile);
        const resolved = resolveProfile(store, profile, secrets ?? {}, { requireAll: true });
        return { jobId: jobs.start(job, resolved, describeJob(job)).id };
      },
      cancel: ({ jobId }) => {
        services.jobs?.cancel(jobId);
      },
      list: () => services.jobs?.list() ?? [],
      events: (_input, { signal }) => jobEvents(manager(), signal),
      clear: () => {
        services.jobs?.clearFinished();
      },
    },
    transfer: {
      preview: async (input) => {
        grants.checkRead(input.path);
        return transferPreviewSchema.parse(await manager().request({ kind: 'preview', input }));
      },
      autoMatch: async (input) =>
        z.array(columnMappingSchema).parse(await manager().request({ kind: 'auto-match', input })),
      planTable: async (input) =>
        newTablePlanSchema.parse(await manager().request({ kind: 'plan-table', input })),
      profiles: {
        list: () => readTransferProfiles(store),
        save: (input) => {
          const profiles = readTransferProfiles(store);
          const existing =
            (input.id !== undefined ? profiles.find((p) => p.id === input.id) : undefined) ??
            profiles.find((p) => p.kind === input.kind && p.name === input.name);
          const saved = transferProfileSchema.parse({
            ...input,
            id: existing?.id ?? newId(),
            updatedAt: new Date().toISOString(),
          });
          const next = [...profiles.filter((p) => p.id !== saved.id), saved].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
          store.settings.set(PROFILES_KEY, JSON.parse(JSON.stringify(next)));
          return saved;
        },
        delete: ({ id }) => {
          const profiles = readTransferProfiles(store);
          store.settings.set(
            PROFILES_KEY,
            JSON.parse(JSON.stringify(profiles.filter((p) => p.id !== id))),
          );
        },
      },
    },
  };
}

/** `dialogs.saveFile` and `dialogs.openDirectory`: the picked paths become write grants. */
export function fileDialogHandlers(
  dialogs: FileDialogs,
  grants: FileGrants,
): Pick<MainHandlers['dialogs'], 'saveFile' | 'openDirectory'> {
  return {
    saveFile: async (options) => {
      if (!dialogs.saveFile) throw jobsUnavailable();
      const path = await dialogs.saveFile(options);
      if (path !== null) grants.grantWrite(path);
      return { path };
    },
    openDirectory: async (options) => {
      if (!dialogs.openDirectory) throw jobsUnavailable();
      const path = await dialogs.openDirectory(options);
      if (path !== null) grants.grantDirectory(path);
      return { path };
    },
  };
}

const STATE_WORDS: Readonly<Record<JobInfo['state'], string>> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

const SYNC_JOB_TITLES: Readonly<Record<SyncJobKind, string>> = {
  'structure-compare': 'Structure compare',
  'structure-apply': 'Structure sync',
  'data-compare': 'Data compare',
  'data-apply': 'Data sync',
};

/** The finished job's one-line summary, for the desktop notification. */
export function notificationFor(job: JobInfo): { title: string; body: string } {
  const summary = job.summary;
  if (isSyncJobKind(job.kind)) {
    const what = SYNC_JOB_TITLES[job.kind];
    return {
      title:
        job.state === 'completed'
          ? `${what} finished`
          : job.state === 'cancelled'
            ? `${what} cancelled`
            : `${what} failed`,
      body: `${job.title}: ${job.error?.message ?? summary?.outcome ?? STATE_WORDS[job.state]}`,
    };
  }
  const rows = summary ? summary.rowsWritten.toLocaleString('en-US') : '0';
  const title =
    job.state === 'completed'
      ? `${job.kind === 'export' ? 'Export' : job.kind === 'import' ? 'Import' : job.kind === 'transfer' ? 'Transfer' : 'SQL file'} finished`
      : job.state === 'cancelled'
        ? 'Job cancelled'
        : 'Job failed';
  const detail =
    job.state === 'failed' && job.error
      ? job.error.message
      : job.kind === 'run-sql-file'
        ? `${summary?.statements ?? 0} statements${summary?.failed ? `, ${summary.failed} failed` : ''}`
        : `${rows} rows${summary?.rowsSkipped ? `, ${summary.rowsSkipped} skipped` : ''}`;
  return { title, body: `${job.title}: ${detail}` };
}
