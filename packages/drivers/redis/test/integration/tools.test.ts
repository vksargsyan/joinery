import type { ConnectionCheckResult } from '@joinery/core';
import { infoMetrics, parseKeyspace } from '@joinery/redis-tools';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MonitorEvent, PubSubMessage, RedisSession } from '../../src';
import {
  REDIS_URL,
  adapter,
  cleanup,
  connect,
  dec,
  enc,
  newPrefix,
  sleep,
  standaloneAddress,
  standaloneProfile,
} from './helpers';

async function take<T>(
  iterable: AsyncIterable<T>,
  count: number,
  match: (item: T) => boolean,
  timeoutMs = 5000,
): Promise<T[]> {
  const out: T[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (out.length < count) {
    const next = await Promise.race([
      iterator.next(),
      sleep(Math.max(0, deadline - Date.now())).then(() => 'timeout' as const),
    ]);
    if (next === 'timeout') throw new Error(`Timed out after ${out.length} of ${count} items`);
    if (next.done) break;
    if (match(next.value)) out.push(next.value);
  }
  return out;
}

async function steps(
  resolved: ReturnType<typeof standaloneProfile>,
): Promise<ConnectionCheckResult[]> {
  const out: ConnectionCheckResult[] = [];
  for await (const step of adapter.checkConnection(resolved)) out.push(step);
  return out;
}

/** Server tools on the standalone server (spec §10, §15). */
describe.skipIf(!REDIS_URL)('server tools (standalone)', () => {
  let session: RedisSession;
  let p: string;

  beforeAll(async () => {
    session = await connect(standaloneProfile());
  });
  afterAll(async () => {
    await session?.close();
  });
  beforeEach(() => {
    p = newPrefix();
  });
  afterEach(async () => {
    await cleanup(session, p);
  });

  it('describes the server and its capabilities', () => {
    expect(session.engine).toBe('redis');
    expect(session.server).toMatchObject({
      flavor: expect.stringMatching(/^(redis|valkey)$/),
      topology: 'standalone',
      role: 'master',
      databases: 16,
      databasesExact: true,
      clusterMode: false,
    });
    expect(session.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(session.capabilities()).toMatchObject({ clusterMode: false, queryCancel: true });
    expect(session.nodes()).toEqual([
      expect.objectContaining({ address: standaloneAddress(), role: 'primary' }),
    ]);
    expect(session.keyDelimiter).toBe(':');
  });

  it('parses INFO, CONFIG and the dashboard metrics', async () => {
    await session.setString(`${p}k`, 'v');
    const info = await session.info();
    expect(info['server']!['tcp_port']).toBe(standaloneAddress().split(':')[1]);
    expect(parseKeyspace(info).find((k) => k.db === 0)!.keys).toBeGreaterThan(0);
    expect(infoMetrics(info).usedMemory).toBeGreaterThan(0);
    expect(Object.keys(await session.info({ section: 'memory' }))).toEqual(['memory']);
    expect((await session.infoAll())[0]!.node).toBe(standaloneAddress());
    const config = await session.configGet('maxmemory*');
    expect(config.denied).toBe(false);
    expect(config.values['maxmemory-policy']).toBeDefined();
    expect(await session.dbSize()).toBeGreaterThan(0);
  });

  it('reads and sets the latency monitor threshold, and reads latency data', async () => {
    const original = await session.latencyMonitorThreshold();
    expect(original).not.toBeNull();
    try {
      await session.setLatencyMonitorThreshold(100);
      expect(await session.latencyMonitorThreshold()).toBe(100);
    } finally {
      await session.setLatencyMonitorThreshold(original!);
    }
    expect(Array.isArray(await session.latencyLatest())).toBe(true);
    expect(Array.isArray(await session.latencyHistory('command'))).toBe(true);
    expect(await session.latencyDoctor()).toMatch(/\w/);
    expect(await session.memoryDoctor()).toMatch(/\w/);
  });

  it('shows slow commands in the slow log', async () => {
    const marker = `${p}slow`;
    // Log every command for the moment, so a marked command lands in the slow log without being
    // slow: a busy script would block the whole server for the suites running beside this one
    // (and scripts see a frozen clock on newer servers). A longer log keeps the entry from being
    // pushed out by those suites' commands.
    const settings = ['slowlog-log-slower-than', 'slowlog-max-len'] as const;
    const original = await Promise.all(
      settings.map(async (name) => (await session.configGet(name)).values[name]),
    );
    await session.command(['CONFIG', 'SET', settings[0], '0', settings[1], '100000']);
    try {
      await session.command(['ECHO', marker]);
      const entries = await session.slowlogGet(100_000);
      const entry = entries.find((e) => e.args.some((a) => dec(a)!.includes(marker)));
      expect(entry).toBeDefined();
      expect(entry!.durationMicros).toBeGreaterThanOrEqual(0);
      expect(dec(entry!.args[0]!)!.toLowerCase()).toBe('echo');
      expect(entry!.clientName).toBe('Joinery');
      expect(await session.slowlogLength()).toBeGreaterThan(0);
    } finally {
      await session.command([
        'CONFIG',
        'SET',
        settings[0],
        original[0] ?? '10000',
        settings[1],
        original[1] ?? '128',
      ]);
    }
  });

  it('lists and kills clients', async () => {
    const victim = await connect(
      standaloneProfile({ options: { applicationName: 'Joinery victim' } }),
    );
    try {
      const clients = await session.clientList();
      const target = clients.find((c) => c.name === 'Joinery-victim');
      expect(target).toBeDefined();
      expect(clients.some((c) => c.name === 'Joinery' && c.cmd === 'client|list')).toBe(true);
      expect(await session.clientKill(target!.id)).toBe(true);
      expect(await session.clientKill(target!.id)).toBe(false);
      expect((await session.clientList({ type: 'replica' })).length).toBeGreaterThanOrEqual(1);
    } finally {
      await victim.close();
    }
  });

  it('subscribes to channels and patterns on its own connection', async () => {
    const subscription = await session.subscribe({
      channels: [`${p}news`],
      patterns: [`${p}ev:*`],
    });
    try {
      expect((await session.pubsubNumSub([`${p}news`]))[0]).toEqual({
        channel: enc(`${p}news`),
        subscribers: 1,
      });
      expect(await session.pubsubNumPat()).toBeGreaterThanOrEqual(1);
      expect((await session.pubsubChannels(`${p}*`)).map(dec)).toEqual([`${p}news`]);
      expect(await session.publish(`${p}news`, Uint8Array.of(0xff, 0x00))).toBe(1);
      expect(await session.publish(`${p}ev:1`, 'hello')).toBe(1);
      const messages: PubSubMessage[] = await take(subscription, 2, () => true);
      expect(messages[0]).toMatchObject({
        kind: 'message',
        channel: enc(`${p}news`),
        message: Uint8Array.of(0xff, 0x00),
        dropped: 0,
      });
      expect(messages[1]).toMatchObject({
        kind: 'pmessage',
        pattern: enc(`${p}ev:*`),
        channel: enc(`${p}ev:1`),
        message: enc('hello'),
      });
      // The session itself is still free for commands.
      expect(await session.command(['PING'])).toEqual({ type: 'status', value: 'PONG' });
    } finally {
      await subscription.close();
    }
    await sleep(100);
    expect((await session.pubsubNumSub([`${p}news`]))[0]!.subscribers).toBe(0);
  });

  it('streams MONITOR output until closed', async () => {
    const stream = await session.monitor();
    try {
      const key = new Uint8Array([...enc(`${p}mon`), 0xff, 0x22]);
      await session.getString(key);
      const events: MonitorEvent[] = await take(stream, 1, (e) =>
        e.args.some(
          (a) => a.length === key.length && dec(a.subarray(0, p.length)) === p && a.at(-1) === 0x22,
        ),
      );
      expect(events[0]!.args.map((a) => [...a])).toContainEqual([...key]);
      expect(events[0]!.db).toBe(0);
      expect(events[0]!.node).toBe(standaloneAddress());
    } finally {
      await stream.close();
    }
  });

  it('starts MONITOR while the server is busy', async () => {
    // Monitor lines can arrive in the same read as MONITOR's OK; that must neither fail the
    // start nor surface as an unhandled error. Keep another connection busy and start often.
    const busy = await connect(standaloneProfile());
    let running = true;
    const traffic = (async () => {
      while (running) await busy.command(['EXISTS', `${p}busy`]);
    })();
    try {
      for (let i = 0; i < 20; i += 1) {
        const stream = await session.monitor();
        await stream.close();
      }
    } finally {
      running = false;
      await traffic;
      await busy.close();
    }
  });

  it('reads ACL users, categories and the log', async () => {
    expect(await session.aclWhoAmI()).toBe('default');
    expect(await session.aclUsers()).toEqual(expect.arrayContaining(['default', 'app']));
    expect((await session.aclList()).some((line) => line.startsWith('user app on'))).toBe(true);
    expect(await session.aclGetUser('app')).toMatchObject({
      keys: '~app:*',
      commands: '+@all -@dangerous',
      flags: expect.arrayContaining(['on']),
    });
    expect(await session.aclGetUser('nobody-here')).toBeNull();
    expect(await session.aclCategories()).toContain('dangerous');
    expect(await session.aclCategories('dangerous')).toContain('flushall');
    expect(Array.isArray(await session.aclLog(5))).toBe(true);
  });

  it('creates, edits and deletes an ACL user', async () => {
    const name = `joinery-it-${p.split(':')[2]}`;
    try {
      await session.aclSetUser(name, ['on', '>s3cret', '~tmp:*', '+get']);
      expect(await session.aclGetUser(name)).toMatchObject({
        keys: '~tmp:*',
        flags: expect.arrayContaining(['on']),
      });
    } finally {
      expect(await session.aclDelUser([name])).toBe(1);
    }
  });

  it('reports big keys grouped by pattern', async () => {
    for (let i = 0; i < 20; i++)
      await session.setString(`${p}user:${i}:bio`, 'x'.repeat(100 + i * 50));
    await session.listPush(
      `${p}queue:big`,
      Array.from({ length: 500 }, (_, i) => `item-${i}`),
    );
    const progress: number[] = [];
    const report = await session.bigKeys({
      match: `${p}*`,
      sampleSize: 1000,
      top: 3,
      onProgress: (e) => progress.push(e.sampled),
    });
    expect(report.sampled).toBe(21);
    expect(report.complete).toBe(true);
    expect(report.memoryDenied).toBe(false);
    expect(dec(report.largest[0]!.key)).toBe(`${p}queue:big`);
    expect(report.largest[0]).toMatchObject({ type: 'list', length: 500 });
    const users = report.patterns.find((s) => s.pattern.endsWith(':user:*:bio'))!;
    expect(users.count).toBe(20);
    expect(users.types).toEqual({ string: 20 });
    expect(report.sampledBytes).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);
    const cancelled = await session.bigKeys({ match: `${p}*`, signal: AbortSignal.abort() });
    expect(cancelled).toMatchObject({ cancelled: true, sampled: 0 });
  });

  it('shows the replication topology', async () => {
    const view = await session.topology();
    expect(view.topology).toBe('standalone');
    expect(view.nodes[0]).toMatchObject({
      role: 'primary',
      myself: true,
      port: Number(standaloneAddress().split(':')[1]),
    });
    // The test servers run one replica of the standalone server.
    expect(view.nodes.some((n) => n.role === 'replica' && n.primaryId === view.nodes[0]!.id)).toBe(
      true,
    );
  });

  it('runs keyless commands on every node', async () => {
    const replies = await session.commandAll(['DBSIZE']);
    expect(replies).toEqual([
      { node: standaloneAddress(), reply: { type: 'integer', value: expect.any(Number) } },
    ]);
  });

  it('returns an empty schema snapshot', async () => {
    expect(await session.introspect()).toMatchObject({
      engine: 'redis',
      database: 'db0',
      schemas: [],
    });
  });

  it('runs Test Connection step by step', async () => {
    const ok = await steps(standaloneProfile());
    expect(ok.map((s) => [s.step, s.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(ok.at(-1)!.message).toMatch(/^(Redis|Valkey) \d+\.\d+\.\d+ \(master\)$/);

    const url = new URL(REDIS_URL!);
    url.password = 'wrong';
    const { redisProfileFromUrl } = await import('../../src');
    const bad = await steps(redisProfileFromUrl(url.toString()));
    const auth = bad.find((s) => s.step === 'auth')!;
    expect(auth.status).toBe('failed');
    expect(auth.message).toMatch(/rejected the user name or password/);
    expect(auth.hint).toMatch(/password/);
    expect(bad.filter((s) => s.status === 'skipped').map((s) => s.step)).toEqual([
      'dns',
      'ssh',
      'tls',
      'ping',
      'version',
    ]);

    url.password = '';
    url.username = '';
    const anonymous = await steps(redisProfileFromUrl(url.toString()));
    expect(anonymous.find((s) => s.step === 'auth')).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/requires authentication/),
    });

    url.port = '1';
    const refused = await steps(redisProfileFromUrl(url.toString()));
    expect(refused.find((s) => s.step === 'tcp')).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/refused/),
    });
  });
});

describe.skipIf(!REDIS_URL)('logical database on connect', () => {
  it('refuses a database the server does not have', async () => {
    const error = await connect(standaloneProfile({ options: { defaultDatabase: '99' } })).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Database 99 does not exist on this server',
    });
  });
});
