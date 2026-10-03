import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QuerybaraError, schemaSnapshotSchema, type SchemaSnapshot } from '@querybara/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverKey } from '../src/commands/data-compare';
import { FakeSession, RoutingAdapter, run, tempDir, type FakeResult } from './helpers';

function snapshot(
  engine: 'postgres' | 'mysql',
  database: string,
  tables: readonly { name: string; columns: string[] }[],
): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine,
    database,
    capturedAt: '2026-01-01T00:00:00Z',
    schemas: [
      {
        name: engine === 'postgres' ? 'public' : database,
        tables: tables.map((table) => ({
          name: table.name,
          columns: table.columns.map((name, i) => ({
            name,
            ordinal: i + 1,
            dataType: engine === 'postgres' ? 'integer' : 'int',
            nullable: i > 0,
          })),
          primaryKey: {
            name: engine === 'postgres' ? `${table.name}_pkey` : 'PRIMARY',
            columns: [table.columns[0]],
          },
          ...(engine === 'mysql' ? { options: { engine: 'InnoDB' } } : {}),
        })),
      },
    ],
  });
}

const SOURCE = [{ name: 'users', columns: ['id', 'age'] }];
const TARGET = [
  { name: 'users', columns: ['id'] },
  { name: 'legacy', columns: ['id'] },
];

/** Source and target sessions; the target converges to the source when its script commits. */
function pair(
  engine: 'postgres' | 'mysql',
  options: { converge?: boolean; fail?: string } = {},
): { source: FakeSession; target: FakeSession; adapter: RoutingAdapter } {
  const source = new FakeSession(engine, () => ({ command: 'SELECT', rowsAffected: 0 }));
  source.snapshot = snapshot(engine, 'a', SOURCE);
  const target: FakeSession = new FakeSession(engine, (text): FakeResult => {
    if (options.fail && text.includes(options.fail)) {
      target.inTransaction = engine === 'postgres';
      return {
        error: new QuerybaraError({
          code: 'SQL_ERROR',
          message: 'lock timeout',
          sqlState: '55P03',
        }),
      };
    }
    if (text === 'BEGIN') target.inTransaction = true;
    if (text === 'ROLLBACK' || text === 'COMMIT') target.inTransaction = false;
    return { command: text.split(' ')[0]!, rowsAffected: null };
  });
  target.snapshot = snapshot(engine, 'b', TARGET);
  const execute = target.execute.bind(target);
  target.execute = (text, opts) => {
    const iterable = execute(text, opts);
    const done = engine === 'postgres' ? text === 'COMMIT' : text === 'SET FOREIGN_KEY_CHECKS = 1';
    if (done && options.converge !== false) {
      const dropped = target.executed.some((e) => e.text.startsWith('DROP TABLE'));
      target.snapshot = snapshot(engine, 'b', dropped ? SOURCE : [...SOURCE, TARGET[1]!]);
    }
    return iterable;
  };
  return { source, target, adapter: new RoutingAdapter(engine, { a: source, b: target }) };
}

const PG_A = 'postgres://u:pw@h/a?sslmode=disable';
const PG_B = 'postgres://u:pw@h/b?sslmode=disable';
const MY_A = 'mysql://u:pw@h/a';
const MY_B = 'mysql://u:pw@h/b';

describe('compare', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it('exits 0 for identical structures', async () => {
    const { adapter, target } = pair('postgres');
    target.snapshot = snapshot('postgres', 'b', SOURCE);
    const result = await run(['compare', PG_A, PG_B], { adapter });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No differences.');
  });

  it('exits 1 and lists the operations, with destructive ones unselected', async () => {
    const { adapter } = pair('postgres');
    const result = await run(['compare', PG_A, PG_B, '--out', 'deploy.sql', '--html', 'r.html'], {
      adapter,
      cwd: dir,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      '2 differences: 1 create, 1 drop (1 destructive, 1 not selected)',
    );
    expect(result.stdout).toMatch(/\+ column\s+public\.users\.age/);
    expect(result.stdout).toMatch(/- table\s+public\.legacy\s+\[destructive, not selected\]/);
    const script = readFileSync(join(dir, 'deploy.sql'), 'utf8');
    expect(script).toContain('ALTER TABLE "public"."users" ADD COLUMN "age" integer;');
    expect(script).not.toContain('DROP TABLE');
    expect(readFileSync(join(dir, 'r.html'), 'utf8')).toContain('<html');
  });

  it('prints a machine-readable diff with --json', async () => {
    const { adapter } = pair('postgres');
    const result = await run(['compare', PG_A, PG_B, '--json', '--include-destructive'], {
      adapter,
    });
    expect(result.code).toBe(1);
    const json = JSON.parse(result.stdout) as {
      identical: boolean;
      summary: { total: number; selected: number };
      operations: { id: string; kind: string; selected: boolean; statements: string[] }[];
      script: { transactional: boolean; statements: string[] };
    };
    expect(json.identical).toBe(false);
    expect(json.summary).toMatchObject({ total: 2, selected: 2 });
    expect(json.operations.map((op) => op.kind).sort()).toEqual(['create', 'drop']);
    expect(json.script.transactional).toBe(true);
    expect(json.script.statements[0]).toBe('BEGIN');
  });

  it('applies, re-compares and fails loudly when unselected differences remain', async () => {
    const { adapter, target } = pair('postgres');
    const result = await run(['compare', PG_A, PG_B, '--apply'], { adapter });
    expect(result.code).toBe(1);
    expect(target.executed.map((e) => e.text)).toEqual([
      'BEGIN',
      'ALTER TABLE "public"."users" ADD COLUMN "age" integer',
      'COMMIT',
    ]);
    expect(result.stderr).toContain(
      'error: 1 difference remains after applying the script: operations that were not selected',
    );
    expect(result.stdout).toMatch(
      /Remaining differences after applying:\n {2}- table\s+public\.legacy/,
    );
  });

  it('applies destructive operations when included and exits 0 once the target matches', async () => {
    const { adapter, target } = pair('postgres');
    const refused = await run(['compare', PG_A, PG_B, '--apply', '--include-destructive'], {
      adapter,
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('needs confirmation');
    expect(target.executed).toHaveLength(0);

    const result = await run(['compare', PG_A, PG_B, '--apply', '--include-destructive', '--yes'], {
      adapter,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('the target now matches the source');
    expect(target.executed.map((e) => e.text)).toContain('DROP TABLE "public"."legacy"');
  });

  it('fails loudly when applied operations did not converge', async () => {
    const { adapter } = pair('postgres', { converge: false });
    const result = await run(['compare', PG_A, PG_B, '--apply', '--include-destructive', '--yes'], {
      adapter,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('2 of them from operations that were applied');
  });

  it('rolls back the PostgreSQL transaction when a statement fails', async () => {
    const { adapter, target } = pair('postgres', { fail: 'ADD COLUMN' });
    const result = await run(['compare', PG_A, PG_B, '--apply'], { adapter });
    expect(result.code).toBe(2);
    expect(target.executed.map((e) => e.text).at(-1)).toBe('ROLLBACK');
    expect(result.stderr).toContain('error: lock timeout');
    expect(result.stderr).toContain('The transaction was rolled back; the target is unchanged.');
  });

  it('warns about non-transactional MySQL DDL and requires --yes', async () => {
    const { adapter, target } = pair('mysql');
    const refused = await run(['compare', MY_A, MY_B, '--apply', '--include-destructive'], {
      adapter,
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('runs DDL outside transactions');
    expect(refused.stderr).toContain('Pass --yes to apply a non-transactional script');
    expect(target.executed).toHaveLength(0);

    const applied = await run(
      ['compare', MY_A, MY_B, '--apply', '--include-destructive', '--yes'],
      {
        adapter,
      },
    );
    expect(applied.code).toBe(0);
    expect(target.executed[0]?.text).toBe('SET FOREIGN_KEY_CHECKS = 0');
  });

  it('refuses to compare across engine families', async () => {
    const pg = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
    const my = new FakeSession('mysql', () => ({ command: 'SELECT', rowsAffected: 0 }));
    const adapter = {
      engine: 'postgres' as const,
      capabilities: () => pg.capabilities(),
      connect: async (resolved: { profile: { engine: string } }) =>
        resolved.profile.engine === 'postgres' ? pg : my,
    };
    const result = await run(['compare', PG_A, MY_B], { adapter });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Cannot compare PostgreSQL with MySQL');
  });
});

describe('data-compare key discovery', () => {
  it('uses the primary key, else a unique NOT NULL key', async () => {
    const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
    session.snapshot = schemaSnapshotSchema.parse({
      engine: 'postgres',
      database: 'd',
      capturedAt: 'now',
      schemas: [
        {
          name: 'public',
          tables: [
            {
              name: 'with_pk',
              columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: false }],
              primaryKey: { name: 'pk', columns: ['id'] },
            },
            {
              name: 'with_unique',
              columns: [
                { name: 'a', ordinal: 1, dataType: 'integer', nullable: true },
                { name: 'b', ordinal: 2, dataType: 'integer', nullable: false },
              ],
              uniques: [
                { name: 'u_a', columns: ['a'] },
                { name: 'u_b', columns: ['b'] },
              ],
            },
            {
              name: 'keyless',
              columns: [{ name: 'x', ordinal: 1, dataType: 'integer', nullable: false }],
            },
          ],
        },
      ],
    });
    expect(await discoverKey(session, 'postgres', { schema: 'public', name: 'with_pk' })).toEqual([
      'id',
    ]);
    expect(
      await discoverKey(session, 'postgres', { schema: 'public', name: 'WITH_UNIQUE' }),
    ).toEqual(['b']);
    await expect(
      discoverKey(session, 'postgres', { schema: 'public', name: 'keyless' }),
    ).rejects.toMatchObject({
      hint: expect.stringContaining('--key'),
    });
    await expect(
      discoverKey(session, 'postgres', { schema: 'public', name: 'nope' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
