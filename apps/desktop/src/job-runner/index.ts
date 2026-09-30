import type { ResolvedProfile } from '@joinery/core';
import {
  TransportManager,
  connectThroughTransport,
  needsTransport,
  tunnelledProfile,
} from '@joinery/tunnel';

import { loadAdapter } from '../connection-host/adapters';
import { HostKeyBridge } from '../connection-host/host-keys';
import type { RunnerToMain } from '../shared/job-protocol';
import { JobRunner, type JobSession } from './runner';

/**
 * Job runner entry (spec §3): an Electron utilityProcess main starts on demand for long jobs
 * (import, export, Run SQL File) and for the wizards' previews. Main talks to it over the
 * parent port with the validated protocol in shared/job-protocol. Nothing here logs profile
 * data or secrets.
 *
 * Each job opens its own driver session, through its own TransportManager when the profile has
 * an SSH tunnel or a proxy (spec §4). Host keys are checked by main, through a HostKeyBridge
 * that tags each question with the job asking.
 */

const parent = process.parentPort;
const bridges = new Set<HostKeyBridge>();

function send(message: RunnerToMain): void {
  parent.postMessage(message);
}

async function connect(resolved: ResolvedProfile, jobId: string): Promise<JobSession> {
  const adapter = await loadAdapter(resolved.profile.engine);
  if (!needsTransport(resolved.profile)) {
    const session = await adapter.connect(resolved);
    return { session, resolved, close: () => session.close() };
  }
  const bridge = new HostKeyBridge((message) => {
    if (message.type === 'host-key') send({ ...message, jobId });
  });
  bridges.add(bridge);
  const transports = new TransportManager({ hostKeyVerifier: bridge.verifier });
  const release = (): void => {
    transports.closeAll();
    bridges.delete(bridge);
  };
  try {
    const opened = await connectThroughTransport(adapter, resolved, transports);
    return {
      // Native tools reach the server through the same local end of the tunnel.
      resolved: opened.transport ? tunnelledProfile(resolved, opened.transport) : resolved,
      session: opened.session,
      close: async () => {
        try {
          await opened.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

const runner = new JobRunner({
  post: send,
  connect,
  hostKeyDecision: (message) => {
    for (const bridge of bridges) bridge.settle(message);
  },
  exit: () => process.exit(0),
});

parent.on('message', (event) => runner.handle(event.data));
