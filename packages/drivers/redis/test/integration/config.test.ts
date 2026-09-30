import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JoineryError } from '@joinery/core';
import { buildConfigRows, infoField } from '@joinery/redis-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisProfileFromUrl, type RedisSession } from '../../src';
import {
  REDIS_ACL_USER,
  REDIS_CLUSTER,
  REDIS_SENTINEL,
  REDIS_URL,
  aclProfile,
  clusterProfile,
  connect,
  sentinelProfile,
  sleep,
  standaloneAddress,
  standaloneProfile,
} from './helpers';

/**
 * The configuration editor's service (spec §15) on real servers. Only harmless parameters are
 * changed on the shared servers (the eviction policy with no memory limit, the LFU factors), and
 * always restored; CONFIG REWRITE and RESETSTAT run on a private server the test starts, so the
 * shared servers' files and statistics stay as they are.
 */

/** A parameter's value on each node, read directly. */
async function valueOf(session: RedisSession, name: string, node?: string): Promise<string> {
  return (await session.configGet(name, node === undefined ? {} : { node })).values[name] ?? '';
}

describe.skipIf(!REDIS_URL)('configuration (standalone)', () => {
  let session: RedisSession;

  beforeAll(async () => {
    session = await connect(standaloneProfile());
  });
  afterAll(async () => {
    await session?.close();
  });

  it('reads every parameter with the secrets masked', async () => {
    expect(await session.configNodes()).toEqual([
      { address: standaloneAddress(), role: 'primary' },
    ]);
    const snapshot = await session.configRead();
    expect(snapshot.multiSet).toBe(true);
    expect(snapshot.nodes).toHaveLength(1);
    const [node] = snapshot.nodes;
    expect(node).toMatchObject({ node: standaloneAddress(), role: 'primary' });
    expect(Object.keys(node!.values).length).toBeGreaterThan(100);
    expect(node!.values['maxmemory-policy']).toMatch(/\w/);
    // The test server has a password: it is reported as set, never read out.
    expect(node!.secrets['requirepass']).toBe(true);
    expect(node!.values['requirepass']).toBeUndefined();
    expect(Object.values(node!.values)).not.toContain(new URL(REDIS_URL!).password);
    expect(node!.values['masterauth']).toBeUndefined();
    const rows = buildConfigRows(snapshot.nodes);
    expect(rows.find((r) => r.name === 'requirepass')).toMatchObject({
      secret: true,
      secretSet: true,
    });
    // Aliases the server lists beside the canonical name are folded into one row.
    expect(rows.some((r) => r.name === 'slave-read-only')).toBe(false);
  });

  it('changes two parameters in one call, then restores them', async () => {
    const policy = await valueOf(session, 'maxmemory-policy');
    const factor = await valueOf(session, 'lfu-log-factor');
    try {
      const result = await session.configApply([
        { name: 'maxmemory-policy', value: 'allkeys-lfu' },
        { name: 'lfu-log-factor', value: String(Number(factor) + 1) },
      ]);
      expect(result).toEqual({
        atomic: true,
        nodes: [
          {
            node: standaloneAddress(),
            parameters: [
              { name: 'maxmemory-policy', applied: true },
              { name: 'lfu-log-factor', applied: true },
            ],
          },
        ],
      });
      expect(await valueOf(session, 'maxmemory-policy')).toBe('allkeys-lfu');
      expect(await valueOf(session, 'lfu-log-factor')).toBe(String(Number(factor) + 1));
    } finally {
      await session.configApply([
        { name: 'maxmemory-policy', value: policy },
        { name: 'lfu-log-factor', value: factor },
      ]);
    }
    expect(await valueOf(session, 'maxmemory-policy')).toBe(policy);
  });

  it('reports the refused parameter and applies none of an all-or-nothing call', async () => {
    const factor = await valueOf(session, 'lfu-log-factor');
    const result = await session.configApply([
      { name: 'lfu-log-factor', value: String(Number(factor) + 2) },
      { name: 'maxmemory-policy', value: 'sometimes' },
    ]);
    const [lfu, policy] = result.nodes[0]!.parameters;
    expect(policy).toMatchObject({ name: 'maxmemory-policy', applied: false });
    expect(policy!.error).toMatch(/maxmemory-policy/);
    expect(lfu).toMatchObject({ name: 'lfu-log-factor', applied: false });
    expect(lfu!.error).toMatch(/all or none/);
    expect(await valueOf(session, 'lfu-log-factor')).toBe(factor);
  });

  it('refuses a parameter that is set at startup only', async () => {
    const result = await session.configApply([{ name: 'databases', value: '16' }]);
    expect(result.nodes[0]!.parameters[0]).toMatchObject({ applied: false });
    expect(result.nodes[0]!.parameters[0]!.error).toMatch(/immutable/i);
  });

  it('knows only the server it is connected to', async () => {
    await expect(session.configRead({ node: '10.9.9.9:6379' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      session.configApply([
        { name: 'lfu-log-factor', value: '1' },
        { name: 'LFU-log-factor', value: '2' },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('explains a missing configuration file on CONFIG REWRITE', async () => {
    const info = await session.info({ section: 'server' });
    // Only where it fails harmlessly: a shared server started from a file keeps its file as is.
    if (infoField(info, 'config_file')) return;
    const [outcome] = await session.configRewrite();
    expect(outcome).toMatchObject({ node: standaloneAddress(), ok: false });
    expect(outcome!.error).toMatch(/without a configuration file/);
  });
});

describe.skipIf(!REDIS_URL || !REDIS_ACL_USER)('configuration as a restricted ACL user', () => {
  let app: RedisSession;

  beforeAll(async () => {
    app = await connect(aclProfile());
  });
  afterAll(async () => {
    await app?.close();
  });

  it('fails with a permission error the page can explain', async () => {
    const error = await app.configRead().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JoineryError);
    expect(error).toMatchObject({ code: 'NOT_SUPPORTED', engineCode: 'NOPERM' });
    expect((error as JoineryError).hint).toMatch(/\+config\|get/);
    await expect(app.configApply([{ name: 'lfu-log-factor', value: '10' }])).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      engineCode: 'NOPERM',
    });
    await expect(app.configResetStat()).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      message: expect.stringContaining('RESETSTAT'),
    });
  });
});

describe.skipIf(!REDIS_URL || !REDIS_CLUSTER)('configuration (Cluster)', () => {
  let session: RedisSession;
  let primaries: string[];

  beforeAll(async () => {
    session = await connect(clusterProfile());
    primaries = session.nodes().map((n) => n.address);
  });
  afterAll(async () => {
    await session?.close();
  });

  it('reads every primary and shows where one node differs', async () => {
    expect((await session.configNodes()).filter((n) => n.role === 'primary')).toHaveLength(
      primaries.length,
    );
    const target = primaries[1]!;
    const factor = await valueOf(session, 'lfu-decay-time', target);
    try {
      const applied = await session.configApply(
        [{ name: 'lfu-decay-time', value: String(Number(factor) + 3) }],
        { node: target },
      );
      expect(applied).toEqual({
        atomic: false,
        nodes: [{ node: target, parameters: [{ name: 'lfu-decay-time', applied: true }] }],
      });
      const snapshot = await session.configRead();
      expect(snapshot.nodes.map((n) => n.node)).toEqual(primaries);
      const row = buildConfigRows(snapshot.nodes).find((r) => r.name === 'lfu-decay-time')!;
      expect(row.differs).toBe(true);
      expect(row.value).toBeUndefined();
      expect(row.byNode.find((n) => n.node === target)!.value).toBe(String(Number(factor) + 3));
      const one = await session.configRead({ node: target });
      expect(one.nodes.map((n) => n.node)).toEqual([target]);
    } finally {
      await session.configApply([{ name: 'lfu-decay-time', value: factor }]);
    }
    for (const node of primaries)
      expect(await valueOf(session, 'lfu-decay-time', node)).toBe(factor);
  });
});

describe.skipIf(!REDIS_URL || !REDIS_SENTINEL)('configuration (Sentinel)', () => {
  let session: RedisSession;

  beforeAll(async () => {
    session = await connect(sentinelProfile());
  });
  afterAll(async () => {
    await session?.close();
  });

  it('reads the master and a replica the Sentinels report', async () => {
    const nodes = await session.configNodes();
    expect(nodes[0]!.role).toBe('primary');
    const replica = nodes.find((n) => n.role === 'replica');
    expect(replica).toBeDefined();
    const master = await session.configRead();
    expect(master.nodes[0]!.role).toBe('primary');
    const snapshot = await session.configRead({ node: replica!.address });
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({ node: replica!.address, role: 'replica' });
    const replicaOf =
      snapshot.nodes[0]!.values['replicaof'] ?? snapshot.nodes[0]!.values['slaveof'];
    expect(replicaOf).toMatch(/\d+$/);
    await expect(session.configRead({ node: '127.0.0.1:1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------------------------

const REDIS_SERVER = ['redis-server', 'valkey-server'].find(
  (bin) => spawnSync(bin, ['--version']).status === 0,
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Starts a throwaway server; stopped (and its directory removed) by the returned function. */
async function privateServer(
  withFile: boolean,
): Promise<{ url: string; dir: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'joinery-config-'));
  const settings = ['port', String(port), 'bind', '127.0.0.1', 'save', '', 'dir', dir];
  let args: string[];
  if (withFile) {
    const file = join(dir, 'redis.conf');
    writeFileSync(file, `port ${port}\nbind 127.0.0.1\nsave ""\ndir ${dir}\n`);
    args = [file];
  } else {
    args = settings.map((s, i) => (i % 2 === 0 ? `--${s}` : s));
  }
  const child: ChildProcess = spawn(REDIS_SERVER!, args, { stdio: 'ignore' });
  const url = `redis://127.0.0.1:${port}/0`;
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const probe = await connect(redisProfileFromUrl(url));
      await probe.close();
      return { url, dir, stop };
    } catch {
      await sleep(100);
    }
  }
  await stop();
  throw new Error(`${REDIS_SERVER} did not start on port ${port}`);
}

describe.skipIf(!REDIS_SERVER)('CONFIG REWRITE and RESETSTAT (private server)', () => {
  const stops: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const stop of stops) await stop();
  });

  it('rewrites the configuration file with the running values', async () => {
    const server = await privateServer(true);
    stops.push(server.stop);
    const session = await connect(redisProfileFromUrl(server.url));
    try {
      await session.configApply([{ name: 'maxmemory-policy', value: 'allkeys-lru' }]);
      const [outcome] = await session.configRewrite();
      expect(outcome).toEqual({ node: session.nodes()[0]!.address, ok: true });
      expect(readFileSync(join(server.dir, 'redis.conf'), 'utf8')).toMatch(
        /^maxmemory-policy allkeys-lru$/m,
      );
    } finally {
      await session.close();
    }
  });

  it('resets the statistics', async () => {
    const server = await privateServer(false);
    stops.push(server.stop);
    const session = await connect(redisProfileFromUrl(server.url));
    try {
      for (let i = 0; i < 20; i++) await session.ping();
      const before = Number(infoField(await session.info(), 'total_commands_processed'));
      expect(before).toBeGreaterThan(20);
      expect(await session.configResetStat()).toEqual([
        { node: session.nodes()[0]!.address, ok: true },
      ]);
      const after = Number(infoField(await session.info(), 'total_commands_processed'));
      expect(after).toBeLessThan(before);
      const [rewrite] = await session.configRewrite();
      expect(rewrite).toMatchObject({ ok: false });
      expect(rewrite!.error).toMatch(/without a configuration file/);
    } finally {
      await session.close();
    }
  });
});
