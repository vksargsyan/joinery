import { JoineryError, type ResultChunk, type Session } from '@joinery/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG_URL, collect, connect, execId, iterate, rows } from './helpers';

const SCHEMA = 'jt_execute';

describe.skipIf(!PG_URL)('PostgreSQL execute', () => {
  let session: Session;

  beforeAll(async () => {
    session = await connect();
    await collect(session, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await collect(session, `CREATE SCHEMA ${SCHEMA}`);
    await collect(session, `CREATE TYPE ${SCHEMA}.mood AS ENUM ('sad', 'happy')`);
    await collect(
      session,
      `CREATE TABLE ${SCHEMA}.items (id serial PRIMARY KEY, name text NOT NULL, mood ${SCHEMA}.mood, note varchar(20))`,
    );
  });

  afterAll(async () => {
    await collect(session, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await session.close();
  });

  it('reports the server version and capabilities', () => {
    expect(session.engine).toBe('postgres');
    expect(session.serverVersion).toMatch(/^\d+\.\d+/);
    expect(session.capabilities().transactionalDdl).toBe(true);
    expect(session.inTransaction).toBe(false);
  });

  it('maps every common type onto CellValues and column kinds', async () => {
    const chunks = await collect(
      session,
      `SELECT 1::int2 AS i2, 2::int4 AS i4, 3::int8 AS i8_small, 9223372036854775807::int8 AS i8_big,
         12345678901234567890.12345::numeric AS num, 1.5::float4 AS f4, 'NaN'::float8 AS nan,
         'Infinity'::float8 AS inf, true AS b, 'text'::text AS t, 'vc'::varchar(10) AS vc, 'c'::char(3) AS ch,
         '2024-02-29'::date AS d, '13:14:15.5'::time AS tm, '13:14:15+02'::timetz AS tmz,
         '2024-02-29 13:14:15.123456'::timestamp AS ts, '2024-02-29 13:14:15+00'::timestamptz AS tstz,
         '1 day 02:03:04'::interval AS iv, '{"a": [1, 2]}'::json AS j, '{"b": 1}'::jsonb AS jb,
         'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS u, '\\x00ff10'::bytea AS by,
         ARRAY[1, 2, 3] AS arr, ARRAY['x', NULL] AS tarr, '192.168.0.1/24'::inet AS ip,
         'happy'::${SCHEMA}.mood AS mood, NULL::int AS nothing, 12.30::numeric(10,2) AS money2`,
    );
    const columns = chunks.find((c) => c.type === 'columns');
    const data = chunks.find((c) => c.type === 'rows');
    if (columns?.type !== 'columns' || data?.type !== 'rows') throw new Error('no result');
    const value = (name: string): unknown =>
      data.data[columns.columns.findIndex((c) => c.name === name)]![0];
    const column = (name: string) => columns.columns.find((c) => c.name === name)!;

    expect(value('i2')).toBe(1);
    expect(value('i4')).toBe(2);
    expect(value('i8_small')).toBe(3);
    expect(value('i8_big')).toBe(9223372036854775807n);
    expect(value('num')).toBe('12345678901234567890.12345');
    expect(value('f4')).toBe(1.5);
    expect(value('nan')).toBeNaN();
    expect(value('inf')).toBe(Infinity);
    expect(value('b')).toBe(true);
    expect(value('t')).toBe('text');
    expect(value('ch')).toBe('c  ');
    expect(value('d')).toBe('2024-02-29');
    expect(value('tm')).toBe('13:14:15.5');
    expect(value('tmz')).toBe('13:14:15+02');
    expect(value('ts')).toBe('2024-02-29 13:14:15.123456');
    expect(typeof value('tstz')).toBe('string');
    expect(value('iv')).toBe('1 day 02:03:04');
    expect(value('j')).toBe('{"a": [1, 2]}');
    expect(value('jb')).toBe('{"b": 1}');
    expect(value('u')).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(value('by')).toEqual(new Uint8Array([0, 255, 16]));
    expect(value('by')).toBeInstanceOf(Uint8Array);
    expect(value('arr')).toBe('{1,2,3}');
    expect(value('tarr')).toBe('{x,NULL}');
    expect(value('ip')).toBe('192.168.0.1/24');
    expect(value('mood')).toBe('happy');
    expect(value('nothing')).toBeNull();
    expect(value('money2')).toBe('12.30');

    expect(column('i2')).toMatchObject({ nativeType: 'int2', kind: 'integer' });
    expect(column('i8_big')).toMatchObject({ nativeType: 'int8', kind: 'bigint' });
    expect(column('num')).toMatchObject({ nativeType: 'numeric', kind: 'decimal' });
    expect(column('money2')).toMatchObject({ nativeType: 'numeric(10,2)', kind: 'decimal' });
    expect(column('vc')).toMatchObject({ nativeType: 'varchar(10)', kind: 'string' });
    expect(column('ch')).toMatchObject({ nativeType: 'bpchar(3)' });
    expect(column('ts')).toMatchObject({ kind: 'datetime' });
    expect(column('tstz')).toMatchObject({ nativeType: 'timestamptz', kind: 'timestamp' });
    expect(column('iv')).toMatchObject({ kind: 'interval' });
    expect(column('jb')).toMatchObject({ nativeType: 'jsonb', kind: 'json' });
    expect(column('u')).toMatchObject({ kind: 'uuid' });
    expect(column('by')).toMatchObject({ kind: 'binary' });
    expect(column('arr')).toMatchObject({ nativeType: 'int4[]', kind: 'array' });
    expect(column('mood')).toMatchObject({ nativeType: 'mood', kind: 'enum' });
  });

  it('fills table, schema and nullability for columns from a table', async () => {
    await collect(session, `INSERT INTO ${SCHEMA}.items (name, mood) VALUES ('a', 'sad')`);
    const chunks = await collect(
      session,
      `SELECT i.id, i.name, i.note, 1 AS computed FROM ${SCHEMA}.items i`,
    );
    const columns = chunks.find((c) => c.type === 'columns');
    if (columns?.type !== 'columns') throw new Error('no columns');
    expect(columns.columns[0]).toMatchObject({
      name: 'id',
      table: 'items',
      schema: SCHEMA,
      nullable: false,
    });
    expect(columns.columns[1]).toMatchObject({ name: 'name', table: 'items', nullable: false });
    expect(columns.columns[2]).toMatchObject({ name: 'note', nullable: true });
    expect(columns.columns[3]!.table).toBeUndefined();
  });

  it('streams 50,000 rows in 1,000-row pages without buffering the result', async () => {
    const fresh = await connect();
    try {
      const before = process.memoryUsage().heapUsed;
      let peak = 0;
      let pages = 0;
      let total = 0;
      // ~2 KB per row: 100 MB if the whole result were held at once.
      for await (const chunk of fresh.execute(
        `SELECT g AS n, repeat('x', 2000) AS pad FROM generate_series(1, 50000) g`,
        { executionId: execId() },
      )) {
        if (chunk.type === 'rows') {
          pages += 1;
          total += chunk.rowCount;
          expect(chunk.rowCount).toBeLessThanOrEqual(1000);
          peak = Math.max(peak, process.memoryUsage().heapUsed - before);
        }
        if (chunk.type === 'end') expect(chunk.rowCount).toBe(50000);
      }
      expect(pages).toBe(50);
      expect(total).toBe(50000);
      expect(peak).toBeLessThan(60 * 1024 * 1024);
    } finally {
      await fresh.close();
    }
  });

  it('keeps the portal open across the metadata lookup on the first page', async () => {
    const fresh = await connect();
    try {
      await collect(
        fresh,
        `CREATE TEMP TABLE many AS SELECT g AS n FROM generate_series(1, 2500) g`,
      );
      let total = 0;
      let table: string | undefined;
      for await (const chunk of fresh.execute('SELECT n FROM many ORDER BY n', {
        executionId: execId(),
        pageSize: 1000,
      })) {
        if (chunk.type === 'columns') table = chunk.columns[0]!.table;
        if (chunk.type === 'rows') total += chunk.rowCount;
      }
      expect(table).toBe('many');
      expect(total).toBe(2500);
    } finally {
      await fresh.close();
    }
  });

  it('closes the cursor on early return and stays usable', async () => {
    const iterator = iterate(session, 'SELECT g FROM generate_series(1, 100000) g', {
      executionId: execId(),
      pageSize: 100,
    });
    let seen = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'rows') {
        seen += next.value.rowCount;
        break;
      }
    }
    await iterator.return?.();
    expect(seen).toBe(100);
    expect(session.inTransaction).toBe(false);
    expect(await rows(session, 'SELECT 42')).toEqual([[42]]);
  });

  it('resumes a paused result when the consumer pulls again (fetch more)', async () => {
    const iterator = iterate(session, 'SELECT g FROM generate_series(1, 30) g', {
      executionId: execId(),
      pageSize: 10,
    });
    const firstRows: ResultChunk[] = [];
    while (firstRows.length < 1) {
      const next = await iterator.next();
      if (!next.done && next.value.type === 'rows') firstRows.push(next.value);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    let rest = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'rows') rest += next.value.rowCount;
    }
    expect(rest).toBe(20);
  });

  it('binds positional parameters of every kind', async () => {
    const result = await rows(
      session,
      'SELECT $1::text, $2::int4, $3::int8, $4::bytea, $5::bool, $6::text IS NULL, $7::float8',
      ["it's", 7, 9007199254740993n, new Uint8Array([1, 2, 3]), true, null, 2.5],
    );
    expect(result).toEqual([
      ["it's", 7, 9007199254740993n, new Uint8Array([1, 2, 3]), true, true, 2.5],
    ]);
  });

  it('rejects named parameters', async () => {
    const run = async () => {
      for await (const _ of session.execute('SELECT 1', {
        executionId: execId(),
        params: { a: 1 },
      })) {
        // drain
      }
    };
    await expect(run()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('reports status with the full command tag and rows affected', async () => {
    const insert = await collect(session, `INSERT INTO ${SCHEMA}.items (name) VALUES ('b'), ('c')`);
    expect(insert).toContainEqual({ type: 'status', command: 'INSERT', rowsAffected: 2 });
    const create = await collect(session, `CREATE TABLE ${SCHEMA}.tmp_status (a int)`);
    expect(create).toContainEqual({ type: 'status', command: 'CREATE TABLE', rowsAffected: null });
    const returning = await collect(
      session,
      `UPDATE ${SCHEMA}.items SET note = 'x' WHERE name IN ('b', 'c') RETURNING id`,
    );
    expect(returning).toContainEqual({ type: 'status', command: 'UPDATE', rowsAffected: 2 });
    const end = returning.at(-1);
    expect(end).toMatchObject({ type: 'end', rowCount: 2 });
  });

  it('emits NOTICE and WARNING messages as notices', async () => {
    const chunks = await collect(
      session,
      `DO $$ BEGIN RAISE NOTICE 'hello %', 1; RAISE WARNING 'careful' USING HINT = 'look'; END $$`,
    );
    const notices = chunks.filter((c) => c.type === 'notice');
    expect(notices).toEqual([
      { type: 'notice', severity: 'notice', message: 'hello 1', code: '00000' },
      { type: 'notice', severity: 'warning', message: 'careful\nHINT: look', code: '01000' },
    ]);
    expect(chunks.at(-1)?.type).toBe('end');
  });

  it('cancels a running statement and stays usable', async () => {
    const id = execId();
    const started = Date.now();
    const run = (async () => {
      for await (const _ of session.execute('SELECT pg_sleep(30)', { executionId: id })) {
        // drain
      }
    })().catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel(id);
    expect(await run).toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await rows(session, 'SELECT 1')).toEqual([[1]]);
  });

  it('cancels through an AbortSignal', async () => {
    const controller = new AbortController();
    const run = (async () => {
      for await (const _ of session.execute('SELECT pg_sleep(30)', {
        executionId: execId(),
        signal: controller.signal,
      })) {
        // drain
      }
    })().catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 300);
    expect(await run).toMatchObject({ code: 'CANCELLED' });
    expect(await rows(session, 'SELECT 2')).toEqual([[2]]);
  });

  it('cancels a result paused between pages', async () => {
    const id = execId();
    const iterator = iterate(session, 'SELECT g FROM generate_series(1, 5000) g', {
      executionId: id,
      pageSize: 100,
    });
    let next = await iterator.next();
    while (!next.done && next.value.type !== 'rows') next = await iterator.next();
    await session.cancel(id);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await rows(session, 'SELECT 3')).toEqual([[3]]);
  });

  it('closes a paused result when another statement runs on the session', async () => {
    const iterator = iterate(session, 'SELECT g FROM generate_series(1, 5000) g', {
      executionId: execId(),
      pageSize: 100,
    });
    let next = await iterator.next();
    while (!next.done && next.value.type !== 'rows') next = await iterator.next();
    expect(await rows(session, 'SELECT 4')).toEqual([[4]]);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('tracks explicit transactions, including BEGIN and COMMIT typed as SQL', async () => {
    await session.begin!();
    expect(session.inTransaction).toBe(true);
    await collect(session, `INSERT INTO ${SCHEMA}.items (name) VALUES ('rolled back')`);
    await session.rollback!();
    expect(session.inTransaction).toBe(false);
    expect(
      await rows(session, `SELECT count(*) FROM ${SCHEMA}.items WHERE name = 'rolled back'`),
    ).toEqual([[0]]);

    await collect(session, 'BEGIN');
    expect(session.inTransaction).toBe(true);
    await expect(collect(session, 'SELECT 1/0')).rejects.toMatchObject({
      code: 'SQL_ERROR',
      sqlState: '22012',
    });
    expect(session.inTransaction).toBe(true);
    await collect(session, 'ROLLBACK');
    expect(session.inTransaction).toBe(false);

    await collect(session, 'START TRANSACTION');
    await collect(session, `INSERT INTO ${SCHEMA}.items (name) VALUES ('kept')`);
    await session.commit!();
    expect(session.inTransaction).toBe(false);
    expect(await rows(session, `SELECT count(*) FROM ${SCHEMA}.items WHERE name = 'kept'`)).toEqual(
      [[1]],
    );
  });

  it('switches search_path with useDatabase', async () => {
    await session.useDatabase!(SCHEMA);
    expect(await rows(session, 'SELECT current_schema()')).toEqual([[SCHEMA]]);
    await session.useDatabase!('public');
  });

  it('answers ping', async () => {
    await expect(session.ping()).resolves.toBeUndefined();
  });

  it('maps SQL errors with SQLSTATE and a 0-based position', async () => {
    const error = await collect(session, 'SELECT * FORM items').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JoineryError);
    expect(error).toMatchObject({ code: 'SQL_ERROR', sqlState: '42601', position: 9 });

    // Positions count characters, not UTF-16 units: the emoji is two units.
    const text = "SELECT '😀', nope FROM (SELECT 1) s";
    const unicode = (await collect(session, text).catch((e: unknown) => e)) as JoineryError;
    expect(unicode.code).toBe('SQL_ERROR');
    expect(text.slice(unicode.position)).toMatch(/^nope/);

    const missing = (await collect(session, 'SELECT * FROM no_such_table').catch(
      (e: unknown) => e,
    )) as JoineryError;
    expect(missing).toMatchObject({ code: 'SQL_ERROR', sqlState: '42P01', position: 14 });
  });

  it('maps statement_timeout to TIMEOUT', async () => {
    const timed = await connect({ options: { queryTimeoutMs: 200 } });
    try {
      await expect(collect(timed, 'SELECT pg_sleep(5)')).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(await rows(timed, 'SELECT 5')).toEqual([[5]]);
    } finally {
      await timed.close();
    }
  });

  it('runs init SQL and applies the time zone on connect', async () => {
    const configured = await connect({
      options: { timeZone: 'Asia/Tokyo', initSql: ["SET application_name = 'init-sql'"] },
    });
    try {
      expect(await rows(configured, 'SHOW TimeZone')).toEqual([['Asia/Tokyo']]);
      expect(await rows(configured, 'SHOW application_name')).toEqual([['init-sql']]);
    } finally {
      await configured.close();
    }
  });

  it('refuses COPY FROM STDIN cleanly', async () => {
    await expect(collect(session, `COPY ${SCHEMA}.items (name) FROM STDIN`)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    expect(await rows(session, 'SELECT 6')).toEqual([[6]]);
  });
});
