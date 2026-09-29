import type { SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { significantTokens, tokenize, type TokenKind } from '../src';

/** [kind, text] pairs of the significant tokens. */
function lex(text: string, dialect: SqlDialect): [TokenKind, string][] {
  return significantTokens(text, dialect).map((token) => [token.kind, token.text]);
}

function kinds(text: string, dialect: SqlDialect): TokenKind[] {
  return tokenize(text, dialect).map((token) => token.kind);
}

describe('tokenize', () => {
  it('covers the input exactly, with contiguous offsets', () => {
    const text = 'SELECT a, \'b;c\' -- note\r\nFROM "t" /* x */ WHERE id = $1;';
    for (const dialect of ['mysql', 'mariadb', 'postgres'] as const) {
      const tokens = tokenize(text, dialect);
      expect(tokens.map((token) => token.text).join('')).toBe(text);
      tokens.forEach((token, i) => {
        expect(token.text).toBe(text.slice(token.start, token.end));
        if (i > 0) expect(token.start).toBe(tokens[i - 1]!.end);
      });
    }
  });

  it('ends whitespace tokens at line breaks so every line start is a token boundary', () => {
    expect(tokenize('a  \n  \r\n\rb', 'mysql').map((token) => token.text)).toEqual([
      'a',
      '  \n',
      '  \r\n',
      '\r',
      'b',
    ]);
  });

  it('treats a byte order mark as whitespace', () => {
    expect(lex('﻿SELECT 1', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['number', '1'],
    ]);
  });
});

describe('MySQL and MariaDB lexing', () => {
  it('handles backslash escapes and doubled quotes in strings', () => {
    expect(lex("SELECT 'it\\'s; ok', 'it''s', \"say \\\"hi\\\"; \"", 'mysql')).toEqual([
      ['word', 'SELECT'],
      ['string', "'it\\'s; ok'"],
      ['punctuation', ','],
      ['string', "'it''s'"],
      ['punctuation', ','],
      ['string', '"say \\"hi\\"; "'],
    ]);
    // A backslash before the closing quote escapes it: the string runs on.
    expect(lex("'a\\\\' b", 'mysql')).toEqual([
      ['string', "'a\\\\'"],
      ['word', 'b'],
    ]);
  });

  it('lexes backtick identifiers with doubled backticks', () => {
    expect(lex('SELECT `we``ird;name` FROM `my db`.`t`', 'mariadb')).toEqual([
      ['word', 'SELECT'],
      ['quoted-identifier', '`we``ird;name`'],
      ['word', 'FROM'],
      ['quoted-identifier', '`my db`'],
      ['punctuation', '.'],
      ['quoted-identifier', '`t`'],
    ]);
  });

  it('requires whitespace or a control character after --', () => {
    expect(kinds('SELECT 1 -- c', 'mysql')).toContain('line-comment');
    expect(kinds('SELECT 1 --\tc', 'mysql')).toContain('line-comment');
    expect(kinds('SELECT 1 --', 'mysql')).toContain('line-comment');
    expect(lex('SELECT 5--1', 'mysql')).toEqual([
      ['word', 'SELECT'],
      ['number', '5'],
      ['operator', '--'],
      ['number', '1'],
    ]);
  });

  it('lexes # comments to the end of the line', () => {
    expect(tokenize('SELECT 1 # c;\nSELECT 2', 'mysql').map((t) => t.kind)).toEqual([
      'word',
      'whitespace',
      'number',
      'whitespace',
      'line-comment',
      'whitespace',
      'word',
      'whitespace',
      'number',
    ]);
  });

  it('does not nest block comments', () => {
    expect(lex('/* a /* b */ SELECT 1 */', 'mysql')).toEqual([
      ['word', 'SELECT'],
      ['number', '1'],
      ['operator', '*/'],
    ]);
  });

  it('recognises executable comments; /*M! only in MariaDB; hints are comments', () => {
    expect(lex('/*!40101 SET NAMES utf8 */', 'mysql')).toEqual([
      ['executable-comment', '/*!40101 SET NAMES utf8 */'],
    ]);
    expect(lex('/*M!100100 SET x = 1 */', 'mariadb')).toEqual([
      ['executable-comment', '/*M!100100 SET x = 1 */'],
    ]);
    expect(lex('/*M!100100 SET x = 1 */', 'mysql')).toEqual([]);
    expect(lex('SELECT /*+ NO_ICP(t) */ 1', 'mysql')).toEqual([
      ['word', 'SELECT'],
      ['number', '1'],
    ]);
  });

  it('lexes variables, placeholders and assignments', () => {
    expect(lex('SET @a := @@global.max_connections + ? + :name + $1', 'mysql')).toEqual([
      ['word', 'SET'],
      ['variable', '@a'],
      ['operator', ':='],
      ['variable', '@@global.max_connections'],
      ['operator', '+'],
      ['parameter', '?'],
      ['operator', '+'],
      ['parameter', ':name'],
      ['operator', '+'],
      ['parameter', '$1'],
    ]);
  });

  it('lexes identifiers that start with digits or dollar signs as words', () => {
    expect(lex('SELECT * FROM 2fa_codes, $tbl, a$b', 'mysql').map(([kind]) => kind)).toEqual([
      'word',
      'operator',
      'word',
      'word',
      'punctuation',
      'word',
      'punctuation',
      'word',
    ]);
  });

  it('lexes prefixed literals as one string', () => {
    expect(lex("SELECT X'0F', B'01', N'abc', _utf8mb4'x'", 'mysql')).toEqual([
      ['word', 'SELECT'],
      ['string', "X'0F'"],
      ['punctuation', ','],
      ['string', "B'01'"],
      ['punctuation', ','],
      ['string', "N'abc'"],
      ['punctuation', ','],
      ['word', '_utf8mb4'],
      ['string', "'x'"],
    ]);
  });

  it('lexes numbers', () => {
    expect(lex('1 1.5 .5 1e10 1.5E-3 0x1F 0b101', 'mysql').map(([, text]) => text)).toEqual([
      '1',
      '1.5',
      '.5',
      '1e10',
      '1.5E-3',
      '0x1F',
      '0b101',
    ]);
  });
});

describe('DELIMITER client command', () => {
  it('changes the delimiter for the following text', () => {
    const tokens = tokenize('DELIMITER $$\nSELECT 1; SELECT 2$$\ndelimiter ;\nSELECT 3;', 'mysql');
    expect(tokens.filter((t) => t.kind === 'client-command').map((t) => t.text)).toEqual([
      'DELIMITER $$',
      'delimiter ;',
    ]);
    expect(tokens.filter((t) => t.kind === 'delimiter').map((t) => t.text)).toEqual(['$$', ';']);
  });

  it('finds the delimiter inside a word, as the mysql client does', () => {
    expect(lex('DELIMITER //\nEND//', 'mariadb')).toEqual([
      ['client-command', 'DELIMITER //'],
      ['word', 'END'],
      ['delimiter', '//'],
    ]);
  });

  it('strips quotes around the delimiter', () => {
    expect(lex("DELIMITER '$$'\nSELECT 1$$", 'mysql').at(-1)).toEqual(['delimiter', '$$']);
  });

  it('is only honoured at the start of a line between statements', () => {
    expect(kinds('SELECT 1 DELIMITER $$', 'mysql')).not.toContain('client-command');
    expect(kinds('SELECT a,\ndelimiter $$\nFROM t', 'mysql')).not.toContain('client-command');
    expect(kinds('-- comment\n  DELIMITER $$\n', 'mysql')).toContain('client-command');
    expect(kinds('delimiter\nFROM t', 'mysql')).not.toContain('client-command');
  });

  it('means nothing to PostgreSQL', () => {
    expect(kinds('DELIMITER $$\n', 'postgres')).not.toContain('client-command');
  });
});

describe('PostgreSQL lexing', () => {
  it('uses standard strings, E strings and U& strings', () => {
    expect(lex("SELECT 'a\\', E'b\\'c', e'\\\\', U&'d\\0061t', 'it''s'", 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['string', "'a\\'"],
      ['punctuation', ','],
      ['string', "E'b\\'c'"],
      ['punctuation', ','],
      ['string', "e'\\\\'"],
      ['punctuation', ','],
      ['string', "U&'d\\0061t'"],
      ['punctuation', ','],
      ['string', "'it''s'"],
    ]);
  });

  it('lexes double quotes as identifiers', () => {
    expect(lex('SELECT "we""ird;col", U&"d\\0061t" FROM "T"', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['quoted-identifier', '"we""ird;col"'],
      ['punctuation', ','],
      ['quoted-identifier', 'U&"d\\0061t"'],
      ['word', 'FROM'],
      ['quoted-identifier', '"T"'],
    ]);
  });

  it('lexes dollar quotes and tells them from parameters', () => {
    const text = 'SELECT $1, $$a;$b$ $$, $body$ $$; $body$, $_x1$y$_x1$ FROM t WHERE a = $12';
    expect(lex(text, 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['parameter', '$1'],
      ['punctuation', ','],
      ['dollar-string', '$$a;$b$ $$'],
      ['punctuation', ','],
      ['dollar-string', '$body$ $$; $body$'],
      ['punctuation', ','],
      ['dollar-string', '$_x1$y$_x1$'],
      ['word', 'FROM'],
      ['word', 't'],
      ['word', 'WHERE'],
      ['word', 'a'],
      ['operator', '='],
      ['parameter', '$12'],
    ]);
  });

  it('keeps $ inside identifiers', () => {
    expect(lex('SELECT a$b$c', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['word', 'a$b$c'],
    ]);
  });

  it('nests block comments and needs no space after --', () => {
    expect(lex('/* a /* b; */ c; */ SELECT 1--x', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['number', '1'],
    ]);
  });

  it('lexes casts, assignments, named parameters and array slices', () => {
    expect(lex('SELECT x::int, a[1:2], a[lo:hi], f(p := 1), :name FROM t', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['word', 'x'],
      ['operator', '::'],
      ['word', 'int'],
      ['punctuation', ','],
      ['word', 'a'],
      ['punctuation', '['],
      ['number', '1'],
      ['punctuation', ':'],
      ['number', '2'],
      ['punctuation', ']'],
      ['punctuation', ','],
      ['word', 'a'],
      ['punctuation', '['],
      ['word', 'lo'],
      ['punctuation', ':'],
      ['word', 'hi'],
      ['punctuation', ']'],
      ['punctuation', ','],
      ['word', 'f'],
      ['punctuation', '('],
      ['word', 'p'],
      ['operator', ':='],
      ['number', '1'],
      ['punctuation', ')'],
      ['punctuation', ','],
      ['parameter', ':name'],
      ['word', 'FROM'],
      ['word', 't'],
    ]);
  });

  it('lexes jsonb and other multi-character operators', () => {
    expect(lex("SELECT d ? 'k', d ?| a, d @> x, d #>> '{a}', 1 <> 2", 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['word', 'd'],
      ['operator', '?'],
      ['string', "'k'"],
      ['punctuation', ','],
      ['word', 'd'],
      ['operator', '?|'],
      ['word', 'a'],
      ['punctuation', ','],
      ['word', 'd'],
      ['operator', '@>'],
      ['word', 'x'],
      ['punctuation', ','],
      ['word', 'd'],
      ['operator', '#>>'],
      ['string', "'{a}'"],
      ['punctuation', ','],
      ['number', '1'],
      ['operator', '<>'],
      ['number', '2'],
    ]);
  });

  it('stops operators at comment starts', () => {
    expect(lex('SELECT 1 +-- c\n2', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['number', '1'],
      ['operator', '+'],
      ['number', '2'],
    ]);
  });
});

describe('malformed input', () => {
  const cases: [SqlDialect, string, TokenKind][] = [
    ['mysql', "SELECT 'abc", 'string'],
    ['mysql', 'SELECT "abc', 'string'],
    ['mysql', 'SELECT `abc', 'quoted-identifier'],
    ['mysql', 'SELECT /* abc', 'block-comment'],
    ['mysql', 'SELECT /*! abc', 'executable-comment'],
    ['mysql', "SELECT 'abc\\", 'string'],
    ['postgres', 'SELECT $$ abc', 'dollar-string'],
    ['postgres', 'SELECT $a$ abc $a', 'dollar-string'],
    ['postgres', 'SELECT /* /* */', 'block-comment'],
    ['postgres', 'SELECT "abc', 'quoted-identifier'],
    ['postgres', "SELECT E'abc\\'", 'string'],
  ];

  it.each(cases)('%s: %s extends to the end, flagged unterminated', (dialect, text, kind) => {
    const last = tokenize(text, dialect).at(-1)!;
    expect(last.kind).toBe(kind);
    expect(last.end).toBe(text.length);
    expect(last.unterminated).toBe(true);
  });

  it('lexes stray characters as other', () => {
    expect(lex('SELECT \\ 1', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['other', '\\'],
      ['number', '1'],
    ]);
  });
});
