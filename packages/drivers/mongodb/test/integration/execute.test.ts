import { EJSON, parseShell, toEjson } from '@joinery/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MongoSession } from '../../src';
import { MONGO_URL, cells, collect, connectMongo, execId, testDatabase } from './helpers';

describe.skipIf(!MONGO_URL)('MongoDB execute (replica set)', () => {
  const db = testDatabase();
  let session: MongoSession;

  beforeAll(async () => {
    session = await connectMongo(MONGO_URL!);
    await session.useDatabase(db);
    const docs = Array.from({ length: 2500 }, (_, i) => `{ i: ${i}, even: ${i % 2 === 0} }`);
    await session.insertMany({ db, collection: 'items' }, `[${docs.join(',')}]`);
  });

  afterAll(async () => {
    await session?.dropDatabase(db).catch(() => undefined);
    await session?.close();
  });

  it('reports the server and topology', async () => {
    expect(session.serverVersion).toMatch(/^\d+\.\d+/);
    const caps = session.capabilities();
    expect(caps).toMatchObject({ transactions: true, changeStreams: true, queryCancel: true });
    const info = await session.serverInfo();
    expect(info.topology).toBe('replicaSet');
    expect(info.setName).toBe('rs0');
    expect(info.members[0]).toMatchObject({ state: 'PRIMARY', healthy: true });
    expect(info.storageEngine).toBe('wiredTiger');
    await session.ping();
  });

  it('runs a command and returns its reply as one Extended JSON row', async () => {
    const chunks = await collect(session, '{ ping: 1 }');
    expect(chunks.map((c) => c.type)).toEqual(['columns', 'rows', 'status', 'end']);
    expect(chunks[0]).toMatchObject({ columns: [{ name: 'document', kind: 'json' }] });
    const reply = EJSON.parse(cells(chunks)[0]!, { relaxed: true }) as { ok: number };
    expect(reply.ok).toBe(1);
  });

  it('streams cursor commands page by page, pulling on demand', async () => {
    const result = session.execute(`{ find: 'items', filter: { even: true }, sort: { i: 1 } }`, {
      executionId: execId(),
      pageSize: 400,
    });
    const iterator = result[Symbol.asyncIterator]();
    const columns = await iterator.next();
    expect(columns.value).toMatchObject({ type: 'columns' });
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: 'rows', rowCount: 400 });
    const doc = EJSON.parse((first.value as { data: string[][] }).data[0]![0]!, { relaxed: false });
    // Canonical Extended JSON keeps the Int32 type of `i`.
    expect(toEjson((doc as { i: unknown }).i)).toBe('{"$numberInt":"0"}');
    let rows = 400;
    let status: unknown;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'rows') rows += next.value.rowCount;
      if (next.value.type === 'status') status = next.value;
    }
    expect(rows).toBe(1250);
    expect(status).toMatchObject({ command: 'find', rowsAffected: null });
  });

  it('closes the cursor when the consumer stops early', async () => {
    for await (const chunk of session.execute(`{ aggregate: 'items', pipeline: [] }`, {
      executionId: execId(),
      pageSize: 10,
    })) {
      if (chunk.type === 'rows') break;
    }
    const ops = await session.currentOp({ filter: `{ ns: '${db}.items' }` });
    expect(ops.filter((op) => op.includes('getMore'))).toEqual([]);
  });

  it('counts writes and runs admin-only commands against admin', async () => {
    const chunks = await collect(
      session,
      `{ update: 'items', updates: [{ q: { i: { $lt: 3 } }, u: { $set: { x: 1 } }, multi: true }] }`,
    );
    expect(chunks.find((c) => c.type === 'status')).toMatchObject({
      command: 'update',
      rowsAffected: 3,
    });
    const dbs = cells(await collect(session, '{ listDatabases: 1, nameOnly: true }'));
    expect(dbs[0]).toContain(db);
  });

  it('maps command errors and parse errors', async () => {
    await expect(collect(session, '{ nosuchcommand: 1 }')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      engineCode: 'CommandNotFound',
    });
    await expect(
      collect(session, `{ aggregate: 'items', pipeline: [{ $bogus: 1 }], cursor: {} }`),
    ).rejects.toMatchObject({
      code: 'SQL_ERROR',
    });
    await expect(collect(session, '{ find: "items", filter: { a: } }')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      position: 30,
    });
  });

  it('cancels a slow query from another connection', async () => {
    const executionId = execId();
    const started = Date.now();
    const run = collect(session, `{ find: 'items', filter: { $where: 'sleep(20) || true' } }`, {
      executionId,
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await session.cancel(executionId);
    expect(await run).toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(10_000);
    await session.ping();
  });

  it('cancels through an abort signal', async () => {
    const controller = new AbortController();
    const run = collect(
      session,
      `{ aggregate: 'items', pipeline: [{ $match: { $expr: { $function: { body: 'function() { sleep(20); return true; }', args: [], lang: 'js' } } } }], cursor: {} }`,
      {
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 300);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('explains a command document as a plan tree', async () => {
    const plan = await session.explain(`{ find: 'items', filter: { i: { $gt: 5 } } }`, {
      analyze: true,
    });
    expect(plan.operation).toBe('COLLSCAN');
    expect(plan.detail['collectionScan']).toBe(true);
    expect(plan.actualRows).toBeGreaterThan(0);
  });

  it('parses command text written in shell syntax', () => {
    expect(parseShell(`{ find: 'items', limit: NumberLong(5) }`)).toBeTruthy();
  });
});
