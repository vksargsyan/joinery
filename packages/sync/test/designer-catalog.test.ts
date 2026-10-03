import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaSnapshotSchema } from '@querybara/core';
import type { SchemaSnapshot } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { canonicalType, findType, formatType, parseType, typeCatalog } from '../src';

const root = fileURLToPath(new URL('./golden', import.meta.url));

/** Every column `dataType` of the golden fixtures, by engine family. */
function goldenTypes(): { postgres: Set<string>; mysql: Set<string> } {
  const out = { postgres: new Set<string>(), mysql: new Set<string>() };
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const side of ['source.json', 'target.json']) {
      const snapshot: SchemaSnapshot = schemaSnapshotSchema.parse(
        JSON.parse(readFileSync(join(root, dir.name, side), 'utf8')),
      );
      const family = snapshot.engine === 'postgres' ? out.postgres : out.mysql;
      for (const schema of snapshot.schemas) {
        for (const table of schema.tables) for (const c of table.columns) family.add(c.dataType);
      }
    }
  }
  return out;
}

describe('parseType / formatType', () => {
  const types = goldenTypes();

  it('covers the fixtures of both families', () => {
    expect(types.postgres.size).toBeGreaterThan(40);
    expect(types.mysql.size).toBeGreaterThan(50);
  });

  for (const text of [...types.postgres].sort()) {
    it(`round-trips PostgreSQL ${text}`, () => {
      const parsed = parseType(text, 'postgres');
      expect(parsed).toBeDefined();
      expect(formatType(parsed!, 'postgres')).toBe(text);
    });
  }
  for (const text of [...types.mysql].sort()) {
    it(`round-trips MySQL ${text}`, () => {
      const parsed = parseType(text, 'mysql');
      expect(parsed).toBeDefined();
      expect(formatType(parsed!, 'mysql')).toBe(text);
    });
  }

  it.each([
    ['int4', 'integer'],
    ['int', 'integer'],
    ['bool', 'boolean'],
    ['varchar(20)', 'character varying(20)'],
    ['varchar', 'character varying'],
    ['char', 'character(1)'],
    ['bpchar(3)', 'character(3)'],
    ['timestamptz', 'timestamp with time zone'],
    ['timestamptz(3)', 'timestamp(3) with time zone'],
    ['timestamp(0)', 'timestamp(0) without time zone'],
    ['time', 'time without time zone'],
    ['timetz(2)', 'time(2) with time zone'],
    ['float', 'double precision'],
    ['float(10)', 'real'],
    ['decimal(12,4)', 'numeric(12,4)'],
    ['int[]', 'integer[]'],
    ['text[3][]', 'text[][]'],
    ['varbit(4)', 'bit varying(4)'],
    ['interval hour to minute', 'interval hour to minute'],
    ['Public.Mood', 'public.mood'],
  ])('writes PostgreSQL %s as %s (the sync engine agrees)', (alias, spelled) => {
    const text = formatType(parseType(alias, 'postgres')!, 'postgres');
    expect(text).toBe(spelled);
    expect(canonicalType(text, 'postgres')).toBe(canonicalType(alias, 'postgres'));
  });

  it.each([
    ['INTEGER', 'int'],
    ['bool', 'tinyint(1)'],
    ['BOOLEAN', 'tinyint(1)'],
    ['numeric(10,2)', 'decimal(10,2)'],
    ['dec(8)', 'decimal(8,0)'],
    ['character varying(5)', 'varchar(5)'],
    ['national varchar(5)', 'varchar(5)'],
    ['double precision', 'double'],
    ['real', 'double'],
    ['INT UNSIGNED', 'int unsigned'],
    ["ENUM('a', 'B')", "enum('a','B')"],
    ["set('x','y''z')", "set('x','y''z')"],
    ['DATETIME(6)', 'datetime(6)'],
  ])('writes MySQL %s as %s (the sync engine agrees)', (alias, spelled) => {
    const text = formatType(parseType(alias, 'mysql')!, 'mysql');
    expect(text).toBe(spelled);
    expect(canonicalType(text, 'mysql')).toBe(canonicalType(alias, 'mysql'));
  });

  // Spellings the server reports differently from what was written; the designer writes the
  // server's, so the next compare against the live table is clean.
  it.each([
    ['postgres', 'numeric(5)', 'numeric(5,0)'],
    ['mysql', 'int(10) zerofill', 'int(10) unsigned zerofill'],
    ['mysql', 'long varbinary', 'mediumblob'],
    ['mysql', 'geomcollection', 'geometrycollection'],
  ] as const)('writes %s %s as the server reports it: %s', (engine, alias, spelled) => {
    expect(formatType(parseType(alias, engine)!, engine)).toBe(spelled);
  });

  it('splits types into their parameters', () => {
    expect(parseType('numeric(10,2)[]', 'postgres')).toEqual({
      name: 'numeric',
      precision: 10,
      scale: 2,
      arrayDimensions: 1,
    });
    expect(parseType('interval day to second(3)', 'postgres')).toEqual({
      name: 'interval',
      fields: 'day to second',
      fsp: 3,
    });
    expect(parseType('public.geometry(Point,4326)', 'postgres')).toEqual({
      name: 'public.geometry',
      modifier: 'point,4326',
    });
    expect(parseType('bigint(20) unsigned', 'mysql')).toEqual({
      name: 'bigint',
      displayWidth: 20,
      unsigned: true,
    });
    expect(parseType("enum('a\\\\b','it''s')", 'mysql')).toEqual({
      name: 'enum',
      values: ['a\\b', "it's"],
    });
    expect(formatType({ name: 'enum', values: ['a\\b', "it's"] }, 'mysql')).toBe(
      "enum('a\\\\b','it''s')",
    );
  });

  it.each(['', '   ', 'int; drop table t', 'varchar(10) -- x', '123', '(int)', 'int[]'])(
    'rejects %j as a MySQL type',
    (text) => {
      expect(parseType(text, 'mysql')).toBeUndefined();
    },
  );

  it('rejects text that is not a PostgreSQL type', () => {
    expect(parseType('', 'postgres')).toBeUndefined();
    expect(parseType('integer; select 1', 'postgres')).toBeUndefined();
    expect(parseType('9lives', 'postgres')).toBeUndefined();
  });
});

describe('typeCatalog', () => {
  const names = (engine: 'postgres' | 'mysql' | 'mariadb', version?: string): string[] =>
    typeCatalog(engine, version).map((e) => e.name);

  it('lists built-in types by category with their parameters and flags', () => {
    const pg = typeCatalog('postgres', '16.4');
    const varchar = findType(pg, 'varchar')!;
    expect(varchar).toMatchObject({
      name: 'character varying',
      category: 'text',
      collation: true,
      array: true,
      autoIncrement: false,
    });
    expect(varchar.parameters).toEqual([
      { name: 'length', required: false, min: 1, max: 10485760 },
    ]);
    expect(findType(pg, 'bigint')).toMatchObject({ category: 'numeric', autoIncrement: true });
    expect(findType(pg, 'serial')).toMatchObject({ pseudo: true, array: false });
    expect(findType(pg, 'timestamptz')!.parameters).toEqual([
      { name: 'fsp', required: false, min: 0, max: 6, default: 6 },
    ]);
    expect(findType(pg, 'point')!.category).toBe('spatial');
    expect(findType(pg, 'jsonb')!.category).toBe('json');
    expect(findType(pg, 'bytea')!.category).toBe('binary');

    const my = typeCatalog('mysql', '8.4.2');
    expect(findType(my, 'int')).toMatchObject({
      category: 'numeric',
      unsigned: true,
      zerofill: true,
      autoIncrement: true,
      charset: false,
    });
    expect(findType(my, 'varchar')).toMatchObject({ charset: true, collation: true });
    expect(findType(my, 'varchar')!.parameters[0]).toMatchObject({
      name: 'length',
      required: true,
    });
    expect(findType(my, 'decimal')!.parameters.map((x) => x.name)).toEqual(['precision', 'scale']);
    expect(findType(my, 'datetime')!.parameters).toEqual([
      { name: 'fsp', required: false, min: 0, max: 6, default: 0 },
    ]);
    expect(findType(my, 'enum')!.parameters[0]).toMatchObject({ name: 'values', required: true });
    expect(findType(my, 'multipolygon')!.category).toBe('spatial');
    expect(findType(my, 'bool')!.name).toBe('tinyint');
  });

  it('leaves out types the server version does not have', () => {
    expect(names('postgres', '9.3')).not.toContain('jsonb');
    expect(names('postgres', '13')).not.toContain('int4multirange');
    expect(names('postgres', '14')).toContain('int4multirange');
    expect(names('mysql', '5.7.7')).not.toContain('json');
    expect(names('mysql', '8.0.30')).toContain('json');
    expect(names('mysql', '8.4')).not.toContain('vector');
    expect(names('mysql', '9.1')).toContain('vector');
    expect(names('mysql', '8.4')).not.toContain('uuid');
    expect(names('mariadb', '10.6')).not.toContain('uuid');
    expect(names('mariadb', '10.11')).toContain('uuid');
    expect(names('mariadb', '10.11')).toContain('inet6');
  });

  it('marks what the version deprecates', () => {
    expect(findType(typeCatalog('mysql', '8.4'), 'int')!.deprecated).toMatch(/display widths/);
    expect(findType(typeCatalog('mysql', '5.7.40'), 'int')!.deprecated).toBeUndefined();
    expect(findType(typeCatalog('mariadb', '11.4'), 'int')!.deprecated).toBeUndefined();
    expect(findType(typeCatalog('postgres', '16'), 'timetz')!.deprecated).toBeDefined();
    expect(findType(typeCatalog('postgres', '14'), 'numeric')!.parameters[1]!.min).toBe(0);
    expect(findType(typeCatalog('postgres', '15'), 'numeric')!.parameters[1]!.min).toBe(-1000);
  });

  it('adds PostgreSQL enum, domain, composite and extension types from the schema', () => {
    const snapshot = schemaSnapshotSchema.parse({
      engine: 'postgres',
      database: 'db',
      capturedAt: '2026-01-01T00:00:00Z',
      extensions: [{ name: 'citext', schema: 'ext' }],
      schemas: [
        {
          name: 'public',
          types: [
            {
              name: 'mood',
              kind: 'enum',
              values: ['happy', 'sad'],
              definition: "CREATE TYPE public.mood AS ENUM ('happy', 'sad')",
            },
            {
              name: 'pos_int',
              kind: 'domain',
              definition: 'CREATE DOMAIN public.pos_int AS integer CHECK (VALUE > 0)',
            },
          ],
        },
        {
          name: 'MySchema',
          types: [
            {
              name: 'Pair',
              kind: 'composite',
              definition: 'CREATE TYPE "MySchema"."Pair" AS (a int)',
            },
          ],
        },
      ],
    });
    const catalog = typeCatalog('postgres', '16', snapshot);
    expect(findType(catalog, 'public.mood')).toMatchObject({
      category: 'text',
      userType: { kind: 'enum', schema: 'public', values: ['happy', 'sad'] },
    });
    expect(findType(catalog, 'public.pos_int')!.description).toBe('Domain over integer');
    expect(findType(catalog, '"MySchema"."Pair"')!.userType!.kind).toBe('composite');
    expect(findType(catalog, 'ext.citext')).toMatchObject({
      extension: 'citext',
      category: 'text',
    });
    expect(findType(catalog, 'citext')!.name).toBe('ext.citext');
    const parsed = parseType('"MySchema"."Pair"[]', 'postgres')!;
    expect(findType(catalog, parsed)!.name).toBe('"MySchema"."Pair"');
  });
});
