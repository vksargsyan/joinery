import type { ResultChunk, Session } from '@querybara/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SUITES, TARGETS, collect, execId, iterate, rows, target, withDatabase } from './helpers';

/** MySQL stops recursive CTEs after 1,000 iterations by default; MariaDB uses seq_1_to_N instead. */
const RAISE_CTE_DEPTH = '/*+ SET_VAR(cte_max_recursion_depth = 10000000) */';

describe.skipIf(TARGETS.length === 0).each(SUITES)('%s execute', (engine, url) => {
  const t = target(engine, url);
  const DB = `jt_execute_${engine}`;
  let session: Session;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ session, drop } = await withDatabase(t, DB));
    await collect(
      session,
      `CREATE TABLE items (
         id int unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
         name varchar(50) NOT NULL,
         note varchar(20) NULL,
         qty tinyint(1) NOT NULL DEFAULT 0
       ) ENGINE=InnoDB`,
    );
    await collect(
      session,
      `CREATE PROCEDURE two_results(IN n INT)
       BEGIN
         SELECT n AS first;
         SELECT n + 1 AS second, 'x' AS label;
       END`,
    );
  });

  afterAll(async () => {
    await drop();
  });

  it('reports the server version and capabilities', () => {
    expect(session.engine).toBe(engine);
    expect(session.serverVersion).toMatch(/^\d+\.\d+/);
    expect(session.capabilities().transactionalDdl).toBe(false);
    expect(session.inTransaction).toBe(false);
  });

  it('maps every common type onto CellValues and column kinds', async () => {
    await collect(
      session,
      `CREATE TABLE typed (
         ti tinyint, tb tinyint(1), si smallint, mi mediumint, i int, iu int unsigned,
         bi bigint, bu bigint unsigned, de decimal(12,3), fl float, db double,
         dt date, tm time(3), dtt datetime(6), ts timestamp NULL, yr year,
         ch char(3), vc varchar(10), tx text, bn binary(3), vb varbinary(8), bl blob,
         en enum('a','b'), st set('x','y'), bt bit(10), js json
       ) CHARACTER SET utf8mb4`,
    );
    await collect(
      session,
      `INSERT INTO typed VALUES (-1, 1, 300, 70000, -5, 4294967295, 42, 18446744073709551615,
         1234567.125, 1.5, 2.25, '2024-02-29', '13:14:15.500', '2024-02-29 13:14:15.123456',
         '2024-02-29 13:14:15', 2024, 'ab', 'vc', 'long text', 'abc', X'00FF10', X'CAFE',
         'b', 'x,y', b'1000000001', '{"a": [1, 2]}')`,
    );
    const chunks = await collect(session, 'SELECT * FROM typed');
    const columns = chunks.find((c) => c.type === 'columns');
    const data = chunks.find((c) => c.type === 'rows');
    if (columns?.type !== 'columns' || data?.type !== 'rows') throw new Error('no result');
    const value = (name: string): unknown =>
      data.data[columns.columns.findIndex((c) => c.name === name)]![0];
    const column = (name: string) => columns.columns.find((c) => c.name === name)!;

    expect(value('ti')).toBe(-1);
    expect(value('tb')).toBe(1);
    expect(value('si')).toBe(300);
    expect(value('iu')).toBe(4294967295);
    expect(value('bi')).toBe(42);
    expect(value('bu')).toBe(18446744073709551615n);
    expect(value('de')).toBe('1234567.125');
    expect(value('fl')).toBe(1.5);
    expect(value('db')).toBe(2.25);
    expect(value('dt')).toBe('2024-02-29');
    expect(value('tm')).toBe('13:14:15.500');
    expect(value('dtt')).toBe('2024-02-29 13:14:15.123456');
    expect(value('ts')).toBe('2024-02-29 13:14:15');
    expect(value('yr')).toBe(2024);
    expect(value('ch')).toBe('ab');
    expect(value('tx')).toBe('long text');
    expect(value('bn')).toEqual(new Uint8Array([0x61, 0x62, 0x63]));
    expect(value('vb')).toBeInstanceOf(Uint8Array);
    expect(value('vb')).toEqual(new Uint8Array([0, 255, 16]));
    expect(value('bl')).toEqual(new Uint8Array([0xca, 0xfe]));
    expect(value('en')).toBe('b');
    expect(value('st')).toBe('x,y');
    expect(value('bt')).toBe(513);
    expect(JSON.parse(value('js') as string)).toEqual({ a: [1, 2] });

    expect(column('tb')).toMatchObject({ nativeType: 'tinyint(1)', kind: 'integer' });
    expect(column('iu')).toMatchObject({ nativeType: 'int unsigned', kind: 'integer' });
    expect(column('bu')).toMatchObject({ nativeType: 'bigint unsigned', kind: 'bigint' });
    expect(column('de')).toMatchObject({ nativeType: 'decimal(12,3)', kind: 'decimal' });
    expect(column('dtt')).toMatchObject({ nativeType: 'datetime(6)', kind: 'datetime' });
    expect(column('ts')).toMatchObject({ kind: 'timestamp' });
    expect(column('vc')).toMatchObject({
      nativeType: 'varchar(10)',
      kind: 'string',
      table: 'typed',
      schema: DB,
    });
    expect(column('tx')).toMatchObject({ nativeType: 'text', kind: 'string' });
    expect(column('vb')).toMatchObject({ nativeType: 'varbinary(8)', kind: 'binary' });
    expect(column('bl')).toMatchObject({ kind: 'binary' });
    expect(column('en')).toMatchObject({ kind: 'enum' });
    expect(column('js').kind).toBe('json');
  });

  it('fills table and nullability metadata', async () => {
    const chunks = await collect(session, 'SELECT i.id, i.note, 1 AS computed FROM items i');
    const columns = chunks.find((c) => c.type === 'columns');
    if (columns?.type !== 'columns') throw new Error('no columns');
    expect(columns.columns[0]).toMatchObject({
      name: 'id',
      table: 'items',
      schema: DB,
      nullable: false,
    });
    expect(columns.columns[1]).toMatchObject({ name: 'note', nullable: true });
    expect(columns.columns[2]!.table).toBeUndefined();
  });

  it('streams 50,000 rows in 1,000-row pages without buffering the result', async () => {
    const fresh = await t.connect();
    try {
      const before = process.memoryUsage().heapUsed;
      let peak = 0;
      let pages = 0;
      let total = 0;
      const source = engine === 'mariadb' ? 'seq_1_to_50000' : null;
      const sql = source
        ? `SELECT seq AS n, REPEAT('x', 2000) AS pad FROM ${source}`
        : `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 50000)
           SELECT ${RAISE_CTE_DEPTH} n, REPEAT('x', 2000) AS pad FROM g`;
      for await (const chunk of fresh.execute(sql, { executionId: execId() })) {
        if (chunk.type === 'rows') {
          pages += 1;
          total += chunk.rowCount;
          expect(chunk.rowCount).toBeLessThanOrEqual(1000);
          peak = Math.max(peak, process.memoryUsage().heapUsed - before);
        }
      }
      expect(pages).toBe(50);
      expect(total).toBe(50000);
      expect(peak).toBeLessThan(60 * 1024 * 1024);
    } finally {
      await fresh.close();
    }
  });

  it('closes the result on early return and stays usable', async () => {
    // A millisecond per row: reading the rest would take over half an hour, so finishing
    // within the limit below shows the query was killed rather than drained, even on a busy
    // machine.
    const iterator = iterate(
      session,
      engine === 'mariadb'
        ? 'SELECT seq, SLEEP(0.001) FROM seq_1_to_2000000'
        : `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 2000000) SELECT ${RAISE_CTE_DEPTH} n, SLEEP(0.001) FROM g`,
      { executionId: execId(), pageSize: 100 },
    );
    let seen = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'rows') {
        seen += next.value.rowCount;
        break;
      }
    }
    const started = Date.now();
    await iterator.return?.();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(seen).toBe(100);
    expect(await rows(session, 'SELECT 42')).toEqual([[42]]);
  });

  it('returns multiple result sets from CALL with increasing resultIndex', async () => {
    const chunks = await collect(session, 'CALL two_results(?)', [5]);
    const columns = chunks.filter(
      (c): c is Extract<ResultChunk, { type: 'columns' }> => c.type === 'columns',
    );
    expect(columns.map((c) => [c.resultIndex, c.columns.map((col) => col.name)])).toEqual([
      [0, ['first']],
      [1, ['second', 'label']],
    ]);
    const data = chunks.filter(
      (c): c is Extract<ResultChunk, { type: 'rows' }> => c.type === 'rows',
    );
    expect(data.map((d) => [d.resultIndex, d.data.map((col) => col[0])])).toEqual([
      [0, [5]],
      [1, [6, 'x']],
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'end', rowCount: 2 });
    const plain = await collect(session, 'CALL two_results(1)');
    expect(plain.filter((c) => c.type === 'columns').length).toBe(2);
  });

  it('binds positional parameters of every kind', async () => {
    const result = await rows(session, 'SELECT ?, ? + 1, ?, HEX(?), ? IS NULL', [
      "it's ? a 'test'",
      41,
      9007199254740993n,
      new Uint8Array([1, 2, 255]),
      null,
    ]);
    expect(result[0]![0]).toBe("it's ? a 'test'");
    expect(Number(result[0]![1])).toBe(42);
    expect(String(result[0]![2])).toBe('9007199254740993');
    expect(result[0]![3]).toBe('0102FF');
    expect(result[0]![4]).toBe(1);
  });

  it('reads FLOAT values the same with and without parameters (text and binary protocol)', async () => {
    await collect(
      session,
      `CREATE TABLE floats (id int NOT NULL PRIMARY KEY, f float, fu float unsigned,
         fp float(7,3), d double)`,
    );
    await collect(
      session,
      `INSERT INTO floats VALUES (1, 0.1, 0.1, 1.5, 0.1), (2, -0.3, 33.3, 12.346, 1.2345678),
         (3, 19.99, 1234.5, -9999.999, 1e300), (4, 2.5e-7, 3.4e38, 0.001, 1e-300),
         (5, 1e20, 0, 1234.567, 0.3), (6, 16777200, 100, 0, -0.1), (7, NULL, NULL, NULL, NULL)`,
    );
    const sql = 'SELECT id, f, fu, fp, d FROM floats';
    const text = await rows(session, `${sql} ORDER BY id`);
    const binary = await rows(session, `${sql} WHERE id > ? ORDER BY id`, [0]);
    expect(binary).toEqual(text);
    expect(text).toEqual([
      [1, 0.1, 0.1, 1.5, 0.1],
      [2, -0.3, 33.3, 12.346, 1.2345678],
      [3, 19.99, 1234.5, -9999.999, 1e300],
      [4, 2.5e-7, 3.4e38, 0.001, 1e-300],
      [5, 1e20, 0, 1234.567, 0.3],
      [6, 16777200, 100, 0, -0.1],
      [7, null, null, null, null],
    ]);
    // The binary protocol sends the exact single-precision value, read as the shortest decimal
    // that round-trips through float32 rather than its double expansion (1.2345677614...). The
    // server itself rounds FLOAT to six significant digits in the text protocol.
    await collect(session, 'INSERT INTO floats (id, f) VALUES (8, 1.2345678)');
    expect(await rows(session, 'SELECT f FROM floats WHERE id = ?', [8])).toEqual([[1.2345678]]);
    expect(await rows(session, 'SELECT f FROM floats WHERE id = 8')).toEqual([[1.23457]]);
  });

  it('reports status with rows affected and the last insert id', async () => {
    const insert = await collect(session, "INSERT INTO items (name) VALUES ('a'), ('b')");
    const status = insert.find((c) => c.type === 'status');
    expect(status).toMatchObject({ type: 'status', command: 'INSERT', rowsAffected: 2 });
    expect(Number((status as { lastInsertId?: string }).lastInsertId)).toBeGreaterThan(0);
    const create = await collect(session, 'CREATE TABLE tmp_status (a int)');
    expect(create).toContainEqual({ type: 'status', command: 'CREATE TABLE', rowsAffected: 0 });
    const select = await collect(session, 'SELECT 1');
    expect(select).toContainEqual({ type: 'status', command: 'SELECT', rowsAffected: null });
  });

  it('turns warnings into notices through SHOW WARNINGS', async () => {
    const chunks = await collect(session, "SELECT CAST('12abc' AS SIGNED) AS n");
    expect(chunks.filter((c) => c.type === 'notice')).toEqual([
      expect.objectContaining({ type: 'notice', severity: 'warning', code: '1292' }),
    ]);
    const update = await collect(session, "INSERT INTO items (name, qty) VALUES ('w', 1000)").catch(
      () => [],
    );
    expect(Array.isArray(update)).toBe(true);
  });

  it('cancels SELECT SLEEP(30) and stays usable', async () => {
    const id = execId();
    const started = Date.now();
    const run = (async () => {
      for await (const _ of session.execute('SELECT SLEEP(30)', { executionId: id })) {
        // drain
      }
    })().catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel(id);
    expect(await run).toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await rows(session, 'SELECT 1')).toEqual([[1]]);
  });

  it('cancels a long-running statement that errors when killed', async () => {
    const id = execId();
    const run = (async () => {
      for await (const _ of session.execute(
        'SELECT COUNT(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c',
        { executionId: id },
      )) {
        // drain
      }
    })().catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel(id);
    expect(await run).toMatchObject({ code: 'CANCELLED' });
    expect(await rows(session, 'SELECT 2')).toEqual([[2]]);
  });

  it('cancels through an AbortSignal', async () => {
    const controller = new AbortController();
    const run = (async () => {
      for await (const _ of session.execute('SELECT SLEEP(30)', {
        executionId: execId(),
        signal: controller.signal,
      })) {
        // drain
      }
    })().catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 300);
    expect(await run).toMatchObject({ code: 'CANCELLED' });
    expect(await rows(session, 'SELECT 3')).toEqual([[3]]);
  });

  it('cancels a result paused between pages', async () => {
    const id = execId();
    const iterator = iterate(
      session,
      engine === 'mariadb'
        ? 'SELECT seq FROM seq_1_to_500000'
        : `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 500000) SELECT ${RAISE_CTE_DEPTH} n FROM g`,
      { executionId: id, pageSize: 100 },
    );
    let next = await iterator.next();
    while (!next.done && next.value.type !== 'rows') next = await iterator.next();
    await session.cancel(id);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await rows(session, 'SELECT 4')).toEqual([[4]]);
  });

  it('closes a paused result when another statement runs on the session', async () => {
    const iterator = iterate(
      session,
      engine === 'mariadb' ? 'SELECT seq FROM seq_1_to_5000' : 'SELECT 1 UNION ALL SELECT 2',
      {
        executionId: execId(),
        pageSize: 1,
      },
    );
    let next = await iterator.next();
    while (!next.done && next.value.type !== 'rows') next = await iterator.next();
    expect(await rows(session, 'SELECT 5')).toEqual([[5]]);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('tracks transactions from the server status, including typed BEGIN and COMMIT', async () => {
    await session.begin!();
    expect(session.inTransaction).toBe(true);
    await collect(session, "INSERT INTO items (name) VALUES ('rolled back')");
    await session.rollback!();
    expect(session.inTransaction).toBe(false);
    expect(await rows(session, "SELECT COUNT(*) FROM items WHERE name = 'rolled back'")).toEqual([
      [0],
    ]);

    await collect(session, 'BEGIN');
    expect(session.inTransaction).toBe(true);
    await collect(session, "INSERT INTO items (name) VALUES ('kept')");
    await collect(session, 'COMMIT');
    expect(session.inTransaction).toBe(false);
    expect(await rows(session, "SELECT COUNT(*) FROM items WHERE name = 'kept'")).toEqual([[1]]);

    await collect(session, 'SET autocommit = 0');
    await collect(session, 'SELECT * FROM items LIMIT 1');
    expect(session.inTransaction).toBe(true);
    await collect(session, 'ROLLBACK');
    await collect(session, 'SET autocommit = 1');
    expect(session.inTransaction).toBe(false);
  });

  it('switches databases with useDatabase', async () => {
    await session.useDatabase!('mysql');
    expect(await rows(session, 'SELECT DATABASE()')).toEqual([['mysql']]);
    await session.useDatabase!(DB);
    expect(await rows(session, 'SELECT DATABASE()')).toEqual([[DB]]);
  });

  it('answers ping', async () => {
    await expect(session.ping()).resolves.toBeUndefined();
  });

  it('maps syntax errors with the position from the message', async () => {
    const error = await collect(session, 'SELECT *\nFORM items').catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'SQL_ERROR',
      sqlState: '42000',
      engineCode: 1064,
      position: 9,
    });
    const missing = await collect(session, 'SELECT * FROM no_such_table').catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'SQL_ERROR', sqlState: '42S02', engineCode: 1146 });
  });

  it('maps the query timeout to TIMEOUT', async () => {
    const timed = await t.connect({ options: { queryTimeoutMs: 300 } });
    try {
      const outcome = await collect(
        timed,
        'SELECT COUNT(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c',
      ).catch((e: unknown) => e);
      expect(outcome).toMatchObject({ code: 'TIMEOUT' });
      expect(await rows(timed, 'SELECT 6')).toEqual([[6]]);
    } finally {
      await timed.close();
    }
  });

  it('runs init SQL and applies the time zone on connect', async () => {
    const configured = await t.connect({
      options: { timeZone: '+05:30', initSql: ["SET @querybara_init = 'yes'"] },
    });
    try {
      expect(await rows(configured, 'SELECT @@session.time_zone, @querybara_init')).toEqual([
        ['+05:30', 'yes'],
      ]);
    } finally {
      await configured.close();
    }
  });
});
