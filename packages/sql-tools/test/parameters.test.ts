import { JoineryError } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { bindParameters, findParameters, parameterNames } from '../src';

function names(text: string, dialect: 'mysql' | 'mariadb' | 'postgres'): string[] {
  return findParameters(text, dialect).map((p) => `${p.style}:${p.name}`);
}

function validationError(fn: () => unknown): JoineryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof JoineryError) return error;
    throw error;
  }
  throw new Error('expected a JoineryError');
}

describe('findParameters', () => {
  it('finds :name, $n and ? with their offsets', () => {
    const text = 'SELECT * FROM t WHERE a = :id AND b = :id2';
    expect(findParameters(text, 'postgres')).toEqual([
      { style: 'named', name: 'id', start: 26, end: 29 },
      { style: 'named', name: 'id2', start: 38, end: 42 },
    ]);
    expect(names('SELECT $1, $2, $01', 'postgres')).toEqual([
      'numbered:1',
      'numbered:2',
      'numbered:1',
    ]);
    expect(names('SELECT ?, ?', 'mysql')).toEqual(['positional:1', 'positional:2']);
  });

  it('ignores placeholders in strings, comments, identifiers and dollar-quoted bodies', () => {
    expect(
      names(
        `SELECT ':a', "?b", \`:c\`, '$1' /* :d ? */ -- :e ?\n# :f\nFROM t WHERE x = :real`,
        'mysql',
      ),
    ).toEqual(['named:real']);
    expect(
      names(
        `SELECT ':a', ":b", $$ :c $1 $$, $fn$ SELECT $1 $fn$, E'\\':d' /* /* :e */ */ FROM t WHERE x = $2`,
        'postgres',
      ),
    ).toEqual(['numbered:2']);
  });

  it('ignores casts, assignments, variables, labels and slices', () => {
    expect(names('SELECT x::int, y::"my type" FROM t', 'postgres')).toEqual([]);
    expect(names('SELECT f(a := 1), arr[1:2], arr[lo:hi] FROM t', 'postgres')).toEqual([]);
    expect(names('SET @x := 1; SELECT @x, @@global.max_connections', 'mysql')).toEqual([]);
    expect(names('lbl:LOOP LEAVE lbl; END LOOP lbl', 'mariadb')).toEqual([]);
  });

  it('leaves PostgreSQL ? alone unless asked, and never touches ?| or ?&', () => {
    const text = "SELECT * FROM t WHERE d ? 'k' AND d ?| array['a'] AND d ?& array['b'] AND a=?";
    expect(findParameters(text, 'postgres')).toEqual([]);
    const found = findParameters(text, 'postgres', { questionMarks: true });
    expect(found.map((p) => text.slice(p.start, p.end))).toEqual(['?', '?']);
    expect(found.map((p) => p.start)).toEqual([text.indexOf("? 'k'"), text.length - 1]);
    expect(findParameters('SELECT ?', 'mysql', { questionMarks: false })).toEqual([]);
  });
});

describe('parameterNames', () => {
  it('lists what to prompt for, in binding order', () => {
    expect(parameterNames(findParameters('SELECT :b, :a, :b', 'postgres'))).toEqual(['b', 'a']);
    expect(parameterNames(findParameters('SELECT $3, $1, $3', 'postgres'))).toEqual(['1', '3']);
    expect(parameterNames(findParameters('SELECT ?, ?, ?', 'mysql'))).toEqual(['1', '2', '3']);
    expect(parameterNames([])).toEqual([]);
  });

  it('rejects mixed styles', () => {
    const error = validationError(() => parameterNames(findParameters('SELECT :a, ?', 'mysql')));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toMatch(/Cannot mix :name and \? placeholders/);
    expect(error.position).toBe(11);
  });
});

describe('bindParameters', () => {
  it('binds named parameters as $n for PostgreSQL, reusing numbers', () => {
    expect(
      bindParameters('SELECT * FROM t WHERE a = :id OR b = :name OR c = :id', 'postgres', {
        id: 7,
        name: 'x',
        unused: true,
      }),
    ).toEqual({ text: 'SELECT * FROM t WHERE a = $1 OR b = $2 OR c = $1', values: [7, 'x'] });
  });

  it('binds named parameters as ? for MySQL, one value per occurrence', () => {
    expect(
      bindParameters('UPDATE t SET a = :v WHERE id = :id OR a = :v', 'mariadb', {
        v: null,
        id: 1n,
      }),
    ).toEqual({
      text: 'UPDATE t SET a = ? WHERE id = ? OR a = ?',
      values: [null, 1n, null],
    });
  });

  it('renumbers $n compactly for PostgreSQL and maps them to ? for MySQL', () => {
    expect(bindParameters('SELECT $3, $1, $3', 'postgres', ['a', 'b', 'c'])).toEqual({
      text: 'SELECT $2, $1, $2',
      values: ['a', 'c'],
    });
    expect(bindParameters('SELECT $2, $1', 'mysql', { '1': 'one', '2': 'two' })).toEqual({
      text: 'SELECT ?, ?',
      values: ['two', 'one'],
    });
  });

  it('binds ? positionally', () => {
    expect(bindParameters('SELECT ?, ?', 'mysql', [1, 'x'])).toEqual({
      text: 'SELECT ?, ?',
      values: [1, 'x'],
    });
    expect(
      bindParameters('SELECT d ?| array[?], ?', 'postgres', ['a', 2], { questionMarks: true }),
    ).toEqual({ text: 'SELECT d ?| array[$1], $2', values: ['a', 2] });
  });

  it('returns text without placeholders unchanged', () => {
    expect(bindParameters("SELECT ':x'", 'postgres', { x: 1 })).toEqual({
      text: "SELECT ':x'",
      values: [],
    });
    expect(bindParameters('SELECT 1', 'mysql', undefined)).toEqual({
      text: 'SELECT 1',
      values: [],
    });
  });

  it('keeps binary and large values as they are', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(bindParameters('SELECT :b', 'postgres', { b: bytes }).values[0]).toBe(bytes);
  });

  it('reports missing values with the placeholder position', () => {
    const error = validationError(() => bindParameters('SELECT :a, :b, :c', 'postgres', { a: 1 }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('Missing value for parameter :b, :c');
    expect(error.position).toBe(11);
    expect(validationError(() => bindParameters('SELECT $1, $2', 'postgres', [1])).message).toBe(
      'Missing value for parameter $2',
    );
  });

  it('rejects a wrong number of positional values and arrays for named parameters', () => {
    expect(validationError(() => bindParameters('SELECT ?, ?', 'mysql', [1])).message).toBe(
      'Expected 2 parameter values, got 1',
    );
    expect(validationError(() => bindParameters('SELECT ?', 'mysql', [1, 2])).message).toBe(
      'Expected 1 parameter value, got 2',
    );
    expect(validationError(() => bindParameters('SELECT :a', 'mysql', [1])).message).toMatch(
      /Named parameters need values by name/,
    );
  });

  it('rejects mixed styles', () => {
    expect(validationError(() => bindParameters('SELECT $1, ?', 'mysql', [1, 2])).message).toBe(
      'Cannot mix $n and ? placeholders in one statement',
    );
  });
});
