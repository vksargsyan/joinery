import { describe, expect, it } from 'vitest';

import { quoteIdent, quoteQualified, quoteString } from '../src';

describe('dialect quoting', () => {
  it('quotes identifiers per dialect', () => {
    expect(quoteIdent('user"s', 'postgres')).toBe('"user""s"');
    expect(quoteIdent('order`s', 'mysql')).toBe('`order``s`');
    expect(quoteQualified(['public', undefined, 'users'], 'postgres')).toBe('"public"."users"');
  });

  it('quotes string literals per dialect', () => {
    expect(quoteString("it's", 'postgres')).toBe("'it''s'");
    expect(quoteString('a\\b', 'postgres')).toBe("'a\\b'");
    expect(quoteString("it's a\\b\n", 'mariadb')).toBe("'it''s a\\\\b\\n'");
  });
});
