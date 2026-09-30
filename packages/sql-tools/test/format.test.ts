import type { SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { formatSql, significantTokens, splitStatements } from '../src';

/** What formatting must preserve: every significant token, words compared case-insensitively. */
function meaning(text: string, dialect: SqlDialect): string[] {
  return splitStatements(text, dialect).flatMap((statement) =>
    significantTokens(statement.text, dialect).map((token) =>
      token.kind === 'word' ? token.text.toUpperCase() : token.text,
    ),
  );
}

const MYSQL_SCRIPT = `-- header comment
/*!40101 SET NAMES utf8mb4 */;
select id, name from users u where u.active = 1 and u.email like '%@x.com' order by id;
DELIMITER $$
create procedure bump(in n int)
begin
  update counters set value = value + n where id = 1;
  select value from counters;
END$$
DELIMITER ;
insert into log (msg) values ('done; ok'), (:note), (?); -- trailing note
`;

const PG_SCRIPT = `select a::int, $1, data ->> 'k' from t where b = :name and d ? 'key';
create function add(a int, b int) returns int language sql immutable as $$ select a + b; $$;
create function g(a int) returns int language sql begin atomic select a + 1; end;
`;

describe('formatSql', () => {
  it('upper-cases keywords and indents by two spaces by default', () => {
    expect(formatSql('select a, b from t where x = 1', 'postgres')).toBe(
      'SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1',
    );
  });

  it('honours options', () => {
    expect(formatSql('SELECT a FROM t', 'mysql', { keywordCase: 'lower', indent: 4 })).toBe(
      'select\n    a\nfrom\n    t',
    );
    expect(formatSql('SELECT 1; SELECT 2;', 'mysql', { linesBetweenStatements: 0 })).toBe(
      'SELECT\n  1;\nSELECT\n  2;',
    );
  });

  it('puts statements a blank line apart and keeps a trailing newline', () => {
    expect(formatSql('select 1 ;select 2;\n', 'postgres')).toBe('SELECT\n  1;\n\nSELECT\n  2;\n');
  });

  it('keeps DELIMITER commands, custom delimiters and executable comments intact', () => {
    const formatted = formatSql(MYSQL_SCRIPT, 'mysql');
    expect(formatted).toContain('-- header comment\n/*!40101 SET NAMES utf8mb4 */;');
    expect(formatted).toContain('\nDELIMITER $$\n');
    expect(formatted).toMatch(/\nEND\$\$\nDELIMITER ;\n/);
    expect(formatted).toContain('-- trailing note');
    expect(formatted).toContain("('done; ok')");
    expect(splitStatements(formatted, 'mysql').map((s) => s.delimiter)).toEqual(
      splitStatements(MYSQL_SCRIPT, 'mysql').map((s) => s.delimiter),
    );
  });

  it.each([
    ['mysql', MYSQL_SCRIPT],
    ['postgres', PG_SCRIPT],
  ] as const)('changes only whitespace and keyword case (%s)', (dialect, script) => {
    const formatted = formatSql(script, dialect);
    expect(meaning(formatted, dialect)).toEqual(meaning(script, dialect));
  });

  it('keeps placeholders, casts and jsonb operators', () => {
    const formatted = formatSql(PG_SCRIPT, 'postgres');
    expect(formatted).toContain('a::INT');
    expect(formatted).toContain('$1');
    expect(formatted).toContain(':name');
    expect(formatted).toContain("d ? 'key'");
    expect(formatted).toContain('$$ select a + b; $$');
  });

  it('is stable when run twice', () => {
    for (const [dialect, script] of [
      ['mysql', MYSQL_SCRIPT],
      ['postgres', PG_SCRIPT],
    ] as const) {
      const once = formatSql(script, dialect);
      expect(formatSql(once, dialect)).toBe(once);
    }
  });

  it('leaves statements sql-formatter cannot parse as written', () => {
    expect(formatSql('SELECT (((; select 2', 'mysql')).toBe('SELECT (((;\n\nSELECT\n  2');
  });

  it('returns text without statements unchanged', () => {
    expect(formatSql('  -- just a comment\n', 'postgres')).toBe('  -- just a comment\n');
    expect(formatSql('', 'mysql')).toBe('');
  });
});
