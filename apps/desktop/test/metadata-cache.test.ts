import { schemaSnapshotSchema, type SchemaSnapshot, type SqlDialect } from '@joinery/core';
import { analyzeStatement, splitStatements } from '@joinery/sql-tools';
import { describe, expect, it } from 'vitest';

import {
  MetadataCache,
  type MetadataSink,
  type MetadataSource,
  type MetadataStatus,
  type SnapshotChange,
  type StructureChange,
} from '../src/renderer/src/state/metadata-cache';
import {
  effectsOfRun,
  qualifierBefore,
  readConnectionFacts,
  sessionChangeOf,
  tabFacts,
  type ConnectionFacts,
  type RanStatement,
} from '../src/renderer/src/state/session-facts';
import { flush } from './helpers';

/**
 * When the app's metadata loads and refreshes (spec §5): the stored copy first for autocomplete,
 * then the server; only the databases in use; fresh snapshots for the designer and table views;
 * refreshes after DDL (at COMMIT inside a PostgreSQL transaction), USE, designer saves and
 * Refresh, reporting what changed; and each connection on its own.
 */

function snapshot(
  engine: SqlDialect,
  database: string,
  version = 1,
  tables: readonly string[] = [],
): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine,
    database,
    schemas: [
      {
        name: engine === 'postgres' ? 'public' : database,
        tables: tables.map((name) => ({
          name,
          columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: false }],
        })),
      },
    ],
    capturedAt: `2026-09-29T10:00:0${version}.000Z`,
  });
}

function statements(sql: string, dialect: SqlDialect): RanStatement[] {
  return splitStatements(sql, dialect).map((statement) => ({
    text: statement.text,
    analysis: analyzeStatement(statement.text, dialect),
  }));
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A source that records calls and serves per-profile facts, caches and snapshots. */
function fakes(options: {
  readonly facts: Record<string, ConnectionFacts>;
  readonly cached?: Record<string, readonly SchemaSnapshot[]>;
  readonly dialects?: Record<string, SqlDialect>;
}) {
  const calls: string[] = [];
  const stored: string[] = [];
  const dropped: string[] = [];
  const published: { profileId: string; change: SnapshotChange }[] = [];
  const statuses: { profileId: string; status: MetadataStatus }[] = [];
  const forgotten: string[] = [];
  const changes: { profileId: string; change: StructureChange }[] = [];
  const versions = new Map<string, number>();
  /** The tables each `profile/database` has on the "server". */
  const tables = new Map<string, string[]>();
  const facts = { ...options.facts };
  /** Introspections wait on this gate while set. */
  const hold: { gate: Gate | undefined } = { gate: undefined };
  let failFacts = false;
  let failIntrospect = false;
  const source: MetadataSource = {
    loadCached: async (profileId) => {
      calls.push(`${profileId} cache`);
      return options.cached?.[profileId] ?? [];
    },
    store: async (profileId, s) => {
      stored.push(`${profileId}/${s.database}`);
    },
    drop: async (profileId, database) => {
      dropped.push(`${profileId}/${database}`);
    },
    facts: async (profileId) => {
      calls.push(`${profileId} facts`);
      if (failFacts) throw new Error('Not connected');
      const found = facts[profileId];
      if (!found) throw new Error('unknown profile');
      return found;
    },
    introspect: async (profileId, dialect, database, schemas) => {
      calls.push(`${profileId} introspect ${database}${schemas ? ` ${schemas.join(',')}` : ''}`);
      await hold.gate?.promise;
      const key = `${profileId}/${database}`;
      const version = (versions.get(key) ?? 0) + 1;
      versions.set(key, version);
      if (failIntrospect) throw new Error('permission denied');
      return snapshot(dialect, database, version, tables.get(key) ?? []);
    },
  };
  const sink: MetadataSink = {
    publish: (profileId, change) => published.push({ profileId, change }),
    forget: (profileId) => forgotten.push(profileId),
    status: (profileId, status) => statuses.push({ profileId, status }),
    changed: (profileId, change) => changes.push({ profileId, change }),
  };
  const metadata = new MetadataCache(source, sink);
  const introspections = (profileId?: string): string[] =>
    calls.filter(
      (call) => call.includes(' introspect ') && (!profileId || call.startsWith(`${profileId} `)),
    );
  return {
    metadata,
    calls,
    stored,
    dropped,
    published,
    statuses,
    forgotten,
    changes,
    tables,
    facts,
    hold,
    introspections,
    failFacts: (fail: boolean) => {
      failFacts = fail;
    },
    failIntrospect: (fail: boolean) => {
      failIntrospect = fail;
    },
  };
}

const PG_FACTS: ConnectionFacts = { database: 'shop', searchPath: ['public'], user: 'app' };
const MY_FACTS: ConnectionFacts = {
  database: 'shop',
  lowerCaseTableNames: 0,
  databases: ['crm', 'hr', 'shop'],
};

describe('MetadataCache: loading', () => {
  it('publishes the cache at once, then refreshes the connected PostgreSQL database', async () => {
    const f = fakes({
      facts: { pg: PG_FACTS },
      cached: { pg: [snapshot('postgres', 'shop'), snapshot('postgres', 'old_default')] },
    });
    f.hold.gate = gate();
    const opening = f.metadata.open('pg', 'postgres');
    await flush();
    // Cached snapshots reach the worker before the server answers.
    expect(f.published[0]).toEqual({
      profileId: 'pg',
      change: { put: [snapshot('postgres', 'shop'), snapshot('postgres', 'old_default')] },
    });
    expect(f.statuses.at(-1)?.status.loading).toBe(true);
    f.hold.gate.open();
    await opening;
    // Only the connected database is introspected; another database leaves the worker.
    expect(f.introspections()).toEqual(['pg introspect shop']);
    expect(f.published.slice(1).map((p) => p.change)).toEqual([
      { remove: ['old_default'] },
      { put: [snapshot('postgres', 'shop', 1)] },
    ]);
    expect(f.stored).toEqual(['pg/shop']);
    expect(f.dropped).toEqual([]);
    expect(f.statuses.at(-1)).toEqual({ profileId: 'pg', status: { loading: false } });
    expect(f.metadata.facts('pg')).toEqual(PG_FACTS);
    expect(f.metadata.loaded('pg')).toEqual(['shop']);
    // Opening again joins the first load.
    await f.metadata.open('pg', 'postgres');
    expect(f.introspections()).toHaveLength(1);
  });

  it('loads only the MySQL databases in use, and names the rest', async () => {
    const f = fakes({
      facts: { my: MY_FACTS },
      cached: { my: [snapshot('mysql', 'hr'), snapshot('mysql', 'dropped_meanwhile')] },
    });
    const opening = f.metadata.open('my', 'mysql');
    // Expanded in the explorer before the connection's facts were read.
    void f.metadata.use('my', 'crm');
    await opening;
    expect(f.introspections().sort()).toEqual(['my introspect crm', 'my introspect shop']);
    expect(f.published[1]?.change).toEqual({
      remove: ['dropped_meanwhile'],
      databases: ['crm', 'hr', 'shop'],
    });
    expect(f.dropped).toEqual(['my/dropped_meanwhile']);
    // hr stays usable from the cache without a round trip.
    expect([...f.metadata.loaded('my')].sort()).toEqual(['crm', 'hr', 'shop']);
  });

  it('loads a database when it is used, from the cache first', async () => {
    const f = fakes({ facts: { my: MY_FACTS }, cached: { my: [snapshot('mysql', 'hr')] } });
    await f.metadata.open('my', 'mysql');
    f.hold.gate = gate();
    // Cached: usable at once, refreshed in the background.
    await f.metadata.use('my', 'hr');
    expect(f.introspections()).toContain('my introspect hr');
    // Not cached: resolves once introspected.
    let loaded = false;
    void f.metadata.use('my', 'crm').then(() => {
      loaded = true;
    });
    await flush();
    expect(loaded).toBe(false);
    f.hold.gate.open();
    await expect.poll(() => loaded).toBe(true);
    // Unknown databases and PostgreSQL are ignored.
    await f.metadata.use('my', 'nope');
    expect(f.introspections()).not.toContain('my introspect nope');
  });

  it('reports a failed load and tries again on the next open', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    f.failFacts(true);
    await f.metadata.open('pg', 'postgres');
    expect(f.statuses.at(-1)?.status).toEqual({ loading: false, error: 'Not connected' });
    f.failFacts(false);
    await f.metadata.open('pg', 'postgres');
    expect(f.introspections()).toEqual(['pg introspect shop']);
    expect(f.statuses.at(-1)?.status).toEqual({ loading: false });
  });

  it('runs an introspection again when asked while it is running', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    await f.metadata.open('pg', 'postgres');
    f.hold.gate = gate();
    const first = f.metadata.refresh('pg');
    await flush();
    const second = f.metadata.refresh('pg');
    await flush();
    // One read at a time; the second request waits for the first and then reads again.
    expect(f.introspections()).toHaveLength(2);
    f.hold.gate.open();
    await Promise.all([first, second]);
    expect(f.introspections()).toHaveLength(3);
  });
});

describe('MetadataCache: refresh decisions', () => {
  it('refreshes after DDL, not after queries or TRUNCATE', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    await f.metadata.open('pg', 'postgres');
    const run = (sql: string, inTransaction = false) =>
      f.metadata.afterRun('pg', {
        tabId: 't1',
        statements: statements(sql, 'postgres'),
        database: 'shop',
        inTransaction,
      });
    run('select * from orders; insert into orders values (1); truncate orders');
    await flush();
    expect(f.introspections()).toHaveLength(1);
    expect(run('create table refunds (id int)')?.stale).toEqual(['shop']);
    await expect.poll(() => f.introspections()).toHaveLength(2);
    // Open views and the explorer hear of it once the new structure is read.
    await expect
      .poll(() => f.changes)
      .toEqual([{ profileId: 'pg', change: { databases: ['shop'], list: false } }]);
  });

  it('waits for COMMIT when PostgreSQL DDL runs inside a transaction', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    await f.metadata.open('pg', 'postgres');
    const ddl = { statements: statements('alter table orders add note text', 'postgres') };
    f.metadata.afterRun('pg', { tabId: 't1', ...ddl, database: 'shop', inTransaction: true });
    await flush();
    expect(f.introspections()).toHaveLength(1);
    f.metadata.afterTransaction('pg', 't1', false);
    f.metadata.afterTransaction('pg', 't1', true);
    await flush();
    // Rolled back: nothing to refresh.
    expect(f.introspections()).toHaveLength(1);

    f.metadata.afterRun('pg', { tabId: 't1', ...ddl, database: 'shop', inTransaction: true });
    // Another tab's commit is not this transaction's.
    f.metadata.afterTransaction('pg', 't2', true);
    await flush();
    expect(f.introspections()).toHaveLength(1);
    f.metadata.afterTransaction('pg', 't1', true);
    await expect.poll(() => f.introspections()).toHaveLength(2);

    // A COMMIT typed in the editor ends it too.
    f.metadata.afterRun('pg', { tabId: 't1', ...ddl, database: 'shop', inTransaction: true });
    f.metadata.afterRun('pg', {
      tabId: 't1',
      statements: statements('commit', 'postgres'),
      database: 'shop',
      inTransaction: false,
    });
    await expect.poll(() => f.introspections()).toHaveLength(3);
  });

  it('refreshes the MySQL databases DDL touched and follows CREATE / DROP DATABASE', async () => {
    const f = fakes({ facts: { my: MY_FACTS }, cached: { my: [snapshot('mysql', 'hr')] } });
    await f.metadata.open('my', 'mysql');
    const before = f.introspections().length;
    const effects = f.metadata.afterRun('my', {
      tabId: 't1',
      statements: statements(
        'use crm; create table leads (id int); alter table hr.staff add x int',
        'mysql',
      ),
      database: 'shop',
      inTransaction: false,
    });
    expect([...(effects?.stale ?? [])].sort()).toEqual(['crm', 'hr']);
    expect(effects?.session).toEqual({ database: 'crm' });
    await expect
      .poll(() => f.introspections().slice(before).sort())
      .toEqual(['my introspect crm', 'my introspect hr']);

    f.facts['my'] = { ...MY_FACTS, databases: ['audit', 'crm', 'shop'] };
    f.metadata.afterRun('my', {
      tabId: 't1',
      statements: statements('drop database hr; create database audit', 'mysql'),
      database: 'crm',
      inTransaction: false,
    });
    await expect.poll(() => f.dropped).toEqual(['my/hr']);
    expect(f.published.at(-1)?.change).toMatchObject({ databases: ['audit', 'crm', 'shop'] });
    expect(f.published.some((p) => p.change.remove?.includes('hr'))).toBe(true);
    expect(f.metadata.loaded('my')).not.toContain('hr');
    expect(f.introspections()).not.toContain('my introspect audit');
  });

  it('keeps each connection to itself', async () => {
    const f = fakes({ facts: { a: PG_FACTS, b: { ...PG_FACTS, database: 'crm' } } });
    await Promise.all([f.metadata.open('a', 'postgres'), f.metadata.open('b', 'postgres')]);
    expect(f.introspections().sort()).toEqual(['a introspect shop', 'b introspect crm']);
    const published = f.published.length;
    f.metadata.afterRun('a', {
      tabId: 'ta',
      statements: statements('create table t (id int)', 'postgres'),
      database: 'shop',
      inTransaction: false,
    });
    await expect.poll(() => f.introspections('a')).toHaveLength(2);
    expect(f.introspections('b')).toHaveLength(1);
    expect(f.published.slice(published).every((p) => p.profileId === 'a')).toBe(true);

    // A designer save or Refresh on b refreshes b only.
    await f.metadata.refresh('b');
    expect(f.introspections('a')).toHaveLength(2);
    expect(f.introspections('b')).toHaveLength(2);

    f.metadata.close('a');
    expect(f.forgotten).toEqual(['a']);
    expect(f.metadata.facts('a')).toBeUndefined();
    expect(f.metadata.facts('b')).toEqual({ ...PG_FACTS, database: 'crm' });
    expect(
      f.metadata.afterRun('a', {
        tabId: 'ta',
        statements: [],
        database: undefined,
        inTransaction: false,
      }),
    ).toBeUndefined();
  });

  it('ignores a closed connection whose introspection finishes late', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    f.hold.gate = gate();
    const opening = f.metadata.open('pg', 'postgres');
    await expect.poll(() => f.introspections()).toHaveLength(1);
    f.metadata.close('pg');
    const published = f.published.length;
    f.hold.gate.open();
    await opening;
    expect(f.published).toHaveLength(published);
    expect(f.stored).toEqual([]);
  });
});

describe('MetadataCache: snapshots for the designer and table views', () => {
  it('serves the fresh snapshot, waiting for a read in progress, never the stored copy', async () => {
    const f = fakes({
      facts: { pg: PG_FACTS },
      cached: { pg: [snapshot('postgres', 'shop', 9, ['stale_copy'])] },
    });
    f.tables.set('pg/shop', ['orders']);
    f.hold.gate = gate();
    void f.metadata.open('pg', 'postgres');
    const served = f.metadata.snapshot('pg', 'postgres');
    await flush();
    f.hold.gate.open();
    expect((await served).schemas[0]?.tables.map((t) => t.name)).toEqual(['orders']);
    // Held and fresh: no second read.
    await f.metadata.snapshot('pg', 'postgres', { database: 'shop', schemas: ['public'] });
    expect(f.introspections()).toEqual(['pg introspect shop']);
  });

  it('reads another PostgreSQL database for the designer without handing it to autocomplete', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    await f.metadata.open('pg', 'postgres');
    const published = f.published.length;
    const other = await f.metadata.snapshot('pg', 'postgres', { database: 'archive' });
    expect(other.database).toBe('archive');
    expect(f.published).toHaveLength(published);
    expect(f.stored).toEqual(['pg/shop']);
    // A table view narrowing to one schema of a database nobody has read yet reads only that.
    await f.metadata.snapshot('pg', 'postgres', { database: 'logs', schemas: ['audit'] });
    expect(f.introspections()).toContain('pg introspect logs audit');
    expect(f.metadata.loaded('pg')).not.toContain('logs');
  });

  it('loads a MySQL database a view asks for, for autocomplete too', async () => {
    const f = fakes({ facts: { my: MY_FACTS } });
    await f.metadata.open('my', 'mysql');
    await f.metadata.snapshot('my', 'mysql', { database: 'crm' });
    expect(f.published.some((p) => p.change.put?.[0]?.database === 'crm')).toBe(true);
    expect(f.stored).toContain('my/crm');
  });

  it('rejects with the read`s error', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    await f.metadata.open('pg', 'postgres');
    f.failIntrospect(true);
    await expect(f.metadata.snapshot('pg', 'postgres', { database: 'archive' })).rejects.toThrow(
      'permission denied',
    );
    f.failFacts(true);
    const g = fakes({ facts: {} });
    await expect(g.metadata.snapshot('x', 'postgres')).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
  });

  it('makes everything stale on invalidate and reports the change once read again', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    f.tables.set('pg/shop', ['orders']);
    await f.metadata.open('pg', 'postgres');
    await f.metadata.snapshot('pg', 'postgres', { database: 'archive' });
    f.tables.set('pg/shop', ['orders', 'refunds']);
    f.hold.gate = gate();
    expect(f.metadata.invalidate('pg')).toBe(true);
    // The next snapshot waits for the new read instead of serving the old one.
    const served = f.metadata.snapshot('pg', 'postgres');
    await flush();
    expect(f.changes).toEqual([]);
    f.hold.gate.open();
    expect((await served).schemas[0]?.tables.map((t) => t.name)).toEqual(['orders', 'refunds']);
    await expect.poll(() => f.changes.length).toBe(2);
    expect(f.changes.map((c) => c.change.databases[0]).sort()).toEqual(['archive', 'shop']);
    expect(fakes({ facts: {} }).metadata.invalidate('nobody')).toBe(false);
  });

  it('reports a refresh only when the structure differs', async () => {
    const f = fakes({ facts: { pg: PG_FACTS } });
    await f.metadata.open('pg', 'postgres');
    await f.metadata.snapshot('pg', 'postgres');
    await f.metadata.refresh('pg');
    expect(f.changes).toEqual([]);
    f.tables.set('pg/shop', ['made_elsewhere']);
    await f.metadata.refresh('pg', ['shop']);
    expect(f.changes).toEqual([{ profileId: 'pg', change: { databases: ['shop'], list: false } }]);
  });
});

describe('effectsOfRun', () => {
  it('tracks the database of each MySQL statement through USE', () => {
    const effects = effectsOfRun({
      dialect: 'mysql',
      statements: statements('create table a (id int); use crm; drop view v', 'mysql'),
      database: 'shop',
      loaded: ['shop', 'crm'],
    });
    expect(effects).toEqual({
      stale: ['shop', 'crm'],
      dropped: [],
      databaseList: false,
      session: { database: 'crm' },
    });
  });

  it('refreshes PostgreSQL`s connected database only, whatever the DDL names', () => {
    const effects = effectsOfRun({
      dialect: 'postgres',
      statements: statements(
        'create schema reporting; create database other; set search_path to reporting, "$user"',
        'postgres',
      ),
      database: 'shop',
      loaded: ['shop'],
    });
    expect(effects).toEqual({
      stale: ['shop'],
      dropped: [],
      databaseList: true,
      session: { searchPath: ['reporting', '$user'] },
    });
  });

  it('tells created, altered and dropped databases apart', () => {
    const effects = effectsOfRun({
      dialect: 'mysql',
      statements: statements(
        'create database if not exists audit; alter schema hr character set utf8mb4; ' +
          'drop database if exists `crm`; create table crm.t (id int)',
        'mysql',
      ),
      database: 'shop',
      loaded: ['shop', 'crm', 'hr'],
    });
    expect(effects).toEqual({
      stale: ['hr', 'shop'],
      dropped: ['crm'],
      databaseList: true,
      session: undefined,
    });
  });
});

describe('sessionChangeOf', () => {
  it('reads USE in MySQL and MariaDB', () => {
    expect(sessionChangeOf('USE crm', 'mysql')).toEqual({ kind: 'database', database: 'crm' });
    expect(sessionChangeOf('use `my db`;', 'mariadb')).toEqual({
      kind: 'database',
      database: 'my db',
    });
    expect(sessionChangeOf('select 1', 'mysql')).toBeUndefined();
  });

  it('reads the PostgreSQL search path forms', () => {
    expect(sessionChangeOf('SET search_path TO Sales, "Mixed", \'$user\'', 'postgres')).toEqual({
      kind: 'search-path',
      searchPath: ['sales', 'Mixed', '$user'],
    });
    expect(sessionChangeOf('set session search_path = a', 'postgres')).toEqual({
      kind: 'search-path',
      searchPath: ['a'],
    });
    expect(sessionChangeOf("SET SCHEMA 'app'", 'postgres')).toEqual({
      kind: 'search-path',
      searchPath: ['app'],
    });
    expect(sessionChangeOf('set search_path to default', 'postgres')).toEqual({
      kind: 'search-path',
      searchPath: 'default',
    });
    expect(sessionChangeOf('RESET ALL', 'postgres')).toEqual({
      kind: 'search-path',
      searchPath: 'default',
    });
    // Transaction-scoped, and other settings, change nothing that lasts.
    expect(sessionChangeOf('SET LOCAL search_path TO a', 'postgres')).toBeUndefined();
    expect(sessionChangeOf('SET work_mem = 1024', 'postgres')).toBeUndefined();
  });
});

describe('qualifierBefore', () => {
  it('finds the qualifier of the name being typed', () => {
    expect(qualifierBefore('SELECT * FROM crm.')).toBe('crm');
    expect(qualifierBefore('SELECT * FROM crm.lea')).toBe('crm');
    expect(qualifierBefore('SELECT * FROM `my ``db`` 2`.`le')).toBe('my `db` 2');
    expect(qualifierBefore('SELECT * FROM données.t')).toBe('données');
    expect(qualifierBefore('SELECT * FROM crm')).toBeUndefined();
  });
});

describe('tabFacts', () => {
  it('lays a tab`s own USE and search path over the connection`s facts', () => {
    const connection: ConnectionFacts = { ...PG_FACTS, lowerCaseTableNames: 1 };
    expect(tabFacts(connection)).toEqual({
      database: 'shop',
      searchPath: ['public'],
      user: 'app',
      lowerCaseTableNames: 1,
    });
    expect(tabFacts(connection, { searchPath: ['sales'] })).toMatchObject({
      searchPath: ['sales'],
    });
    expect(tabFacts(connection, { searchPath: 'default' })).toMatchObject({
      searchPath: ['public'],
    });
    expect(tabFacts(MY_FACTS, { database: 'crm' })).toMatchObject({ database: 'crm' });
    expect(tabFacts(undefined)).toEqual({});
  });
});

describe('readConnectionFacts', () => {
  it('reads PostgreSQL`s database, search path and user in one query', async () => {
    const queries: string[] = [];
    const facts = await readConnectionFacts('postgres', async (sql) => {
      queries.push(sql);
      return [['shop', '["app","public"]', 'app']];
    });
    expect(facts).toEqual({ database: 'shop', searchPath: ['app', 'public'], user: 'app' });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('current_schemas(false)');
  });

  it('reads MySQL`s database, lower_case_table_names and database list', async () => {
    const facts = await readConnectionFacts('mysql', async (sql) =>
      sql.includes('SCHEMATA') ? [['crm'], ['shop']] : [[null, 1n]],
    );
    expect(facts).toEqual({ lowerCaseTableNames: 1, databases: ['crm', 'shop'] });
  });
});
