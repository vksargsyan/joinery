import { join } from 'node:path';

import {
  BASE_CAPABILITIES,
  schemaSnapshotSchema,
  type Capabilities,
  type DriverAdapter,
  type EngineId,
  type ResolvedProfile,
  type SchemaSnapshot,
  type Session,
} from '@joinery/core';
import { InvalidArgumentError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSpec,
  embedFlag,
  renameFlag,
  shapeFlag,
  skipFlag,
  typeFlag,
  type TransferDbOptions,
} from '../src/commands/transfer-db';
import { transferDbOptions } from '../src/program';
import { FakeSession, ScriptedPrompter, column, run, tempDir, type FakeResult } from './helpers';

/**
 * `joinery transfer` in-process against fake sessions: the flag parsers, the options and the
 * spec they build, the plan printed by --dry-run (text and JSON), the checks made before
 * connecting (engine pair, what to transfer, read-only targets), the confirmations of
 * destructive plans, and a whole PostgreSQL → MySQL run with its summary and exit code.
 */

const PG = 'postgres://app:pw@pg/src';
const MY = 'mysql://app:pw@my/shop';
const CAPTURED = '2026-09-29T10:00:00.000Z';

const SOURCE = schemaSnapshotSchema.parse({
  engine: 'postgres',
  database: 'src',
  capturedAt: CAPTURED,
  schemas: [
    {
      name: 'public',
      tables: [
        {
          name: 'people',
          columns: [
            { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
            { name: 'full_name', ordinal: 2, dataType: 'text', nullable: true },
            { name: 'amount', ordinal: 3, dataType: 'numeric(10,2)', nullable: true },
            { name: 'seen', ordinal: 4, dataType: 'timestamp with time zone', nullable: true },
          ],
          primaryKey: { name: 'people_pkey', columns: ['id'] },
        },
      ],
    },
  ],
});

function mysqlSnapshot(tables: readonly string[]): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'mysql',
    database: 'shop',
    capturedAt: CAPTURED,
    schemas: [
      {
        name: 'shop',
        tables: tables.map((name) => ({
          name,
          columns: [{ name: 'id', ordinal: 1, dataType: 'int', nullable: false }],
          primaryKey: { name: 'PRIMARY', columns: ['id'] },
        })),
      },
    ],
  });
}

const PEOPLE: readonly (readonly (string | number | null)[])[] = [
  [1, 'Ada', '12.50', '2024-01-02 03:04:05+00'],
  [2, 'Grüße 😀', null, null],
  [3, null, '0.25', '1999-12-31 23:59:59+00'],
];

function pgSource(): FakeSession {
  return new FakeSession('postgres', (text): FakeResult => {
    if (text.includes('pg_class')) {
      return {
        columns: [column('relname'), column('reltuples', 'integer')],
        rows: [['people', 3]],
      };
    }
    if (/^SELECT .* FROM "public"\."people"/s.test(text)) {
      return {
        columns: [
          column('id', 'integer'),
          column('full_name'),
          column('amount', 'decimal'),
          column('seen', 'datetime'),
        ],
        rows: PEOPLE,
      };
    }
    return { command: text.split(/\s+/)[0]!.toUpperCase(), rowsAffected: 0 };
  });
}

function mysqlTarget(tables: readonly string[] = []): FakeSession {
  const session = new FakeSession('mysql', (text): FakeResult => {
    if (text === 'SELECT @@foreign_key_checks') {
      return { columns: [column('@@foreign_key_checks', 'integer')], rows: [[1]] };
    }
    if (text.includes('information_schema')) return { columns: [column('x')], rows: [] };
    const command = text.split(/\s+/)[0]!.toUpperCase();
    const inserted = /^INSERT/i.test(text) ? (text.match(/\),\s*\(/g)?.length ?? 0) + 1 : 0;
    return { command, rowsAffected: inserted };
  });
  session.snapshot = mysqlSnapshot(tables);
  return session;
}

/** Opens the fake session of each engine. */
class EngineAdapter implements DriverAdapter {
  readonly engine = 'postgres';
  readonly opened: EngineId[] = [];
  constructor(private readonly sessions: Partial<Record<EngineId, Session>>) {}

  capabilities(): Capabilities {
    return BASE_CAPABILITIES.postgres;
  }

  async connect(resolved: ResolvedProfile): Promise<Session> {
    const session = this.sessions[resolved.profile.engine];
    if (!session) throw new Error(`no fake ${resolved.profile.engine} session`);
    this.opened.push(resolved.profile.engine);
    return session;
  }
}

function fakes(targetTables: readonly string[] = []) {
  const source = pgSource();
  source.snapshot = SOURCE;
  const target = mysqlTarget(targetTables);
  const adapter = new EngineAdapter({ postgres: source, mysql: target });
  return { source, target, adapter };
}

const written = (session: FakeSession): string[] =>
  session.executed
    .map((e) => e.text)
    .filter((text) => /^(CREATE|DROP|TRUNCATE|INSERT|ALTER|DELETE)/i.test(text));

describe('flag parsers', () => {
  it('parses renames, column types, skips, shapes and embeds', () => {
    expect(renameFlag('orders=orders_2024')).toEqual(['orders', 'orders_2024']);
    expect(typeFlag('orders.total=numeric(12,2)')).toEqual(['orders', 'total', 'numeric(12,2)']);
    // The first dot ends the table name: a MongoDB field path keeps its other dots.
    expect(typeFlag('events.meta.source=varchar(40)')).toEqual([
      'events',
      'meta.source',
      'varchar(40)',
    ]);
    expect(skipFlag('orders.note')).toEqual(['orders', 'note']);
    expect(shapeFlag('orders.items=child')).toEqual(['orders', 'items', 'child']);
    expect(shapeFlag('events.tags=json')).toEqual(['events', 'tags', 'json']);
    expect(embedFlag('orders:items:items_order_fk')).toEqual({
      parent: 'orders',
      table: 'items',
      foreignKey: 'items_order_fk',
    });
    expect(embedFlag('orders:items:items_order_fk:lines')).toEqual({
      parent: 'orders',
      table: 'items',
      foreignKey: 'items_order_fk',
      field: 'lines',
    });
  });

  it('refuses malformed values', () => {
    expect(() => renameFlag('orders')).toThrow(InvalidArgumentError);
    expect(() => renameFlag('=x')).toThrow(InvalidArgumentError);
    expect(() => typeFlag('orders=int')).toThrow(/table\.column/);
    expect(() => typeFlag('orders.total=')).toThrow(/type is empty/);
    expect(() => skipFlag('orders')).toThrow(InvalidArgumentError);
    expect(() => shapeFlag('orders.items=table')).toThrow(/columns\|json\|child/);
    expect(() => embedFlag('orders:items')).toThrow(/parent:child:foreign_key/);
    expect(() => embedFlag('orders::fk')).toThrow(InvalidArgumentError);
  });
});

describe('options and spec', () => {
  const defaults = {
    mode: 'create' as const,
    onError: 'stop' as const,
    transaction: true,
    deferConstraints: true,
    resetSequences: true,
    idFromKey: true,
    ttl: true,
  };

  it('maps the flags to the engine options, negations included', () => {
    const options = transferDbOptions({
      ...defaults,
      table: ['orders'],
      batchSize: 250,
      parallel: 4,
      sample: 50,
      transaction: false,
      deferConstraints: false,
      resetSequences: false,
      idFromKey: false,
      ttl: false,
      replace: true,
      disableConstraints: true,
      targetSchema: 'archive',
      dryRun: true,
    });
    expect(options.objects).toEqual(['orders']);
    expect(options.targetSchema).toBe('archive');
    expect(options.dryRun).toBe(true);
    expect(options.options).toEqual({
      mode: 'create',
      onError: 'stop',
      transactionPerBatch: false,
      disableConstraints: true,
      deferConstraints: false,
      resetSequences: false,
      idFromPrimaryKey: false,
      replace: true,
      keepTtl: false,
      batchSize: 250,
      parallel: 4,
      sampleSize: 50,
    });
    const plain = transferDbOptions({ ...defaults, all: true });
    expect(plain.all).toBe(true);
    expect(plain.options).toMatchObject({ transactionPerBatch: true, keepTtl: true });
    expect(plain).not.toHaveProperty('tunnel');
  });

  it('builds one object per table with its overrides', () => {
    const options: TransferDbOptions = {
      ...transferDbOptions({ ...defaults, table: ['orders', 'items'] }),
      renames: [['orders', 'orders_copy']],
      types: [['orders', 'total', 'numeric(12,2)']],
      skips: [['orders', 'note']],
      shapes: [],
      embeds: [{ parent: 'orders', table: 'items', foreignKey: 'fk', field: 'lines' }],
    };
    const spec = buildSpec(options, 'postgres', ['orders', 'items'], 'sales');
    expect(spec.source).toEqual({ schema: 'sales' });
    expect(spec.objects).toEqual([
      {
        name: 'orders',
        target: 'orders_copy',
        columns: [
          { source: 'total', dataType: 'numeric(12,2)' },
          { source: 'note', skip: true },
        ],
        embed: [{ table: 'items', foreignKey: 'fk', field: 'lines' }],
      },
      { name: 'items' },
    ]);
    expect(() =>
      buildSpec({ ...options, types: [['nope', 'x', 'int']] }, 'postgres', ['orders'], undefined),
    ).toThrow(/nope is not one of the tables/);
    const keys = transferDbOptions({ ...defaults, pattern: ['user:*'] });
    const redis = buildSpec(keys, 'redis', [], undefined);
    expect(redis.objects).toEqual([]);
    expect(redis.keyPatterns).toEqual(['user:*']);
  });
});

describe('joinery transfer', () => {
  let dir = '';
  let cleanup: () => void = () => undefined;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });

  afterEach(() => cleanup());

  it('prints the plan with --dry-run and writes nothing', async () => {
    const { target, adapter } = fakes();
    const result = await run(['transfer', PG, MY, '--table', 'people', '--dry-run'], { adapter });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('people → people (create, about 3 rows)');
    expect(result.stdout).toMatch(/amount\s+numeric\(10,2\)\s+→ decimal\(10,2\)/);
    expect(result.stdout).toMatch(/seen\s+timestamp with time zone\s+→ datetime\(6\)/);
    expect(result.stdout).toContain('-- Before the data');
    expect(result.stdout).toContain('CREATE TABLE `people`');
    expect(written(target)).toEqual([]);
    expect(target.closed).toBe(true);

    const json = await run(
      ['transfer', PG, MY, '--table', 'public.people', '--dry-run', '--json'],
      {
        adapter: fakes().adapter,
      },
    );
    expect(json.code).toBe(0);
    const plan = JSON.parse(json.stdout) as {
      tables: { target: string; columns: { source: string; targetType: string }[] }[];
      creates: string[];
    };
    expect(plan.tables[0]!.columns.map((c) => [c.source, c.targetType])).toEqual([
      ['id', 'int'],
      ['full_name', 'longtext'],
      ['amount', 'decimal(10,2)'],
      ['seen', 'datetime(6)'],
    ]);
    expect(plan.creates).toEqual(['Create table people']);
  });

  it('prints the plan with a changed type and a renamed table', async () => {
    const { adapter } = fakes();
    const result = await run(
      [
        'transfer',
        PG,
        MY,
        '--table',
        'people',
        '--rename',
        'people=persons',
        '--type',
        'people.full_name=varchar(200)',
        '--skip',
        'people.seen',
        '--dry-run',
      ],
      { adapter },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('people → persons');
    expect(result.stdout).toMatch(/full_name\s+text\s+→ varchar\(200\)/);
    expect(result.stdout).toMatch(/seen .*\(skipped\)/);
    expect(result.stdout).toContain('CREATE TABLE `persons`');
  });

  it('checks the pair, the objects and read-only targets before connecting', async () => {
    const { adapter } = fakes();
    const pair = await run(['transfer', 'redis://r1:6379/0', PG, '--pattern', '*'], { adapter });
    expect(pair.code).toBe(2);
    expect(pair.stderr).toContain('Data transfer from Redis to PostgreSQL is not supported');

    const noKeys = await run(['transfer', 'redis://r1:6379/0', 'redis://r2:6379/0'], { adapter });
    expect(noKeys.code).toBe(2);
    expect(noKeys.stderr).toContain('Name the keys to copy with --pattern');

    const noTables = await run(['transfer', PG, MY], { adapter });
    expect(noTables.code).toBe(2);
    expect(noTables.stderr).toContain('Name the tables to transfer');
    expect(noTables.stderr).toContain('--table (repeatable) or --all');

    const badMode = await run(['transfer', PG, MY, '--table', 'people', '--mode', 'merge'], {
      adapter,
    });
    expect(badMode.code).toBe(2);
    expect(badMode.stderr).toContain('Allowed choices are create, drop-create, truncate, append');

    const store = ['--store', join(dir, 'joinery.db')];
    const added = await run([...store, 'profiles', 'add', 'Locked', MY, '--read-only'], {
      adapter,
      cwd: dir,
    });
    expect(added.code).toBe(0);
    const locked = await run([...store, 'transfer', PG, 'Locked', '--table', 'people'], {
      adapter,
      cwd: dir,
      env: { JOINERY_PASSWORD: 'pw' },
    });
    expect(locked.code).toBe(2);
    expect(locked.stderr).toContain('"Locked" is read-only; nothing can be transferred into it');
    expect(adapter.opened).toEqual([]);
  });

  it('confirms dropping an existing table, and refuses without an answer', async () => {
    const refused = fakes(['people']);
    const unasked = await run(['transfer', PG, MY, '--table', 'people', '--mode', 'drop-create'], {
      adapter: refused.adapter,
    });
    expect(unasked.code).toBe(2);
    expect(unasked.stderr).toContain('Drop table people (it exists) and create it again');
    expect(unasked.stderr).toContain('needs confirmation');
    expect(unasked.stderr).toContain('--yes');
    expect(written(refused.target)).toEqual([]);

    const declined = fakes(['people']);
    const prompter = new ScriptedPrompter(true, { confirm: ['no'] });
    const no = await run(['transfer', PG, MY, '--table', 'people', '--mode', 'truncate'], {
      adapter: declined.adapter,
      prompter,
    });
    expect(no.code).toBe(2);
    expect(prompter.asked).toEqual([
      'The transfer drops, empties or overwrites data on "MySQL my/shop". Continue?',
    ]);
    expect(no.stderr).toContain('Empty table people');
    expect(no.stderr).toContain('Not confirmed');
    expect(written(declined.target)).toEqual([]);
  });

  it('runs a transfer and prints the summary', async () => {
    const { source, target, adapter } = fakes();
    const result = await run(
      ['transfer', PG, MY, '--table', 'people', '--batch-size', '2', '--json'],
      { adapter },
    );
    expect(result.stderr).toContain('Transferred 3 rows into MySQL');
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as { status: string; rowsWritten: number };
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
    const statements = written(target);
    expect(statements[0]).toMatch(/^CREATE TABLE `people`/);
    expect(statements.filter((s) => s.startsWith('INSERT'))).toHaveLength(2);
    expect(source.closed).toBe(true);
    expect(target.closed).toBe(true);
  });
});
