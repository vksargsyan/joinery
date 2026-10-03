import { MessageChannel } from 'node:worker_threads';

import { connectionProfileSchema, type ConnectionProfileInput } from '@querybara/core';
import { connectionHostContract, createClient, fromNodePort } from '@querybara/ipc';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../src/connection-host/host';
import { fakeRedisAdapter, type FakeRedisSession } from './fake-redis-session';
import { profileInput } from './helpers';

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

async function startHost(
  presentation: ConnectionProfileInput['presentation'] = {},
  options: { readonly cluster?: boolean } = {},
) {
  const adapter = fakeRedisAdapter(options);
  const profile = connectionProfileSchema.parse(
    profileInput({
      engine: 'redis',
      endpoint: { kind: 'host', host: 'localhost', port: 6379 },
      auth: { method: 'none' },
      presentation,
    }),
  );
  const host = new ConnectionHost(adapter, { profile, secrets: {} });
  await host.start();
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  const session = (): FakeRedisSession => adapter.sessions.at(-1)!;
  return { client, sessionId, session };
}

describe('the configuration editor in the host', () => {
  it('reads the configuration with secrets only marked as set', async () => {
    const { client, sessionId } = await startHost();
    expect(await client.redis.config.nodes({ sessionId })).toEqual([
      { address: '127.0.0.1:6379', role: 'primary' },
    ]);
    const snapshot = await client.redis.config.get({ sessionId });
    expect(snapshot.nodes[0]).toMatchObject({
      values: { 'maxmemory-policy': 'noeviction' },
      secrets: { requirepass: true },
    });
    expect(JSON.stringify(snapshot)).not.toContain('hunter2');
  });

  it('passes the node and replicas choice on to the session', async () => {
    const { client, sessionId, session } = await startHost({}, { cluster: true });
    await client.redis.config.get({ sessionId, node: '10.0.0.2:7001' });
    await client.redis.config.set({
      sessionId,
      changes: [{ name: 'hz', value: '20' }],
      replicas: true,
    });
    const calls = session().calls.filter((c) => c.method.startsWith('config'));
    expect(calls).toEqual([
      { method: 'configRead', args: [{ node: '10.0.0.2:7001' }] },
      { method: 'configApply', args: [[{ name: 'hz', value: '20' }], { replicas: true }] },
    ]);
  });

  it('runs a harmless CONFIG SET on a development profile without asking', async () => {
    const { client, sessionId, session } = await startHost();
    const result = await client.redis.config.set({
      sessionId,
      changes: [{ name: 'maxmemory-policy', value: 'allkeys-lru' }],
    });
    expect(result.nodes[0]!.parameters).toEqual([{ name: 'maxmemory-policy', applied: true }]);
    expect(session().config.get('maxmemory-policy')).toBe('allkeys-lru');
  });

  it('asks before parameters that can lock clients out, and before REWRITE and RESETSTAT', async () => {
    const { client, sessionId, session } = await startHost();
    const needs = { code: 'CONFIRMATION_REQUIRED' };
    await expect(
      client.redis.config.set({ sessionId, changes: [{ name: 'requirepass', value: 'new' }] }),
    ).rejects.toMatchObject({
      ...needs,
      message: expect.stringContaining('lock clients out'),
    });
    await expect(client.redis.config.rewrite({ sessionId })).rejects.toMatchObject(needs);
    await expect(client.redis.config.resetStat({ sessionId })).rejects.toMatchObject(needs);
    expect(session().calls.map((c) => c.method)).not.toContain('configRewrite');
    await client.redis.config.set({
      sessionId,
      changes: [{ name: 'requirepass', value: 'new' }],
      confirmed: true,
    });
    expect(session().config.get('requirepass')).toBe('new');
    expect(await client.redis.config.rewrite({ sessionId, confirmed: true })).toEqual([
      { node: '127.0.0.1:6379', ok: true },
    ]);
    expect(await client.redis.config.resetStat({ sessionId, confirmed: true })).toEqual([
      { node: '127.0.0.1:6379', ok: true },
    ]);
  });

  it('asks for every CONFIG SET on production and confirm-writes profiles', async () => {
    for (const presentation of [{ environment: 'production' as const }, { confirmWrites: true }]) {
      const { client, sessionId } = await startHost(presentation);
      const change = { sessionId, changes: [{ name: 'slowlog-max-len', value: '256' }] };
      await expect(client.redis.config.set(change)).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      });
      expect((await client.redis.config.set({ ...change, confirmed: true })).atomic).toBe(false);
    }
  });

  it('refuses every configuration change on a read-only profile', async () => {
    const { client, sessionId, session } = await startHost({ readOnly: true });
    const refused = { code: 'READ_ONLY' };
    await expect(
      client.redis.config.set({
        sessionId,
        changes: [{ name: 'slowlog-max-len', value: '256' }],
        confirmed: true,
      }),
    ).rejects.toMatchObject(refused);
    await expect(client.redis.config.rewrite({ sessionId, confirmed: true })).rejects.toMatchObject(
      refused,
    );
    await expect(
      client.redis.config.resetStat({ sessionId, confirmed: true }),
    ).rejects.toMatchObject(refused);
    await expect(
      client.redis.command({
        sessionId,
        args: ['CONFIG', 'SET', 'slowlog-max-len', '256'],
        confirmed: true,
      }),
    ).rejects.toMatchObject(refused);
    expect((await client.redis.config.get({ sessionId })).nodes).toHaveLength(1);
    expect(session().config.get('slowlog-max-len')).toBeUndefined();
  });

  it('applies the same rules to CONFIG typed in the CLI', async () => {
    const { client, sessionId } = await startHost();
    // Harmless: runs (the fake server does not know CONFIG and answers with an error reply).
    const harmless = await client.redis.command({
      sessionId,
      args: ['CONFIG', 'SET', 'slowlog-max-len', '256'],
    });
    expect(harmless.reply.type).toBe('error');
    await expect(
      client.redis.command({ sessionId, args: ['CONFIG', 'SET', 'port', '6380'] }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      client.redis.command({ sessionId, args: ['CONFIG', 'RESETSTAT'] }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });
});
