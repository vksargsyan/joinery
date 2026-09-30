import {
  ENGINES,
  JoineryError,
  isSqlEngine,
  requiresWriteConfirmation,
  type ConnectionProfile,
  type EngineId,
} from '@joinery/core';
import {
  transferInspectionSchema,
  transferPlanSchema,
  type HandlersOf,
  type TransferJob,
  type mainContract,
} from '@joinery/ipc';
import type { Store, StoredProfile } from '@joinery/storage';

import type { JobDescription, JobManager } from './jobs';
import { resolveProfile } from './secrets';

/**
 * Main's side of data transfer between databases (spec §12): the wizard's `transferDb`
 * requests and the start of a `transfer` job. Profiles are resolved here, with their secrets,
 * and handed to the job runner only. The write rules are checked before anything starts (a
 * read-only target refuses; drop and create, truncate, REPLACE and any transfer into a
 * production or confirm-every-write profile need the page's confirmation), and checked again
 * in the runner against what the plan really drops or empties.
 */

type Handlers = HandlersOf<typeof mainContract>['transferDb'];

function unavailable(): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message: 'Jobs cannot run here' });
}

function profileOf(store: Store, id: string): StoredProfile {
  const profile = store.profiles.get(id);
  if (!profile)
    throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
  return profile;
}

/**
 * The engine pairs a transfer supports (@joinery/transfer's `transferSupport`, which the job
 * runner applies again; main does not load the transfer engine).
 */
export function checkTransferEngines(source: EngineId, target: EngineId): void {
  const ok =
    (isSqlEngine(source) && (isSqlEngine(target) || target === 'mongodb')) ||
    (source === 'mongodb' && isSqlEngine(target)) ||
    (source === 'redis' && target === 'redis');
  if (ok) return;
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: `Data transfer from ${ENGINES[source].displayName} to ${ENGINES[target].displayName} is not supported`,
  });
}

/** The modes and options of a transfer that destroy data whatever the tables hold. */
export function destructiveChoices(job: TransferJob): string[] {
  const choices = new Set<string>();
  const modes = [job.options?.mode, ...job.objects.map((o) => o.mode)];
  if (modes.includes('drop-create')) choices.add('drops and creates tables that exist');
  if (modes.includes('truncate')) choices.add('empties tables that exist');
  if (job.options?.replace === true) choices.add('overwrites keys that exist');
  return [...choices];
}

/** The write rules for a transfer, checked before it starts (spec §4, §12). */
export function checkTransferSafety(job: TransferJob, target: ConnectionProfile): void {
  if (target.presentation.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: `"${target.name}" is read-only, so nothing can be transferred into it`,
    });
  }
  if (job.confirmed === true) return;
  const destructive = destructiveChoices(job);
  if (destructive.length > 0) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `The transfer ${destructive.join(' and ')}, and needs confirmation`,
    });
  }
  if (requiresWriteConfirmation(target)) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `Transferring into ${
        target.presentation.environment === 'production'
          ? 'a production connection'
          : `"${target.name}"`
      } needs confirmation`,
    });
  }
}

/** What the job list shows about a transfer. */
export function describeTransfer(
  job: TransferJob,
  names: {
    readonly source?: string;
    readonly target?: string;
    readonly engine?: EngineId;
  } = {},
): JobDescription {
  const objects = job.objects.map((o) => o.name);
  const noun = names.engine === 'mongodb' ? 'collections' : 'tables';
  const what =
    job.keyPatterns !== undefined && objects.length === 0
      ? `keys ${job.keyPatterns.join(', ')}`
      : objects.length === 1
        ? objects[0]!
        : `${objects.length} ${noun}`;
  const route =
    names.source !== undefined && names.target !== undefined
      ? ` from ${names.source} to ${names.target}`
      : '';
  const shown = (objects.length > 0 ? objects : (job.keyPatterns ?? [])).join(', ');
  return {
    title: `Transfer ${what}${route}`,
    target: {
      ...(shown !== '' ? { table: shown.length > 200 ? `${shown.slice(0, 199)}…` : shown } : {}),
      ...(job.database !== undefined ? { database: job.database } : {}),
      format: 'transfer',
    },
  };
}

/** Starts a transfer job after the checks; its secrets go to the job runner only. */
export function startTransferJob(
  store: Store,
  jobs: JobManager,
  job: TransferJob,
  secrets: Readonly<Record<string, string>>,
): { jobId: string } {
  const source = profileOf(store, job.profileId);
  const target = profileOf(store, job.target.profileId);
  checkTransferEngines(source.engine, target.engine);
  checkTransferSafety(job, target);
  const resolved = resolveProfile(store, source, secrets, { requireAll: true });
  const resolvedTarget = resolveProfile(store, target, secrets, { requireAll: true });
  const info = jobs.start(
    job,
    resolved,
    describeTransfer(job, { source: source.name, target: target.name, engine: source.engine }),
    { resolvedTarget },
  );
  return { jobId: info.id };
}

/** The `transferDb` handlers: the wizard's inspection and plan, worked out in the job runner. */
export function transferDbHandlers(services: {
  readonly store: Store;
  readonly jobs?: JobManager | undefined;
}): Handlers {
  const { store } = services;
  const manager = (): JobManager => {
    if (!services.jobs) throw unavailable();
    return services.jobs;
  };
  return {
    inspect: async ({ profileId, database, schema, secrets }) => {
      const resolved = resolveProfile(store, profileOf(store, profileId), secrets ?? {}, {
        requireAll: true,
      });
      return transferInspectionSchema.parse(
        await manager().request({
          kind: 'transfer-inspect',
          input: {
            ...(database !== undefined ? { database } : {}),
            ...(schema !== undefined ? { schema } : {}),
          },
          resolved,
        }),
      );
    },
    plan: async ({ job, secrets }) => {
      const source = profileOf(store, job.profileId);
      const target = profileOf(store, job.target.profileId);
      const resolved = resolveProfile(store, source, secrets ?? {}, { requireAll: true });
      const resolvedTarget = resolveProfile(store, target, secrets ?? {}, { requireAll: true });
      return transferPlanSchema.parse(
        await manager().request({ kind: 'transfer-plan', job, resolved, resolvedTarget }),
      );
    },
  };
}
