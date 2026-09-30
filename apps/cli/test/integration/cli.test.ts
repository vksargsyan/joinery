import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end tests of the BUILT binary (dist/joinery.mjs) against real servers, as a child
 * process with a temporary store. Gated on JOINERY_TEST_POSTGRES_URL, JOINERY_TEST_MARIADB_URL
 * and JOINERY_TEST_MYSQL_URL; `pnpm test:integration` builds first. Every database is created
 * with a unique name and dropped afterwards; the servers are shared.
 */

const BIN = fileURLToPath(new URL('../../dist/joinery.mjs', import.meta.url));

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

const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let workDir = '';
let storePath = '';

interface Result {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

interface RunOptions {
  readonly env?: Record<string, string>;
  /** Run the file itself (shebang) instead of `node dist/joinery.mjs`. */
  readonly direct?: boolean;
  /** Called with the child once it started (e.g. to send SIGINT). */
  readonly onSpawn?: (child: ReturnType<typeof spawn>) => void;
}

function joinery(args: readonly string[], options: RunOptions = {}): Promise<Result> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: workDir,
    JOINERY_STORE: storePath,
    NO_COLOR: '1',
    ...options.env,
  };
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = options.direct
      ? spawn(BIN, [...args], { env, cwd: workDir })
      : spawn(process.execPath, [BIN, ...args], { env, cwd: workDir });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ms: performance.now() - started,
      }),
    );
    options.onSpawn?.(child);
  });
}

/** The server URL pointed at another database, with TLS off (test servers use plain TCP). */
function urlFor(engine: Engine, database?: string): string {
  const url = new URL(engine.url);
  if (database !== undefined) url.pathname = `/${database}`;
  url.searchParams.set(
    engine.name === 'postgres' ? 'sslmode' : 'ssl-mode',
    engine.name === 'postgres' ? 'disable' : 'disabled',
  );
  return url.toString();
}

function passwordOf(engine: Engine): string {
  return decodeURIComponent(new URL(engine.url).password);
}

/** Runs SQL on the server's default database and expects success. */
async function admin(engine: Engine, sql: string, database?: string): Promise<void> {
  const result = await joinery(['query', urlFor(engine, database), '--yes', '-q', '-e', sql]);
  if (result.code !== 0) throw new Error(`admin SQL failed (${result.code}): ${result.stderr}`);
}

/**
 * Resolves once another connection runs a statement containing `marker` (polled with the CLI),
 * or rejects after `timeoutMs`.
 */
async function statementRunning(engine: Engine, marker: string, timeoutMs = 20_000) {
  const sql =
    engine.name === 'postgres'
      ? `SELECT count(*) AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%${marker}%'`
      : `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND INFO LIKE '%${marker}%'`;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await joinery(['query', urlFor(engine), '--format', 'csv', '-e', sql]);
    if (result.code === 0 && /^n\r?\n[1-9]/m.test(result.stdout)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The statement ${marker} did not start within ${timeoutMs} ms`);
}

const DIGITS =
  '(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';

/** `SELECT n` for 1..count, portable across MySQL and MariaDB (at most 100 000). */
function mysqlSeries(count: number): string {
  return `(SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 + 1 AS n FROM ${DIGITS} a, ${DIGITS} b, ${DIGITS} c, ${DIGITS} e, ${DIGITS} f) s WHERE n <= ${count}`;
}

beforeAll(() => {
  if (ENGINES.length === 0) return;
  if (!existsSync(BIN))
    throw new Error(`${BIN} is missing: run "pnpm --filter @joinery/cli build" first`);
  workDir = mkdtempSync(join(tmpdir(), 'joinery-cli-it-'));
  storePath = join(workDir, 'joinery.db');
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(ENGINES.length === 0)('built binary', () => {
  it('prints help through the shebang without an ExperimentalWarning', async () => {
    const direct = await joinery(['--help'], { direct: true });
    expect(direct.code).toBe(0);
    expect(direct.stdout).toContain('Usage: joinery');
    const listed = await joinery(['profiles', 'list']);
    expect(listed.code).toBe(0);
    for (const result of [direct, listed])
      expect(result.stderr).not.toContain('ExperimentalWarning');
  });
});

describe.each(ENGINES)('$name', (engine) => {
  const pg = engine.name === 'postgres';
  const db = (suffix: string): string => `jcli_${RUN_ID}_${engine.name.slice(0, 2)}_${suffix}`;
  const created: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  async function createDatabase(suffix: string): Promise<string> {
    const name = db(suffix);
    await admin(engine, `CREATE DATABASE ${name}`);
    created.push(name);
    return name;
  }

  afterAll(async () => {
    for (const name of created) {
      await admin(engine, `DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    }
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  it('test passes step by step', async () => {
    const result = await joinery(['test', urlFor(engine)]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/✓ TCP/);
    expect(result.stdout).toMatch(/✓ Auth/);
    expect(result.stdout).toContain('Connection OK.');
    expect(result.stdout + result.stderr).not.toContain(`:${passwordOf(engine)}@`);
  });

  it('test exits 1 at the auth step for a wrong password', async () => {
    const url = new URL(urlFor(engine));
    url.password = 'definitely-wrong';
    const result = await joinery(['test', url.toString()]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/✗ Auth/);
    expect(result.stdout).toContain('hint:');
    expect(result.stdout + result.stderr).not.toContain('definitely-wrong');
  });

  it('runs a file of statements, including a DELIMITER block on MySQL/MariaDB', async () => {
    const name = await createDatabase('script');
    const file = join(workDir, `${name}.sql`);
    writeFileSync(
      file,
      pg
        ? `-- a script
create table items (id int primary key, name text not null, price numeric(10,2));
insert into items values (1, 'a', 1.50), (2, 'b', 2.25);
create function item_count() returns bigint language sql as $$ select count(*) from items; $$;
select item_count() as n;
update items set price = price * 2 where id = 1;
select id, name, price from items order by id;
`
        : `-- a script
CREATE TABLE items (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL, price DECIMAL(10,2));
INSERT INTO items VALUES (1, 'a', 1.50), (2, 'b', 2.25);
DELIMITER //
CREATE PROCEDURE item_report()
BEGIN
  SELECT COUNT(*) AS n FROM items;
  UPDATE items SET price = price * 2 WHERE id = 1;
END //
DELIMITER ;
CALL item_report();
SELECT id, name, price FROM items ORDER BY id;
`,
    );
    const result = await joinery(['query', urlFor(engine, name), '-f', file, '--format', 'csv']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('n\n2\n\nid,name,price\n1,a,3.00\n2,b,2.25\n');
    expect(result.stderr).toContain(`Ran ${pg ? 6 : 5} statements`);
  });

  it('streams 50 000 rows as exact CSV and JSON', async () => {
    // EMPTY is a reserved word in MySQL 8, so the MySQL-family alias is quoted.
    const sql = pg
      ? `select g as id, 'name ' || g as name, g::bigint * 1000000000000 as big, null::text as empty from generate_series(1, 50000) g`
      : `SELECT n AS id, CONCAT('name ', n) AS name, CAST(n AS SIGNED) * 1000000000000 AS big, NULL AS \`empty\` FROM ${mysqlSeries(50000)} ORDER BY n`;
    const csv = await joinery(['query', urlFor(engine), '--format', 'csv', '-e', sql]);
    expect(csv.code, csv.stderr).toBe(0);
    const lines = csv.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(50001);
    expect(lines[0]).toBe('id,name,big,empty');
    expect(lines[1]).toBe('1,name 1,1000000000000,');
    expect(lines[50000]).toBe('50000,name 50000,50000000000000000,');
    expect(csv.stderr).toContain('50,000 rows');

    const json = await joinery(['query', urlFor(engine), '--format', 'json', '-e', sql]);
    expect(json.code, json.stderr).toBe(0);
    const rows = JSON.parse(json.stdout) as { id: number; name: string; empty: null }[];
    expect(rows).toHaveLength(50000);
    expect(rows[49999]).toMatchObject({ id: 50000, name: 'name 50000', empty: null });
    // Beyond 2^53: the digits are exact in the text.
    expect(json.stdout).toContain('"big":50000000000000000,');

    const jsonl = await joinery([
      'query',
      urlFor(engine),
      '--format',
      'jsonl',
      '--row-limit',
      '10',
      '-e',
      sql,
    ]);
    expect(jsonl.stdout.trimEnd().split('\n')).toHaveLength(10);
  });

  it('refuses a risky statement without --yes and leaves the data alone', async () => {
    const name = await createDatabase('safety');
    const url = urlFor(engine, name);
    await admin(engine, 'CREATE TABLE t (id INT PRIMARY KEY); INSERT INTO t VALUES (1), (2)', name);
    const refused = await joinery(['query', url, '-e', 'DELETE FROM t']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('needs confirmation: DELETE without WHERE removes every row');
    expect(refused.stderr).toContain('--yes');
    const count = await joinery([
      'query',
      url,
      '--format',
      'csv',
      '-e',
      'SELECT COUNT(*) AS n FROM t',
    ]);
    expect(count.stdout).toBe('n\n2\n');
    const allowed = await joinery(['query', url, '--yes', '-e', 'DELETE FROM t']);
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toContain('2 rows affected');
  });

  it('compares two databases, applies the script, and compares again with no differences', async () => {
    const source = await createDatabase('src');
    const target = await createDatabase('tgt');
    if (pg) {
      await admin(
        engine,
        `create table customers (id int primary key, email varchar(200) not null, created_at timestamp default now());
         create index customers_email_idx on customers (email);
         create table orders (id int primary key, customer_id int not null references customers(id), total numeric(10,2) default 0);
         create view big_orders as select id, total from orders where total > 100;`,
        source,
      );
      await admin(
        engine,
        'create table customers (id int primary key, email varchar(100)); create table obsolete (id int);',
        target,
      );
    } else {
      await admin(
        engine,
        `CREATE TABLE customers (id INT PRIMARY KEY, email VARCHAR(200) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, KEY customers_email_idx (email)) ENGINE=InnoDB;
         CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2) DEFAULT 0, CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)) ENGINE=InnoDB;
         CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100;`,
        source,
      );
      await admin(
        engine,
        'CREATE TABLE customers (id INT PRIMARY KEY, email VARCHAR(100)) ENGINE=InnoDB; CREATE TABLE obsolete (id INT) ENGINE=InnoDB;',
        target,
      );
    }
    const src = urlFor(engine, source);
    const tgt = urlFor(engine, target);

    const before = await joinery([
      'compare',
      src,
      tgt,
      '--json',
      '--out',
      'deploy.sql',
      '--html',
      'report.html',
    ]);
    expect(before.code, before.stderr).toBe(1);
    const diff = JSON.parse(before.stdout) as {
      operations: { objectKind: string; kind: string }[];
    };
    expect(diff.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectKind: 'table', kind: 'create' }),
        expect.objectContaining({ objectKind: 'table', kind: 'drop' }),
        expect.objectContaining({ objectKind: 'view', kind: 'create' }),
      ]),
    );
    expect(readFileSync(join(workDir, 'deploy.sql'), 'utf8')).toMatch(/CREATE TABLE/);
    expect(readFileSync(join(workDir, 'report.html'), 'utf8')).toContain('customers');

    if (!pg) {
      const refused = await joinery(['compare', src, tgt, '--apply', '--include-destructive']);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('outside transactions');
    }
    const applied = await joinery([
      'compare',
      src,
      tgt,
      '--apply',
      '--include-destructive',
      '--yes',
    ]);
    expect(applied.code, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(applied.stderr).toContain('the target now matches the source');

    const after = await joinery(['compare', src, tgt]);
    expect(after.code, `${after.stdout}\n${after.stderr}`).toBe(0);
    expect(after.stdout).toContain('No differences.');
  });

  it('data-compare finds the differences and --apply syncs them', async () => {
    const source = await createDatabase('dsrc');
    const target = await createDatabase('dtgt');
    const table =
      'CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, price DECIMAL(10,2))';
    await admin(engine, table, source);
    await admin(engine, table, target);
    if (pg) {
      await admin(
        engine,
        `insert into plans select g, 'plan ' || g, g * 1.5 from generate_series(1, 500) g`,
        source,
      );
      await admin(
        engine,
        `insert into plans select g, case when g % 50 = 0 then 'changed' else 'plan ' || g end, g * 1.5 from generate_series(21, 510) g`,
        target,
      );
    } else {
      await admin(
        engine,
        `INSERT INTO plans SELECT n, CONCAT('plan ', n), n * 1.5 FROM ${mysqlSeries(500)}`,
        source,
      );
      await admin(
        engine,
        `INSERT INTO plans SELECT n, CASE WHEN n % 50 = 0 THEN 'changed' ELSE CONCAT('plan ', n) END, n * 1.5 FROM ${mysqlSeries(510)} AND n > 20`,
        target,
      );
    }
    const src = urlFor(engine, source);
    const tgt = urlFor(engine, target);
    const found = await joinery([
      'data-compare',
      src,
      tgt,
      '--table',
      'plans',
      '--json',
      '--out',
      'sync.sql',
    ]);
    expect(found.code, found.stderr).toBe(1);
    expect(JSON.parse(found.stdout)).toMatchObject({
      key: ['id'],
      summary: { inserts: 20, updates: 10, deletes: 10 },
    });
    expect(readFileSync(join(workDir, 'sync.sql'), 'utf8')).toMatch(/^(BEGIN|START TRANSACTION);/);

    const applied = await joinery([
      'data-compare',
      src,
      tgt,
      '--table',
      'plans',
      '--apply',
      '--yes',
    ]);
    expect(applied.code, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(applied.stdout).toMatch(/insert\s+20/);

    const again = await joinery(['data-compare', src, tgt, '--table', 'plans']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/equal\s+500/);
  });

  it('dumps the schema as DDL', async () => {
    const name = await createDatabase('ddl');
    await admin(engine, 'CREATE TABLE widgets (id INT PRIMARY KEY, label VARCHAR(40))', name);
    const result = await joinery(['ddl', urlFor(engine, name)]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/CREATE TABLE .*widgets/);
  });

  it('exits 130 quickly when Ctrl+C interrupts a long statement', async () => {
    // The alias marks the statement, so the test can see it running on the server.
    const marker = `jcli_sigint_${RUN_ID}`;
    const sql = pg ? `select pg_sleep(30) as ${marker}` : `SELECT SLEEP(30) AS ${marker}`;
    let sentAt = 0;
    const result = await joinery(['query', urlFor(engine), '-e', sql], {
      onSpawn: (child) => {
        // Ctrl+C once the statement runs: a fixed delay raced the CLI's start on busy runners,
        // and a SIGINT before it listens ends the process by the signal instead of exit 130.
        void statementRunning(engine, marker).then(
          () => {
            sentAt = performance.now();
            child.kill('SIGINT');
          },
          () => child.kill('SIGKILL'),
        );
      },
    });
    expect(result.code, result.stderr).toBe(130);
    expect(result.stderr).toContain('Cancelling');
    expect(performance.now() - sentAt).toBeLessThan(3000);
  });

  it('saves a profile, then lists, shows and uses it without showing the secret', async () => {
    // A login of our own with a password that cannot appear by accident in any output.
    const user = `jcli_${RUN_ID}_u`;
    const password = `Pw${RUN_ID}Zq9x7Kd`;
    if (pg) {
      await admin(engine, `CREATE ROLE ${user} LOGIN PASSWORD '${password}'`);
      cleanups.push(() => admin(engine, `DROP ROLE IF EXISTS ${user}`));
    } else {
      await admin(
        engine,
        `CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'; CREATE USER '${user}'@'localhost' IDENTIFIED BY '${password}'`,
      );
      cleanups.push(() =>
        admin(engine, `DROP USER IF EXISTS '${user}'@'%', '${user}'@'localhost'`),
      );
    }
    const url = new URL(urlFor(engine, pg ? undefined : ''));
    url.username = user;
    url.password = password;

    const env = { JOINERY_PASSPHRASE: `it-${RUN_ID}` };
    const profile = `it-${engine.name}-${RUN_ID}`;
    const added = await joinery(
      ['profiles', 'add', profile, url.toString(), '--environment', 'test', '--folder', 'CI'],
      { env },
    );
    expect(added.code, added.stderr).toBe(0);
    const list = await joinery(['profiles', 'list'], { env });
    expect(list.stdout).toContain(profile);
    const show = await joinery(['profiles', 'show', profile], { env });
    expect(show.stdout).toContain('Password:     saved (readable here)');
    const json = await joinery(['profiles', 'show', profile, '--json'], { env });
    expect(JSON.parse(json.stdout)).toMatchObject({
      name: profile,
      auth: { user },
      presentation: { environment: 'test' },
    });
    const tested = await joinery(['test', profile, '--verbose'], { env });
    expect(tested.code, tested.stderr).toBe(0);
    const query = await joinery(['query', profile, '--verbose', '-e', 'SELECT 1 AS one'], { env });
    expect(query.code, query.stderr).toBe(0);
    for (const result of [added, list, show, json, tested, query]) {
      expect(result.stdout + result.stderr).not.toContain(password);
    }
    expect(readFileSync(storePath).includes(Buffer.from(password))).toBe(false);

    // Without the passphrase the saved value is unreadable, and a non-interactive run says why.
    const locked = await joinery(['test', profile]);
    expect(locked.code).toBe(2);
    expect(locked.stderr).toContain(
      `JOINERY_PASSWORD_${profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    );
    const fromEnv = await joinery(['test', profile], { env: { JOINERY_PASSWORD: password } });
    expect(fromEnv.code, fromEnv.stderr).toBe(0);
    expect(fromEnv.stdout + fromEnv.stderr).not.toContain(password);
  });
});
