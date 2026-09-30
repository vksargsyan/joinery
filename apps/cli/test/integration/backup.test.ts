import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `joinery backup` and `joinery restore` of the BUILT binary against the real servers: an
 * encrypted archive of a SQL database, listed and restored table by table into a database the
 * restore creates, a restore over it refused without --yes, a gzipped SQL script restored into
 * another new database, a MongoDB database copied into another, and Redis keys restored with
 * their TTLs. Every database and key is unique to the run and removed afterwards.
 */

const BIN = fileURLToPath(new URL('../../dist/joinery.mjs', import.meta.url));
const RUN_ID = randomBytes(4).toString('hex');
const PASSPHRASE = 'cli integration passphrase';

interface Engine {
  readonly name: 'postgres' | 'mariadb' | 'mysql';
  readonly url: string;
}

const ENGINES: Engine[] = (
  [
    ['postgres', process.env['JOINERY_TEST_POSTGRES_URL']],
    ['mariadb', process.env['JOINERY_TEST_MARIADB_URL']],
    ['mysql', process.env['JOINERY_TEST_MYSQL_URL']],
  ] as const
)
  .filter((entry): entry is readonly [Engine['name'], string] => Boolean(entry[1]))
  .map(([name, url]) => ({ name, url }));
const MONGO_URL = process.env['JOINERY_TEST_MONGODB_URL'];
const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];

let workDir = '';

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function joinery(args: readonly string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: workDir,
        JOINERY_STORE: join(workDir, 'joinery.db'),
        NO_COLOR: '1',
        ...env,
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

const withPassphrase = { JOINERY_BACKUP_PASSPHRASE: PASSPHRASE };

beforeAll(() => {
  if (ENGINES.length === 0 && !MONGO_URL && !REDIS_URL) return;
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing: run "pnpm --filter @joinery/cli build" first`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'joinery-cli-backup-'));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.each(ENGINES)('$name', (engine) => {
  const source = `jbk_${RUN_ID}_${engine.name.slice(0, 2)}`;
  const copy = `${source}_copy`;
  const script = `${source}_script`;

  function urlFor(database?: string): string {
    const url = new URL(engine.url);
    if (database !== undefined) url.pathname = `/${database}`;
    url.searchParams.set(
      engine.name === 'postgres' ? 'sslmode' : 'ssl-mode',
      engine.name === 'postgres' ? 'disable' : 'disabled',
    );
    return url.toString();
  }

  async function sql(text: string, database?: string): Promise<void> {
    const result = await joinery(['query', urlFor(database), '--yes', '-q', '-e', text]);
    if (result.code !== 0) throw new Error(`SQL failed (${result.code}): ${result.stderr}`);
  }

  async function rows(database: string, text: string): Promise<unknown[]> {
    const result = await joinery(['query', urlFor(database), '--format', 'json', '-e', text]);
    if (result.code !== 0) throw new Error(`query failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as unknown[];
  }

  beforeAll(async () => {
    await sql(`CREATE DATABASE ${source}`);
    await sql(
      'CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, note TEXT)',
      source,
    );
    await sql(
      'CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers (id), total DECIMAL(8,2))',
      source,
    );
    await sql(
      "INSERT INTO customers VALUES (1, 'Ada', NULL), (2, 'Grace', 'it''s fine'), (3, 'Zoë', '')",
      source,
    );
    await sql('INSERT INTO orders VALUES (10, 1, 9.99), (11, 2, 120.50)', source);
  });

  afterAll(async () => {
    for (const name of [source, copy, script]) {
      await sql(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    }
  });

  it('backs up to an encrypted archive and restores a table into a new database', async () => {
    const backup = await joinery(
      ['backup', urlFor(source), '--out', `${source}.jbak`, '--encrypt'],
      withPassphrase,
    );
    expect(backup.code, backup.stderr).toBe(0);
    expect(backup.stderr).toMatch(/Backed up \d+ objects and 5 rows to .*\.jbak \(.*encrypted\)/);

    const listed = await joinery(['restore', urlFor(), `${source}.jbak`, '--list'], withPassphrase);
    expect(listed.code, listed.stderr).toBe(0);
    const customers = listed.stdout
      .split('\n')
      .find((line) => /\ttable\t/.test(line) && line.includes('customers'));
    expect(customers).toMatch(/\t3$/);

    const restored = await joinery(
      [
        'restore',
        urlFor(source),
        `${source}.jbak`,
        '--database',
        copy,
        '--create-database',
        '--select',
        'customers',
      ],
      withPassphrase,
    );
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.stderr).toContain(`Created the database ${copy}`);
    expect(await rows(copy, 'SELECT id, name, note FROM customers ORDER BY id')).toEqual([
      { id: 1, name: 'Ada', note: null },
      { id: 2, name: 'Grace', note: "it's fine" },
      { id: 3, name: 'Zoë', note: '' },
    ]);

    // Over itself: listed, refused without --yes, done with it.
    const refused = await joinery(
      ['restore', urlFor(copy), `${source}.jbak`, '--select', 'customers'],
      withPassphrase,
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/drop and recreate table .*customers/);
    expect(refused.stderr).toContain('needs confirmation');
    await sql("UPDATE customers SET name = 'changed' WHERE id = 1", copy);
    const replaced = await joinery(
      ['restore', urlFor(copy), `${source}.jbak`, '--select', 'customers', '--yes'],
      withPassphrase,
    );
    expect(replaced.code, replaced.stderr).toBe(0);
    expect(await rows(copy, 'SELECT name FROM customers WHERE id = 1')).toEqual([{ name: 'Ada' }]);
    expect(`${backup.stderr}${listed.stdout}${restored.stderr}`).not.toContain(PASSPHRASE);
  });

  it('restores a gzipped SQL script into a new database', async () => {
    const backup = await joinery(['backup', urlFor(source), '--out', `${source}.sql.gz`]);
    expect(backup.code, backup.stderr).toBe(0);
    const restored = await joinery([
      'restore',
      urlFor(source),
      `${source}.sql.gz`,
      '--database',
      script,
      '--create-database',
    ]);
    expect(restored.code, restored.stderr).toBe(0);
    expect(await rows(script, 'SELECT id, customer_id, total FROM orders ORDER BY id')).toEqual([
      { id: 10, customer_id: 1, total: '9.99' },
      { id: 11, customer_id: 2, total: '120.50' },
    ]);
  });
});

describe.skipIf(!MONGO_URL)('MongoDB', () => {
  const db = `jbk_${RUN_ID}_mongo`;
  const target = `${db}_copy`;
  const url = (): string => {
    const parsed = new URL(MONGO_URL!);
    parsed.searchParams.set('tls', 'false');
    return parsed.toString();
  };
  const run = (database: string, command: string, ...extra: string[]) =>
    joinery(['query', url(), '--database', database, ...extra, '-e', command]);

  afterAll(async () => {
    for (const name of [db, target]) await run(name, '{ dropDatabase: 1 }', '--yes', '-q');
  });

  it('copies a database with its indexes through an archive', async () => {
    const setup = await run(
      db,
      `[{ insert: "people", documents: [{ _id: 1, name: "Ada" }, { _id: 2, name: "Grace" }] },
        { createIndexes: "people", indexes: [{ key: { name: 1 }, name: "by_name", unique: true }] }]`,
    );
    expect(setup.code, setup.stderr).toBe(0);
    const backup = await joinery(['backup', url(), '--database', db, '--out', 'mongo.jbak']);
    expect(backup.code, backup.stderr).toBe(0);
    const restored = await joinery(['restore', url(), 'mongo.jbak', '--database', target]);
    expect(restored.code, restored.stderr).toBe(0);
    const found = await run(target, '{ find: "people", sort: { _id: 1 } }', '--format', 'jsonl');
    expect(found.stdout.trim().split('\n')).toHaveLength(2);
    const indexes = await run(target, '{ listIndexes: "people" }', '--format', 'jsonl');
    expect(indexes.stdout).toContain('by_name');
  });
});

describe.skipIf(!REDIS_URL)('Redis', () => {
  const prefix = `joinery:cli-backup:${RUN_ID}:`;
  const run = (command: string, ...extra: string[]) =>
    joinery(['query', REDIS_URL!, ...extra, '-e', command]);

  afterAll(async () => {
    await run(`DEL ${prefix}a ${prefix}b`, '--yes', '-q');
  });

  it('restores keys with their TTLs, and overwrites only with --replace and --yes', async () => {
    const setup = await run(`SET ${prefix}a one EX 3600\nHSET ${prefix}b f v`);
    expect(setup.code, setup.stderr).toBe(0);
    const backup = await joinery([
      'backup',
      REDIS_URL!,
      '--out',
      'keys.jbak',
      '--pattern',
      `${prefix}*`,
    ]);
    expect(backup.code, backup.stderr).toBe(0);
    expect(backup.stderr).toContain('2 keys');
    await run(`DEL ${prefix}a ${prefix}b`, '--yes', '-q');

    const restored = await joinery(['restore', REDIS_URL!, 'keys.jbak']);
    expect(restored.code, restored.stderr).toBe(0);
    const ttl = await run(`TTL ${prefix}a`);
    expect(Number(ttl.stdout.replace(/\(integer\)\s*/, ''))).toBeGreaterThan(3500);

    await run(`SET ${prefix}a changed`, '--yes', '-q');
    const kept = await joinery(['restore', REDIS_URL!, 'keys.jbak']);
    expect(kept.code, kept.stderr).toBe(0);
    expect((await run(`GET ${prefix}a`)).stdout).toContain('changed');
    const refused = await joinery(['restore', REDIS_URL!, 'keys.jbak', '--replace']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('needs confirmation');
    const replaced = await joinery(['restore', REDIS_URL!, 'keys.jbak', '--replace', '--yes']);
    expect(replaced.code, replaced.stderr).toBe(0);
    expect((await run(`GET ${prefix}a`)).stdout).toContain('one');
  });
});
