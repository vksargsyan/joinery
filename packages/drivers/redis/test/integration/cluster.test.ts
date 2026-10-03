import type { ConnectionCheckResult, QuerybaraError } from '@querybara/core';
import { keySlot } from '@querybara/redis-tools';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RedisSession } from '../../src';
import {
  REDIS_CLUSTER,
  REDIS_URL,
  adapter,
  cleanup,
  clusterProfile,
  connect,
  dec,
  newPrefix,
  run,
  sleep,
} from './helpers';

/** Redis Cluster: cluster-wide scans, slot routing, topology and bulk operations across nodes. */
describe.skipIf(!REDIS_CLUSTER || !REDIS_URL)('Cluster', () => {
  let session: RedisSession;
  let p: string;
  let primaries: string[];
  let slotRanges: Map<string, (readonly [number, number])[]>;

  beforeAll(async () => {
    session = await connect(clusterProfile());
    const view = await session.topology();
    slotRanges = new Map(
      view.nodes
        .filter((n) => n.role === 'primary')
        .map((n) => [n.address, n.slots.map((r) => [r[0], r[1]] as const)]),
    );
    primaries = [...slotRanges.keys()].sort();
  });

  /** The primary serving a key, from the topology. */
  function owner(key: string): string {
    const slot = keySlot(key);
    return [...slotRanges.entries()].find(([, ranges]) =>
      ranges.some(([s, e]) => slot >= s && slot <= e),
    )![0];
  }
  afterAll(async () => {
    await session?.close();
  });
  beforeEach(() => {
    p = newPrefix();
    session.setTargetNode(undefined);
  });
  afterEach(async () => {
    await cleanup(session, p);
  });

  /** Keys spread over every primary. */
  async function spread(count: number): Promise<string[]> {
    const names = Array.from({ length: count }, (_, i) => `${p}k:${i}`);
    await Promise.all(names.map((k, i) => session.setString(k, String(i))));
    return names;
  }

  it('connects to every primary', () => {
    expect(session.server).toMatchObject({
      topology: 'cluster',
      clusterMode: true,
      databases: 1,
      role: 'master',
    });
    expect(session.capabilities().clusterMode).toBe(true);
    expect(session.nodes().map((n) => n.address)).toEqual(primaries);
    expect(primaries.length).toBeGreaterThanOrEqual(3);
    expect(session.database).toBe(0);
  });

  it('scans every primary with a composite cursor', async () => {
    const names = await spread(300);
    const owners = new Set(names.map(owner));
    expect(owners.size).toBe(primaries.length);
    const found = new Set<string>();
    let cursor = '0';
    let calls = 0;
    do {
      const page = await session.scan({ cursor, match: `${p}*`, count: 20 });
      page.keys.forEach((k) => found.add(dec(k)!));
      cursor = page.cursor;
      calls += 1;
      if (!page.done) expect(primaries).toContain(cursor.split(',')[0]!.split('@')[0]);
    } while (cursor !== '0');
    expect(calls).toBeGreaterThan(1);
    expect(found.size).toBe(300);
    const one = await session.scanPage({ match: `${p}*`, limit: 1000, node: primaries[1]! });
    expect(one.keys.length).toBeGreaterThan(0);
    expect(one.keys.every((k) => owner(dec(k)!) === primaries[1])).toBe(true);
    expect(await session.dbSize()).toBeGreaterThanOrEqual(300);
  });

  it('routes CLI commands by key slot and reports the node', async () => {
    const chunks = await run(session, `set ${p}a 1\nset ${p}b 2\nget ${p}a`);
    const nodes = chunks.flatMap((c) => (c.type === 'rows' ? [String(c.data[1]![0])] : []));
    expect(chunks.find((c) => c.type === 'columns')).toMatchObject({
      columns: [{ name: 'reply' }, { name: 'node' }],
    });
    expect(nodes).toEqual([owner(`${p}a`), owner(`${p}b`), owner(`${p}a`)]);
    const cross = await run(session, `mget ${p}a ${p}b`).catch((e: unknown) => e);
    if (keySlot(`${p}a`) !== keySlot(`${p}b`))
      expect(cross).toMatchObject({ engineCode: 'CROSSSLOT' });
    expect(await session.command(['GET', `${p}{t}x`])).toEqual({ type: 'nil' });
  });

  it('sends keyless commands to the chosen node, or to every node', async () => {
    const last = primaries.at(-1)!;
    session.setTargetNode(last);
    const chunks = await run(session, 'cluster myid');
    const row = chunks.find((c) => c.type === 'rows');
    expect(row && row.type === 'rows' ? row.data[1]![0] : undefined).toBe(last);
    expect((await session.command(['DBSIZE'], { node: primaries[0]! })).type).toBe('integer');
    const all = await session.commandAll(['PING']);
    expect(all.map((r) => [r.node, r.reply])).toEqual(
      primaries.map((address) => [address, { type: 'status', value: 'PONG' }]),
    );
    expect(() => session.setTargetNode('10.9.9.9:1')).toThrow(/No node/);
  });

  it('shows the topology with the slot map', async () => {
    const view = await session.topology();
    expect(view.topology).toBe('cluster');
    expect(view.uncoveredSlots).toEqual([]);
    const nodes = view.nodes.filter((n) => n.role === 'primary');
    expect(nodes.map((n) => n.address).sort()).toEqual(primaries);
    const covered = nodes.flatMap((n) => n.slots).reduce((sum, [s, e]) => sum + e - s + 1, 0);
    expect(covered).toBe(16384);
    expect(nodes.every((n) => n.slots.length > 0 && n.id.length === 40)).toBe(true);
    expect(view.nodes.filter((n) => n.myself)).toHaveLength(1);
  });

  it('bulk-deletes across nodes and deletes keys of many slots', async () => {
    await spread(250);
    const dry = await session.bulkDelete({ match: `${p}k:*`, dryRun: true });
    expect(dry.matched).toBe(250);
    const result = await session.bulkDelete({ match: `${p}k:*`, batchSize: 40 });
    expect(result).toMatchObject({ matched: 250, deleted: 250, failed: 0 });
    const names = await spread(30);
    expect(await session.exists(names)).toBe(30);
    expect(await session.deleteKeys(names)).toBe(30);
  });

  it('renames and copies across hash slots with DUMP / RESTORE', async () => {
    let target = `${p}dst`;
    for (let i = 0; keySlot(target) === keySlot(`${p}src`); i++) target = `${p}dst${i}`;
    await session.setString(`${p}src`, 'v', { ttlMs: 60_000 });
    expect(await session.copy(`${p}src`, target)).toEqual({ copied: true, method: 'dump-restore' });
    expect(await session.copy(`${p}src`, target)).toEqual({
      copied: false,
      method: 'dump-restore',
    });
    await session.deleteKeys([target]);
    expect(await session.rename(`${p}src`, target)).toBe(true);
    expect(await session.exists([`${p}src`])).toBe(0);
    const [info] = await session.keyInfo([target]);
    expect(info!.ttlMs).toBeGreaterThan(50_000);
    expect(await session.copy(`${p}{s}1`, `${p}{s}2`)).toEqual({ copied: false, method: 'copy' });
    expect(await session.copy(`${p}missing`, target)).toEqual({
      copied: false,
      method: 'dump-restore',
    });
    const missing = await session.rename(`${p}missing`, target).catch((e: unknown) => e);
    expect((missing as QuerybaraError).code).toBe('NOT_FOUND');
    await session.setString(`${p}{s}1`, 'x');
    expect(await session.copy(`${p}{s}1`, `${p}{s}2`)).toEqual({ copied: true, method: 'copy' });
  });

  it('browses primaries and their namespaces', async () => {
    await spread(30);
    const root = await session.browse([]);
    expect(root.map((n) => [n.kind, n.name])).toEqual(
      primaries.map((address) => ['node', address]),
    );
    const segments = p.slice(0, -1).split(':');
    let total = 0;
    for (const node of root) {
      const children = await session.browse([...node.path, ...segments, 'k']);
      total += children.filter((c) => c.kind === 'key').length;
    }
    expect(total).toBe(30);
  });

  it('cancels a blocking command on the node that runs it', async () => {
    const pending = run(session, `blpop ${p}q 20`, 'cluster-block').catch((e: unknown) => e);
    await sleep(300);
    await session.cancel('cluster-block');
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    await sleep(200);
    expect(await session.command(['GET', `${p}q`])).toEqual({ type: 'nil' });
  });

  it('publishes and subscribes through the cluster', async () => {
    const subscription = await session.subscribe({ channels: [`${p}ch`] });
    try {
      await session.publish(`${p}ch`, 'hi');
      const iterator = subscription[Symbol.asyncIterator]();
      const next = await iterator.next();
      expect(dec(next.value!.message)).toBe('hi');
    } finally {
      await subscription.close();
    }
  });

  it('runs Test Connection over the seeds', async () => {
    const steps: ConnectionCheckResult[] = [];
    for await (const step of adapter.checkConnection(clusterProfile())) steps.push(step);
    expect(steps.map((s) => s.status)).toEqual([
      'skipped',
      'ok',
      'skipped',
      'skipped',
      'ok',
      'ok',
      'ok',
    ]);
    expect(steps.find((s) => s.step === 'version')!.message).toMatch(/cluster of 3 primaries/);
  });
});
