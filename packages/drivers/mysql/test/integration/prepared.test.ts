import type { Session } from '@querybara/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PREPARED_STATEMENT_LIMIT } from '../../src/session';
import { SUITES, TARGETS, collect, execId, rows, target, withDatabase } from './helpers';

/** A session status counter (Com_stmt_prepare, Com_stmt_close...), read over the text protocol. */
async function counter(session: Session, name: string): Promise<number> {
  const [row] = await rows(session, `SHOW SESSION STATUS LIKE '${name}'`);
  return Number(row?.[1]);
}

/** How much `name` grows while `work` runs. */
async function growth(
  session: Session,
  name: string,
  work: () => Promise<unknown>,
): Promise<number> {
  const before = await counter(session, name);
  await work();
  return (await counter(session, name)) - before;
}

/**
 * Statements the client prepared while `work` runs, and the ones the server re-prepared by
 * itself (after a table changed), which Com_stmt_prepare counts too.
 */
async function prepares(
  session: Session,
  work: () => Promise<unknown>,
): Promise<{ client: number; server: number }> {
  let server = 0;
  const total = await growth(session, 'Com_stmt_prepare', async () => {
    server = await growth(session, 'Com_stmt_reprepare', work);
  });
  return { client: total - server, server };
}

describe.skipIf(TARGETS.length === 0).each(SUITES)('%s prepared statements', (engine, url) => {
  const t = target(engine, url);
  const DB = `jt_prepared_${engine}`;
  const OTHER = `jt_prepared_${engine}_other`;
  let session: Session;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ session, drop } = await withDatabase(t, DB));
    await collect(session, 'CREATE TABLE t (id int NOT NULL PRIMARY KEY, v int NOT NULL)');
    await collect(session, `DROP DATABASE IF EXISTS \`${OTHER}\``);
    await collect(session, `CREATE DATABASE \`${OTHER}\``);
    await collect(session, `CREATE TABLE \`${OTHER}\`.t (id int NOT NULL PRIMARY KEY, v int)`);
    await collect(session, `INSERT INTO \`${OTHER}\`.t VALUES (1, -1)`);
  });

  afterAll(async () => {
    await collect(session, `DROP DATABASE IF EXISTS \`${OTHER}\``).catch(() => undefined);
    await drop();
  });

  it('prepares a repeated statement once, and it follows ALTER TABLE', async () => {
    const insert = 'INSERT INTO t (id, v) VALUES (?, ?)';
    const inserts = await prepares(session, async () => {
      for (let i = 1; i <= 20; i++) await collect(session, insert, [i, i * 10]);
    });
    expect(inserts).toEqual({ client: 1, server: 0 });

    const select = 'SELECT * FROM t WHERE id = ?';
    const selects = await prepares(session, async () => {
      expect(await rows(session, select, [2])).toEqual([[2, 20]]);
      await collect(session, 'ALTER TABLE t ADD COLUMN w int NOT NULL DEFAULT 7');
      const chunks = await collect(session, select, [2]);
      const columns = chunks.find((c) => c.type === 'columns');
      expect(columns?.type === 'columns' && columns.columns.map((c) => c.name)).toEqual([
        'id',
        'v',
        'w',
      ]);
      expect(await rows(session, select, [2])).toEqual([[2, 20, 7]]);
      await collect(session, 'ALTER TABLE t DROP COLUMN w');
      expect(await rows(session, select, [2])).toEqual([[2, 20]]);
    });
    // Prepared once here; the server re-prepared it after each ALTER TABLE.
    expect(selects).toEqual({ client: 1, server: 2 });
  });

  it(`keeps at most ${PREPARED_STATEMENT_LIMIT} statements, closing the least recently used`, async () => {
    const statement = (i: number): string => `SELECT ? + ${i}`;
    const extra = 6;
    const closes = await growth(session, 'Com_stmt_close', async () => {
      for (let i = 0; i < PREPARED_STATEMENT_LIMIT + extra; i++) {
        expect(await rows(session, statement(i), [1])).toEqual([[1 + i]]);
      }
    });
    expect(closes).toBeGreaterThanOrEqual(extra);
    const newest = await growth(session, 'Com_stmt_prepare', () =>
      rows(session, statement(PREPARED_STATEMENT_LIMIT + extra - 1), [2]),
    );
    expect(newest).toBe(0);
    const evicted = await growth(session, 'Com_stmt_prepare', () =>
      rows(session, statement(0), [2]),
    );
    expect(evicted).toBe(1);
  });

  it('forgets its statements when the database changes', async () => {
    const select = 'SELECT v FROM t WHERE id = ?';
    expect(await rows(session, select, [1])).toEqual([[10]]);
    await session.useDatabase!(OTHER);
    try {
      expect(await rows(session, select, [1])).toEqual([[-1]]);
      await collect(session, `USE \`${DB}\``);
      expect(await rows(session, select, [1])).toEqual([[10]]);
      await collect(session, `USE \`${OTHER}\``);
      expect(await rows(session, select, [1])).toEqual([[-1]]);
    } finally {
      await session.useDatabase!(DB);
    }
    expect(await rows(session, select, [1])).toEqual([[10]]);
  });

  it('forgets its statements when session settings change', async () => {
    const concat = "SELECT ? || 'x' AS r";
    const [[mode]] = (await rows(session, 'SELECT @@SESSION.sql_mode')) as [[string]];
    try {
      await collect(session, "SET SESSION sql_mode = ''");
      expect(await rows(session, concat, ['a'])).toEqual([[0]]);
      await collect(session, "SET SESSION sql_mode = 'PIPES_AS_CONCAT'");
      expect(await rows(session, concat, ['a'])).toEqual([['ax']]);
    } finally {
      await collect(session, 'SET SESSION sql_mode = ?', [mode]);
    }
  });

  it('prepares again after a failed or cancelled execution', async () => {
    const insert = 'INSERT INTO t (id, v) VALUES (?, ?)';
    await collect(session, insert, [100, 1]);
    const duplicate = await collect(session, insert, [100, 2]).catch((e: unknown) => e);
    expect(duplicate).toMatchObject({ engineCode: 1062 });
    const prepares = await growth(session, 'Com_stmt_prepare', () =>
      collect(session, insert, [101, 1]),
    );
    expect(prepares).toBe(1);

    const sleep = 'SELECT SLEEP(?) AS s';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const outcome = await (async () => {
      const chunks = session.execute(sleep, {
        executionId: execId(),
        params: [30],
        signal: controller.signal,
      });
      for await (const _chunk of chunks) {
        // runs until cancelled
      }
    })().catch((e: unknown) => e);
    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(await rows(session, sleep, [0])).toEqual([[0]]);
  });

  it('prepares again when the server no longer knows a kept statement', async () => {
    const select = 'SELECT v FROM t WHERE id = ?';
    expect(await rows(session, select, [1])).toEqual([[10]]);
    // Close the statement on the server behind mysql2's back, as a lost handle would be.
    const internal = session as unknown as {
      connection: { _statements: { get(key: string): { close(): void } | undefined } };
    };
    const statement = internal.connection._statements.get(`undefined/undefined/undefined${select}`);
    expect(statement).toBeDefined();
    statement!.close();
    const prepares = await growth(session, 'Com_stmt_prepare', async () => {
      expect(await rows(session, select, [1])).toEqual([[10]]);
    });
    expect(prepares).toBe(1);
  });
});
