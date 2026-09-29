import { describe, expect, it } from 'vitest';

import {
  bool,
  byName,
  isRecord,
  json,
  num,
  opt,
  parseInteger,
  planNode,
  positionalParams,
  resolvedProfileFromUrl,
  scalarDetail,
  str,
  toBytes,
  toNumber,
} from '../src';

describe('value helpers', () => {
  it('keeps integers as numbers up to 2^53 and as bigint beyond', () => {
    expect(parseInteger('42')).toBe(42);
    expect(parseInteger('-9007199254740991')).toBe(-9007199254740991);
    expect(parseInteger('9007199254740993')).toBe(9007199254740993n);
    expect(parseInteger('18446744073709551615')).toBe(18446744073709551615n);
  });

  it('copies bytes out of shared driver buffers', () => {
    const pool = Buffer.from([1, 2, 3, 4, 5]);
    const view = pool.subarray(1, 3);
    const copy = toBytes(view);
    expect(copy).toEqual(new Uint8Array([2, 3]));
    expect(copy.buffer.byteLength).toBe(2);
    expect(Buffer.isBuffer(copy)).toBe(false);
  });

  it('accepts positional parameters and refuses named ones and handles', () => {
    expect(positionalParams(undefined)).toEqual([]);
    expect(positionalParams([1, 'a', null, 2n])).toEqual([1, 'a', null, 2n]);
    expect(() => positionalParams({ a: 1 })).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
    expect(() =>
      positionalParams([{ $handle: 'h', preview: '', byteLength: 1, kind: 'text' }]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('row helpers', () => {
  const row = { a: 'x', b: null, c: 5, d: 7n, e: true, j: '["p","q"]', empty: '' };

  it('reads typed columns', () => {
    expect(str(row, 'a')).toBe('x');
    expect(str(row, 'b')).toBe('');
    expect(str(row, 'c')).toBe('5');
    expect(opt(row, 'b')).toBeUndefined();
    expect(opt(row, 'empty')).toBeUndefined();
    expect(num(row, 'd')).toBe(7);
    expect(bool(row, 'e')).toBe(true);
    expect(json(row, 'j', [])).toEqual(['p', 'q']);
    expect(json(row, 'b', 'fallback')).toBe('fallback');
  });

  it('sorts by name independent of the locale', () => {
    const names = [{ name: 'b' }, { name: 'B' }, { name: 'a' }, { name: '_x' }]
      .sort(byName)
      .map((n) => n.name);
    expect(names).toEqual(['B', '_x', 'a', 'b']);
  });
});

describe('plan helpers', () => {
  it('copies scalars and joins scalar arrays into the detail', () => {
    expect(
      scalarDetail(
        { a: 1, b: 'x', c: true, d: null, e: ['k1', 'k2'], f: { nested: 1 }, g: [{}], skip: 2 },
        new Set(['skip']),
      ),
    ).toEqual({ a: 1, b: 'x', c: true, d: null, e: 'k1, k2' });
  });

  it('reads numbers from JSON numbers and numeric strings', () => {
    expect(toNumber('1.25')).toBe(1.25);
    expect(toNumber(3)).toBe(3);
    expect(toNumber('')).toBeUndefined();
    expect(toNumber('abc')).toBeUndefined();
    expect(isRecord([])).toBe(false);
  });

  it('drops undefined optional fields from plan nodes', () => {
    expect(
      planNode({ id: '0', operation: 'Scan', relation: undefined, detail: {}, children: [] }),
    ).toEqual({
      id: '0',
      operation: 'Scan',
      detail: {},
      children: [],
    });
  });
});

describe('resolvedProfileFromUrl', () => {
  it('moves the password into secrets and keeps the database', () => {
    const resolved = resolvedProfileFromUrl('postgres://app:p%40ss@127.0.0.1:5433/sales', {
      options: { queryTimeoutMs: 1000 },
    });
    expect(resolved.secrets).toEqual({ password: 'p@ss' });
    expect(resolved.profile).toMatchObject({
      engine: 'postgres',
      endpoint: { kind: 'host', host: '127.0.0.1', port: 5433 },
      auth: { method: 'password', user: 'app', password: { id: 'password' } },
      tls: { mode: 'disable' },
      options: { defaultDatabase: 'sales', queryTimeoutMs: 1000 },
    });
    expect(JSON.stringify(resolved.profile)).not.toContain('p@ss');
    expect(resolvedProfileFromUrl('mariadb://root@localhost/x').profile.endpoint).toMatchObject({
      port: 3306,
    });
  });
});
