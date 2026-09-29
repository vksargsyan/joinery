import type { SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { buildBrowseQuery, checkRawWhere, rowIdentity } from '../src';
import { itemsFor } from './fixtures';

describe('checkRawWhere', () => {
  const accepted: [SqlDialect, string][] = [
    ['postgres', 'qty > 5'],
    ['postgres', "name = 'a;b' AND (qty < 3 OR price IS NULL)"],
    ['postgres', "doc ? 'key'"],
    ['postgres', 'a IS DISTINCT FROM b'],
    ['postgres', 'EXISTS (SELECT 1 FROM other o WHERE o.id = items.id)'],
    ['postgres', 'extract(year FROM born) = 2026 /* comment ; */'],
    ['postgres', '$$;$$ = name'],
    ['mysql', "name LIKE '%x%' -- trailing comment"],
    ['mysql', '`offset` > 3 AND offset < 9'],
    ['mysql', 'qty # comment'],
  ];
  it.each(accepted)('%s accepts %s', (dialect, text) => {
    expect(checkRawWhere(text, dialect).ok).toBe(true);
  });

  const rejected: [SqlDialect, string, RegExp][] = [
    ['postgres', 'qty > 1; DROP TABLE items', /Only one condition/],
    ['postgres', "name = 'open", /Unterminated string/],
    ['postgres', 'qty > 1 /* open', /Unterminated comment/],
    ['postgres', 'qty > 1) OR (1 = 1', /Unbalanced/],
    ['postgres', '(qty > 1', /Missing "\)"/],
    ['postgres', 'id = $1', /Parameters/],
    ['postgres', 'qty > 1 ORDER BY id', /ORDER is not part/],
    ['postgres', 'WHERE qty > 1', /Leave out the WHERE/],
    ['postgres', 'true OFFSET 5', /OFFSET/],
    ['postgres', '   -- only a comment', /empty/],
    ['mysql', 'id = ?', /Parameters/],
    ['mysql', '1 = 1 /*!) OR (1 */', /Executable comments/],
    ['mysql', 'x = `open', /Unterminated quoted name/],
    ['mysql', '1 UNION SELECT 2', /UNION/],
  ];
  it.each(rejected)('%s rejects %s', (dialect, text, message) => {
    const check = checkRawWhere(text, dialect);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(message);
  });

  it('points at the offending token', () => {
    const check = checkRawWhere('a = 1; b', 'postgres');
    expect(check).toEqual({
      ok: false,
      message: 'Only one condition is allowed: remove the ";"',
      position: 5,
    });
  });

  it('is inserted verbatim, parenthesised, ending a trailing line comment with a line break', () => {
    const { table, columns } = itemsFor('mysql');
    const query = (rawWhere: string) =>
      buildBrowseQuery({
        dialect: 'mysql',
        table: { name: 'items' },
        columns,
        select: ['id'],
        identity: rowIdentity(table),
        rawWhere,
        limit: 10,
      }).sql;
    expect(query('qty > 5')).toBe(
      'SELECT `id`, `region` FROM `items` WHERE (qty > 5) ORDER BY `region` ASC, `id` ASC LIMIT 10',
    );
    expect(query('qty > 5 -- big')).toContain('WHERE (qty > 5 -- big\n) ORDER BY');
    expect(() => query('qty > 5; DELETE FROM items')).toThrow(/Invalid WHERE condition/);
  });
});
