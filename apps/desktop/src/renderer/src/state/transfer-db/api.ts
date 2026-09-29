import { JoineryError } from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { create } from 'zustand';

import { mainApi } from '../../lib/main-client';
import { profileById } from '../data';
import { askSecrets, confirm } from '../dialogs';
import { showJobs, useJobs } from '../jobs';
import { invalidateMetadata } from '../metadata';
import type { TransferDbApi, TransferSource } from './wizard';

/**
 * Where the data transfer wizard is open (the explorer's "Transfer data to…"), and what it
 * asks of main. "Ask every time" secrets are asked for once per connection and kept by this
 * wizard only, for its inspections, plans and the job it starts.
 */

export const useTransferDbDialog = create<{ readonly source: TransferSource | undefined }>()(
  () => ({
    source: undefined,
  }),
);

export function openTransferDb(source: TransferSource): void {
  useTransferDbDialog.setState({ source });
}

export function closeTransferDb(): void {
  useTransferDbDialog.setState({ source: undefined });
}

/** Opens the wizard on a connection's objects (for the explorer menus). */
export function openTransferFrom(
  profile: Pick<StoredProfile, 'id'>,
  where: Omit<TransferSource, 'profileId'> = {},
): void {
  openTransferDb({ profileId: profile.id, ...where });
}

/** Runs `then` once the job has finished (at once when it already has). */
function whenFinished(jobId: string, then: () => void): void {
  const done = (): boolean => {
    const job = useJobs.getState().jobs[jobId];
    return job !== undefined && job.state !== 'running';
  };
  if (done()) {
    then();
    return;
  }
  const unsubscribe = useJobs.subscribe(() => {
    if (!done()) return;
    unsubscribe();
    then();
  });
}

/** The wizard's API over main, with its own secrets cache. */
export function transferDbApi(): TransferDbApi {
  const secrets = new Map<string, Record<string, string>>();
  const secretsFor = async (profileId: string): Promise<Record<string, string>> => {
    const known = secrets.get(profileId);
    if (known !== undefined) return known;
    const status = await mainApi().profiles.secretStatus({ profileId });
    let typed: Record<string, string> = {};
    if (status.missing.length > 0) {
      const profile = await profileById(profileId);
      const answer = await askSecrets(profile?.name ?? 'the connection', status.missing);
      if (answer === null) {
        throw new JoineryError({ code: 'CANCELLED', message: 'The password was not given' });
      }
      typed = answer;
    }
    secrets.set(profileId, typed);
    return typed;
  };
  const both = async (
    source: string,
    target: string,
  ): Promise<{ secrets?: Record<string, string> }> => {
    const all = { ...(await secretsFor(source)), ...(await secretsFor(target)) };
    return Object.keys(all).length > 0 ? { secrets: all } : {};
  };
  return {
    profiles: () => mainApi().profiles.list(),
    inspect: async (profileId, database, schema) => {
      const typed = await secretsFor(profileId);
      return mainApi().transferDb.inspect({
        profileId,
        ...(database !== undefined ? { database } : {}),
        ...(schema !== undefined ? { schema } : {}),
        ...(Object.keys(typed).length > 0 ? { secrets: typed } : {}),
      });
    },
    plan: async (job) =>
      mainApi().transferDb.plan({ job, ...(await both(job.profileId, job.target.profileId)) }),
    confirm: (options) => confirm(options),
    start: async (job) => {
      const extra = await both(job.profileId, job.target.profileId);
      const { jobId } = await mainApi().jobs.start({ job, ...extra });
      // The target's explorer, designers and autocomplete see the new tables.
      whenFinished(jobId, () => invalidateMetadata(job.target.profileId));
      showJobs(true, jobId);
      return jobId;
    },
  };
}
