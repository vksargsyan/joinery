import { tableDefSchema, type SqlDialect } from '@joinery/core';
import { renderCreateTable } from '@joinery/sync';
import { describe, expect, it } from 'vitest';

import {
  autoMatch,
  buildStatement,
  converterFor,
  inferColumns,
  jsonText,
  sqlTypeFor,
  supportsRowAlias,
  tableFromColumns,
  targetKind,
  type ConversionOptions,
  type SourceCell,
  type StatementPlan,
} from '../src';

describe('autoMatch', () => {
  it('matches exactly, then ignoring case, spaces, underscores and hyphens', () => {
    const table = ['id', 'first_name', 'LastName', 'e-mail', 'Created At'];
    expect(
      autoMatch(['ID', 'First Name', 'last_name', 'email', 'created_at', 'extra'], table),
    ).toEqual([
      { source: 'ID', target: 'id' },
      { source: 'First Name', target: 'first_name' },
      { source: 'last_name', target: 'LastName' },
      { source: 'email', target: 'e-mail' },
      { source: 'created_at', target: 'Created At' },
    ]);
  });

  it('prefers an exact match and uses each column once', () => {
    expect(autoMatch(['Name', 'name'], ['name', 'NAME'])).toEqual([
      { source: 'Name', target: 'NAME' },
      { source: 'name', target: 'name' },
    ]);
  });
});

describe('targetKind', () => {
  it('maps PostgreSQL and MySQL types to conversion targets', () => {
    const pg: [string, string][] = [
      ['integer', 'integer'],
      ['bigint', 'integer'],
      ['numeric(10,2)', 'decimal'],
      ['double precision', 'float'],
      ['boolean', 'boolean'],
      ['timestamp(3) with time zone', 'timestamp'],
      ['timestamp without time zone', 'datetime'],
      ['jsonb', 'json'],
      ['bytea', 'binary'],
      ['uuid', 'uuid'],
      ['integer[]', 'text'],
      ['character varying(20)', 'text'],
      ['money', 'text'],
    ];
    for (const [type, kind] of pg)
      expect([type, targetKind(type, 'postgres')]).toEqual([type, kind]);
    const my: [string, string][] = [
      ['int unsigned', 'integer'],
      ['tinyint(1)', 'integer'],
      ['decimal(20,6)', 'decimal'],
      ['double', 'float'],
      ['datetime(6)', 'datetime'],
      ['timestamp', 'timestamp'],
      ['json', 'json'],
      ['varbinary(16)', 'binary'],
      ['longblob', 'binary'],
      ['geometry', 'binary'],
      ["enum('a','b')", 'text'],
    ];
    for (const [type, kind] of my) expect([type, targetKind(type, 'mysql')]).toEqual([type, kind]);
  });
});

describe('conversions', () => {
  const convert = (
    dataType: string,
    value: SourceCell,
    dialect: SqlDialect = 'postgres',
    options: ConversionOptions = {},
  ): unknown => converterFor({ name: 'c', dataType }, dialect, options)(value);

  it('converts integers, keeping precision beyond 2^53', () => {
    expect(convert('integer', ' 42 ')).toBe(42);
    expect(convert('bigint', '9007199254740993')).toBe(9007199254740993n);
    expect(convert('bigint', 9007199254740993n)).toBe(9007199254740993n);
    expect(convert('bigint', 12n)).toBe(12);
    expect(convert('integer', '5.00')).toBe(5);
    expect(convert('integer', '1e3')).toBe(1000);
    expect(convert('tinyint(1)', 'true', 'mysql')).toBe(1);
    expect(convert('integer', true)).toBe(1);
    expect(() => convert('integer', '1.5')).toThrow(/not an integer/);
    expect(() => convert('integer', 'abc')).toThrow(/"abc" is not an integer/);
    expect(() => convert('integer', 2.5)).toThrow(/not an integer/);
  });

  it('keeps decimals as exact text and floats as numbers', () => {
    expect(convert('numeric(30,10)', '12345678901234567890.0123456789')).toBe(
      '12345678901234567890.0123456789',
    );
    expect(convert('numeric', jsonText('1.50'))).toBe('1.50');
    expect(convert('numeric', 0.1)).toBe('0.1');
    expect(convert('numeric', 'NaN')).toBe('NaN');
    expect(() => convert('numeric', '1,5')).toThrow(/not a number/);
    expect(convert('double precision', '1e-300')).toBe(1e-300);
    expect(convert('real', '-Infinity')).toBe(Number.NEGATIVE_INFINITY);
  });

  it('reads booleans in the usual spellings', () => {
    for (const word of ['true', 'T', 'yes', 'on', '1']) expect(convert('boolean', word)).toBe(true);
    for (const word of ['false', 'f', 'NO', 'off', '0'])
      expect(convert('boolean', word)).toBe(false);
    expect(convert('boolean', 0)).toBe(false);
    expect(() => convert('boolean', 'maybe')).toThrow(/not a boolean/);
  });

  it('turns empty text into NULL except for text columns', () => {
    expect(convert('integer', '')).toBeNull();
    expect(convert('date', '  ')).toBeNull();
    expect(convert('text', '')).toBe('');
    expect(convert('integer', null)).toBeNull();
    expect(() => convert('integer', '', 'postgres', { emptyAsNull: false })).toThrow();
  });

  it('rewrites dates in day/month order and MySQL datetimes', () => {
    expect(convert('date', '03/04/2024')).toBe('2024-04-03');
    expect(convert('date', '03/04/2024', 'postgres', { dateOrder: 'mdy' })).toBe('2024-03-04');
    expect(convert('date', '2024-04-03')).toBe('2024-04-03');
    expect(convert('timestamp with time zone', '2024-01-02T03:04:05Z')).toBe(
      '2024-01-02T03:04:05Z',
    );
    expect(convert('datetime(6)', '2024-01-02T03:04:05.123456', 'mysql')).toBe(
      '2024-01-02 03:04:05.123456',
    );
    expect(convert('datetime', '2024-01-02T03:04:05Z', 'mysql', { serverVersion: '8.4.2' })).toBe(
      '2024-01-02 03:04:05+00:00',
    );
    expect(
      convert('datetime', '2024-01-02 03:04:05+0530', 'mysql', { serverVersion: '8.0.36' }),
    ).toBe('2024-01-02 03:04:05+05:30');
    // MariaDB has no offsets: the instant is written as UTC.
    expect(
      convert('datetime(3)', '2024-01-01T01:30:00.250+02:00', 'mariadb', {
        serverVersion: '11.4.3-MariaDB',
      }),
    ).toBe('2023-12-31 23:30:00.250');
  });

  it('writes JSON: text sources as they are, JSON sources re-encoded', () => {
    expect(convert('jsonb', '{"a":1}')).toBe('{"a":1}');
    expect(convert('jsonb', jsonText('{"a": [1]}'), 'postgres', { jsonSource: true })).toBe(
      '{"a": [1]}',
    );
    expect(convert('jsonb', 'hello', 'postgres', { jsonSource: true })).toBe('"hello"');
    expect(convert('json', 12, 'mysql', { jsonSource: true })).toBe('12');
    expect(convert('json', true, 'mysql', { jsonSource: true })).toBe('true');
  });

  it('decodes binary from hex or base64', () => {
    const bytes = (value: unknown): number[] => [...(value as Uint8Array)];
    expect(bytes(convert('bytea', '\\xdeadbeef'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytes(convert('bytea', '0x0102'))).toEqual([1, 2]);
    expect(bytes(convert('bytea', 'AQID'))).toEqual([1, 2, 3]);
    // JSON sources write base64, which may start with "0x".
    expect(bytes(convert('bytea', '0x01', 'postgres', { jsonSource: true }))).toEqual([
      211, 29, 53,
    ]);
    expect(bytes(convert('bytea', '0x01'))).toEqual([1]);
    expect(bytes(convert('bytea', 'hi!', 'postgres'))).toEqual([104, 105, 33]);
    expect(bytes(convert('bytea', 'AQID', 'postgres', { binaryFormat: 'utf8' }))).toEqual([
      65, 81, 73, 68,
    ]);
    expect(() => convert('bytea', 'zz', 'postgres', { binaryFormat: 'hex' })).toThrow(/not hex/);
  });

  it('writes anything as text for text columns', () => {
    expect(convert('text', 12)).toBe('12');
    expect(convert('text', 9007199254740993n)).toBe('9007199254740993');
    expect(convert('text', false)).toBe('false');
    expect(convert('text', jsonText('[1]'))).toBe('[1]');
    expect(convert('text', '  padded  ')).toBe('  padded  ');
  });
});

describe('create a table from the file', () => {
  const columns = inferColumns(
    ['id', 'amount', 'paid', 'when', 'at', 'ref', 'doc', 'note', 'Note', ''],
    [
      [
        '1',
        '10.50',
        'true',
        '2024-01-01',
        '2024-01-01 10:00:00.5+00',
        '0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b',
        '{"a":1}',
        'x',
        'y',
        '1e5',
      ],
      [
        '2',
        '3',
        'false',
        '2024-01-02',
        '2024-01-02 10:00:00+01',
        '1b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b',
        '[1]',
        'y'.repeat(300),
        'z',
        '2',
      ],
    ],
  );

  it('picks a type per dialect', () => {
    expect(columns.map((c) => sqlTypeFor(c, 'postgres'))).toEqual([
      'integer',
      'numeric(4,2)',
      'boolean',
      'date',
      'timestamp with time zone',
      'uuid',
      'jsonb',
      'text',
      'text',
      'double precision',
    ]);
    expect(columns.map((c) => sqlTypeFor(c, 'mysql'))).toEqual([
      'int',
      'decimal(4,2)',
      'tinyint(1)',
      'date',
      'datetime(1)',
      'char(36)',
      'json',
      'text',
      'varchar(255)',
      'double',
    ]);
  });

  it('builds a table definition and mapping that sync renders', () => {
    const { table, mapping } = tableFromColumns(columns, {
      name: 'imported',
      dialect: 'postgres',
      primaryKey: ['id'],
    });
    expect(table.columns.map((c) => c.name)).toEqual([
      'id',
      'amount',
      'paid',
      'when',
      'at',
      'ref',
      'doc',
      'note',
      'Note_2',
      'column10',
    ]);
    expect(mapping[8]).toEqual({ source: 'Note', target: 'Note_2' });
    expect(table.columns[0]!.nullable).toBe(false);
    expect(table.columns[1]!.nullable).toBe(true);
    expect(renderCreateTable(table, 'postgres', { schema: 'public' })).toBe(
      [
        'CREATE TABLE "public"."imported" (',
        '  "id" integer NOT NULL,',
        '  "amount" numeric(4,2),',
        '  "paid" boolean,',
        '  "when" date,',
        '  "at" timestamp with time zone,',
        '  "ref" uuid,',
        '  "doc" jsonb,',
        '  "note" text,',
        '  "Note_2" text,',
        '  "column10" double precision,',
        '  CONSTRAINT "imported_pkey" PRIMARY KEY ("id")',
        ')',
      ].join('\n'),
    );
    const mysql = tableFromColumns(columns, {
      name: 'imported',
      dialect: 'mysql',
      types: { note: 'mediumtext' },
    });
    expect(renderCreateTable(mysql.table, 'mysql')).toContain('`note` mediumtext,');
  });

  it('cuts long names to the engine limit and keeps them unique', () => {
    const long = 'x'.repeat(70);
    const { table } = tableFromColumns(inferColumns([long, `${long}y`], [['1', '2']]), {
      name: 't',
      dialect: 'postgres',
    });
    expect(table.columns.map((c) => c.name.length)).toEqual([63, 63]);
    expect(table.columns[1]!.name.endsWith('_2')).toBe(true);
  });
});

describe('import statements', () => {
  const table = tableDefSchema.parse({
    name: 'items',
    columns: [
      { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
      { name: 'name', ordinal: 2, dataType: 'character varying(20)', nullable: true },
      {
        name: 'n',
        ordinal: 3,
        dataType: 'bigint',
        nullable: true,
        identity: { generation: 'always' },
      },
    ],
  });
  const plan = (
    dialect: SqlDialect,
    mode: StatementPlan['mode'],
    extra: Partial<StatementPlan> = {},
  ): StatementPlan => ({
    dialect,
    table,
    mode,
    columns: ['id', 'name'],
    keys: ['id'],
    ...extra,
  });

  it('builds multi-row INSERTs with the right placeholders', () => {
    expect(buildStatement(plan('postgres', 'append', { schema: 's' }), 2)).toBe(
      'INSERT INTO "s"."items" ("id", "name") VALUES ($1, $2), ($3, $4)',
    );
    expect(buildStatement(plan('mysql', 'append'), 2)).toBe(
      'INSERT INTO `items` (`id`, `name`) VALUES (?, ?), (?, ?)',
    );
    expect(buildStatement(plan('postgres', 'append', { columns: ['id', 'n'] }), 1)).toBe(
      'INSERT INTO "items" ("id", "n") OVERRIDING SYSTEM VALUE VALUES ($1, $2)',
    );
  });

  it('builds upserts per dialect and version', () => {
    expect(buildStatement(plan('postgres', 'upsert'), 1)).toBe(
      'INSERT INTO "items" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"',
    );
    expect(buildStatement(plan('postgres', 'upsert', { columns: ['id'] }), 1)).toBe(
      'INSERT INTO "items" ("id") VALUES ($1) ON CONFLICT ("id") DO NOTHING',
    );
    expect(buildStatement(plan('mysql', 'upsert', { rowAlias: true }), 1)).toBe(
      'INSERT INTO `items` (`id`, `name`) VALUES (?, ?) AS joinery_new ON DUPLICATE KEY UPDATE `name` = joinery_new.`name`',
    );
    expect(buildStatement(plan('mariadb', 'upsert'), 1)).toBe(
      'INSERT INTO `items` (`id`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)',
    );
    expect(supportsRowAlias('mysql', '8.0.19')).toBe(true);
    expect(supportsRowAlias('mysql', '8.0.18')).toBe(false);
    expect(supportsRowAlias('mysql', '10.11.6-MariaDB')).toBe(false);
    expect(supportsRowAlias('mariadb', '11.4.3-MariaDB')).toBe(false);
  });

  it('builds updates and deletes by key', () => {
    expect(buildStatement(plan('postgres', 'update'), 2)).toBe(
      'UPDATE "items" AS t SET "name" = v."name" FROM (VALUES (CAST($1 AS integer), CAST($2 AS character varying(20))), ($3, $4)) AS v ("id", "name") WHERE t."id" = v."id"',
    );
    expect(buildStatement(plan('mysql', 'update'), 2)).toBe(
      'UPDATE `items` AS t JOIN (SELECT ? AS `id`, ? AS `name` UNION ALL SELECT ?, ?) AS v ON t.`id` = v.`id` SET t.`name` = v.`name`',
    );
    expect(buildStatement(plan('postgres', 'delete', { columns: ['id'] }), 3)).toBe(
      'DELETE FROM "items" WHERE "id" IN ($1, $2, $3)',
    );
    expect(
      buildStatement(plan('mysql', 'delete', { columns: ['id', 'name'], keys: ['id', 'name'] }), 2),
    ).toBe('DELETE FROM `items` WHERE (`id`, `name`) IN ((?, ?), (?, ?))');
  });
});
