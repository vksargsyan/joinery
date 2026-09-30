import { describe, expect, it } from 'vitest';

import {
  commandOf,
  normaliseColumnDefault,
  normaliseCurrentTimestamp,
  onUpdateOf,
  removeDatabaseQualifier,
  stripDefiner,
  syntaxErrorPosition,
  tokenize,
  unquoteLiteral,
} from '../src/dialect';
import { partitionBound } from '../src/introspect';

describe('tokenize', () => {
  it('never loses a character', () => {
    const sql = "SELECT `a``b`, 'it''s \\' x', \"q\" -- c\n# h\n/* b */ x.y FROM t";
    expect(
      tokenize(sql)
        .map((t) => t.text)
        .join(''),
    ).toBe(sql);
    expect(tokenize('`a``b`')[0]).toMatchObject({ kind: 'ident', name: 'a`b' });
  });
});

describe('removeDatabaseQualifier', () => {
  it('drops the own-database qualifier from identifiers only', () => {
    expect(
      removeDatabaseQualifier(
        "select `shop`.`t`.`id` AS `id` from `shop`.`t` where `x` = 'shop.t'",
        'shop',
      ),
    ).toBe("select `t`.`id` AS `id` from `t` where `x` = 'shop.t'");
    expect(removeDatabaseQualifier('UPDATE shop.orders SET a = 1 -- shop.orders', 'shop')).toBe(
      'UPDATE orders SET a = 1 -- shop.orders',
    );
  });

  it('keeps other databases and column references named like the database', () => {
    expect(removeDatabaseQualifier('select `other`.`t`.`id` from `other`.`t`', 'shop')).toBe(
      'select `other`.`t`.`id` from `other`.`t`',
    );
    expect(removeDatabaseQualifier('select t.shop from t', 'shop')).toBe('select t.shop from t');
    expect(removeDatabaseQualifier('select 1 from `my db`.`t`', 'my db')).toBe('select 1 from `t`');
  });
});

describe('stripDefiner', () => {
  it.each([
    [
      'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() BEGIN END',
      'CREATE PROCEDURE `p`() BEGIN END',
    ],
    [
      "CREATE DEFINER='app'@'%' TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1",
      'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1',
    ],
    [
      'CREATE DEFINER=root@localhost EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1',
      'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1',
    ],
    [
      'CREATE DEFINER=CURRENT_USER FUNCTION f() RETURNS int RETURN 1',
      'CREATE FUNCTION f() RETURNS int RETURN 1',
    ],
    [
      'CREATE ALGORITHM=UNDEFINED DEFINER=`a``b`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1',
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1',
    ],
    [
      'CREATE OR REPLACE DEFINER=`u`@`h` PROCEDURE p() SELECT 1',
      'CREATE OR REPLACE PROCEDURE p() SELECT 1',
    ],
  ])('%s', (input, expected) => {
    expect(stripDefiner(input)).toBe(expected);
  });

  it('leaves statements without a definer alone', () => {
    expect(stripDefiner('CREATE PROCEDURE p() SELECT "DEFINER=x"')).toBe(
      'CREATE PROCEDURE p() SELECT "DEFINER=x"',
    );
  });
});

describe('commandOf', () => {
  it('names the command, with the object for DDL', () => {
    expect(commandOf('  /* hi */ insert into t values (1)')).toBe('INSERT');
    expect(commandOf('CREATE TABLE t (a int)')).toBe('CREATE TABLE');
    expect(commandOf('create or replace algorithm=merge definer=`a`@`b` view v as select 1')).toBe(
      'CREATE VIEW',
    );
    expect(commandOf('CREATE UNIQUE INDEX i ON t (a)')).toBe('CREATE INDEX');
    expect(commandOf('DROP TABLE IF EXISTS t')).toBe('DROP TABLE');
    expect(commandOf('-- nothing\n')).toBeNull();
    // Long statements are read from their first words only, even behind a long comment.
    const values = Array.from({ length: 2000 }, (_, i) => `(${i})`).join(', ');
    expect(commandOf(`INSERT INTO t VALUES ${values}`)).toBe('INSERT');
    expect(commandOf(`/* ${'x'.repeat(2000)} */ CREATE TABLE t (a int)`)).toBe('CREATE TABLE');
    expect(commandOf(`CREATE ${'  '.repeat(600)}TEMPORARY TABLE t (a int)`)).toBe('CREATE TABLE');
    expect(commandOf(`-- ${'x'.repeat(2000)}`)).toBeNull();
  });
});

describe('syntaxErrorPosition', () => {
  const message = (near: string, line: number) =>
    `You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '${near}' at line ${line}`;

  it('finds the near text on the reported line', () => {
    expect(syntaxErrorPosition(message('FORM t', 1), 'SELECT * FORM t')).toBe(9);
    expect(syntaxErrorPosition(message('FORM t', 2), 'SELECT FORM t,\n* FORM t')).toBe(17);
  });

  it('points at the end for errors at the end of the statement', () => {
    expect(syntaxErrorPosition(message('', 1), 'SELECT * FROM  ')).toBe(13);
  });

  it('gives up on messages without a location', () => {
    expect(syntaxErrorPosition("Table 'x' doesn't exist", 'SELECT 1')).toBeUndefined();
  });
});

describe('normaliseColumnDefault', () => {
  describe('MySQL 8 (unquoted literals, DEFAULT_GENERATED expressions)', () => {
    const mysql = (value: string | null, extra: string, type: string) =>
      normaliseColumnDefault(value, extra, type, false);
    it.each([
      [null, '', 'varchar(10)', null],
      ['abc', '', 'varchar(10)', "'abc'"],
      ["it's", '', 'varchar(10)', "'it''s'"],
      ['back\\slash', '', 'varchar(10)', "'back\\\\slash'"],
      ['', '', 'varchar(10)', "''"],
      ['NULL', '', 'varchar(10)', "'NULL'"],
      ['0', '', 'int', '0'],
      ['-1.50', '', 'decimal(5,2)', '-1.50'],
      ["b'101'", '', 'bit(3)', "b'101'"],
      ['1', '', 'tinyint(1)', '1'],
      ['person', '', "enum('person','company')", "'person'"],
      ['2024-01-01 00:00:00', '', 'datetime', "'2024-01-01 00:00:00'"],
      ['0x6162', '', 'binary(2)', '0x6162'],
      ['CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', 'timestamp', 'CURRENT_TIMESTAMP'],
      [
        'CURRENT_TIMESTAMP(3)',
        'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)',
        'datetime(3)',
        'CURRENT_TIMESTAMP(3)',
      ],
      ['CURRENT_TIMESTAMP', '', 'timestamp', 'CURRENT_TIMESTAMP'],
      ['uuid()', 'DEFAULT_GENERATED', 'char(36)', '(uuid())'],
      ["_utf8mb4\\'[]\\'", 'DEFAULT_GENERATED', 'json', "(_utf8mb4'[]')"],
      ['(`a` + 1)', 'DEFAULT_GENERATED', 'int', '(`a` + 1)'],
      ['(`a`) + (`b`)', 'DEFAULT_GENERATED', 'int', '((`a`) + (`b`))'],
    ])('%j (%s, %s) → %j', (value, extra, type, expected) => {
      expect(mysql(value, extra, type)).toBe(expected);
    });
  });

  describe('MariaDB (SQL text)', () => {
    const mariadb = (value: string | null, type = 'varchar(10)') =>
      normaliseColumnDefault(value, '', type, true);
    it.each([
      [null, null],
      ['NULL', null],
      ["'abc'", "'abc'"],
      ["'it''s'", "'it''s'"],
      ["'back\\\\slash'", "'back\\\\slash'"],
      ["''", "''"],
      ["'NULL'", "'NULL'"],
      ['5', '5'],
      ['-1500', '-1500'],
      ['1.50', '1.50'],
      ["b'1'", "b'1'"],
      ['current_timestamp()', 'CURRENT_TIMESTAMP'],
      ['current_timestamp(3)', 'CURRENT_TIMESTAMP(3)'],
      ['curdate()', '(curdate())'],
      ["concat('a','b')", "(concat('a','b'))"],
    ])('%j → %j', (value, expected) => {
      expect(mariadb(value)).toBe(expected);
    });
  });

  it('normalises both flavours to the same text for the same column', () => {
    expect(normaliseColumnDefault("it's", '', 'varchar(9)', false)).toBe(
      normaliseColumnDefault("'it''s'", '', 'varchar(9)', true),
    );
    expect(
      normaliseColumnDefault('CURRENT_TIMESTAMP(6)', 'DEFAULT_GENERATED', 'datetime(6)', false),
    ).toBe(normaliseColumnDefault('current_timestamp(6)', '', 'datetime(6)', true));
  });
});

describe('small helpers', () => {
  it('normalises CURRENT_TIMESTAMP spellings', () => {
    expect(normaliseCurrentTimestamp('now()')).toBe('CURRENT_TIMESTAMP');
    expect(normaliseCurrentTimestamp('current_timestamp(0)')).toBe('CURRENT_TIMESTAMP');
    expect(normaliseCurrentTimestamp('LOCALTIMESTAMP(2)')).toBe('CURRENT_TIMESTAMP(2)');
    expect(normaliseCurrentTimestamp('curdate()')).toBeUndefined();
  });

  it('reads ON UPDATE from EXTRA', () => {
    expect(onUpdateOf('on update CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
    expect(onUpdateOf('DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)')).toBe(
      'CURRENT_TIMESTAMP(3)',
    );
    expect(onUpdateOf('on update current_timestamp(6)')).toBe('CURRENT_TIMESTAMP(6)');
    expect(onUpdateOf('auto_increment')).toBeUndefined();
  });

  it('unquotes literals with either escape style', () => {
    expect(unquoteLiteral("'it''s'")).toBe("it's");
    expect(unquoteLiteral("'it\\'s'")).toBe("it's");
    expect(unquoteLiteral("'a\\nb\\\\'")).toBe('a\nb\\');
  });

  it('builds partition bounds', () => {
    expect(partitionBound('RANGE', '2024')).toBe('VALUES LESS THAN (2024)');
    expect(partitionBound('RANGE COLUMNS', 'MAXVALUE')).toBe('VALUES LESS THAN MAXVALUE');
    expect(partitionBound('LIST', "'eu','us'")).toBe("VALUES IN ('eu','us')");
    expect(partitionBound('HASH', undefined)).toBeUndefined();
  });
});
