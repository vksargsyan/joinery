import { ENGINES, JoineryError, describeRule, isSqlEngine } from '@joinery/core';
import {
  scheduleTaskSchema,
  type HandlersOf,
  type ScheduleEvent,
  type ScheduleInfo,
  type ScheduleSaveInput,
  type mainContract,
} from '@joinery/ipc';
import type { ScheduleRecord, Store } from '@joinery/storage';

import type { FileGrants } from './jobs-api';
import { checkJobSafety } from './jobs-api';
import { passphraseRef } from './schedule-tasks';
import type { Scheduler } from './scheduler';
import { subscriptionStream } from './updates';

/**
 * The main contract's `schedules.*` handlers (spec: scheduler and automation). Saving checks
 * what a run will need, whatever the page sends: the connection (or saved comparison) exists, a
 * SQL file or export runs on a SQL connection, the write rules allow it (a production schedule is
 * confirmed), a new output folder was picked in a dialog in this window (and a new SQL file
 * opened in one), and an encrypted backup has its passphrase, which goes to the secret store.
 * Main trusts a saved schedule's paths afterwards, run after run. The list says what would make
 * a run fail as things stand: a password not saved, a connection gone.
 */

type MainHandlers = HandlersOf<typeof mainContract>;

/** Fans the scheduler's events out to every open stream. */
export class ScheduleEvents {
  readonly #listeners = new Set<(event: ScheduleEvent) => void>();

  publish(event: ScheduleEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(listener: (event: ScheduleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export interface ScheduleServices {
  readonly store: Store;
  readonly scheduler?: Scheduler | undefined;
  readonly scheduleEvents?: ScheduleEvents | undefined;
}

function unavailable(): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message: 'Schedules are not available here' });
}

/** Why the schedule's runs would fail as things stand. */
function warningsOf(store: Store, schedule: ScheduleRecord): string[] {
  const warnings: string[] = [];
  const missingSecrets = (profileId: string | null, role: string): void => {
    const profile = profileId === null ? undefined : store.profiles.get(profileId);
    if (!profile) {
      warnings.push(`The ${role} was deleted`);
      return;
    }
    if (store.secrets.resolve(profile).missing.length > 0) {
      warnings.push(
        `The password of ${profile.name} is not saved: runs will fail until it is saved in the connection settings`,
      );
    }
  };
  if (schedule.kind === 'comparison') {
    const record =
      schedule.comparisonId === null ? undefined : store.comparisons.get(schedule.comparisonId);
    if (!record) warnings.push('The saved comparison was deleted');
    else {
      missingSecrets(record.sourceProfileId, 'source connection');
      missingSecrets(record.targetProfileId, 'target connection');
    }
  } else {
    missingSecrets(schedule.profileId, 'connection');
  }
  const task = scheduleTaskSchema.safeParse(schedule.task);
  if (!task.success) warnings.push('The schedule was saved by another version of Joinery');
  else if (
    task.data.kind === 'backup' &&
    task.data.encrypted &&
    store.secrets.get(passphraseRef(schedule.id)) === undefined
  ) {
    warnings.push('The backup passphrase is not saved: edit the schedule and enter it again');
  }
  return [...new Set(warnings)];
}

function targetOf(store: Store, schedule: ScheduleRecord): string {
  if (schedule.kind === 'comparison') {
    const record =
      schedule.comparisonId === null ? undefined : store.comparisons.get(schedule.comparisonId);
    return record ? `Comparison: ${record.name}` : 'A deleted comparison';
  }
  const profile = schedule.profileId === null ? undefined : store.profiles.get(schedule.profileId);
  const task = scheduleTaskSchema.safeParse(schedule.task);
  const database =
    task.success && task.data.kind !== 'comparison' ? task.data.job.database : undefined;
  return profile ? [profile.name, database].filter(Boolean).join(' · ') : 'A deleted connection';
}

export function scheduleInfo(services: ScheduleServices, schedule: ScheduleRecord): ScheduleInfo {
  const task = scheduleTaskSchema.parse(schedule.task);
  return {
    id: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    kind: schedule.kind,
    profileId: schedule.profileId,
    comparisonId: schedule.comparisonId,
    task,
    rule: schedule.rule,
    missed: schedule.missed,
    notify: schedule.notify,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastStatus: schedule.lastStatus,
    version: schedule.version,
    description: describeRule(schedule.rule),
    target: targetOf(services.store, schedule),
    running: services.scheduler?.isRunning(schedule.id) ?? false,
    warnings: warningsOf(services.store, schedule),
  };
}

/** Checks a schedule about to be saved; `previous` is the saved one when it is an update. */
function checkSave(
  store: Store,
  grants: FileGrants,
  input: ScheduleSaveInput,
  previous: ScheduleRecord | undefined,
): void {
  const { task } = input;
  const previousTask = previous ? scheduleTaskSchema.safeParse(previous.task) : undefined;
  const before = previousTask?.success ? previousTask.data : undefined;

  if (task.kind === 'comparison') {
    if (input.comparisonId === null || input.profileId !== null) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'A comparison schedule runs a saved comparison',
      });
    }
    if (!store.comparisons.get(input.comparisonId)) {
      throw new JoineryError({ code: 'NOT_FOUND', message: 'The saved comparison was deleted' });
    }
  } else {
    if (input.profileId === null || input.comparisonId !== null) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'The schedule runs on a connection',
      });
    }
    if (task.job.profileId !== input.profileId) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'The job runs on another connection than the schedule',
      });
    }
    const profile = store.profiles.get(input.profileId);
    if (!profile)
      throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
    if (task.kind !== 'backup' && !isSqlEngine(profile.engine)) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `${ENGINES[profile.engine].displayName} connections do not run SQL files or exports`,
      });
    }
    // The write rules as a run will meet them (an output path stands in for the real one).
    if (task.kind === 'sql') checkJobSafety(task.job, profile);
    if (task.kind === 'sql' && (before?.kind !== 'sql' || before.job.path !== task.job.path)) {
      grants.checkRead(task.job.path);
    }
  }
  if (task.kind !== 'sql') {
    const folderBefore = before && before.kind !== 'sql' ? before.output.folder : undefined;
    if (folderBefore !== task.output.folder) grants.checkDirectory(task.output.folder);
  }
  if (task.kind === 'backup' && task.encrypted && input.passphrase === undefined) {
    const kept =
      previous !== undefined && store.secrets.get(passphraseRef(previous.id)) !== undefined;
    if (!kept) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'An encrypted backup needs its passphrase',
      });
    }
  }
  if (task.kind === 'backup' && input.passphrase !== undefined && !store.secrets.canSave()) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message:
        'Secure storage is not available, so the passphrase cannot be kept for scheduled runs',
    });
  }
}

export function scheduleHandlers(
  services: ScheduleServices,
  grants: FileGrants,
): MainHandlers['schedules'] {
  const { store } = services;
  const scheduler = (): Scheduler => {
    if (!services.scheduler) throw unavailable();
    return services.scheduler;
  };
  const require = (id: string): ScheduleRecord => {
    const schedule = store.schedules.get(id);
    if (!schedule)
      throw new JoineryError({ code: 'NOT_FOUND', message: 'The schedule was deleted' });
    return schedule;
  };

  return {
    list: () => store.schedules.list().map((schedule) => scheduleInfo(services, schedule)),

    save: (input) => {
      const previous = input.id === undefined ? undefined : require(input.id);
      checkSave(store, grants, input, previous);
      // A new rule, or turning it on, plans the next run afresh.
      const replan =
        !previous ||
        JSON.stringify(previous.rule) !== JSON.stringify(input.rule) ||
        (!previous.enabled && input.enabled);
      const fields = {
        name: input.name,
        enabled: input.enabled,
        task: input.task,
        rule: input.rule,
        missed: input.missed,
        notify: input.notify,
        ...(replan ? { nextRunAt: null } : {}),
      };
      const saved = previous
        ? store.schedules.update(
            previous.id,
            fields,
            input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion },
          )
        : store.schedules.create({
            ...fields,
            kind: input.task.kind,
            profileId: input.profileId,
            comparisonId: input.comparisonId,
          });
      if (input.task.kind === 'backup' && input.task.encrypted && input.passphrase !== undefined) {
        store.secrets.set(passphraseRef(saved.id), input.passphrase);
      } else if (input.task.kind !== 'backup' || !input.task.encrypted) {
        store.secrets.delete(passphraseRef(saved.id).id);
      }
      services.scheduler?.reconcile(saved.id);
      return scheduleInfo(services, require(saved.id));
    },

    delete: ({ id }) => {
      store.schedules.delete(id);
      store.secrets.delete(passphraseRef(id).id);
      services.scheduler?.reconcile();
    },

    setEnabled: ({ id, enabled }) => {
      const schedule = require(id);
      if (schedule.enabled !== enabled) {
        store.schedules.update(id, { enabled, ...(enabled ? { nextRunAt: null } : {}) });
        services.scheduler?.reconcile(id);
      }
      return scheduleInfo(services, require(id));
    },

    runNow: ({ id }) => {
      require(id);
      try {
        return { runId: scheduler().runNow(id).id };
      } catch (error) {
        if (error instanceof JoineryError) throw error;
        throw new JoineryError({
          code: 'CONFLICT',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    runs: ({ id, limit }) => store.schedules.runs(id, limit ?? 50),

    events: (_input, { signal }) =>
      subscriptionStream<ScheduleEvent>(
        (listener) => services.scheduleEvents?.subscribe(listener) ?? (() => undefined),
        signal,
      ),
  };
}
