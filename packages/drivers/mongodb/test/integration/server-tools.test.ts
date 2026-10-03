import { newId } from '@querybara/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMongoServerTools, type MongoSession } from '../../src';
import { MONGO_URL, collect, connectMongo, testDatabase } from './helpers';

/**
 * MongoDB server tools against the 8.0 replica set (spec §15): serverStatus, replica set
 * status and the oplog window; $currentOp and killOp of an operation this test started; the
 * database profiler turned on, read, cleared and turned off in a database of its own; compact
 * and validate on a collection it created; server parameters read, changed and restored.
 */

describe.skipIf(!MONGO_URL)('MongoDB server tools', () => {
  const DB = testDatabase();
  let session: MongoSession;
  let other: MongoSession;

  beforeAll(async () => {
    session = await connectMongo(MONGO_URL!);
    other = await connectMongo(MONGO_URL!);
    const docs = Array.from({ length: 40 }, (_, i) => ({ _id: i, n: i, text: `doc ${i}` }));
    await session.insertMany({ db: DB, collection: 'orders' }, JSON.stringify(docs));
  });

  afterAll(async () => {
    await session?.dropDatabase(DB).catch(() => undefined);
    await session?.close();
    await other?.close();
  });

  it('describes the server', async () => {
    const info = await createMongoServerTools(session).info();
    expect(info).toMatchObject({ engine: 'mongodb', product: 'MongoDB', access: [] });
    expect(info.version).toMatch(/^8\./);
    expect(info.databases).toContain(DB);
    expect(info.user).toBe('querybara@admin');
    expect(info.sessionActions).toEqual([expect.objectContaining({ operation: 'cancel' })]);
    await expect(createMongoServerTools(session).accounts()).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it('reads serverStatus, the replica set and the oplog window', async () => {
    const tools = createMongoServerTools(session);
    const first = await tools.monitor();
    await other.useDatabase(DB);
    await collect(other, `{ find: 'orders', filter: {} }`);
    const second = await tools.monitor();
    const tile = (snapshot: typeof first, id: string) => snapshot.tiles.find((t) => t.id === id);
    const a = tile(first, 'ops');
    const b = tile(second, 'ops');
    if (a?.kind !== 'rate' || b?.kind !== 'rate') throw new Error('ops is a rate');
    expect(b.counter!).toBeGreaterThan(a.counter!);
    expect(tile(second, 'cache-hit')).toMatchObject({ kind: 'ratio' });
    expect(tile(second, 'read-latency')).toMatchObject({ kind: 'ratio', unit: 'ms' });
    const window = tile(second, 'oplog-window');
    expect(window?.kind === 'gauge' && window.value).toBeGreaterThanOrEqual(0);
    const members = second.sections.find((s) => s.id === 'replica-set')!.table.rows;
    expect(members.length).toBeGreaterThan(0);
    expect(members.some((m) => m['state'] === 'PRIMARY')).toBe(true);
    expect(second.sections.find((s) => s.id === 'oplog')!.table.rows).toHaveLength(1);
    expect(second.uptimeSeconds).toBeGreaterThan(0);
  });

  it('lists operations and kills one it started', async () => {
    const tools = createMongoServerTools(session);
    const marker = `st-${newId()}`;
    // A find that sleeps in $where for each of the 40 documents: about 40 seconds.
    await other.useDatabase(DB);
    const slow = collect(
      other,
      `{ find: 'orders', filter: { $where: 'sleep(1000) || true' }, comment: '${marker}' }`,
    ).then(
      () => 'finished',
      (error: unknown) => error,
    );
    let op;
    for (let i = 0; i < 60 && !op; i++) {
      const list = await tools.sessions({ includeIdle: false });
      op = list.sessions.find((s) => s.query?.includes(marker) === true);
      if (!op) await new Promise((r) => setTimeout(r, 100));
    }
    expect(op).toMatchObject({ state: 'query', idle: false, own: false, database: DB });
    expect(op!.id).toMatch(/^\d+$/);
    const preview = await tools.preview({ kind: 'session', operation: 'cancel', id: op!.id });
    expect(preview.statements).toEqual([`db.adminCommand({ killOp: 1, op: ${op!.id} })`]);
    const started = Date.now();
    await tools.run({ kind: 'session', operation: 'cancel', id: op!.id });
    expect(await slow).toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(
      tools.run({ kind: 'session', operation: 'terminate', id: op!.id }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('turns the profiler on, reads it grouped by query shape, clears it and turns it off', async () => {
    const tools = createMongoServerTools(session);
    const off = await tools.topQueries({ database: DB });
    expect(off.profiler).toMatchObject({ database: DB, level: 0 });
    expect(off.unavailable).toMatchObject({
      reason: 'disabled',
      fix: { kind: 'profiler', database: DB, level: 1 },
    });
    const on = { kind: 'profiler', database: DB, level: 2, slowMs: 100 } as const;
    expect((await tools.preview(on)).statements).toEqual([
      `db.getSiblingDB('${DB}').runCommand({ profile: 2, slowms: 100 })`,
    ]);
    await tools.run(on);
    try {
      for (let i = 0; i < 3; i++) {
        await collect(other, `{ find: 'orders', filter: { n: { $gt: ${i} } } }`);
      }
      const top = await tools.topQueries({ database: DB, orderBy: 'calls' });
      expect(top.unavailable).toBeNull();
      expect(top.profiler).toMatchObject({ level: 2, slowMs: 100 });
      const finds = top.queries.find((q) => q.text.startsWith(`query ${DB}.orders`));
      expect(finds).toBeDefined();
      expect(finds!.calls).toBeGreaterThanOrEqual(3);
      expect(finds!.rows).toBeGreaterThan(0);

      const reset = { kind: 'topQueries', operation: 'reset', database: DB } as const;
      expect((await tools.preview(reset)).statements).toEqual([
        `db.getSiblingDB('${DB}').runCommand({ profile: 0 })`,
        `db.getSiblingDB('${DB}').runCommand({ drop: 'system.profile' })`,
        `db.getSiblingDB('${DB}').runCommand({ profile: 2, slowms: 100 })`,
      ]);
      await tools.run(reset);
      const cleared = await tools.topQueries({ database: DB });
      expect(cleared.queries.find((q) => q.text.startsWith(`query ${DB}.orders`))).toBeUndefined();
    } finally {
      await tools.run({ kind: 'profiler', database: DB, level: 0 });
    }
    expect((await tools.topQueries({ database: DB })).profiler?.level).toBe(0);
  });

  it('runs validate and compact on a collection it created', async () => {
    const tools = createMongoServerTools(session);
    const targets = await tools.maintenanceTargets(DB);
    expect(targets.container).toBe(DB);
    expect(targets.targets.find((t) => t.name === 'orders')?.detail['documents']).toBe(40);
    const target = [{ container: DB, name: 'orders' }];
    const validate = {
      kind: 'maintenance',
      operation: 'validate',
      targets: target,
      options: ['full'],
    } as const;
    expect((await tools.preview(validate)).statements).toEqual([
      `db.getSiblingDB('${DB}').runCommand({ validate: 'orders', full: true })`,
    ]);
    const validated = await tools.run(validate);
    expect(validated.table?.rows).toEqual([
      expect.objectContaining({ collection: `${DB}.orders`, valid: true, records: 40 }),
    ]);
    const compacted = await tools.run({
      kind: 'maintenance',
      operation: 'compact',
      targets: target,
      options: ['force'],
    });
    expect(compacted.messages.some((m) => m.message.includes(`compact ${DB}.orders`))).toBe(true);
    await expect(
      tools.preview({ kind: 'maintenance', operation: 'vacuum', targets: target, options: [] }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('reads server parameters, and changes and restores one', async () => {
    const tools = createMongoServerTools(session);
    const list = await tools.settings();
    const cursorTimeout = list.settings.find((s) => s.name === 'cursorTimeoutMillis');
    expect(cursorTimeout).toMatchObject({ scopes: ['global'], type: 'integer' });
    expect(list.settings.find((s) => s.name === 'logComponentVerbosity')?.type).toBe('document');
    const original = cursorTimeout!.value!;
    const change = {
      kind: 'setting',
      name: 'cursorTimeoutMillis',
      value: String(Number(original) + 1),
      scope: 'global',
    } as const;
    expect((await tools.preview(change)).statements).toEqual([
      `db.adminCommand({ setParameter: 1, cursorTimeoutMillis: ${Number(original) + 1} })`,
    ]);
    try {
      await tools.run(change);
      const now = (await tools.settings()).settings.find((s) => s.name === 'cursorTimeoutMillis');
      expect(now?.value).toBe(String(Number(original) + 1));
    } finally {
      await tools.run({ ...change, value: original });
    }
    const restored = (await tools.settings()).settings.find(
      (s) => s.name === 'cursorTimeoutMillis',
    );
    expect(restored?.value).toBe(original);
  });
});
