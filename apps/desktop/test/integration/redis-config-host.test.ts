import { MessageChannel } from 'node:worker_threads';

import { connectionProfileSchema, type ResolvedProfile } from '@joinery/core';
import { createRedisAdapter, redisProfileFromUrl } from '@joinery/driver-redis';
import { connectionHostContract, createClient, fromNodePort, type Client } from '@joinery/ipc';
import { buildConfigRows } from '@joinery/redis-tools';
import { afterAll, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../../src/connection-host/host';

/**
 * The configuration editor's host services against the real servers (spec §15): CONFIG GET with
 * secrets masked, CONFIG SET under the write rules (a production profile asks, a read-only one
 * refuses) with the original value restored, and every Cluster primary read at once.
 */

const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];
const REDIS_CLUSTER = process.env['JOINERY_TEST_REDIS_CLUSTER'];

type HostClient = Client<(typeof connectionHostContract)['shape']>;

const channels: MessageChannel[] = [];
const hosts: ConnectionHost[] = [];

async function open(resolved: ResolvedProfile): Promise<{ client: HostClient; sessionId: string }> {
  const host = new ConnectionHost(createRedisAdapter(), resolved);
  await host.start();
  hosts.push(host);
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { client, sessionId };
}

afterAll(async () => {
  await Promise.all(hosts.map((h) => h.shutdown()));
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

function withPresentation(presentation: Record<string, unknown>): ResolvedProfile {
  const resolved = redisProfileFromUrl(REDIS_URL!);
  return {
    ...resolved,
    profile: connectionProfileSchema.parse({ ...resolved.profile, presentation }),
  };
}

describe.skipIf(!REDIS_URL)('redis configuration through the host', () => {
  it('reads the configuration without secret values', async () => {
    const { client, sessionId } = await open(redisProfileFromUrl(REDIS_URL!));
    const snapshot = await client.redis.config.get({ sessionId });
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]!.secrets['requirepass']).toBe(true);
    expect(snapshot.nodes[0]!.values['requirepass']).toBeUndefined();
    const rows = buildConfigRows(snapshot.nodes);
    expect(rows.find((r) => r.name === 'maxmemory-policy')?.group).toBe('memory');
  });

  it('asks on production, refuses on read-only, and restores the value', async () => {
    const production = await open(withPresentation({ environment: 'production' }));
    const read = async (): Promise<string> =>
      (await production.client.redis.config.get({ sessionId: production.sessionId })).nodes[0]!
        .values['lfu-decay-time']!;
    const originalDecay = await read();
    const change = {
      sessionId: production.sessionId,
      changes: [{ name: 'lfu-decay-time', value: String(Number(originalDecay) + 1) }],
    };
    await expect(production.client.redis.config.set(change)).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    try {
      const result = await production.client.redis.config.set({ ...change, confirmed: true });
      expect(result.nodes[0]!.parameters).toEqual([{ name: 'lfu-decay-time', applied: true }]);
      expect(await read()).toBe(String(Number(originalDecay) + 1));
    } finally {
      await production.client.redis.config.set({
        sessionId: production.sessionId,
        changes: [{ name: 'lfu-decay-time', value: originalDecay }],
        confirmed: true,
      });
    }
    expect(await read()).toBe(originalDecay);

    const readOnly = await open(withPresentation({ readOnly: true }));
    await expect(
      readOnly.client.redis.config.set({
        sessionId: readOnly.sessionId,
        changes: [{ name: 'lfu-decay-time', value: '1' }],
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(await read()).toBe(originalDecay);
  });
});

describe.skipIf(!REDIS_URL || !REDIS_CLUSTER)(
  'redis configuration through the host (Cluster)',
  () => {
    it('reads every primary by default and one node on request', async () => {
      const password = decodeURIComponent(new URL(REDIS_URL!).password) || undefined;
      const now = new Date().toISOString();
      const profile = connectionProfileSchema.parse({
        id: 'cluster',
        name: 'Cluster',
        engine: 'redis',
        endpoint: {
          kind: 'cluster',
          seeds: REDIS_CLUSTER!.split(',').map((seed) => {
            const [host, port] = seed.trim().split(':') as [string, string];
            return { host, port: Number(port) };
          }),
        },
        auth: password ? { method: 'password', password: { id: 'password' } } : { method: 'none' },
        tls: { mode: 'disable' },
        createdAt: now,
        updatedAt: now,
      });
      const { client, sessionId } = await open({
        profile,
        secrets: password ? { password } : {},
      });
      const nodes = await client.redis.config.nodes({ sessionId });
      const primaries = nodes.filter((n) => n.role === 'primary').map((n) => n.address);
      expect(primaries.length).toBeGreaterThanOrEqual(3);
      const all = await client.redis.config.get({ sessionId });
      expect(all.nodes.map((n) => n.node)).toEqual(primaries);
      const one = await client.redis.config.get({ sessionId, node: primaries[2]! });
      expect(one.nodes.map((n) => n.node)).toEqual([primaries[2]]);
    });
  },
);
