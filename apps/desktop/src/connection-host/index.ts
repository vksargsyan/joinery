import { JoineryError, toErrorData, type ResolvedProfile } from '@joinery/core';
import { fromElectronPort } from '@joinery/ipc';
import {
  TransportManager,
  checkConnectionThroughTransport,
  connectThroughTransport,
} from '@joinery/tunnel';

import { mainToHostSchema, type HostRequest, type HostToMain } from '../shared/host-protocol';
import { loadAdapter } from './adapters';
import { ConnectionHost } from './host';
import { HostKeyBridge } from './host-keys';

/**
 * Connection host entry (spec §3): an Electron utilityProcess started by main for one open
 * connection, or briefly for Test Connection. Main talks to it over the parent port with the
 * validated control protocol in shared/host-protocol; renderer RPC arrives on transferred
 * MessagePorts. Nothing here logs profile data or secrets.
 *
 * Every session and every Test Connection goes through the process's TransportManager, which
 * opens the profile's SSH tunnel or proxy (spec §4) and shares one SSH session between the
 * sessions of this connection. Host keys are checked by main, through the HostKeyBridge.
 */

const parent = process.parentPort;
let host: ConnectionHost | undefined;
let busy = false;

function send(message: HostToMain): void {
  parent.postMessage(message);
}

const hostKeys = new HostKeyBridge(send);
/** Requests from main in flight, to cancel them. */
const requests = new Map<string, AbortController>();

async function runRequest(requestId: string, request: HostRequest): Promise<void> {
  const controller = new AbortController();
  requests.set(requestId, controller);
  try {
    if (!host) throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
    const result = await host.request(request, {
      signal: controller.signal,
      progress: (progress) => send({ type: 'request-progress', requestId, progress }),
    });
    send({ type: 'response', requestId, result });
  } catch (error) {
    send({ type: 'response', requestId, error: toErrorData(error) });
  } finally {
    requests.delete(requestId);
  }
}
const transports = new TransportManager({ hostKeyVerifier: hostKeys.verifier });

async function connect(resolved: ResolvedProfile): Promise<void> {
  try {
    const adapter = await loadAdapter(resolved.profile.engine);
    const started = new ConnectionHost(adapter, resolved, {
      open: (profile) => connectThroughTransport(adapter, profile, transports),
      // The tunnel dropped after `ready`: main restarts this host, which reopens it.
      onTransportLost: (error) => send({ type: 'failed', error: toErrorData(error) }),
    });
    const info = await started.start();
    host = started;
    send({ type: 'ready', info });
  } catch (error) {
    send({ type: 'failed', error: toErrorData(error) });
  }
}

async function check(resolved: ResolvedProfile): Promise<void> {
  try {
    const adapter = await loadAdapter(resolved.profile.engine);
    for await (const result of checkConnectionThroughTransport(adapter, resolved, transports)) {
      send({ type: 'check-step', result });
    }
    send({ type: 'check-done' });
  } catch (error) {
    send({ type: 'failed', error: toErrorData(error) });
  }
}

async function shutdown(): Promise<void> {
  await host?.shutdown();
  transports.closeAll();
  process.exit(0);
}

parent.on('message', (event) => {
  const parsed = mainToHostSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  switch (message.type) {
    case 'connect':
    case 'check':
      // One job per process: a second connect or check is a protocol error, ignored.
      if (busy) return;
      busy = true;
      void (message.type === 'connect' ? connect(message.resolved) : check(message.resolved));
      return;
    case 'attach': {
      const port = event.ports[0];
      if (!host || !port) {
        port?.close();
        return;
      }
      host.attach(fromElectronPort(port));
      return;
    }
    case 'host-key-decision':
      hostKeys.settle(message);
      return;
    case 'shutdown':
      void shutdown();
      return;
    case 'request':
      void runRequest(message.requestId, message.request);
      return;
    case 'cancel-request':
      requests.get(message.requestId)?.abort();
      return;
  }
});
