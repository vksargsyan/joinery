import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `querybara import`, `export` and `run-file` from the BUILT binary against real servers
 * (PostgreSQL, MySQL, MariaDB; each skipped when its QUERYBARA_TEST_*_URL is unset): files in
 * every format into existing and new tables, upserts, skipped rows and exit codes, exports to
 * files, folders, gzip and stdout, and an export → run-file round trip into another database.
 * Every database is created with a unique name and dropped afterwards.
 */

const BIN = fileURLToPath(new URL('../../dist/querybara.mjs', import.meta.url));

interface Engine {
  readonly name: 'postgres' | 'mariadb' | 'mysql';
  readonly url: string;
}

const ENGINES: Engine[] = (
  [
    ['postgres', process.env['QUERYBARA_TEST_POSTGRES_URL']],
    ['mariadb', process.env['QUERYBARA_TEST_MARIADB_URL']],
    ['mysql', process.env['QUERYBARA_TEST_MYSQL_URL']],
  ] as const
)
  .filter((entry): entry is readonly [Engine['name'], string] => Boolean(entry[1]))
  .map(([name, url]) => ({ name, url }));

const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let workDir = '';

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function querybara(args: readonly string[], stdin?: string | Uint8Array): Promise<Result> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: workDir,
    QUERYBARA_STORE: join(workDir, 'querybara.db'),
    NO_COLOR: '1',
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: workDir });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(stdin ?? '');
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

function urlFor(engine: Engine, database?: string): string {
  const url = new URL(engine.url);
  if (database !== undefined) url.pathname = `/${database}`;
  url.searchParams.set(
    engine.name === 'postgres' ? 'sslmode' : 'ssl-mode',
    engine.name === 'postgres' ? 'disable' : 'disabled',
  );
  return url.toString();
}

async function admin(engine: Engine, sql: string, database?: string): Promise<void> {
  const result = await querybara(['query', urlFor(engine, database), '--yes', '-q', '-e', sql]);
  if (result.code !== 0) throw new Error(`admin SQL failed (${result.code}): ${result.stderr}`);
}

/** Rows of a query as JSON objects (`query --format json` writes decimals as strings). */
async function rows(engine: Engine, database: string, sql: string): Promise<unknown[]> {
  const result = await querybara([
    'query',
    urlFor(engine, database),
    '--format',
    'json',
    '-e',
    sql,
  ]);
  if (result.code !== 0) throw new Error(`query failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown[];
}

function file(name: string, content: string | Uint8Array): string {
  writeFileSync(join(workDir, name), content);
  return name;
}

beforeAll(() => {
  if (ENGINES.length === 0) return;
  if (!existsSync(BIN))
    throw new Error(`${BIN} is missing: run "pnpm --filter @querybara/cli build" first`);
  workDir = mkdtempSync(join(tmpdir(), 'querybara-cli-transfer-'));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.each(ENGINES)('$name', (engine) => {
  const created: string[] = [];

  async function createDatabase(suffix: string): Promise<string> {
    const name = `jxfer_${RUN_ID}_${engine.name.slice(0, 2)}_${suffix}`;
    await admin(engine, `CREATE DATABASE ${name}`);
    created.push(name);
    return name;
  }

  afterAll(async () => {
    for (const name of created) {
      await admin(engine, `DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    }
  });

  it('imports CSV into an existing table, then upserts, and skips bad rows with exit 1', async () => {
    const db = await createDatabase('imp');
    const url = urlFor(engine, db);
    await admin(
      engine,
      `CREATE TABLE people (id INT PRIMARY KEY, full_name VARCHAR(80) NOT NULL, score DECIMAL(6,2), joined DATE)`,
      db,
    );
    file(
      'people.csv',
      'ID,Full Name,score,joined\n1,Ada Lovelace,9.5,2024-01-02\n2,"Hopper, Grace",,2024-02-03\n3,Linus,7.25,\n',
    );
    const imported = await querybara(['import', url, '--table', 'people', '--file', 'people.csv']);
    expect(imported.code, imported.stderr).toBe(0);
    expect(imported.stderr).toContain('Imported 3 rows into');
    expect(
      await rows(engine, db, 'SELECT id, full_name, score, joined FROM people ORDER BY id'),
    ).toEqual([
      { id: 1, full_name: 'Ada Lovelace', score: '9.50', joined: '2024-01-02' },
      { id: 2, full_name: 'Hopper, Grace', score: null, joined: '2024-02-03' },
      { id: 3, full_name: 'Linus', score: '7.25', joined: null },
    ]);

    file('changes.tsv', 'id\tname\n2\tGrace Hopper\n4\tBarbara\n');
    const upsert = await querybara([
      'import',
      url,
      '--table',
      'people',
      '--file',
      'changes.tsv',
      '--mode',
      'upsert',
      '--key',
      'id',
      '--map',
      'id=id',
      '--map',
      'name=full_name',
    ]);
    expect(upsert.code, upsert.stderr).toBe(0);
    expect(await rows(engine, db, 'SELECT id, full_name FROM people ORDER BY id')).toEqual([
      { id: 1, full_name: 'Ada Lovelace' },
      { id: 2, full_name: 'Grace Hopper' },
      { id: 3, full_name: 'Linus' },
      { id: 4, full_name: 'Barbara' },
    ]);

    file('bad.csv', 'id,full_name\n10,Ok\nnope,Bad\n11,\n12,Fine\n');
    const skipped = await querybara([
      'import',
      url,
      '--table',
      'people',
      '--file',
      'bad.csv',
      '--on-error',
      'skip',
      '--null',
      'NULL',
      '--error-log',
      'bad.log',
    ]);
    expect(skipped.code, skipped.stderr).toBe(1);
    expect(skipped.stderr).toContain('skipped: row 2 (line 3), column id');
    expect(skipped.stderr).toContain('Imported 3 rows');
    expect(readFileSync(join(workDir, 'bad.log'), 'utf8')).toContain('row 2 (line 3)');
    expect(await rows(engine, db, 'SELECT COUNT(*) AS n FROM people')).toEqual([{ n: 7 }]);

    const stopped = await querybara(['import', url, '--table', 'people', '--file', 'bad.csv']);
    expect(stopped.code).toBe(2);
    expect(stopped.stderr).toContain('nothing was kept');
    expect(await rows(engine, db, 'SELECT COUNT(*) AS n FROM people')).toEqual([{ n: 7 }]);

    const replace = await querybara([
      'import',
      url,
      '--table',
      'people',
      '--file',
      'people.csv',
      '--mode',
      'replace',
    ]);
    expect(replace.code).toBe(2);
    expect(replace.stderr).toContain('--yes');
    const replaced = await querybara([
      'import',
      url,
      '--table',
      'people',
      '--file',
      'people.csv',
      '--mode',
      'replace',
      '--yes',
    ]);
    expect(replaced.code, replaced.stderr).toBe(0);
    expect(await rows(engine, db, 'SELECT COUNT(*) AS n FROM people')).toEqual([{ n: 3 }]);
  });

  it('creates tables from JSON Lines, gzipped JSON and stdin CSV', async () => {
    const db = await createDatabase('new');
    const url = urlFor(engine, db);
    file(
      'events.jsonl',
      '{"id": 1, "kind": "click", "at": "2024-05-06T07:08:09Z", "meta": {"x": 1}}\n{"id": 2, "kind": "view", "at": "2024-05-06T07:08:10Z", "meta": null}\n',
    );
    const jsonl = await querybara([
      'import',
      url,
      '--table',
      'events',
      '--file',
      'events.jsonl',
      '--create',
      '--key',
      'id',
    ]);
    expect(jsonl.code, jsonl.stderr).toBe(0);
    expect(jsonl.stderr).toContain('Created table');
    const events = (await rows(engine, db, 'SELECT id, kind, meta FROM events ORDER BY id')) as {
      id: number;
      kind: string;
      meta: unknown;
    }[];
    expect(events.map((e) => [e.id, e.kind])).toEqual([
      [1, 'click'],
      [2, 'view'],
    ]);
    // A JSON column comes back as JSON (PostgreSQL, MySQL) or as its text (MariaDB).
    const meta = events[0]!.meta;
    expect(typeof meta === 'string' ? JSON.parse(meta) : meta).toEqual({ x: 1 });

    file(
      'items.json.gz',
      gzipSync(
        JSON.stringify([
          { sku: 'A-1', qty: 3 },
          { sku: 'B-2', qty: 5000000000 },
        ]),
      ),
    );
    const gz = await querybara([
      'import',
      url,
      '--table',
      'items',
      '--file',
      'items.json.gz',
      '--create',
    ]);
    expect(gz.code, gz.stderr).toBe(0);
    expect(await rows(engine, db, 'SELECT sku, qty FROM items ORDER BY sku')).toEqual([
      { sku: 'A-1', qty: 3 },
      { sku: 'B-2', qty: 5000000000 },
    ]);

    const piped = await querybara(
      ['import', url, '--table', 'piped', '--file', '-', '--create', '--delimiter', ';'],
      'a;b\n1;x\n2;y\n',
    );
    expect(piped.code, piped.stderr).toBe(0);
    expect(await rows(engine, db, 'SELECT a, b FROM piped ORDER BY a')).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  it('exports to every format, files, folders and stdout, and round-trips SQL with DDL', async () => {
    const source = await createDatabase('exp');
    const target = await createDatabase('rt');
    const url = urlFor(engine, source);
    await admin(
      engine,
      `CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL);
       CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2), note TEXT, FOREIGN KEY (customer_id) REFERENCES customers (id));
       INSERT INTO customers VALUES (1, 'Ada'), (2, 'Grace, "Amazing" Hopper');
       INSERT INTO orders VALUES (10, 1, 12.50, 'first'), (11, 2, NULL, NULL), (12, 2, 99999999.99, 'line
break')`,
      source,
    );
    const csv = await querybara([
      'export',
      url,
      '--table',
      'customers',
      '--format',
      'csv',
      '--out',
      '-',
    ]);
    expect(csv.code, csv.stderr).toBe(0);
    expect(csv.stdout).toBe('id,name\r\n1,Ada\r\n2,"Grace, ""Amazing"" Hopper"\r\n');

    const json = await querybara([
      'export',
      url,
      '--query',
      'SELECT id, total, note FROM orders ORDER BY id',
      '--format',
      'json',
      '--out',
      'orders.json',
    ]);
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(workDir, 'orders.json'), 'utf8'))).toEqual([
      { id: 10, total: 12.5, note: 'first' },
      { id: 11, total: null, note: null },
      { id: 12, total: 99999999.99, note: 'line\nbreak' },
    ]);

    const folder = await querybara([
      'export',
      url,
      '--table',
      'customers',
      '--table',
      'orders',
      '--format',
      'jsonl',
      '--gzip',
      '--out',
      `per-table-${engine.name}`,
    ]);
    expect(folder.code, folder.stderr).toBe(0);
    expect(readdirSync(join(workDir, `per-table-${engine.name}`)).sort()).toEqual([
      'customers.jsonl.gz',
      'orders.jsonl.gz',
    ]);
    expect(
      gunzipSync(
        readFileSync(join(workDir, `per-table-${engine.name}`, 'customers.jsonl.gz')),
      ).toString('utf8'),
    ).toBe('{"id":1,"name":"Ada"}\n{"id":2,"name":"Grace, \\"Amazing\\" Hopper"}\n');

    const dump = `dump-${engine.name}.sql`;
    const ddl = await querybara([
      'export',
      url,
      '--table',
      'orders',
      '--table',
      'customers',
      '--format',
      'sql-ddl',
      '--one-file',
      '--out',
      dump,
    ]);
    expect(ddl.code, ddl.stderr).toBe(0);
    const script = readFileSync(join(workDir, dump), 'utf8');
    expect(script).toMatch(/CREATE TABLE/);
    // Foreign keys come last, so the table order does not matter on import.
    expect(script.lastIndexOf('FOREIGN KEY')).toBeGreaterThan(script.lastIndexOf('INSERT INTO'));

    const ran = await querybara(['run-file', urlFor(engine, target), dump]);
    expect(ran.code, ran.stderr).toBe(0);
    const query =
      'SELECT o.id, c.name, o.total, o.note FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id';
    expect(await rows(engine, target, query)).toEqual(await rows(engine, source, query));
    expect(await rows(engine, target, query)).toHaveLength(3);
  });

  it('exports to Excel, XML, HTML, Markdown and a ZIP, and imports Excel and XML back', async () => {
    const db = await createDatabase('xlsx');
    const url = urlFor(engine, db);
    await admin(
      engine,
      `CREATE TABLE items (id INT PRIMARY KEY, label VARCHAR(40), price DECIMAL(10,2), added DATE);
       INSERT INTO items VALUES (1, 'Anvil & <co>', 19.99, '2024-01-02'), (2, 'Bucket', NULL, NULL);
       CREATE TABLE xml_items (id INT PRIMARY KEY, label VARCHAR(40), price DECIMAL(10,2), added DATE)`,
      db,
    );
    const book = `items-${engine.name}.xlsx`;
    const exported = await querybara([
      'export',
      url,
      '--table',
      'items',
      '--format',
      'xlsx',
      '--decimals',
      'number',
      '--out',
      book,
    ]);
    expect(exported.code, exported.stderr).toBe(0);
    expect(readFileSync(join(workDir, book)).subarray(0, 2).toString('latin1')).toBe('PK');

    // Into a new table, from the file and again from stdin.
    for (const [table, args, stdin] of [
      ['from_file', ['--file', book], undefined],
      ['from_stdin', ['--file', '-'], readFileSync(join(workDir, book))],
    ] as const) {
      const imported = await querybara(
        ['import', url, '--table', table, ...args, '--create', '--key', 'id'],
        stdin,
      );
      expect(imported.code, imported.stderr).toBe(0);
      expect(imported.stderr).toContain(`Imported 2 rows into`);
      expect(
        await rows(engine, db, `SELECT id, label, price, added FROM ${table} ORDER BY id`),
      ).toEqual(await rows(engine, db, 'SELECT id, label, price, added FROM items ORDER BY id'));
    }

    const xml = await querybara([
      'export',
      url,
      '--table',
      'items',
      '--format',
      'xml',
      '--out',
      '-',
    ]);
    expect(xml.code, xml.stderr).toBe(0);
    expect(xml.stdout).toContain('<label>Anvil &amp; &lt;co&gt;</label>');
    file(`items-${engine.name}.xml`, xml.stdout);
    const loaded = await querybara([
      'import',
      url,
      '--table',
      'xml_items',
      '--file',
      `items-${engine.name}.xml`,
    ]);
    expect(loaded.code, loaded.stderr).toBe(0);
    expect(
      await rows(engine, db, 'SELECT id, label, price, added FROM xml_items ORDER BY id'),
    ).toEqual(await rows(engine, db, 'SELECT id, label, price, added FROM items ORDER BY id'));

    const page = await querybara([
      'export',
      url,
      '--table',
      'items',
      '--format',
      'html',
      '--out',
      '-',
    ]);
    expect(page.stdout).toContain('<td>Anvil &amp; &lt;co&gt;</td>');
    const markdown = await querybara([
      'export',
      url,
      '--table',
      'items',
      '--format',
      'markdown',
      '--out',
      '-',
    ]);
    expect(markdown.stdout.split('\n')[2]).toBe('| 1 | Anvil \\& \\<co\\> | 19.99 | 2024-01-02 |');

    const zip = `items-${engine.name}.zip`;
    const zipped = await querybara([
      'export',
      url,
      '--table',
      'items',
      '--table',
      'xml_items',
      '--format',
      'csv',
      '--zip',
      '--out',
      zip,
    ]);
    expect(zipped.code, zipped.stderr).toBe(0);
    expect(zipped.stderr).toContain(`from 2 tables to ${zip}`);
    const names = readFileSync(join(workDir, zip)).toString('latin1');
    expect(names).toContain('items.csv');
    expect(names).toContain('xml_items.csv');
  });

  it('runs a SQL file past a failing statement with --continue', async () => {
    const db = await createDatabase('run');
    const url = urlFor(engine, db);
    file(
      `script-${engine.name}.sql.gz`,
      gzipSync(
        "CREATE TABLE audit (id INT, what VARCHAR(20));\nINSERT INTO missing_table VALUES (1);\nINSERT INTO audit VALUES (1, 'kept');\n",
      ),
    );
    const continued = await querybara([
      'run-file',
      url,
      `script-${engine.name}.sql.gz`,
      '--continue',
    ]);
    expect(continued.code, continued.stderr).toBe(1);
    expect(continued.stderr).toContain(`at statement 2 (script-${engine.name}.sql.gz:2:1)`);
    expect(continued.stderr).toContain('Ran 3 statements');
    expect(continued.stderr).toContain('1 failed');
    expect(await rows(engine, db, 'SELECT what FROM audit')).toEqual([{ what: 'kept' }]);

    const stopped = await querybara(['run-file', url, `script-${engine.name}.sql.gz`]);
    expect(stopped.code).toBe(2);
    expect(stopped.stderr).toContain('already exists');
  });

  it('imports 20 000 rows in batches', async () => {
    const db = await createDatabase('bulk');
    const url = urlFor(engine, db);
    const lines = ['id,label,amount'];
    for (let i = 1; i <= 20_000; i++) lines.push(`${i},row ${i},${(i / 100).toFixed(2)}`);
    file('bulk.csv', `${lines.join('\n')}\n`);
    await admin(
      engine,
      'CREATE TABLE bulk (id INT PRIMARY KEY, label VARCHAR(20), amount DECIMAL(10,2))',
      db,
    );
    const result = await querybara([
      'import',
      url,
      '--table',
      'bulk',
      '--file',
      'bulk.csv',
      '--batch-size',
      '5000',
      '--transaction',
      'per-batch',
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('Imported 20,000 rows');
    expect(await rows(engine, db, 'SELECT COUNT(*) AS n, SUM(amount) AS total FROM bulk')).toEqual([
      { n: 20000, total: '2000100.00' },
    ]);
  });
});
