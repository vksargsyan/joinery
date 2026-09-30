import { JoineryError } from '@joinery/core';
import { Double, Int32, Long, fromEjson, toEjson, type BsonDocument } from '@joinery/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  commandText,
  enrichMongoError,
  mongoMonitorSnapshot,
  mongoSession,
  mongoSetting,
  mongoTopQuery,
  opidOf,
  profilePipeline,
} from '../src/server-tools';

describe('MongoDB server tool readers', () => {
  it('reads $currentOp documents', () => {
    const op = mongoSession({
      type: 'op',
      opid: new Int32(123),
      active: true,
      op: 'query',
      ns: 'shop.orders',
      desc: 'conn42',
      client: '127.0.0.1:50000',
      appName: 'etl',
      effectiveUsers: [{ user: 'app', db: 'admin' }],
      microsecs_running: new Long(2_500_000),
      waitingForLock: true,
      command: { find: 'orders', filter: { n: new Int32(1) }, comment: 'x' },
      planSummary: 'COLLSCAN',
      numYields: new Int32(3),
    });
    expect(op).toMatchObject({
      id: '123',
      user: 'app@admin',
      database: 'shop',
      client: '127.0.0.1:50000',
      application: 'etl',
      state: 'query',
      durationMs: 2500,
      wait: 'waiting for a lock',
      own: false,
      background: false,
      idle: false,
      detail: { planSummary: 'COLLSCAN', yields: 3, ns: 'shop.orders' },
    });
    expect(op.query).toContain("find: 'orders'");
    const mongos = mongoSession({
      opid: 'shard01:77',
      active: true,
      client_s: '10.0.0.1:1',
      command: { comment: 'joinery server tools' },
    });
    expect(mongos).toMatchObject({ id: 'shard01:77', client: '10.0.0.1:1', own: true });
    const idle = mongoSession({ type: 'idleSession', active: false, desc: 'conn1' });
    expect(idle).toMatchObject({ id: '', idle: true, state: 'idle', durationMs: null });
    expect(
      mongoSession({ desc: 'WTCheckpointThread', active: true, opid: new Int32(1) }).background,
    ).toBe(true);
  });

  it('builds the monitor from serverStatus, the replica set and the oplog', () => {
    const now = Date.UTC(2026, 8, 29, 12, 0, 0);
    const status = fromEjson(
      toEjson({
        uptime: new Double(3600),
        connections: {
          current: new Int32(12),
          available: new Int32(800),
          totalCreated: new Int32(40),
        },
        opcounters: {
          insert: new Long(5),
          query: new Long(10),
          update: new Long(1),
          delete: new Long(0),
          getmore: new Long(2),
          command: new Long(100),
        },
        opLatencies: {
          reads: { latency: new Long(50_000), ops: new Long(10) },
          writes: { latency: new Long(0), ops: new Long(0) },
        },
        network: { bytesIn: new Long(1000), bytesOut: new Long(2000) },
        mem: { resident: new Int32(100) },
        globalLock: {
          currentQueue: { total: new Int32(1), readers: new Int32(1), writers: new Int32(0) },
          activeClients: { total: new Int32(3) },
        },
        wiredTiger: {
          cache: {
            'bytes currently in the cache': new Long(1024),
            'maximum bytes configured': new Long(4096),
            'tracked dirty bytes in the cache': new Long(10),
            'pages requested from the cache': new Long(1000),
            'pages read into cache': new Long(50),
          },
        },
      }),
    ) as BsonDocument;
    const snapshot = mongoMonitorSnapshot(1, {
      status,
      replSet: {
        set: 'rs0',
        members: [
          {
            name: 'a:1',
            stateStr: 'PRIMARY',
            health: new Double(1),
            optimeDate: new Date(now),
            self: true,
          },
          {
            name: 'b:1',
            stateStr: 'SECONDARY',
            health: new Double(1),
            optimeDate: new Date(now - 4000),
            pingMs: new Long(2),
            syncSourceHost: 'a:1',
          },
        ],
      },
      oplog: { first: 1000, last: 4600, size: 10 * 1024 * 1024, maxSize: 990 * 1024 * 1024 },
      notices: [],
    });
    const tile = (id: string) => snapshot.tiles.find((t) => t.id === id);
    expect(snapshot.uptimeSeconds).toBe(3600);
    expect(tile('connections')).toMatchObject({
      value: 12,
      detail: '800 available · 40 created since start',
    });
    expect(tile('ops')).toMatchObject({ kind: 'rate', counter: 118 });
    expect(tile('read-latency')).toMatchObject({ kind: 'ratio', unit: 'ms', hits: 50, total: 10 });
    expect(tile('cache-hit')).toMatchObject({ hits: 950, total: 1000 });
    expect(tile('resident')).toMatchObject({ value: 100 * 1024 * 1024 });
    expect(tile('replication-lag')).toMatchObject({ value: 4, detail: '2 members · set rs0' });
    expect(tile('oplog-window')).toMatchObject({ value: 3600, detail: '10 MB used of 990 MB' });
    const members = snapshot.sections.find((s) => s.id === 'replica-set')!.table.rows;
    expect(members).toEqual([
      expect.objectContaining({ member: 'a:1 (this)', state: 'PRIMARY', health: true, lag: 0 }),
      expect.objectContaining({ member: 'b:1', lag: 4, ping: 2, syncSource: 'a:1' }),
    ]);
    const standalone = mongoMonitorSnapshot(1, {
      status: {},
      replSet: null,
      oplog: null,
      notices: [],
    });
    expect(standalone.tiles.find((t) => t.id === 'replication-lag')).toMatchObject({
      value: null,
      detail: 'not a replica set',
    });
    expect(standalone.sections.find((s) => s.id === 'oplog')!.table.rows).toEqual([]);
  });

  it('groups the profiler output by query shape', () => {
    const pipeline = profilePipeline('mean', 50);
    expect(pipeline.at(-2)).toEqual({ $sort: { meanMs: -1 } });
    expect(toEjson(pipeline.at(-1))).toBe('{"$limit":{"$numberInt":"50"}}');
    const query = mongoTopQuery({
      _id: { ns: 'shop.orders', op: 'query', shape: 'ABC123' },
      calls: new Int32(4),
      totalMs: new Int32(40),
      maxMs: new Int32(20),
      rows: new Int32(8),
      docsExamined: new Int32(100),
      keysExamined: new Int32(0),
      lastSeen: new Date(Date.UTC(2026, 0, 1)),
      sample: { find: 'orders', filter: { n: new Int32(1) } },
      planSummary: 'COLLSCAN',
      user: 'app@admin',
    });
    expect(query).toMatchObject({
      id: 'shop.orders|query|ABC123',
      database: 'shop',
      user: 'app@admin',
      calls: 4,
      totalMs: 40,
      meanMs: 10,
      maxMs: 20,
      rows: 8,
      detail: { docsExamined: 100, planSummary: 'COLLSCAN', lastSeen: '2026-01-01T00:00:00.000Z' },
    });
    expect(query.text).toMatch(/^query shop\.orders \{ find: 'orders'/);
    const byCommand = mongoTopQuery({
      _id: { ns: 'shop.orders', op: 'insert', shape: { insert: 'orders' } },
      calls: new Int32(1),
      totalMs: new Int32(1),
    });
    expect(byCommand.id).toMatch(/^shop\.orders\|insert\|[0-9a-f]{8}$/);
  });

  it('reads parameters with and without details', () => {
    expect(
      mongoSetting(
        'cursorTimeoutMillis',
        { value: new Long(600000), settableAtRuntime: true, settableAtStartup: true },
        true,
      ),
    ).toMatchObject({
      value: '600000',
      type: 'integer',
      scopes: ['global'],
      restartRequired: false,
    });
    expect(
      mongoSetting(
        'storageEngine',
        { value: 'wiredTiger', settableAtRuntime: false, settableAtStartup: true },
        true,
      ),
    ).toMatchObject({
      value: 'wiredTiger',
      scopes: [],
      restartRequired: true,
    });
    expect(mongoSetting('logComponentVerbosity', { verbosity: new Int32(0) }, false)).toMatchObject(
      {
        type: 'document',
        value: '{ verbosity: 0 }',
        scopes: ['global'],
      },
    );
    expect(mongoSetting('ratio', new Double(0.5), false)).toMatchObject({
      type: 'real',
      value: '0.5',
    });
    expect(mongoSetting('flag', true, false).type).toBe('bool');
  });
});

describe('MongoDB server tool commands', () => {
  it('shows commands as the shell would run them', () => {
    expect(commandText('admin', { killOp: new Int32(1), op: new Int32(5) })).toBe(
      'db.adminCommand({ killOp: 1, op: 5 })',
    );
    expect(commandText("it's", { validate: 'orders', full: true })).toBe(
      "db.getSiblingDB('it\\'s').runCommand({ validate: 'orders', full: true })",
    );
  });

  it('accepts operation ids of mongod and mongos only', () => {
    expect(opidOf('42')).toEqual(new Int32(42));
    expect(opidOf('9007199254740993')).toBeInstanceOf(Long);
    expect(opidOf('shard-01:42')).toBe('shard-01:42');
    expect(() => opidOf('1; db.dropDatabase()')).toThrow(JoineryError);
    expect(() => opidOf('')).toThrow(JoineryError);
  });

  it('names the role an unauthorised action needs', () => {
    const denied = new JoineryError({
      code: 'SQL_ERROR',
      message: 'not authorized',
      engineCode: 'Unauthorized',
    });
    expect(
      (
        enrichMongoError(denied, {
          kind: 'maintenance',
          operation: 'compact',
          targets: [],
          options: [],
        }) as JoineryError
      ).hint,
    ).toMatch(/compact action/);
    expect(
      (enrichMongoError(denied, { kind: 'profiler', database: 'x', level: 1 }) as JoineryError)
        .hint,
    ).toMatch(/enableProfiler/);
    const other = new JoineryError({ code: 'SQL_ERROR', message: 'x', engineCode: 'BadValue' });
    expect(enrichMongoError(other, { kind: 'session', operation: 'cancel', id: '1' })).toBe(other);
  });
});
