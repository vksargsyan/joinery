import type { CellValue, ColumnKind, Session } from '@querybara/core';
import { quoteIdent } from '@querybara/sql-tools';
import { describe, expect, it } from 'vitest';

import { compareTableData, generateDataSyncScript, sqlLiteral } from '../../src';
import type { DataCompareOptions, DataCompareSummary, RowDiff, TablePair } from '../../src';
import { configuredServers, dialectOf, query, runStatements, ScratchDatabases } from './helpers';
import type { ServerEngine, TestServer } from './helpers';

/**
 * The data sync round trip (spec §13, data sync): two tables with the same structure and
 * overlapping rows (only in the source, only in the target, changed, identical), compared with
 * range checksums and bisection, synced with the generated script through the driver, then
 * compared again: zero differences, and the tables hold exactly the same values.
 */

type Value = CellValue;

/** A deterministic pseudo-random generator (mulberry32), so failures reproduce. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = [
  '',
  'plain',
  "it's",
  'O\'Brien said "hi"',
  'back\\slash \\n not a newline',
  'line\nbreak\tand tab',
  'Grüße, 東京, emoji 😀',
  'Ωμέγα',
  '%_ like wildcards',
  '  padded  ',
];

/** Column layout of the single-key table; the SQL types per engine family. */
const ITEM_COLUMNS: readonly {
  readonly name: string;
  readonly postgres: string;
  readonly mysql: string;
  make(rnd: () => number, id: number): Value;
}[] = [
  {
    name: 'qty',
    postgres: 'integer',
    mysql: 'int',
    make: (rnd) => (rnd() < 0.1 ? null : Math.floor(rnd() * 2_000_000) - 1_000_000),
  },
  {
    name: 'big',
    postgres: 'bigint',
    mysql: 'bigint',
    make: (rnd, id) =>
      rnd() < 0.1 ? null : id % 7 === 0 ? 9_007_199_254_740_993n + BigInt(id) : -id * 1000,
  },
  {
    name: 'price',
    postgres: 'numeric(20,6)',
    mysql: 'decimal(20,6)',
    make: (rnd) =>
      rnd() < 0.1
        ? null
        : `${rnd() < 0.5 ? '-' : ''}${Math.floor(rnd() * 1e9)}.${String(Math.floor(rnd() * 1e6)).padStart(6, '0')}`,
  },
  {
    name: 'ratio',
    postgres: 'double precision',
    mysql: 'double',
    make: (rnd) =>
      rnd() < 0.1 ? null : [0.1, 1e-300, -2.5e10, 123456.789, 1 / 3][Math.floor(rnd() * 5)]!,
  },
  {
    name: 'name',
    postgres: 'text',
    mysql: 'text',
    make: (rnd) => (rnd() < 0.15 ? null : TEXTS[Math.floor(rnd() * TEXTS.length)]!),
  },
  {
    name: 'code',
    postgres: 'varchar(40)',
    mysql: 'varchar(40)',
    make: (rnd, id) => (rnd() < 0.1 ? '' : `C-${id.toString(36)}-${Math.floor(rnd() * 100)}`),
  },
  {
    name: 'flag',
    postgres: 'boolean',
    mysql: 'tinyint(1)',
    make: (rnd) => (rnd() < 0.1 ? null : rnd() < 0.5),
  },
  {
    name: 'born',
    postgres: 'date',
    mysql: 'date',
    make: (rnd) =>
      rnd() < 0.1
        ? null
        : `${1900 + Math.floor(rnd() * 200)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
  },
  {
    name: 'seen',
    postgres: 'timestamp(3)',
    mysql: 'datetime(3)',
    make: (rnd) =>
      rnd() < 0.1
        ? null
        : `20${String(10 + Math.floor(rnd() * 20))}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)} 1${Math.floor(rnd() * 9)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:0${Math.floor(rnd() * 9)}.${String(Math.floor(rnd() * 1000)).padStart(3, '0')}`,
  },
  {
    name: 'at',
    postgres: 'timestamptz(3)',
    mysql: 'timestamp(3) NULL',
    make: (rnd) =>
      rnd() < 0.1
        ? null
        : new Date(Date.UTC(2001, 0, 1) + Math.floor(rnd() * 8e11))
            .toISOString()
            .replace('T', ' ')
            .replace('Z', ''),
  },
  {
    name: 'u',
    postgres: 'uuid',
    mysql: 'char(36)',
    make: (rnd) =>
      rnd() < 0.1
        ? null
        : '00000000-0000-4000-8000-000000000000'.replace(/0/g, () =>
            Math.floor(rnd() * 16).toString(16),
          ),
  },
  {
    name: 'doc',
    postgres: 'jsonb',
    mysql: 'json',
    make: (rnd, id) =>
      rnd() < 0.1
        ? null
        : JSON.stringify({ id, tags: ['a', "b'c", 'é'], nested: { ok: rnd() < 0.5, n: null } }),
  },
  {
    name: 'raw',
    postgres: 'bytea',
    mysql: 'blob',
    make: (rnd) =>
      rnd() < 0.1
        ? null
        : Uint8Array.from({ length: Math.floor(rnd() * 12) }, (_v, i) =>
            i === 0 ? 0 : i === 1 ? 255 : Math.floor(rnd() * 256),
          ),
  },
];

/** Values of a changed row: every column re-drawn from a different seed. */
function itemRow(id: number, seed: number): Value[] {
  const rnd = random(id * 7919 + seed);
  return [id, ...ITEM_COLUMNS.map((c) => c.make(rnd, id))];
}

const REGIONS = ['alpha', 'Zeta', 'Émile', 'ümlaut', "o'brien", 'mid-point', 'Øresund'];

function pairRow(region: string, n: number, seed: number): Value[] {
  const rnd = random(n * 31 + region.length * 1009 + seed);
  return [
    region,
    n,
    rnd() < 0.1 ? null : TEXTS[Math.floor(rnd() * TEXTS.length)]!,
    rnd() < 0.1
      ? null
      : `${Math.floor(rnd() * 100000)}.${String(Math.floor(rnd() * 100)).padStart(2, '0')}`,
  ];
}

interface Fixture {
  readonly table: string;
  readonly keyColumns: readonly string[];
  /** Key columns holding strings: listed in binary order when the contents are compared. */
  readonly stringKeys: readonly string[];
  readonly columns: readonly string[];
  readonly source: readonly Value[][];
  readonly target: readonly Value[][];
  readonly expected: {
    readonly inserts: number;
    readonly updates: number;
    readonly deletes: number;
  };
  ddl(engine: ServerEngine): string;
}

/**
 * 5 000 keys: scattered keys only in the source or only in the target, a contiguous block
 * missing from the target, 100 target-only keys past the end, and scattered changed rows (every
 * value re-drawn, so some change only NULL ↔ '' or a single column). Most 40-row ranges still
 * match, so both the checksum and the bisection paths run.
 */
function itemsFixture(): Fixture {
  const source: Value[][] = [];
  const target: Value[][] = [];
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  for (let id = 1; id <= 5000; id++) {
    const inSource = !onlyInTarget(id);
    const inTarget = !onlyInSource(id);
    const row = itemRow(id, 1);
    if (inSource) source.push(row);
    if (inTarget) {
      const changed = isChanged(id) ? itemRow(id, 2) : row;
      target.push(changed);
      if (inSource && changed !== row) updates++;
    }
    if (inSource && !inTarget) inserts++;
    if (inTarget && !inSource) deletes++;
  }
  for (let id = 5001; id <= 5100; id++) {
    target.push(itemRow(id, 3));
    deletes++;
  }
  return {
    table: 'items',
    keyColumns: ['id'],
    stringKeys: [],
    columns: ['id', ...ITEM_COLUMNS.map((c) => c.name)],
    source,
    target,
    // A re-drawn row can come out identical; the compare must not count it.
    expected: { inserts, updates: updates - identicalRedraws(), deletes },
    ddl: (engine) => {
      const family = engine === 'postgres' ? 'postgres' : 'mysql';
      const cols = ITEM_COLUMNS.map(
        (c) => `${quoteIdent(c.name, dialectOf(engine))} ${c[family]}`,
      ).join(', ');
      return `CREATE TABLE items (id bigint NOT NULL PRIMARY KEY, ${cols})`;
    },
  };
}

const onlyInTarget = (id: number): boolean => id % 397 === 0;
const onlyInSource = (id: number): boolean => id % 331 === 0 || (id > 2000 && id <= 2060);
const isChanged = (id: number): boolean => id % 211 === 0 || id % 1000 === 7;

function identicalRedraws(): number {
  let count = 0;
  for (let id = 1; id <= 5000; id++) {
    if (!isChanged(id) || onlyInTarget(id) || onlyInSource(id)) continue;
    if (JSON.stringify(itemRow(id, 1), replacer) === JSON.stringify(itemRow(id, 2), replacer))
      count++;
  }
  return count;
}

/** 7 string regions × 400: composite key whose collation order differs from binary order. */
function pairsFixture(): Fixture {
  const source: Value[][] = [];
  const target: Value[][] = [];
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  for (const region of REGIONS) {
    for (let n = 1; n <= 400; n++) {
      const inSource = !(region === 'Zeta' && n > 380);
      const inTarget = !(region === 'Émile' && n % 50 === 0);
      const row = pairRow(region, n, 1);
      if (inSource) source.push(row);
      if (inTarget) {
        const changed = n % 97 === 0 ? [region, n, 'changed', row[3] ?? null] : row;
        target.push(changed);
        if (inSource && changed !== row && changed[2] !== row[2]) updates++;
      }
      if (inSource && !inTarget) inserts++;
      if (inTarget && !inSource) deletes++;
    }
  }
  return {
    table: 'pairs',
    keyColumns: ['region', 'n'],
    stringKeys: ['region'],
    columns: ['region', 'n', 'label', 'amount'],
    source,
    target,
    expected: { inserts, updates, deletes },
    ddl: (engine) =>
      engine === 'postgres'
        ? 'CREATE TABLE pairs (region varchar(20) NOT NULL, n integer NOT NULL, label text, amount numeric(12,2), PRIMARY KEY (region, n))'
        : 'CREATE TABLE pairs (region varchar(20) NOT NULL, n int NOT NULL, label text, amount decimal(12,2), PRIMARY KEY (region, n))',
  };
}

/**
 * 1 500 string keys where some differ between the sides only by letter case, an accent or a
 * trailing space: equal under MariaDB's default case- and accent-insensitive PAD SPACE
 * collation, different byte for byte. The compare works in binary order, so each such key is
 * a delete of the target's spelling plus an insert of the source's.
 */
function wordsFixture(): Fixture {
  const source: Value[][] = [];
  const target: Value[][] = [];
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  for (let i = 0; i < 1500; i++) {
    const word = `w${String(i).padStart(4, '0')}e`;
    const variant =
      i % 97 === 0
        ? word.toUpperCase()
        : i % 89 === 0
          ? `${word} `
          : i % 83 === 0
            ? word.replace(/e$/, 'é')
            : word;
    source.push([word, i]);
    const changed = i % 71 === 0 && variant === word;
    target.push([variant, changed ? -i : i]);
    if (variant !== word) {
      inserts++;
      deletes++;
    } else if (changed && i !== 0) {
      updates++;
    }
  }
  return {
    table: 'words',
    keyColumns: ['k'],
    stringKeys: ['k'],
    columns: ['k', 'v'],
    source,
    target,
    expected: { inserts, updates, deletes },
    ddl: () => 'CREATE TABLE words (k varchar(40) NOT NULL PRIMARY KEY, v int)',
  };
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('hex')}`;
  return value;
}

/** Inserts rows with literal VALUES lists, a few hundred per statement. */
async function load(
  session: Session,
  engine: ServerEngine,
  fixture: Fixture,
  rows: readonly Value[][],
): Promise<void> {
  const dialect = dialectOf(engine);
  const cols = fixture.columns.map((c) => quoteIdent(c, dialect)).join(', ');
  for (let i = 0; i < rows.length; i += 250) {
    const values = rows
      .slice(i, i + 250)
      .map((row) => `(${row.map((v) => sqlLiteral(v, dialect)).join(', ')})`)
      .join(', ');
    await query(session, `INSERT INTO ${fixture.table} (${cols}) VALUES ${values}`);
  }
}

/** Every row of a table in key order, with values made comparable (bytes as hex, bigints). */
async function contents(
  session: Session,
  engine: ServerEngine,
  fixture: Fixture,
): Promise<string[]> {
  const dialect = dialectOf(engine);
  const cols = fixture.columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const order = fixture.keyColumns
    .map((c) => {
      const ident = quoteIdent(c, dialect);
      if (!fixture.stringKeys.includes(c)) return ident;
      return engine === 'postgres' ? `${ident} COLLATE "C"` : `CAST(${ident} AS BINARY)`;
    })
    .join(', ');
  const rows = await query(session, `SELECT ${cols} FROM ${fixture.table} ORDER BY ${order}`);
  return rows.map((row) => JSON.stringify(row, replacer));
}

interface CompareResult {
  readonly diffs: RowDiff[];
  readonly summary: DataCompareSummary;
  readonly columns: readonly string[];
  readonly targetKinds: Record<string, ColumnKind>;
}

async function compare(
  source: Session,
  target: Session,
  fixture: Fixture,
  options: DataCompareOptions,
): Promise<CompareResult> {
  const pair: TablePair = {
    source: { schema: 'public', name: fixture.table },
    target: { schema: 'public', name: fixture.table },
    keyColumns: fixture.keyColumns,
  };
  const diffs: RowDiff[] = [];
  let columns: readonly string[] = [];
  let targetKinds: Record<string, ColumnKind> = {};
  let summary: DataCompareSummary | undefined;
  for await (const event of compareTableData(source, target, pair, options)) {
    if (event.type === 'start') {
      columns = [...fixture.keyColumns, ...event.compared];
      targetKinds = Object.fromEntries(event.targetColumns.map((c) => [c.name, c.kind]));
    } else if (event.type === 'diff') {
      diffs.push(event.diff);
    } else if (event.type === 'done') {
      summary = event.summary;
    }
  }
  if (summary === undefined) throw new Error('compareTableData ended without a summary');
  return { diffs, summary, columns, targetKinds };
}

async function dataRoundTrip(server: TestServer, fixture: Fixture): Promise<void> {
  const engine = server.engine;
  const dialect = dialectOf(engine);
  const scratch = new ScratchDatabases(server);
  try {
    const source = await scratch.create(`data_${fixture.table}_src`);
    const target = await scratch.create(`data_${fixture.table}_tgt`);
    for (const [session, rows] of [
      [source, fixture.source],
      [target, fixture.target],
    ] as const) {
      await query(session, fixture.ddl(engine));
      await load(session, engine, fixture, rows);
    }

    // Small ranges so the key space is split, identical ranges match by checksum and
    // mismatched ones are bisected before rows are streamed.
    const options: DataCompareOptions = { chunkRows: 1000, streamRows: 40, pageSize: 300 };
    const before = await compare(source, target, fixture, options);
    const counts = (s: DataCompareSummary): object => ({
      inserts: s.inserts,
      updates: s.updates,
      deletes: s.deletes,
    });
    expect(counts(before.summary)).toEqual(fixture.expected);
    expect(before.summary.checksums).toBe(true);
    expect(before.summary.matchedRanges).toBeGreaterThan(0);
    expect(before.summary.streamedRanges).toBeGreaterThan(0);
    expect(before.summary.ranges).toBeGreaterThan(Math.ceil(fixture.source.length / 1000));
    expect(before.summary.sourceRows).toBe(fixture.source.length);
    expect(before.summary.targetRows).toBe(fixture.target.length);

    // Streaming every row finds exactly the same differences.
    const streamed = await compare(source, target, fixture, { checksums: false });
    const describe = (diffs: readonly RowDiff[]): string[] =>
      diffs.map((d) => `${d.action} ${JSON.stringify(d.key, replacer)}`).sort();
    expect(describe(streamed.diffs)).toEqual(describe(before.diffs));

    const script = generateDataSyncScript(before.diffs, {
      dialect,
      table: { schema: 'public', name: fixture.table },
      keyColumns: fixture.keyColumns,
      sourceColumns: before.columns,
      targetColumns: before.columns,
      targetKinds: before.targetKinds,
      batchSize: 200,
    });
    expect(script.counts).toEqual({
      insert: fixture.expected.inserts,
      update: fixture.expected.updates,
      delete: fixture.expected.deletes,
    });
    await runStatements(target, script.statements);

    const after = await compare(source, target, fixture, options);
    expect(counts(after.summary)).toEqual({ inserts: 0, updates: 0, deletes: 0 });
    expect(after.diffs).toEqual([]);
    expect(after.summary.matchedRanges).toBe(after.summary.ranges);
    expect(await contents(target, engine, fixture)).toEqual(
      await contents(source, engine, fixture),
    );
  } finally {
    await scratch.dropAll();
  }
}

const servers = configuredServers();

describe('data sync round trip', () => {
  if (servers.length === 0) it.skip('no QUERYBARA_TEST_*_URL is set', () => undefined);
  for (const server of servers) {
    describe(server.engine, () => {
      it('single-column key, every value kind', () => dataRoundTrip(server, itemsFixture()));
      it('composite string + integer key', () => dataRoundTrip(server, pairsFixture()));
      it('string keys equal only under the collation', () => dataRoundTrip(server, wordsFixture()));
    });
  }
});
