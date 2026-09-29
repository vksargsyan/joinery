import { JoineryError, toErrorData, type ResolvedProfile } from '@joinery/core';
import { fromElectronPort } from '@joinery/ipc';

import { mainToHostSchema, type HostToMain } from '../shared/host-protocol';
import { loadAdapter } from './adapters';
import { ConnectionHost } from './host';

/**
 * Connection host entry (spec §3): an Electron utilityProcess started by main for one open
 * connection, or briefly for Test Connection. Main talks to it over the parent port with the
 * validated control protocol in shared/host-protocol; renderer RPC arrives on transferred
 * MessagePorts. Nothing here logs profile data or secrets.
 */

const parent = process.parentPort;
let host: ConnectionHost | undefined;
let busy = false;

function send(message: HostToMain): void {
  parent.postMessage(message);
}

async function connect(resolved: ResolvedProfile): Promise<void> {
  try {
    const adapter = await loadAdapter(resolved.profile.engine);
    const started = new ConnectionHost(adapter, resolved);
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
    if (!adapter.checkConnection) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: 'Test Connection is not available for this engine yet',
      });
    }
    for await (const result of adapter.checkConnection(resolved)) {
      send({ type: 'check-step', result });
    }
    send({ type: 'check-done' });
  } catch (error) {
    send({ type: 'failed', error: toErrorData(error) });
  }
}

async function shutdown(): Promise<void> {
  await host?.shutdown();
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
    case 'shutdown':
      void shutdown();
      return;
  }
});
