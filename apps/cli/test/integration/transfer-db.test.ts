import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `querybara transfer` from the BUILT binary against real servers (spec §12): PostgreSQL into
 * MySQL and MariaDB and back (types, keys, foreign keys, AUTO_INCREMENT, the create /
 * truncate rules, skipped rows with an error log), PostgreSQL into MongoDB with embedded child
 * rows and back with a child table, and Redis keys between logical databases with their TTLs.
 * Each part is skipped when its QUERYBARA_TEST_*_URL is unset; every database and key is created
 * with a unique name and removed afterwards.
 */

const BIN = fileURLToPath(new URL('../../dist/querybara.mjs', import.meta.url));
const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const REDIS_URL = process.env['QUERYBARA_TEST_REDIS_URL'];
const RUN_ID = randomBytes(4).toString('hex');

const MY_ENGINES = (
  [
    ['mysql', process.env['QUERYBARA_TEST_MYSQL_URL']],
    ['mariadb', process.env['QUERYBARA_TEST_MARIADB_URL']],
  ] as const
)
  .filter((entry): entry is readonly ['mysql' | 'mariadb', string] => Boolean(entry[1]))
  .map(([name, url]) => ({ name, url }));

let workDir = '';

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function querybara(args: readonly string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: workDir,
        QUERYBARA_STORE: join(workDir, 'querybara.db'),
        NO_COLOR: '1',
      },
      cwd: workDir,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

/** A SQL server URL for a database, TLS off (the test servers speak plain TCP). */
function sqlUrl(base: string, postgres: boolean, database?: string): string {
  const url = new URL(base);
  if (database !== undefined) url.pathname = `/${database}`;
  url.searchParams.set(postgres ? 'sslmode' : 'ssl-mode', postgres ? 'disable' : 'disabled');
  return url.toString();
}

async function run(url: string, ...statements: string[]): Promise<void> {
  for (const sql of statements) {
    const result = await querybara(['query', url, '--yes', '-q', '-e', sql]);
    if (result.code !== 0) throw new Error(`SQL failed (${result.code}): ${result.stderr}`);
  }
}

/** Rows of a query as JSON objects. */
async function rows(url: string, sql: string): Promise<unknown[]> {
  const result = await querybara(['query', url, '--format', 'json', '-e', sql]);
  if (result.code !== 0) throw new Error(`query failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown[];
}

beforeAll(() => {
  if (!PG_URL && !REDIS_URL) return;
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing: run "pnpm --filter @querybara/cli build" first`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'querybara-cli-transfer-db-'));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// PostgreSQL ↔ MySQL / MariaDB ------------------------------------------------------------------

describe.each(MY_ENGINES)('PostgreSQL and $name', (engine) => {
  const pgDbs: string[] = [];
  const myDbs: string[] = [];
  const pg = (db?: string): string => sqlUrl(PG_URL!, true, db);
  const my = (db?: string): string => sqlUrl(engine.url, false, db);

  async function pgDatabase(suffix: string): Promise<string> {
    const name = `jxdb_${RUN_ID}_${engine.name.slice(0, 2)}_${suffix}`;
    await run(pg(), `CREATE DATABASE ${name}`);
    pgDbs.push(name);
    return name;
  }

  async function myDatabase(suffix: string): Promise<string> {
    const name = `jxdb_${RUN_ID}_${engine.name.slice(0, 2)}_${suffix}`;
    await run(my(), `CREATE DATABASE ${name} CHARACTER SET utf8mb4`);
    myDbs.push(name);
    return name;
  }

  afterAll(async () => {
    if (!PG_URL) return;
    for (const name of pgDbs) await run(pg(), `DROP DATABASE IF EXISTS ${name}`).catch(() => 0);
    for (const name of myDbs) await run(my(), `DROP DATABASE IF EXISTS ${name}`).catch(() => 0);
  });

  it.skipIf(!PG_URL)(
    'transfers tables into MySQL, refuses to recreate them, truncates with --yes',
    async () => {
      const src = await pgDatabase('src');
      const dst = await myDatabase('dst');
      await run(
        pg(src),
        'CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, vip boolean, data jsonb, photo bytea)',
        `CREATE TABLE orders (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id), total numeric(12,2), placed timestamptz, ref uuid)`,
        `INSERT INTO customers (name, vip, data, photo) VALUES ('Ada', true, '{"a": [1, 2]}', '\\x00ff'), ('Grüße 😀', false, NULL, NULL), ('Linus', NULL, '{"b": "x"}', '\\x')`,
        `INSERT INTO orders (customer_id, total, placed, ref) SELECT 1 + g % 3, g * 1.25, timestamptz '2024-03-01 12:00:00+02' + g * interval '1 hour', CASE WHEN g % 2 = 0 THEN 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid END FROM generate_series(1, 250) g`,
      );

      const dry = await querybara(['transfer', pg(src), my(dst), '--all', '--dry-run']);
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain('customers → customers (create');
      expect(dry.stdout).toMatch(/total\s+numeric\(12,2\)\s+→ decimal\(12,2\)/);
      expect(dry.stdout).toMatch(/placed\s+timestamp with time zone\s+→ datetime\(6\)/);
      expect(dry.stdout).toMatch(/data\s+jsonb\s+→ (json|longtext)/);
      expect(dry.stdout).toMatch(/photo\s+bytea\s+→ longblob/);
      expect(dry.stdout).toContain('-- After the data');
      expect(
        await rows(
          my(dst),
          'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
        ),
      ).toEqual([{ n: 0 }]);

      const done = await querybara(['transfer', pg(src), my(dst), '--all', '--batch-size', '100']);
      expect(done.code, done.stderr).toBe(0);
      expect(done.stderr).toMatch(/Transferred 253 rows into (MySQL|MariaDB)/);
      expect(
        await rows(
          my(dst),
          'SELECT id, name, vip, HEX(photo) AS photo, JSON_UNQUOTE(JSON_EXTRACT(data, "$.a[1]")) AS a FROM customers ORDER BY id',
        ),
      ).toEqual([
        { id: 1, name: 'Ada', vip: 1, photo: '00FF', a: '2' },
        { id: 2, name: 'Grüße 😀', vip: 0, photo: null, a: null },
        { id: 3, name: 'Linus', vip: null, photo: '', a: null },
      ]);
      expect(
        await rows(
          my(dst),
          'SELECT COUNT(*) AS n, SUM(total) AS total, COUNT(ref) AS refs, MIN(placed) AS first FROM orders',
        ),
      ).toEqual([{ n: 250, total: '39218.75', refs: 125, first: '2024-03-01 11:00:00.000000' }]);
      expect(
        await rows(
          my(dst),
          "SELECT REFERENCED_TABLE_NAME AS ref FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND REFERENCED_TABLE_NAME IS NOT NULL",
        ),
      ).toEqual([{ ref: 'customers' }]);
      // AUTO_INCREMENT moved past the copied keys.
      await run(my(dst), "INSERT INTO customers (name) VALUES ('Next')");
      expect(await rows(my(dst), "SELECT id FROM customers WHERE name = 'Next'")).toEqual([
        { id: 4 },
      ]);

      const again = await querybara(['transfer', pg(src), my(dst), '--table', 'customers']);
      expect(again.code).toBe(2);
      expect(again.stderr).toContain('customers already exists on the target');

      const unconfirmed = await querybara([
        'transfer',
        pg(src),
        my(dst),
        '--table',
        'orders',
        '--mode',
        'truncate',
      ]);
      expect(unconfirmed.code).toBe(2);
      expect(unconfirmed.stderr).toContain('Empty table orders');
      expect(unconfirmed.stderr).toContain('--yes');

      const truncated = await querybara([
        'transfer',
        pg(src),
        my(dst),
        '--table',
        'orders',
        '--mode',
        'truncate',
        '--yes',
      ]);
      expect(truncated.code, truncated.stderr).toBe(0);
      expect(await rows(my(dst), 'SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 250 }]);
    },
  );

  it.skipIf(!PG_URL)('transfers back into PostgreSQL, skipping rows that fail', async () => {
    const src = await myDatabase('back');
    const dst = await pgDatabase('back');
    await run(
      my(src),
      'CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(20) NOT NULL, price DECIMAL(8,2), flags SET("a","b","c"), made DATETIME(3), active TINYINT(1))',
      "INSERT INTO items (sku, price, flags, made, active) VALUES ('A-1', 9.99, 'a,c', '2024-01-02 03:04:05.678', 1), ('LONG-SKU-2', 0.5, '', NULL, 0), ('C-3', NULL, 'b', '1999-12-31 23:59:59.000', NULL)",
    );
    const skipped = await querybara([
      'transfer',
      my(src),
      pg(dst),
      '--table',
      'items',
      '--rename',
      'items=products',
      '--type',
      'items.sku=varchar(5)',
      '--on-error',
      'skip',
      '--error-log',
      'products.log',
    ]);
    expect(skipped.code, skipped.stderr).toBe(1);
    expect(skipped.stderr).toContain('skipped: products: row 2');
    expect(skipped.stderr).toMatch(/Transferred 2 rows into PostgreSQL .*; 1 row skipped/);
    expect(readFileSync(join(workDir, 'products.log'), 'utf8')).toContain('products: row 2');
    expect(
      await rows(pg(dst), 'SELECT id, sku, price, flags, made, active FROM products ORDER BY id'),
    ).toEqual([
      {
        id: 1,
        sku: 'A-1',
        price: '9.99',
        flags: 'a,c',
        made: '2024-01-02 03:04:05.678',
        active: true,
      },
      { id: 3, sku: 'C-3', price: null, flags: 'b', made: '1999-12-31 23:59:59', active: null },
    ]);
    // The identity continues after the copied keys.
    await run(pg(dst), "INSERT INTO products (sku) VALUES ('N-4')");
    expect(await rows(pg(dst), "SELECT id FROM products WHERE sku = 'N-4'")).toEqual([{ id: 4 }]);
  });
});

// PostgreSQL ↔ MongoDB ----------------------------------------------------------------------------

describe.skipIf(!PG_URL || !MONGO_URL)('PostgreSQL and MongoDB', () => {
  const pgDbs: string[] = [];
  const mongoDb = `jxdb_${RUN_ID}_mongo`;
  const pg = (db?: string): string => sqlUrl(PG_URL!, true, db);
  const mongo = (): string => {
    const url = new URL(MONGO_URL!);
    url.searchParams.set('tls', 'false');
    return url.toString();
  };
  const command = async (text: string): Promise<string> => {
    const result = await querybara(['query', mongo(), '--database', mongoDb, '-e', text]);
    if (result.code !== 0) throw new Error(`command failed: ${result.stderr}`);
    return result.stdout;
  };

  afterAll(async () => {
    await querybara([
      'query',
      mongo(),
      '--database',
      mongoDb,
      '--yes',
      '-q',
      '-e',
      '{ dropDatabase: 1 }',
    ]);
    for (const name of pgDbs) await run(pg(), `DROP DATABASE IF EXISTS ${name}`).catch(() => 0);
  });

  it('embeds child rows into documents, then flattens them back into a child table', async () => {
    const src = `jxdb_${RUN_ID}_msrc`;
    const back = `jxdb_${RUN_ID}_mback`;
    await run(pg(), `CREATE DATABASE ${src}`, `CREATE DATABASE ${back}`);
    pgDbs.push(src, back);
    await run(
      pg(src),
      'CREATE TABLE orders (id integer PRIMARY KEY, customer text, total numeric(10,2))',
      'CREATE TABLE items (id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES orders (id), sku text, qty integer)',
      "INSERT INTO orders VALUES (1, 'Ada', 12.50), (2, 'Linus', 3.00)",
      "INSERT INTO items VALUES (10, 1, 'pen', 2), (11, 1, 'ink', 1), (12, 2, 'pad', 3)",
    );
    const embedded = await querybara([
      'transfer',
      pg(src),
      mongo(),
      '--target-database',
      mongoDb,
      '--table',
      'orders',
      '--embed',
      'orders:items:items_order_id_fkey:lines',
    ]);
    expect(embedded.code, embedded.stderr).toBe(0);
    expect(embedded.stderr).toContain('Transferred 2 rows into MongoDB');
    const found = await command('{ find: "orders", filter: { _id: 1 } }');
    expect(found).toContain('"customer": "Ada"');
    expect(found).toContain('"lines"');
    expect(found).toContain('"sku": "ink"');
    expect(found).toContain('"$numberDecimal": "12.50"');

    const flattened = await querybara([
      'transfer',
      mongo(),
      pg(back),
      '--database',
      mongoDb,
      '--table',
      'orders',
      '--shape',
      'orders.lines=child',
    ]);
    expect(flattened.code, flattened.stderr).toBe(0);
    expect(await rows(pg(back), 'SELECT _id, customer, total FROM orders ORDER BY _id')).toEqual([
      { _id: 1, customer: 'Ada', total: '12.50' },
      { _id: 2, customer: 'Linus', total: '3.00' },
    ]);
    expect(await rows(pg(back), 'SELECT sku, qty FROM orders_lines ORDER BY sku')).toEqual([
      { sku: 'ink', qty: 1 },
      { sku: 'pad', qty: 3 },
      { sku: 'pen', qty: 2 },
    ]);
  });
});

// Redis → Redis -----------------------------------------------------------------------------------

describe.skipIf(!REDIS_URL)('Redis to Redis', () => {
  const prefix = `querybara:xfer:${RUN_ID}:`;
  const db = (n: number): string => {
    const url = new URL(REDIS_URL!);
    url.pathname = `/${n}`;
    return url.toString();
  };
  const redis = async (n: number, commands: string): Promise<string> => {
    const result = await querybara(['query', db(n), '--yes', '-e', commands]);
    if (result.code !== 0) throw new Error(`redis failed: ${result.stderr}`);
    return result.stdout;
  };
  const keys = ['str', 'h', 'list'].map((k) => `${prefix}${k}`).join(' ');

  afterAll(async () => {
    await redis(0, `DEL ${keys}`).catch(() => '');
    await redis(1, `DEL ${keys}`).catch(() => '');
  });

  it('copies keys by pattern with their TTLs, skips existing keys, replaces with --yes', async () => {
    await redis(
      0,
      [
        `SET ${prefix}str hello PX 600000`,
        `HSET ${prefix}h name Ada lang en`,
        `RPUSH ${prefix}list a b c`,
      ].join('\n'),
    );
    const copied = await querybara(['transfer', db(0), db(1), '--pattern', `${prefix}*`]);
    expect(copied.code, copied.stderr).toBe(0);
    expect(copied.stderr).toContain('Transferred 3 keys into Redis');
    const checked = await redis(
      1,
      [`PTTL ${prefix}str`, `HGET ${prefix}h name`, `LRANGE ${prefix}list 0 -1`].join('\n'),
    );
    const ttl = Number(/\(integer\) (\d+)/.exec(checked)?.[1]);
    expect(ttl).toBeGreaterThan(500_000);
    expect(checked).toContain('"Ada"');
    expect(checked).toContain('1) "a"\n2) "b"\n3) "c"');

    await redis(0, `SET ${prefix}str changed`);
    const kept = await querybara(['transfer', db(0), db(1), '--pattern', `${prefix}str`]);
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain('1 key skipped');
    expect(await redis(1, `GET ${prefix}str`)).toBe('"hello"\n');

    const refused = await querybara([
      'transfer',
      db(0),
      db(1),
      '--pattern',
      `${prefix}str`,
      '--replace',
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('RESTORE ... REPLACE');
    const replaced = await querybara([
      'transfer',
      db(0),
      db(1),
      '--pattern',
      `${prefix}str`,
      '--replace',
      '--yes',
    ]);
    expect(replaced.code, replaced.stderr).toBe(0);
    expect(await redis(1, `GET ${prefix}str\nPTTL ${prefix}str`)).toBe('"changed"\n(integer) -1\n');
  });
});
