import type { ConnectionCheckResult } from '@querybara/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RedisSession } from '../../src';
import {
  REDIS_SENTINEL,
  REDIS_URL,
  adapter,
  cleanup,
  connect,
  dec,
  newPrefix,
  replies,
  sentinelProfile,
} from './helpers';

/** Connecting through Sentinel: master discovery, the same credentials, topology. */
describe.skipIf(!REDIS_SENTINEL || !REDIS_URL)('Sentinel', () => {
  let session: RedisSession;
  const p = newPrefix();

  beforeAll(async () => {
    session = await connect(sentinelProfile({ options: { defaultDatabase: '1' } }));
  });
  afterAll(async () => {
    await cleanup(session, p);
    await session?.close();
  });

  it('finds the master and works on it', async () => {
    expect(session.server).toMatchObject({
      topology: 'sentinel',
      role: 'master',
      clusterMode: false,
    });
    expect(session.database).toBe(1);
    expect(await replies(session, `set ${p}k v\nget ${p}k`)).toEqual(['OK', '"v"']);
    expect(dec((await session.getString(`${p}k`))!.bytes)).toBe('v');
    const root = await session.browse([]);
    expect(root.find((n) => n.name === 'db1')!.detail!['keys']).toBeGreaterThanOrEqual(1);
  });

  it('shows what the Sentinels report', async () => {
    const view = await session.topology();
    const masterName = REDIS_SENTINEL!.split('/')[1];
    expect(view.topology).toBe('sentinel');
    expect(view.sentinel!.masterName).toBe(masterName);
    const [, port] = new URL(process.env['QUERYBARA_TEST_REDIS_URL']!).host.split(':');
    expect(view.sentinel!.master).toMatchObject({ name: masterName, port: Number(port) });
    expect(view.sentinel!.master!.quorum).toBeGreaterThanOrEqual(1);
    expect(view.sentinel!.master!.flags).toContain('master');
    expect(view.sentinel!.replicas.length).toBeGreaterThanOrEqual(1);
    expect(view.sentinel!.sentinels[0]!.flags).toContain('myself');
    expect(view.nodes.some((n) => n.role === 'replica')).toBe(true);
  });

  it('fails with a hint for an unknown master name', async () => {
    const [address] = REDIS_SENTINEL!.split('/') as [string];
    const [host, port] = address.split(':') as [string, string];
    const resolved = sentinelProfile({
      endpoint: {
        kind: 'sentinel',
        sentinels: [{ host, port: Number(port) }],
        masterName: 'no-such-master',
      },
    });
    const error = await connect(resolved).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED' });
    expect((error as { message: string }).message).toMatch(/no-such-master/);
    expect((error as { hint: string }).hint).toMatch(/SENTINEL MASTERS/);
  });

  it('runs Test Connection against the Sentinels', async () => {
    const steps: ConnectionCheckResult[] = [];
    for await (const step of adapter.checkConnection(sentinelProfile())) steps.push(step);
    expect(steps.map((s) => s.status)).toEqual([
      'skipped',
      'ok',
      'skipped',
      'skipped',
      'ok',
      'ok',
      'ok',
    ]);
    expect(steps.at(-1)!.message).toMatch(/through Sentinel, master/);
  });
});
