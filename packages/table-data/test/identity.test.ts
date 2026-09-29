import { tableDefSchema } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  allColumnsIdentity,
  canEdit,
  describeRow,
  isInsertKey,
  rowIdentity,
  rowKeyAt,
  rowKeyOf,
} from '../src';
import { pgItems } from './fixtures';

const col = (name: string, nullable = false, dataType = 'integer') => ({
  name,
  dataType,
  nullable,
  ordinal: 1,
});

describe('rowIdentity', () => {
  it('prefers the primary key', () => {
    expect(rowIdentity(pgItems)).toEqual({
      kind: 'primary-key',
      name: 'items_pkey',
      columns: ['region', 'id'],
    });
  });

  it('falls back to the smallest NOT NULL unique key, skipping nullable, partial and expression keys', () => {
    const table = tableDefSchema.parse({
      name: 't',
      columns: [col('a'), col('b'), col('c', true), col('d')].map((c, i) => ({
        ...c,
        ordinal: i + 1,
      })),
      uniques: [{ name: 'u_ab', columns: ['a', 'b'] }],
      indexes: [
        { name: 'u_c', unique: true, columns: [{ name: 'c' }] },
        { name: 'u_partial', unique: true, columns: [{ name: 'a' }], where: 'd > 0' },
        { name: 'u_expr', unique: true, columns: [{ name: null, expression: 'lower(b)' }] },
        { name: 'u_d', unique: true, columns: [{ name: 'd' }] },
        { name: 'plain', columns: [{ name: 'a' }] },
      ],
    });
    expect(rowIdentity(table)).toEqual({ kind: 'unique', name: 'u_d', columns: ['d'] });
  });

  it('is none without a usable key', () => {
    const table = tableDefSchema.parse({
      name: 't',
      columns: [col('a', true)],
      indexes: [{ name: 'u_a', unique: true, columns: [{ name: 'a' }] }],
    });
    const identity = rowIdentity(table);
    expect(identity).toEqual({ kind: 'none', columns: [] });
    expect(canEdit(identity)).toBe(false);
  });
});

describe('allColumnsIdentity', () => {
  const table = tableDefSchema.parse({
    name: 'loose',
    columns: [
      { name: 'a', ordinal: 1, dataType: 'int', nullable: true },
      { name: 'f', ordinal: 2, dataType: 'float', nullable: true },
      { name: 'j', ordinal: 3, dataType: 'json', nullable: true },
      { name: 'b', ordinal: 4, dataType: 'blob', nullable: true },
      { name: 'g', ordinal: 5, dataType: 'geometry', nullable: true },
      { name: 't', ordinal: 6, dataType: 'longtext', nullable: true },
    ],
  });

  it('matches every column and warns about the unreliable ones', () => {
    const identity = allColumnsIdentity(table, { dialect: 'mysql' });
    expect(identity.kind).toBe('all-columns');
    expect(identity.columns).toEqual(['a', 'f', 'j', 'b', 't']);
    expect(identity.unreliable!.map((u) => u.column)).toEqual(['f', 'j', 'b', 'g', 't']);
    expect(identity.warning).toMatch(/no primary key or unique key/);
    expect(identity.warning).toMatch(/f: floating-point/);
    expect(canEdit(identity)).toBe(true);
  });

  it('keeps geometry on PostgreSQL, where it is compared as text', () => {
    const pg = tableDefSchema.parse({
      name: 'p',
      columns: [
        { name: 'p', ordinal: 1, dataType: 'point', nullable: true },
        { name: 'r', ordinal: 2, dataType: 'real', nullable: true },
      ],
    });
    const identity = allColumnsIdentity(pg, { dialect: 'postgres' });
    expect(identity.columns).toEqual(['p', 'r']);
    expect(allColumnsIdentity(pg).unreliable!.map((u) => u.column)).toEqual(['p', 'r']);
  });
});

describe('row keys', () => {
  const identity = rowIdentity(pgItems);

  it('distinguishes NULL, empty string and the text NULL, and ignores number vs bigint', () => {
    const keys = [null, '', 'NULL', 'N', 5, '5'].map((region) =>
      rowKeyOf(identity, { region, id: 1 }),
    );
    expect(new Set(keys).size).toBe(6);
    expect(rowKeyOf(identity, { region: 'a', id: 5 })).toBe(
      rowKeyOf(identity, { region: 'a', id: 5n }),
    );
    expect(rowKeyOf(identity, { region: 'a|b', id: 1 })).not.toBe(
      rowKeyOf(identity, { region: 'a', id: 1 }),
    );
    expect(rowKeyOf(identity, { region: new Uint8Array([1, 2]), id: 1 })).toBe('x0102|n1');
  });

  it('reads keys from row arrays and never collides with insert keys', () => {
    const key = rowKeyAt(identity, ['id', 'name', 'region'], [7, 'x', 'eu'])!;
    expect(key).toBe(rowKeyOf(identity, { region: 'eu', id: 7 }));
    expect(isInsertKey(key)).toBe(false);
    expect(isInsertKey('+1')).toBe(true);
    expect(rowKeyOf({ kind: 'none', columns: [] }, { a: 1 })).toBeNull();
  });

  it('describes rows for messages', () => {
    expect(describeRow(identity, { region: "o'x", id: 5 })).toBe("region = 'o''x', id = 5");
    const all = { kind: 'all-columns' as const, columns: ['a', 'b', 'c', 'd', 'e'] };
    expect(describeRow(all, { a: 1, b: null, c: new Uint8Array([255]), d: true, e: 2 })).toBe(
      'a = 1, b = NULL, c = 0xff, d = true, …',
    );
  });
});
