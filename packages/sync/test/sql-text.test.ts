import { describe, expect, it } from 'vitest';

import { normalizeSql, referencedNames, tokenizeSql } from '../src';
import { isFullyParenthesized, stripOuterParens, trimStatement, wrapParens } from '../src/sql-text';

describe('tokenizeSql', () => {
  it('keeps strings, quoted identifiers, comments and dollar bodies whole', () => {
    const tokens = tokenizeSql(
      `SELECT 'a;b''c', "x""y" -- c;\n, $f$ body; $f$ /* a /* nested */ b */ FROM t`,
      'postgres',
    )
      .filter((t) => t.kind !== 'ws')
      .map((t) => [t.kind, t.value ?? t.text]);
    expect(tokens).toEqual([
      ['word', 'SELECT'],
      ['string', "'a;b''c'"],
      ['punct', ','],
      ['quoted-ident', 'x"y'],
      ['comment', '-- c;'],
      ['punct', ','],
      ['dollar-string', ' body; '],
      ['comment', '/* a /* nested */ b */'],
      ['word', 'FROM'],
      ['word', 't'],
    ]);
  });

  it('knows MySQL backslash escapes, backticks, # comments and double-quoted strings', () => {
    const kinds = tokenizeSql("SELECT `a``b`, 'it\\'s', \"dq\" # note\n", 'mysql')
      .filter((t) => t.kind !== 'ws')
      .map((t) => t.kind);
    expect(kinds).toEqual([
      'word',
      'quoted-ident',
      'punct',
      'string',
      'punct',
      'string',
      'comment',
    ]);
  });
});

describe('normalizeSql', () => {
  it('collapses whitespace and folds keywords, not literals', () => {
    expect(normalizeSql("SELECT  id,\n\tName FROM   T WHERE x = 'A  B';", 'mysql')).toBe(
      "select id , Name from T where x = 'A  B'",
    );
    expect(normalizeSql('select id , Name from T', 'mysql')).toBe(
      normalizeSql('SELECT id,Name FROM T', 'mysql'),
    );
  });

  it('folds unquoted identifiers for PostgreSQL only, as the servers do', () => {
    expect(normalizeSql('SELECT Id FROM Users', 'postgres')).toBe('select id from users');
    expect(normalizeSql('SELECT "Id" FROM "users"', 'postgres')).toBe('select "Id" from users');
    expect(normalizeSql('SELECT `Id` FROM `users`', 'mysql')).toBe('select Id from users');
    expect(normalizeSql('SELECT `select` FROM t', 'mysql')).toBe('select `select` from t');
  });

  it('drops own-database qualifiers from MySQL definitions', () => {
    expect(
      normalizeSql('select `shop`.`t`.`id` from `shop`.`t`', 'mysql', { stripQualifier: 'shop' }),
    ).toBe('select t . id from t');
  });

  it('keeps comments only when asked and normalises dollar bodies on request', () => {
    const body = 'CREATE FUNCTION f() RETURNS int AS $$\n  SELECT   1; -- one\n$$ LANGUAGE sql';
    expect(
      normalizeSql(body, 'postgres', { keepComments: true, normalizeDollarBodies: true }),
    ).toBe('create function f ( ) returns int as $$ select 1 ; /* one */ $$ language sql');
    expect(normalizeSql(body, 'postgres')).toContain('$$\n  SELECT   1; -- one\n$$');
  });

  it('treats string-type casts of literals as equivalent (PostgreSQL deparse drift)', () => {
    const first =
      "((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))";
    const second =
      "((status)::text = ANY (ARRAY[('a'::character varying)::text, ('b'::character varying)::text]))";
    expect(normalizeSql(first, 'postgres')).toBe(normalizeSql(second, 'postgres'));
    expect(normalizeSql("'x'::character varying(3)", 'postgres')).toContain('varying ( 3 )');
  });

  it('is idempotent', () => {
    for (const [text, dialect] of [
      ['SELECT "We""ird", `x` FROM t WHERE a = \'b\' -- c', 'postgres'],
      ['SELECT `a``b` FROM `db`.`t` # c', 'mysql'],
    ] as const) {
      const once = normalizeSql(text, dialect, { keepComments: true });
      expect(normalizeSql(once, dialect, { keepComments: true })).toBe(once);
    }
  });
});

describe('parentheses helpers', () => {
  it('detects and strips enclosing parentheses only', () => {
    expect(isFullyParenthesized('((a > 0))', 'postgres')).toBe(true);
    expect(isFullyParenthesized('(a) + (b)', 'postgres')).toBe(false);
    expect(isFullyParenthesized("('(')", 'postgres')).toBe(true);
    expect(stripOuterParens('((price > (0)::numeric))', 'postgres')).toBe('price > (0)::numeric');
    expect(wrapParens('a + 1', 'mysql')).toBe('(a + 1)');
    expect(wrapParens('(a + 1)', 'mysql')).toBe('(a + 1)');
    expect(trimStatement(' SELECT 1;; ')).toBe('SELECT 1');
  });
});

describe('referencedNames', () => {
  it('finds qualified and bare names, including regclass literals', () => {
    const refs = referencedNames(
      'SELECT o.id FROM public.orders o JOIN "Line Items" l ON true WHERE nextval(\'public.seq\'::regclass) > 0',
      'postgres',
    );
    expect(refs).toContainEqual({ schema: 'public', name: 'orders' });
    expect(refs).toContainEqual({ name: 'Line Items' });
    expect(refs).toContainEqual({ schema: 'public', name: 'seq' });
  });
});
