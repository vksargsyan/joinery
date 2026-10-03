import type { SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { isIntegerType, mapSqlType } from '../src';
import { readExpression, type SourceUserType } from '../src/db/type-map';

/** The type mapping table per engine pair (spec §12). */

function map(from: SqlDialect, to: SqlDialect, type: string, extra: object = {}) {
  return mapSqlType(type, {
    from,
    to,
    targetVersion: to === 'mariadb' ? '11.4.3-MariaDB' : '8.4.2',
    ...extra,
  });
}

describe('PostgreSQL → MySQL and MariaDB', () => {
  it.each([
    ['smallint', 'smallint'],
    ['integer', 'int'],
    ['bigint', 'bigint'],
    ['numeric(10,2)', 'decimal(10,2)'],
    ['numeric', 'decimal(65,30)'],
    ['numeric(80,40)', 'decimal(65,30)'],
    ['real', 'float'],
    ['double precision', 'double'],
    ['boolean', 'tinyint(1)'],
    ['character varying(100)', 'varchar(100)'],
    ['character varying(5000)', 'text'],
    ['character varying(100000)', 'mediumtext'],
    ['character varying', 'longtext'],
    ['character(3)', 'char(3)'],
    ['character(300)', 'varchar(300)'],
    ['text', 'longtext'],
    ['bytea', 'longblob'],
    ['date', 'date'],
    ['timestamp(3) without time zone', 'datetime(3)'],
    ['timestamp without time zone', 'datetime(6)'],
    ['timestamp(0) with time zone', 'datetime'],
    ['time without time zone', 'time(6)'],
    ['interval', 'varchar(100)'],
    ['jsonb', 'json'],
    ['json', 'json'],
    ['inet', 'varchar(43)'],
    ['bit(8)', 'varchar(8)'],
    ['point', 'longtext'],
    ['int4range', 'varchar(255)'],
    ['tsvector', 'longtext'],
  ])('%s → %s', (source, target) => {
    expect(map('postgres', 'mysql', source).dataType).toBe(target);
  });

  it('notes where values may not fit, and says why', () => {
    expect(map('postgres', 'mysql', 'numeric').note).toMatch(/decimal\(65,30\)/);
    expect(map('postgres', 'mysql', 'timestamp with time zone')).toEqual({
      dataType: 'datetime(6)',
      note: expect.stringMatching(/UTC/),
    });
    expect(map('postgres', 'mysql', 'time with time zone').note).toMatch(/offset/);
  });

  it('shortens text and binary in keys, which MySQL indexes only up to a length', () => {
    expect(map('postgres', 'mysql', 'text', { key: true })).toEqual({
      dataType: 'varchar(255)',
      note: expect.stringMatching(/key column/),
    });
    expect(map('postgres', 'mysql', 'character varying(100)', { key: true }).dataType).toBe(
      'varchar(100)',
    );
    expect(map('postgres', 'mysql', 'character varying(2000)', { key: true }).dataType).toBe(
      'varchar(768)',
    );
    expect(map('postgres', 'mysql', 'bytea', { key: true }).dataType).toBe('varbinary(255)');
  });

  it('reads what MySQL has no type for in a form it takes', () => {
    expect(map('postgres', 'mysql', 'integer[]')).toMatchObject({ dataType: 'json', read: 'json' });
    expect(map('postgres', 'mysql', 'text[]')).toMatchObject({ dataType: 'json', read: 'json' });
    expect(map('postgres', 'mysql', 'money')).toMatchObject({
      dataType: 'decimal(19,2)',
      read: 'numeric',
    });
    expect(map('postgres', 'mysql', 'public.geometry(Point,4326)')).toMatchObject({ read: 'wkt' });
    expect(map('postgres', 'mysql', 'hstore')).toMatchObject({
      dataType: 'longtext',
      read: 'text',
    });
  });

  it('uses MariaDB’s uuid and inet6 where the server has them', () => {
    expect(map('postgres', 'mysql', 'uuid').dataType).toBe('char(36)');
    expect(map('postgres', 'mariadb', 'uuid').dataType).toBe('uuid');
    expect(
      mapSqlType('uuid', { from: 'postgres', to: 'mariadb', targetVersion: '10.6.2-MariaDB' })
        .dataType,
    ).toBe('char(36)');
    expect(map('postgres', 'mariadb', 'inet').dataType).toBe('inet6');
  });

  it('turns enums into ENUM and domains into their base type', () => {
    const userTypes = new Map<string, SourceUserType>([
      [
        'public.mood',
        {
          name: 'mood',
          schema: 'public',
          kind: 'enum',
          values: ['sad', "it's ok"],
          definition: '',
        },
      ],
      [
        'public.posint',
        {
          name: 'posint',
          schema: 'public',
          kind: 'domain',
          values: [],
          definition: 'CREATE DOMAIN public.posint AS integer CHECK (VALUE > 0)',
        },
      ],
    ]);
    expect(map('postgres', 'mysql', 'public.mood', { userTypes }).dataType).toBe(
      "enum('sad','it''s ok')",
    );
    expect(map('postgres', 'mysql', 'public.posint', { userTypes }).dataType).toBe('int');
  });
});

describe('MySQL and MariaDB → PostgreSQL', () => {
  it.each([
    ['tinyint(1)', 'boolean'],
    ['tinyint', 'smallint'],
    ['tinyint unsigned', 'smallint'],
    ['smallint unsigned', 'integer'],
    ['mediumint', 'integer'],
    ['int', 'integer'],
    ['int unsigned', 'bigint'],
    ['bigint', 'bigint'],
    ['bigint unsigned', 'numeric(20,0)'],
    ['decimal(20,6)', 'numeric(20,6)'],
    ['decimal(10,0) unsigned', 'numeric(10,0)'],
    ['float', 'real'],
    ['double', 'double precision'],
    ['bit(1)', 'boolean'],
    ['bit(8)', 'bigint'],
    ['year', 'smallint'],
    ['char(10)', 'character(10)'],
    ['varchar(100)', 'character varying(100)'],
    ['longtext', 'text'],
    ['varbinary(64)', 'bytea'],
    ['longblob', 'bytea'],
    ['date', 'date'],
    ['datetime(6)', 'timestamp(6) without time zone'],
    ['datetime', 'timestamp(0) without time zone'],
    ['timestamp(3)', 'timestamp(3) with time zone'],
    ['time', 'time(0) without time zone'],
    ['json', 'jsonb'],
    ["enum('a','bb')", 'character varying(2)'],
    ["set('x','y')", 'text'],
    ['uuid', 'uuid'],
    ['inet6', 'inet'],
    ['geometry', 'text'],
  ])('%s → %s', (source, target) => {
    expect(map('mysql', 'postgres', source).dataType).toBe(target);
  });

  it('says what a tinyint(1) turns into, and reads spatial values as WKT', () => {
    expect(map('mysql', 'postgres', 'tinyint(1)').note).toMatch(/boolean/);
    expect(map('mariadb', 'postgres', 'point')).toMatchObject({ read: 'wkt' });
  });

  it('recognises a MariaDB JSON column (longtext with json_valid)', () => {
    expect(map('mariadb', 'postgres', 'longtext', { json: true }).dataType).toBe('jsonb');
  });
});

describe('within one engine family', () => {
  it('keeps types verbatim within one dialect', () => {
    for (const dialect of ['postgres', 'mysql', 'mariadb'] as const) {
      expect(map(dialect, dialect, 'numeric(10,2)').dataType).toBe('numeric(10,2)');
      expect(map(dialect, dialect, 'some_custom_type')).toEqual({ dataType: 'some_custom_type' });
    }
  });

  it('drops what MySQL lacks, and keeps MariaDB JSON as JSON', () => {
    expect(map('mariadb', 'mysql', 'uuid').dataType).toBe('char(36)');
    expect(map('mariadb', 'mysql', 'inet4').dataType).toBe('varchar(15)');
    expect(map('mariadb', 'mysql', 'inet6').dataType).toBe('varchar(39)');
    expect(map('mariadb', 'mysql', 'longtext', { json: true }).dataType).toBe('json');
    expect(map('mysql', 'mariadb', 'json').dataType).toBe('json');
    expect(map('mysql', 'mariadb', 'int unsigned').dataType).toBe('int unsigned');
  });
});

describe('helpers', () => {
  it('knows which types can number themselves', () => {
    expect(isIntegerType('integer', 'postgres')).toBe(true);
    expect(isIntegerType('numeric(20,0)', 'postgres')).toBe(false);
    expect(isIntegerType('integer[]', 'postgres')).toBe(false);
    expect(isIntegerType('int unsigned', 'mysql')).toBe(true);
    expect(isIntegerType('tinyint(1)', 'mysql')).toBe(false);
  });

  it('writes the read expressions', () => {
    expect(readExpression('json', '"tags"', 'postgres')).toBe('to_json("tags")::text');
    expect(readExpression('numeric', '"m"', 'postgres')).toBe('"m"::numeric');
    expect(readExpression('wkt', '`g`', 'mysql')).toBe('ST_AsText(`g`)');
    expect(readExpression('text', '"h"', 'postgres')).toBe('"h"::text');
  });
});
