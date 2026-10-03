import { QuerybaraError } from '@querybara/core';
import type { ConnectionEvent, ServerInfo } from '@querybara/ipc';
import { create } from 'zustand';

import { errorMessage } from '../lib/errors';
import { hostClient, mainApi, type HostClient } from '../lib/main-client';
import { connectionPort } from '../lib/ports';
import { profileById } from './data';
import { askSecrets } from './dialogs';

/**
 * Open connections, one per profile (spec §3). Each holds a direct RPC client to its connection
 * host. When the host's port closes (the host crashed, or main restarted it) the connection is
 * marked lost; Reconnect asks main again and gets a fresh port. `generation` counts ports, so a
 * tab knows its session died with the old one.
 */

export type ConnectionStatus = 'connecting' | 'ready' | 'lost' | 'failed';

export interface LiveConnection {
  readonly profileId: string;
  readonly status: ConnectionStatus;
  readonly connectionId?: string;
  readonly host?: HostClient;
  readonly info?: ServerInfo;
  /** Why it is lost or failed, or the host's own state (restarting). */
  readonly error?: string;
  /** Main's view of the host, from connection events. */
  readonly hostState?: ConnectionEvent['state'];
  readonly generation: number;
}

interface ConnectionsState {
  readonly byProfile: Readonly<Record<string, LiveConnection>>;
}

export const useConnections = create<ConnectionsState>()(() => ({ byProfile: {} }));

function update(profileId: string, patch: Partial<LiveConnection>): void {
  useConnections.setState((state) => {
    const current = state.byProfile[profileId] ?? {
      profileId,
      status: 'connecting',
      generation: 0,
    };
    return { byProfile: { ...state.byProfile, [profileId]: { ...current, ...patch } } };
  });
}

function remove(profileId: string): void {
  useConnections.setState((state) => {
    const { [profileId]: _gone, ...rest } = state.byProfile;
    return { byProfile: rest };
  });
}

const inFlight = new Map<string, Promise<LiveConnection>>();

/**
 * The ready connection for a profile, connecting first if needed. Prompts for secrets main has no
 * value for ("ask every time", session secrets after a restart). Rejects with CANCELLED when the
 * user dismisses the prompt.
 */
export function connect(profileId: string): Promise<LiveConnection> {
  const current = useConnections.getState().byProfile[profileId];
  if (current?.status === 'ready' && current.host) return Promise.resolve(current);
  const running = inFlight.get(profileId);
  if (running) return running;
  const attempt = open(profileId).finally(() => inFlight.delete(profileId));
  inFlight.set(profileId, attempt);
  return attempt;
}

async function open(profileId: string): Promise<LiveConnection> {
  const previous = useConnections.getState().byProfile[profileId];
  const generation = (previous?.generation ?? 0) + 1;
  update(profileId, {
    status: 'connecting',
    error: undefined,
    generation: previous?.generation ?? 0,
  });
  try {
    const profile = await profileById(profileId);
    if (!profile)
      throw new QuerybaraError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
    const status = await mainApi().profiles.secretStatus({ profileId });
    let secrets: Record<string, string> | undefined;
    if (status.missing.length > 0) {
      const typed = await askSecrets(profile.name, status.missing);
      if (typed === null) throw new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' });
      secrets = typed;
    }
    const { connectionId } = await mainApi().openConnection({
      profileId,
      ...(secrets ? { secrets } : {}),
    });
    const port = await connectionPort(connectionId);
    const host = hostClient(port);
    const info = await host.serverInfo();
    port.addEventListener('close', () => {
      const now = useConnections.getState().byProfile[profileId];
      if (now?.host !== host) return;
      host.dispose();
      update(profileId, {
        status: 'lost',
        host: undefined,
        error: now.error ?? 'The connection host stopped',
      });
    });
    const ready: LiveConnection = {
      profileId,
      status: 'ready',
      connectionId,
      host,
      info,
      generation,
      hostState: 'ready',
    };
    update(profileId, { ...ready, error: undefined });
    return useConnections.getState().byProfile[profileId] ?? ready;
  } catch (error) {
    if (error instanceof QuerybaraError && error.code === 'CANCELLED') {
      if (previous) update(profileId, previous);
      else remove(profileId);
    } else {
      update(profileId, { status: 'failed', host: undefined, error: errorMessage(error) });
    }
    throw error;
  }
}

/** Closes the connection host and forgets the connection. */
export async function disconnect(profileId: string): Promise<void> {
  const current = useConnections.getState().byProfile[profileId];
  remove(profileId);
  current?.host?.dispose();
  if (current?.connectionId) {
    await mainApi().closeConnection({ connectionId: current.connectionId });
  }
}

/** Applies a supervisor event from main: shows restarts and failures of a host. */
export function applyConnectionEvent(event: ConnectionEvent): void {
  const current = useConnections.getState().byProfile[event.profileId];
  if (!current || (current.connectionId && current.connectionId !== event.connectionId)) return;
  switch (event.state) {
    case 'restarting':
      update(event.profileId, {
        hostState: 'restarting',
        error: `${event.message ?? 'The connection host stopped'}. Restarting it (attempt ${event.attempt ?? 1})…`,
      });
      return;
    case 'ready':
      update(event.profileId, {
        hostState: 'ready',
        ...(current.status === 'lost'
          ? {
              error:
                'The connection host restarted. Reconnect to continue; open transactions were rolled back.',
            }
          : {}),
      });
      return;
    case 'failed':
      update(event.profileId, {
        hostState: 'failed',
        ...(current.status === 'connecting'
          ? {}
          : { status: 'lost', error: event.message ?? 'The connection failed' }),
      });
      return;
    case 'closed':
      if (current.status !== 'connecting') {
        update(event.profileId, { hostState: 'closed', status: 'lost', host: undefined });
      }
      return;
    case 'connecting':
      return;
  }
}

/** Follows main's connection events for the life of the page. */
export async function watchConnectionEvents(): Promise<void> {
  for (;;) {
    try {
      for await (const event of mainApi().connectionEvents()) applyConnectionEvent(event);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
