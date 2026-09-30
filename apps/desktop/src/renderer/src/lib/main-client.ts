import {
  connectionHostContract,
  createClient,
  fromDomPort,
  mainContract,
  type Client,
  type ConnectionHostContract,
  type MainContract,
} from '@joinery/ipc';

import { requestMainPort } from './ports';

/**
 * Typed RPC clients. The main contract runs over a MessagePort main hands to this page at
 * start-up; each connection host gets its own port (spec §3), so result rows never pass through
 * main.
 */

export type MainClient = Client<MainContract['shape']>;
export type HostClient = Client<ConnectionHostContract['shape']>;

let current: MainClient | undefined;

/** Connects to main once at start-up. */
export async function connectMain(): Promise<MainClient> {
  const port = await requestMainPort();
  current = createClient(fromDomPort(port), mainContract);
  return current;
}

/** The main-contract client; only valid after `connectMain` resolved. */
export function mainApi(): MainClient {
  if (!current) throw new Error('The main process is not connected yet');
  return current;
}

/** A client for a connection host on its own port. */
export function hostClient(port: MessagePort): HostClient {
  return createClient(fromDomPort(port), connectionHostContract);
}
