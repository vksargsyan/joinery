import { MessageChannel } from 'node:worker_threads';

import type { ResolvedProfile } from '@joinery/core';
import { redisProfileFromUrl } from '@joinery/driver-redis';
import { connectionHostContract, createClient, fromNodePort } from '@joinery/ipc';
import {
  MemoryKnownHosts,
  TransportManager,
  checkConnectionThroughTransport,
  connectThroughTransport,
  knownHostsVerifier,
} from '@joinery/tunnel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { ConnectionHost } from '../../src/connection-host/host';
import { startSshServer, type TestSshServer } from '../ssh-server';

/**
 * Redis through an SSH tunnel, as the connection host runs it (spec §4): Test Connection with
 * the SSH step opened through the process's TransportManager and the later steps through the
 * tunnel, and a host whose Redis sessions go through the tunnel.
 */

const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];

let ssh: TestSshServer;
const channels: MessageChannel[] = [];

beforeAll(async () => {
  ssh = await startSshServer({ user: 'tunnel', password: 'bastion-pw' });
});

afterAll(async () => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  await ssh?.close();
});

function tunnelled(): ResolvedProfile {
  const resolved = redisProfileFromUrl(REDIS_URL!, {
    ssh: {
      hops: [
        {
          host: '127.0.0.1',
          port: ssh.port,
          user: 'tunnel',
          auth: { method: 'password', password: { id: 'ssh-pw', policy: 'save' } },
        },
      ],
    },
  });
  return { ...resolved, secrets: { ...resolved.secrets, 'ssh-pw': 'bastion-pw' } };
}

function manager(): TransportManager {
  return new TransportManager({
    hostKeyVerifier: knownHostsVerifier(new MemoryKnownHosts(), 'accept-new'),
  });
}

describe.skipIf(!REDIS_URL)('redis through an SSH tunnel', () => {
  it('runs Test Connection with the SSH step and the later steps through the tunnel', async () => {
    const adapter = await loadAdapter('redis');
    const transports = manager();
    const forwards = ssh.stats.forwards;
    const steps = [];
    for await (const step of checkConnectionThroughTransport(adapter, tunnelled(), transports)) {
      steps.push(step);
    }
    transports.closeAll();
    const byStep = Object.fromEntries(steps.map((s) => [s.step, s.status]));
    expect(byStep).toMatchObject({ ssh: 'ok', auth: 'ok', ping: 'ok', version: 'ok' });
    expect(steps.find((s) => s.status === 'failed')).toBeUndefined();
    expect(ssh.stats.forwards).toBeGreaterThan(forwards);
  });

  it('names the SSH step when the tunnel cannot open', async () => {
    const adapter = await loadAdapter('redis');
    const transports = manager();
    const wrong = tunnelled();
    const steps = [];
    for await (const step of checkConnectionThroughTransport(
      adapter,
      { ...wrong, secrets: { ...wrong.secrets, 'ssh-pw': 'wrong' } },
      transports,
    )) {
      steps.push(step);
    }
    transports.closeAll();
    expect(steps.find((s) => s.status === 'failed')?.step).toBe('ssh');
  });

  it('serves Redis sessions through the tunnel', async () => {
    const adapter = await loadAdapter('redis');
    const transports = manager();
    const host = new ConnectionHost(adapter, tunnelled(), {
      open: (profile) => connectThroughTransport(adapter, profile, transports),
    });
    const info = await host.start();
    expect(info.engine).toBe('redis');
    const channel = new MessageChannel();
    channels.push(channel);
    host.attach(fromNodePort(channel.port2));
    const client = createClient(fromNodePort(channel.port1), connectionHostContract);
    const { sessionId } = await client.openSession({});
    const reply = await client.redis.command({ sessionId, args: ['PING'] });
    expect(reply.reply).toEqual({ type: 'status', value: 'PONG' });
    await host.shutdown();
    transports.closeAll();
  });
});
