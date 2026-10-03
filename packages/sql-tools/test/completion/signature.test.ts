import type { SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { signatureHelp } from '../../src';
import { CATALOGS, DIALECTS, cursor } from './helpers';

function help(dialect: SqlDialect, sql: string) {
  const { text, offset } = cursor(sql);
  return signatureHelp(text, offset, dialect, CATALOGS[dialect]);
}

/** The active signature's label and the text of the active parameter. */
function active(dialect: SqlDialect, sql: string): [string, string] | undefined {
  const result = help(dialect, sql);
  if (!result) return undefined;
  const signature = result.signatures[result.activeSignature]!;
  const parameter = signature.parameters[result.activeParameter];
  return [signature.label, parameter ? signature.label.slice(parameter.start, parameter.end) : ''];
}

describe('signatureHelp()', () => {
  it('shows built-in signatures with the argument at the cursor', () => {
    for (const dialect of DIALECTS) {
      expect(active(dialect, 'SELECT lpad(name, |) FROM users')).toEqual([
        'lpad(string, length integer, [fill]) → text',
        'length integer',
      ]);
      expect(active(dialect, 'SELECT lpad(|')?.[1]).toBe('string');
      expect(active(dialect, 'SELECT lpad(name, 5, |')?.[1]).toBe('[fill]');
    }
  });

  it('picks the overload that fits the argument count', () => {
    expect(active('postgres', 'SELECT log(|')?.[0]).toBe('log(x) → double precision');
    expect(active('postgres', 'SELECT log(2, |')?.[0]).toBe('log(base, x) → double precision');
    expect(help('postgres', 'SELECT to_timestamp(|')?.signatures).toHaveLength(2);
  });

  it('stays on the repeated parameter of a variadic function', () => {
    expect(active('mysql', 'SELECT coalesce(a, b, c, |)')).toEqual([
      'coalesce(value, ...values)',
      '...values',
    ]);
  });

  it('uses the innermost call and ignores commas of nested calls', () => {
    expect(active('postgres', 'SELECT substring(name, lower(|), 2)')?.[0]).toBe(
      'lower(string) → text',
    );
    expect(active('postgres', 'SELECT round(coalesce(a, b), |)')?.[1]).toBe('[decimals integer]');
    expect(active('postgres', 'SELECT round(price * (1 + tax), |) FROM t')?.[1]).toBe(
      '[decimals integer]',
    );
  });

  it('works inside string arguments', () => {
    const result = help('postgres', "SELECT concat('a, |b', 1)");
    expect(result?.name).toBe('concat');
    expect(result?.activeParameter).toBe(0);
  });

  it('describes user routines with parameter names from their definition', () => {
    expect(active('postgres', 'SELECT calc_total(1, |)')).toEqual([
      'calc_total(p_order integer, [p_discount numeric DEFAULT 0]) → numeric',
      '[p_discount numeric DEFAULT 0]',
    ]);
    expect(active('postgres', 'SELECT public.calc_total(|)')?.[1]).toBe('p_order integer');
    expect(active('mysql', 'SELECT calc_total(|)')).toEqual([
      'calc_total(p_order INT, p_discount DECIMAL(10,2)) → decimal(10,2)',
      'p_order INT',
    ]);
    expect(active('mariadb', 'CALL archive_orders(|)')?.[1]).toBe('IN before_date DATE');
    const result = help('postgres', 'CALL archive_orders(|)');
    expect(result?.signatures[0]?.documentation).toBe('Procedure public.archive_orders');
  });

  it('returns the opening parenthesis and the name as written', () => {
    const { text } = cursor('SELECT public.calc_total(|)');
    const result = help('postgres', 'SELECT public.calc_total(|)');
    expect(result?.name).toBe('public.calc_total');
    expect(result?.open).toBe(text.indexOf('('));
  });

  it('gives nothing outside calls, for unknown functions and in comments', () => {
    expect(help('postgres', 'SELECT * FROM users WHERE |')).toBeUndefined();
    expect(help('postgres', 'SELECT * FROM users WHERE id IN (|')).toBeUndefined();
    expect(help('postgres', 'SELECT no_such_function(|')).toBeUndefined();
    expect(help('postgres', 'SELECT lpad(a, /* | */ b)')).toBeUndefined();
    expect(help('postgres', 'INSERT INTO orders (|')).toBeUndefined();
    expect(help('postgres', 'SELECT lpad(a, b)|')).toBeUndefined();
  });
});
