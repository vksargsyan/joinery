import { schemaSnapshotSchema } from '@joinery/core';
import type { TableDef } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  canonicalColumn,
  canonicalDefault,
  canonicalMysqlType,
  canonicalPgType,
  isGeneratedName,
  normalizeSnapshot,
  resolveCompareOptions,
  typeChangeRisk,
} from '../src';
import { contextFor } from '../src/normalize';

describe('PostgreSQL type aliases', () => {
  it.each([
    ['int4', 'integer'],
    ['INT', 'integer'],
    ['bool', 'boolean'],
    ['varchar(255)', 'character varying(255)'],
    ['varchar', 'character varying'],
    ['char', 'character(1)'],
    ['bpchar(3)', 'character(3)'],
    ['float8', 'double precision'],
    ['float(10)', 'real'],
    ['float(40)', 'double precision'],
    ['decimal(10, 2)', 'numeric(10,2)'],
    ['timestamptz', 'timestamp with time zone'],
    ['timestamp(3)', 'timestamp(3) without time zone'],
    ['timestamp(3) with time zone', 'timestamp(3) with time zone'],
    ['int4[]', 'integer[]'],
    ['integer[3][3]', 'integer[][]'],
    ['public."Mood"', 'public."Mood"'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalPgType(input)).toBe(expected);
  });
});

describe('MySQL type aliases', () => {
  it.each([
    ['int(11)', 'int'],
    ['bigint(20) unsigned', 'bigint unsigned'],
    ['INTEGER', 'int'],
    ['tinyint(1)', 'tinyint(1)'],
    ['tinyint(4)', 'tinyint'],
    ['int(5) unsigned zerofill', 'int(5) unsigned zerofill'],
    ['boolean', 'tinyint(1)'],
    ['numeric(8, 2)', 'decimal(8,2)'],
    ['decimal', 'decimal(10,0)'],
    ['dec(6)', 'decimal(6,0)'],
    ['double precision', 'double'],
    ['float(30)', 'double'],
    ['character varying(20)', 'varchar(20)'],
    ['char', 'char(1)'],
    ['year(4)', 'year'],
    ['datetime(0)', 'datetime'],
    ["ENUM('A', 'b c')", "enum('A','b c')"],
  ])('%s → %s', (input, expected) => {
    expect(canonicalMysqlType(input)).toBe(expected);
  });
});

describe('type change risk', () => {
  it('flags narrowing and allows widening', () => {
    expect(typeChangeRisk('integer', 'bigint', 'postgres')).toBeNull();
    expect(typeChangeRisk('character varying(50)', 'text', 'postgres')).toBeNull();
    expect(typeChangeRisk('text', 'mediumtext', 'mysql')).toBeNull();
    expect(typeChangeRisk('numeric(10,2)', 'numeric(12,2)', 'postgres')).toBeNull();
    expect(typeChangeRisk('bigint', 'integer', 'postgres')?.lossy).toBe(true);
    expect(typeChangeRisk('varchar(32)', 'varchar(24)', 'mysql')?.lossy).toBe(true);
    expect(typeChangeRisk('numeric(10,2)', 'numeric(10,1)', 'postgres')?.message).toMatch(
      /decimal places/,
    );
    expect(typeChangeRisk('int', 'int unsigned', 'mysql')?.message).toMatch(/negative/);
    expect(typeChangeRisk("enum('a','b')", "enum('a')", 'mysql')?.message).toMatch(/'b'/);
    expect(typeChangeRisk("enum('a')", "enum('a','b')", 'mysql')).toBeNull();
    expect(typeChangeRisk('text', 'integer', 'postgres')?.lossy).toBe(true);
    const zone = typeChangeRisk(
      'timestamp without time zone',
      'timestamp with time zone',
      'postgres',
    );
    expect(zone?.lossy).toBe(false);
  });
});

const pgSnapshot = schemaSnapshotSchema.parse({
  engine: 'postgres',
  database: 'db',
  capturedAt: '2026-01-01T00:00:00Z',
  schemas: [{ name: 'public' }],
});
const mysqlSnapshot = schemaSnapshotSchema.parse({
  engine: 'mysql',
  database: 'shop',
  capturedAt: '2026-01-01T00:00:00Z',
  schemas: [{ name: 'shop' }],
});

describe('default equivalences', () => {
  const pg = contextFor(pgSnapshot, resolveCompareOptions());
  const my = contextFor(mysqlSnapshot, resolveCompareOptions());

  it('drops redundant literal casts and spells the transaction time one way (PostgreSQL)', () => {
    expect(canonicalDefault("'abc'::text", 'text', pg)).toBe(
      canonicalDefault("'abc'::character varying", 'text', pg),
    );
    expect(canonicalDefault("'abc'::character varying", 'character varying(10)', pg)).toBe("'abc'");
    expect(canonicalDefault("'2020-01-01'::date", 'date', pg)).toBe("'2020-01-01'");
    expect(canonicalDefault("'ok'::public.mood", 'public.mood', pg)).toBe("'ok'");
    expect(canonicalDefault('(0)::numeric', 'numeric', pg)).toBe('0');
    expect(canonicalDefault('now()', 'timestamp with time zone', pg)).toBe(
      canonicalDefault('CURRENT_TIMESTAMP', 'timestamp with time zone', pg),
    );
    expect(canonicalDefault("nextval('public.s'::regclass)", 'integer', pg, 'public')).toBe(
      canonicalDefault("nextval('s'::regclass)", 'integer', pg, 'public'),
    );
    expect(canonicalDefault('NULL::character varying', 'text', pg)).toBeNull();
  });

  it('treats MySQL and MariaDB spellings alike', () => {
    for (const spelling of [
      'CURRENT_TIMESTAMP',
      'current_timestamp()',
      'now()',
      'LOCALTIMESTAMP',
    ]) {
      expect(canonicalDefault(spelling, 'timestamp', my)).toBe('current_timestamp');
    }
    expect(canonicalDefault('current_timestamp(3)', 'datetime(3)', my)).toBe(
      canonicalDefault('NOW(3)', 'datetime(3)', my),
    );
    expect(canonicalDefault("'0'", 'int', my)).toBe('0');
    expect(canonicalDefault("'0'", 'varchar(5)', my)).toBe("'0'");
    expect(canonicalDefault('NULL', 'int', my)).toBeNull();
    expect(canonicalDefault('(uuid())', 'char(36)', my)).toBe(
      canonicalDefault('uuid()', 'char(36)', my),
    );
  });
});

describe('charset and collation inheritance (MySQL)', () => {
  const my = contextFor(mysqlSnapshot, resolveCompareOptions());
  const table = (charset: string, collation: string): TableDef =>
    ({
      name: 't',
      kind: 'table',
      columns: [],
      uniques: [],
      indexes: [],
      foreignKeys: [],
      checks: [],
      triggers: [],
      options: { charset, collation },
    }) as TableDef;
  const column = {
    name: 'c',
    ordinal: 1,
    dataType: 'varchar(10)',
    nullable: true,
    default: null,
    autoIncrement: false,
  };

  it('compares effective values, so explicit-but-inherited equals implicit', () => {
    const t = table('utf8mb4', 'utf8mb4_0900_ai_ci');
    const implicit = canonicalColumn(column, t, my);
    const explicit = canonicalColumn(
      { ...column, charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
      t,
      my,
    );
    expect(explicit).toEqual(implicit);
    expect(canonicalColumn(column, table('latin1', 'latin1_swedish_ci'), my).charset).toBe(
      'latin1',
    );
    expect(canonicalColumn({ ...column, charset: 'utf8' }, t, my).charset).toBe('utf8mb3');
  });

  it('ignores collations but not charsets on request', () => {
    const ignoring = contextFor(mysqlSnapshot, resolveCompareOptions({ ignoreCollation: true }));
    const t = table('utf8mb4', 'utf8mb4_0900_ai_ci');
    expect(canonicalColumn({ ...column, collation: 'utf8mb4_bin' }, t, ignoring)).toEqual(
      canonicalColumn(column, t, ignoring),
    );
    expect(canonicalColumn({ ...column, charset: 'latin1' }, t, ignoring)).not.toEqual(
      canonicalColumn(column, t, ignoring),
    );
  });
});

describe('MariaDB JSON alias across families', () => {
  const mariadb = schemaSnapshotSchema.parse({
    engine: 'mariadb',
    database: 'x',
    capturedAt: '2026-01-01T00:00:00Z',
    schemas: [
      {
        name: 'x',
        tables: [
          {
            name: 't',
            columns: [
              {
                name: 'doc',
                ordinal: 1,
                dataType: 'longtext',
                nullable: true,
                collation: 'utf8mb4_bin',
              },
            ],
            checks: [{ name: 'doc', expression: 'json_valid(`doc`)' }],
            options: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' },
          },
        ],
      },
    ],
  });

  it('reads LONGTEXT + json_valid as json only when comparing with MySQL', () => {
    const cross = normalizeSnapshot(mariadb, {}, true).schemas[0]!.tables[0]!;
    expect(cross.columns[0]!.dataType).toBe('json');
    expect(cross.checks).toEqual([]);
    const same = normalizeSnapshot(mariadb, {}, false).schemas[0]!.tables[0]!;
    expect(same.columns[0]!.dataType).toBe('longtext');
    expect(same.checks).toHaveLength(1);
  });
});

describe('generated names', () => {
  const table = {
    name: 'orders',
    foreignKeys: [{ name: 'fk_customer', columns: ['customer_id'] }],
  } as unknown as TableDef;
  it.each([
    ['primary-key', 'orders_pkey', [], 'postgres', true],
    ['unique', 'orders_code_key', ['code'], 'postgres', true],
    ['unique', 'orders_code_key1', ['code'], 'postgres', true],
    ['unique', 'uq_code', ['code'], 'postgres', false],
    ['foreign-key', 'orders_customer_id_fkey', ['customer_id'], 'postgres', true],
    ['check', 'orders_total_check', [], 'postgres', true],
    ['check', 'orders_check', [], 'postgres', true],
    ['index', 'orders_placed_at_idx', ['placed_at'], 'postgres', true],
    ['foreign-key', 'orders_ibfk_3', ['customer_id'], 'mysql', true],
    ['check', 'orders_chk_1', [], 'mariadb', true],
    ['index', 'customer_id_2', ['customer_id'], 'mysql', true],
    ['index', 'fk_customer', ['customer_id'], 'mysql', true],
    ['index', 'idx_customer', ['customer_id'], 'mysql', false],
  ] as const)('%s %s', (kind, name, columns, dialect, expected) => {
    expect(isGeneratedName(kind, name, table, dialect, columns)).toBe(expected);
  });
});
