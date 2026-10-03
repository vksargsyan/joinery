import type { CellValue, ColumnKind, ColumnMeta } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  bytesSource,
  exportRows,
  exportTables,
  memorySink,
  parseCsv,
  readRows,
  type ExportOptions,
  type Sink,
} from '../src';
import { FakeSession } from './fake-session';

const col = (name: string, kind: ColumnKind, nativeType = kind): ColumnMeta => ({
  name,
  kind,
  nativeType,
});

const COLUMNS: ColumnMeta[] = [
  col('id', 'integer'),
  col('big', 'bigint'),
  col('price', 'decimal'),
  col('ratio', 'float'),
  col('ok', 'boolean'),
  col('name', 'string'),
  col('doc', 'json'),
  col('bin', 'binary'),
  col('at', 'timestamp'),
];

const ROWS: CellValue[][] = [
  [
    1,
    9007199254740993n,
    '12.50',
    0.1,
    true,
    'plain',
    '{"a": [1, 2]}',
    new Uint8Array([0xde, 0xad]),
    '2024-01-02 03:04:05+00',
  ],
  [
    2,
    null,
    '-0.001',
    1e-300,
    false,
    'O\'Brien, "quoted"\nline',
    '"just a string"',
    new Uint8Array([]),
    null,
  ],
  [3, -5, null, null, null, '', null, null, '2024-12-31 23:59:59.999+00'],
];

function session(engine: 'postgres' | 'mysql' | 'mariadb' = 'postgres'): FakeSession {
  const s = new FakeSession(engine);
  s.result = { columns: COLUMNS, rows: ROWS };
  return s;
}

async function exportText(
  options: Partial<ExportOptions> & Pick<ExportOptions, 'format'>,
  engine?: 'postgres' | 'mysql' | 'mariadb',
): Promise<string> {
  const sink = memorySink();
  const summary = await exportRows({
    session: session(engine),
    query: 'SELECT * FROM t',
    sink,
    ...options,
  });
  expect(summary.status).toBe('completed');
  expect(summary.rowsWritten).toBe(3);
  expect(sink.closed).toBe(true);
  return sink.text();
}

describe('CSV and TSV export', () => {
  it('writes a header, quotes what needs it and writes binary as hex', async () => {
    const text = await exportText({ format: 'csv' });
    expect(text.split('\r\n')).toEqual([
      'id,big,price,ratio,ok,name,doc,bin,at',
      '1,9007199254740993,12.50,0.1,true,plain,"{""a"": [1, 2]}",\\xdead,2024-01-02 03:04:05+00',
      '2,,-0.001,1e-300,false,"O\'Brien, ""quoted""\nline","""just a string""",\\x,',
      '3,-5,,,,"",,,2024-12-31 23:59:59.999+00',
      '',
    ]);
  });

  it('reads back to the same text, NULLs and empty strings apart', async () => {
    const text = await exportText({ format: 'csv' });
    const records = parseCsv(text);
    expect(records[3]).toEqual([
      '3',
      '-5',
      null,
      null,
      null,
      '',
      null,
      null,
      '2024-12-31 23:59:59.999+00',
    ]);
  });

  it('honours delimiter, quoting, NULL marker, line ending, BOM and UTF-16', async () => {
    const tsv = await exportText({
      format: 'tsv',
      csv: { header: false, quoting: 'all', nullMarker: '\\N', lineEnding: '\n', binary: 'base64' },
    });
    expect(tsv.trimEnd().split('\n').at(-1)).toBe(
      '"3"\t"-5"\t\\N\t\\N\t\\N\t""\t\\N\t\\N\t"2024-12-31 23:59:59.999+00"',
    );
    expect(tsv.split('\n')[0]).toContain('"3q0="');
    const sink = memorySink();
    await exportRows({
      session: session(),
      query: 'SELECT 1',
      sink,
      format: 'csv',
      bom: true,
      encoding: 'utf-16le',
    });
    const bytes = sink.bytes();
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(sink.text('utf-16le').startsWith('id,big')).toBe(true);
  });
});

describe('JSON export', () => {
  it('writes an array of objects with exact numbers, embedded JSON and base64', async () => {
    const text = await exportText({ format: 'json' });
    expect(text).toBe(
      [
        '[',
        '{"id":1,"big":9007199254740993,"price":12.50,"ratio":0.1,"ok":true,"name":"plain","doc":{"a": [1, 2]},"bin":"3q0=","at":"2024-01-02 03:04:05+00"},',
        '{"id":2,"big":null,"price":-0.001,"ratio":1e-300,"ok":false,"name":"O\'Brien, \\"quoted\\"\\nline","doc":"just a string","bin":"","at":null},',
        '{"id":3,"big":-5,"price":null,"ratio":null,"ok":null,"name":"","doc":null,"bin":null,"at":"2024-12-31 23:59:59.999+00"}',
        ']',
        '',
      ].join('\n'),
    );
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  it('pretty-prints, and writes numbers as strings when asked', async () => {
    const text = await exportText({
      format: 'json',
      json: { pretty: true, numbersAsStrings: true },
    });
    expect(
      text.startsWith(
        '[\n  {\n    "id": 1,\n    "big": "9007199254740993",\n    "price": "12.50",',
      ),
    ).toBe(true);
    expect((JSON.parse(text) as unknown[]).length).toBe(3);
  });

  it('writes JSON Lines and reads them back', async () => {
    const text = await exportText({ format: 'jsonl' });
    expect(text.split('\n')).toHaveLength(4);
    const rows: (readonly unknown[])[] = [];
    for await (const batch of readRows(bytesSource(text), { format: 'jsonl' }))
      rows.push(...batch.rows);
    expect(rows[0]![1]).toBe(9007199254740993n);
    expect(rows[0]![6]).toEqual({ $json: '{"a": [1, 2]}' });
  });

  it('writes [] for an empty result and dedupes column names', async () => {
    const s = new FakeSession();
    s.result = { columns: [col('id', 'integer'), col('id', 'integer')], rows: [[1, 2]] };
    const sink = memorySink();
    await exportRows({ session: s, query: 'SELECT a.id, b.id', sink, format: 'json' });
    expect(sink.text()).toBe('[\n{"id":1,"id_2":2}\n]\n');
    s.result = { columns: [col('id', 'integer')], rows: [] };
    const empty = memorySink();
    await exportRows({ session: s, query: 'SELECT id', sink: empty, format: 'json' });
    expect(empty.text()).toBe('[]\n');
  });
});

describe('SQL export', () => {
  it('renders every CellValue kind as a PostgreSQL literal, in batched INSERTs', async () => {
    const text = await exportText({ format: 'sql', sql: { table: 'copy', rowsPerStatement: 2 } });
    expect(text).toBe(
      [
        'INSERT INTO "copy" ("id", "big", "price", "ratio", "ok", "name", "doc", "bin", "at") VALUES',
        `(1, 9007199254740993, '12.50', 0.1, TRUE, 'plain', '{"a": [1, 2]}', '\\xdead'::bytea, '2024-01-02 03:04:05+00'),`,
        `(2, NULL, '-0.001', 1e-300, FALSE, 'O''Brien, "quoted"\nline', '"just a string"', '\\x'::bytea, NULL);`,
        'INSERT INTO "copy" ("id", "big", "price", "ratio", "ok", "name", "doc", "bin", "at") VALUES',
        `(3, -5, NULL, NULL, NULL, '', NULL, NULL, '2024-12-31 23:59:59.999+00');`,
        '',
      ].join('\n'),
    );
  });

  it('renders MySQL literals with backslash escaping, 1/0 booleans and X hex', async () => {
    const text = await exportText({ format: 'sql' }, 'mysql');
    expect(text).toContain(
      "(1, 9007199254740993, '12.50', 0.1, 1, 'plain', '{\"a\": [1, 2]}', X'dead', '2024-01-02 03:04:05+00'),",
    );
    expect(text).toContain(
      "(2, NULL, '-0.001', 1e-300, 0, 'O''Brien, \"quoted\"\\nline', '\"just a string\"', X'', NULL),",
    );
    expect(text.startsWith('INSERT INTO `query_result` (`id`,')).toBe(true);
  });

  it('renders non-finite floats for PostgreSQL and refuses them for MySQL and MariaDB', async () => {
    const floats = (engine: 'postgres' | 'mysql' | 'mariadb'): FakeSession => {
      const s = new FakeSession(engine);
      s.result = { columns: [col('f', 'float')], rows: [[Number.NaN], [Number.NEGATIVE_INFINITY]] };
      return s;
    };
    const pg = memorySink();
    await exportRows({ session: floats('postgres'), query: 'SELECT f', sink: pg, format: 'sql' });
    expect(pg.text()).toContain("('NaN'::float8),\n('-Infinity'::float8);");
    for (const engine of ['mysql', 'mariadb'] as const) {
      const summary = await exportRows({
        session: floats(engine),
        query: 'SELECT f',
        sink: memorySink(),
        format: 'sql',
      });
      expect(summary.status).toBe('failed');
      expect(summary.errors[0]!.message).toMatch(/cannot store the value NaN/);
    }
  });

  it('can write another dialect than the source', async () => {
    const text = await exportText({ format: 'sql', sql: { dialect: 'mysql', table: 't' } });
    expect(text.startsWith('INSERT INTO `t` (`id`')).toBe(true);
    expect(text).toContain("X'dead'");
  });

  it('keeps statements under the length limit', async () => {
    const s = new FakeSession();
    s.result = {
      columns: [col('v', 'string')],
      rows: Array.from({ length: 100 }, () => ['x'.repeat(500)]),
    };
    const sink = memorySink();
    await exportRows({
      session: s,
      query: 'SELECT v',
      sink,
      format: 'sql',
      sql: { maxStatementLength: 2000 },
    });
    const statements = sink
      .text()
      .split(';\n')
      .filter((t) => t !== '');
    expect(statements.length).toBeGreaterThan(20);
    for (const statement of statements) expect(statement.length).toBeLessThanOrEqual(2100);
  });

  it('refuses option combinations that cannot work', async () => {
    const sink = memorySink();
    await expect(
      exportRows({ session: session(), query: 'SELECT 1', sink, format: 'sql-ddl' }),
    ).rejects.toThrow(/not a query/);
    await expect(exportRows({ session: session(), sink, format: 'csv' })).rejects.toThrow(
      /either a query or a table/,
    );
    await expect(
      exportRows({
        session: session(),
        table: { name: 't' },
        sink,
        format: 'sql-ddl',
        sql: { dialect: 'mysql' },
      }),
    ).rejects.toThrow(/source dialect/);
  });
});

describe('streaming, backpressure and cancellation', () => {
  function bigSession(rows: number): FakeSession {
    const s = new FakeSession();
    s.result = {
      columns: [col('id', 'integer')],
      rows: Array.from({ length: rows }, (_, i) => [i]),
    };
    return s;
  }

  it('fetches a page only after the previous one was written', async () => {
    const s = bigSession(10_000);
    let written = 0;
    let maxAhead = 0;
    const slow: Sink = {
      async write() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        written++;
        maxAhead = Math.max(maxAhead, s.pagesServed - written);
      },
      async close() {},
      async abort() {},
    };
    const summary = await exportRows({
      session: s,
      query: 'SELECT id',
      sink: slow,
      format: 'jsonl',
      pageSize: 100,
    });
    expect(summary.rowsWritten).toBe(10_000);
    expect(maxAhead).toBeLessThanOrEqual(1);
  });

  it('stops, aborts the sink and reports cancellation', async () => {
    const s = bigSession(10_000);
    const controller = new AbortController();
    let aborted = false;
    let writes = 0;
    const sink: Sink = {
      async write() {
        if (++writes === 5) controller.abort();
      },
      async close() {
        throw new Error('should not close');
      },
      async abort() {
        aborted = true;
      },
    };
    const summary = await exportRows({
      session: s,
      query: 'SELECT id',
      sink,
      format: 'csv',
      pageSize: 100,
      signal: controller.signal,
    });
    expect(summary.status).toBe('cancelled');
    expect(aborted).toBe(true);
    expect(s.pagesServed).toBeLessThan(10);
  });

  it('fails on a statement without a result set', async () => {
    const summary = await exportRows({
      session: new FakeSession(),
      query: 'UPDATE t SET a = 1',
      sink: memorySink(),
      format: 'csv',
    });
    expect(summary.status).toBe('failed');
    expect(summary.errors[0]!.message).toMatch(/no result set/);
  });
});

describe('exportTables', () => {
  it('writes one sink per table', async () => {
    const sinks = new Map<string, ReturnType<typeof memorySink>>();
    const summary = await exportTables({
      session: session(),
      tables: [{ name: 'a' }, { name: 'b', schema: 'other' }],
      format: 'csv',
      output: {
        kind: 'per-table',
        sinkFor: (table) => {
          const sink = memorySink();
          sinks.set(table.name, sink);
          return sink;
        },
      },
    });
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: 6 });
    expect(summary.tables.map((t) => [t.table, t.rowsWritten])).toEqual([
      ['a', 3],
      ['b', 3],
    ]);
    expect(sinks.get('b')!.text().startsWith('id,big')).toBe(true);
  });

  it('combines JSON into one object keyed by table, and refuses a combined CSV', async () => {
    const sink = memorySink();
    const summary = await exportTables({
      session: session(),
      tables: [{ name: 'a' }, { name: 'b' }],
      format: 'json',
      output: { kind: 'combined', sink },
    });
    expect(summary.status).toBe('completed');
    const parsed = JSON.parse(sink.text()) as Record<string, unknown[]>;
    expect(Object.keys(parsed)).toEqual(['a', 'b']);
    expect(parsed['b']).toHaveLength(3);
    await expect(
      exportTables({
        session: session(),
        tables: [{ name: 'a' }],
        format: 'csv',
        output: { kind: 'combined', sink: memorySink() },
      }),
    ).rejects.toThrow(/one file per table/);
  });
});
