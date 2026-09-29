import { describe, expect, it } from 'vitest';

import {
  canonicalDecimal,
  canonicalTimestamp,
  canonicalValue,
  compareCodePoints,
  compareDecimals,
  compareKeyValues,
  compareKeys,
  compareKind,
  valuesEqual,
} from '../src';

describe('value canonicalisation', () => {
  it('normalises timestamps to UTC ISO strings, keeping microseconds', () => {
    expect(canonicalValue('2024-05-01 12:00:00+02', 'timestamp')).toBe('2024-05-01T10:00:00Z');
    expect(canonicalValue('2024-05-01T10:00:00.500000Z', 'timestamp')).toBe(
      '2024-05-01T10:00:00.5Z',
    );
    expect(canonicalValue('2024-05-01 10:00:00.123456', 'datetime')).toBe(
      '2024-05-01T10:00:00.123456Z',
    );
    expect(canonicalValue('2024-05-01 23:30:00-01:30', 'timestamp')).toBe('2024-05-02T01:00:00Z');
    expect(canonicalValue('2024-05-01 10:00:00', 'datetime', { assumeTimeZone: '+02:00' })).toBe(
      '2024-05-01T08:00:00Z',
    );
    expect(canonicalValue('infinity', 'timestamp')).toBe('infinity');
    expect(canonicalTimestamp('2024-05-01 10:00:00.5', 'Z', 6)).toBe('2024-05-01T10:00:00.500000Z');
  });

  it('writes decimals without redundant zeros', () => {
    expect(canonicalDecimal('1.500')).toBe('1.5');
    expect(canonicalDecimal('-0.000')).toBe('0');
    expect(canonicalDecimal('+007.10')).toBe('7.1');
    expect(canonicalDecimal('1e3')).toBe('1000');
    expect(canonicalDecimal('1.5E-3')).toBe('0.0015');
    expect(canonicalDecimal('abc')).toBeNull();
    expect(canonicalValue(12345678901234567890n, 'bigint')).toBe('12345678901234567890');
    expect(canonicalValue(2, 'decimal')).toBe(canonicalValue('2.00', 'decimal'));
  });

  it('sorts JSON object keys and keeps array order', () => {
    expect(canonicalValue('{"b": 1, "a": {"d": [2, 1], "c": null}}', 'json')).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(canonicalValue('not json', 'json')).toBe('not json');
  });

  it('keeps NULL, empty string and the string NULL apart', () => {
    expect(canonicalValue(null, 'string')).toBeNull();
    expect(canonicalValue('', 'string')).toBe('');
    expect(canonicalValue('NULL', 'string')).toBe('NULL');
    expect(valuesEqual(null, '', 'string')).toBe(false);
    expect(valuesEqual('NULL', null, 'string')).toBe(false);
    expect(valuesEqual(null, null, 'string')).toBe(true);
  });

  it('encodes binary as hex and folds UUID spellings', () => {
    expect(canonicalValue(new Uint8Array([0, 255, 16]), 'binary')).toBe('00ff10');
    expect(canonicalValue('\\x00FF10', 'binary')).toBe('00ff10');
    expect(canonicalValue('{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}', 'uuid')).toBe(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    );
    expect(canonicalValue('a0eebc999c0b4ef8bb6d6bb9bd380a11', 'uuid')).toBe(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    );
  });

  it('applies trim, case and float tolerance rules', () => {
    expect(valuesEqual('abc  ', 'abc', 'string')).toBe(false);
    expect(valuesEqual('abc  ', 'abc', 'string', 'string', { trim: 'trailing' })).toBe(true);
    expect(valuesEqual('  abc', 'abc', 'string', 'string', { trim: 'trailing' })).toBe(false);
    expect(valuesEqual('  abc ', 'abc', 'string', 'string', { trim: 'both' })).toBe(true);
    expect(valuesEqual('ABC', 'abc', 'string', 'string', { caseInsensitive: true })).toBe(true);
    expect(valuesEqual(0.1 + 0.2, 0.3, 'float')).toBe(false);
    expect(valuesEqual(0.1 + 0.2, 0.3, 'float', 'float', { floatTolerance: 1e-9 })).toBe(true);
    expect(valuesEqual(1.5, 1.6, 'float', 'float', { floatTolerance: 0.01 })).toBe(false);
    expect(valuesEqual(Number.NaN, Number.NaN, 'float', 'float', { floatTolerance: 0.1 })).toBe(
      true,
    );
  });

  it('compares across engines through a common kind', () => {
    expect(compareKind('boolean', 'integer')).toBe('boolean');
    expect(compareKind('decimal', 'float')).toBe('float');
    expect(compareKind('integer', 'bigint')).toBe('decimal');
    expect(compareKind('json', 'string')).toBe('json');
    expect(compareKind('datetime', 'timestamp')).toBe('timestamp');
    // PostgreSQL boolean vs MySQL TINYINT(1)
    expect(valuesEqual(true, 1, 'boolean', 'integer')).toBe(true);
    expect(valuesEqual('t', 0, 'boolean', 'integer')).toBe(false);
    // numeric(10,2) text vs double
    expect(valuesEqual('2.50', 2.5, 'decimal', 'float')).toBe(true);
    // jsonb text vs MySQL JSON text with other key order and spacing
    expect(valuesEqual('{"a": 1, "b": [1, 2]}', '{"b":[1,2],"a":1}', 'json', 'string')).toBe(true);
    // timestamptz with offset vs UTC datetime
    expect(
      valuesEqual('2024-01-01 12:00:00+01', '2024-01-01 11:00:00', 'timestamp', 'datetime'),
    ).toBe(true);
  });

  it('compares large values by length and preview only', () => {
    const a = { $handle: 'h1', preview: 'abc', byteLength: 10_000, kind: 'text' as const };
    const b = { $handle: 'h2', preview: 'abc', byteLength: 10_000, kind: 'text' as const };
    expect(valuesEqual(a, b, 'string')).toBe(true);
    expect(valuesEqual(a, { ...b, byteLength: 10_001 }, 'string')).toBe(false);
  });
});

describe('key ordering', () => {
  it('orders decimals numerically, not as text', () => {
    expect(compareDecimals('10', '9')).toBeGreaterThan(0);
    expect(compareDecimals('-10', '-9')).toBeLessThan(0);
    expect(compareDecimals('1.05', '1.5')).toBeLessThan(0);
    expect(compareKeyValues('10', 9, 'decimal')).toBeGreaterThan(0);
    expect(compareKeyValues(2n ** 63n, 2 ** 53, 'bigint')).toBeGreaterThan(0);
  });

  it('orders strings by code point like binary collations', () => {
    expect(compareCodePoints('B', 'a')).toBeLessThan(0);
    // U+FF21 (fullwidth A) sorts before U+1F600 by code point, but after it in UTF-16 units.
    expect('\u{1F600}' < 'Ａ').toBe(true);
    expect(compareCodePoints('\u{1F600}', 'Ａ')).toBeGreaterThan(0);
    expect(compareCodePoints('ab', 'abc')).toBeLessThan(0);
  });

  it('orders timestamps chronologically whatever their fraction length', () => {
    expect(
      compareKeyValues('2024-01-01 10:00:00.5', '2024-01-01 10:00:00', 'timestamp'),
    ).toBeGreaterThan(0);
    expect(
      compareKeyValues('2024-01-01 10:00:00+02', '2024-01-01 09:00:00Z', 'timestamp'),
    ).toBeLessThan(0);
  });

  it('orders composite keys lexicographically', () => {
    expect(compareKeys([1, 'b'], [1, 'a'], ['integer', 'string'])).toBeGreaterThan(0);
    expect(compareKeys([1, 'z'], [2, 'a'], ['integer', 'string'])).toBeLessThan(0);
    expect(
      compareKeys([new Uint8Array([1, 2])], [new Uint8Array([1, 2, 0])], ['binary']),
    ).toBeLessThan(0);
  });
});
