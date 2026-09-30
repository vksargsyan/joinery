import type { TypeDef } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { contextFor, resolveCompareOptions } from '../src';
import { partitionsOverlap } from '../src/diff/tables';
import { alterTypeInPlace, parseComposite, parseDomain, rebuildRisk } from '../src/diff/pg-types';

const ctx = contextFor(
  { engine: 'postgres', database: 'app', options: {}, schemas: [], extensions: [], capturedAt: '' },
  resolveCompareOptions(),
);

const domain = (definition: string): TypeDef => ({
  name: 'd',
  kind: 'domain',
  values: [],
  definition,
});
const composite = (definition: string): TypeDef => ({
  name: 'c',
  kind: 'composite',
  values: [],
  definition,
});

describe('parseDomain', () => {
  it('splits the base type, collation, default, NOT NULL and named checks', () => {
    expect(
      parseDomain(
        `CREATE DOMAIN "public"."d" AS character varying(20) COLLATE "C" DEFAULT 'x'::character varying NOT NULL CONSTRAINT "d_check" CHECK ((VALUE)::text <> ''::text) CONSTRAINT "d_len" CHECK (length((VALUE)::text) < 10)`,
      ),
    ).toEqual({
      base: 'character varying(20)',
      collation: 'C',
      default: "'x'::character varying",
      notNull: true,
      checks: [
        { name: 'd_check', text: "((VALUE)::text <> ''::text)" },
        { name: 'd_len', text: '(length((VALUE)::text) < 10)' },
      ],
    });
  });

  it('keeps DEFAULT NULL as the default expression and reads multi-word types', () => {
    expect(parseDomain('CREATE DOMAIN d AS timestamp with time zone DEFAULT NULL')).toEqual({
      base: 'timestamp with time zone',
      default: 'NULL',
      notNull: false,
      checks: [],
    });
  });
});

describe('parseComposite', () => {
  it('lists attributes with their types and collations', () => {
    expect(
      parseComposite(
        'CREATE TYPE "s"."c" AS ("a" integer, "Odd, name" numeric(5,2), b text COLLATE "C")',
      ),
    ).toEqual({
      attributes: [
        { name: 'a', type: 'integer' },
        { name: 'Odd, name', type: 'numeric(5,2)' },
        { name: 'b', type: 'text', collation: 'C' },
      ],
    });
  });
});

describe('alterTypeInPlace', () => {
  it('changes default, NOT NULL and checks of a domain with ALTER DOMAIN', () => {
    const change = alterTypeInPlace(
      '"public"."d"',
      domain(
        'CREATE DOMAIN d AS integer DEFAULT 1 NOT NULL CONSTRAINT d_check CHECK (VALUE > 1) CONSTRAINT d_new CHECK (VALUE < 9)',
      ),
      domain(
        'CREATE DOMAIN d AS integer CONSTRAINT d_check CHECK (VALUE > 0) CONSTRAINT d_old CHECK (VALUE <> 5)',
      ),
      ctx,
      ctx,
    );
    expect(change?.statements).toEqual([
      'ALTER DOMAIN "public"."d" SET DEFAULT 1',
      'ALTER DOMAIN "public"."d" DROP CONSTRAINT "d_check"',
      'ALTER DOMAIN "public"."d" DROP CONSTRAINT "d_old"',
      'ALTER DOMAIN "public"."d" SET NOT NULL',
      'ALTER DOMAIN "public"."d" ADD CONSTRAINT "d_check" CHECK (VALUE > 1)',
      'ALTER DOMAIN "public"."d" ADD CONSTRAINT "d_new" CHECK (VALUE < 9)',
    ]);
    expect(change?.warnings.map((w) => w.code)).toEqual(['may-fail', 'may-fail']);
  });

  it('needs a rebuild for a new base type or collation', () => {
    const target = domain('CREATE DOMAIN d AS varchar(10)');
    expect(
      alterTypeInPlace('d', domain('CREATE DOMAIN d AS varchar(20)'), target, ctx, ctx),
    ).toBeUndefined();
    expect(
      alterTypeInPlace('d', domain('CREATE DOMAIN d AS varchar(10) COLLATE "C"'), target, ctx, ctx),
    ).toBeUndefined();
    expect(rebuildRisk(domain('CREATE DOMAIN d AS varchar(5)'), target)?.lossy).toBe(true);
    expect(rebuildRisk(domain('CREATE DOMAIN d AS varchar(20)'), target)?.lossy).toBe(false);
  });

  it('adds and drops composite attributes in place when the order allows it', () => {
    const target = composite('CREATE TYPE c AS (a integer, b text, old text)');
    expect(
      alterTypeInPlace(
        'c',
        composite('CREATE TYPE c AS (a integer, b text, z numeric(5,2))'),
        target,
        ctx,
        ctx,
      ),
    ).toMatchObject({
      statements: ['ALTER TYPE c DROP ATTRIBUTE "old", ADD ATTRIBUTE "z" numeric(5,2)'],
      destructive: true,
    });
    // A new attribute in the middle, or a changed attribute type, needs the type rebuilt.
    expect(
      alterTypeInPlace(
        'c',
        composite('CREATE TYPE c AS (a integer, z int, b text, old text)'),
        target,
        ctx,
        ctx,
      ),
    ).toBeUndefined();
    expect(
      alterTypeInPlace(
        'c',
        composite('CREATE TYPE c AS (a bigint, b text, old text)'),
        target,
        ctx,
        ctx,
      ),
    ).toBeUndefined();
    expect(rebuildRisk(composite('CREATE TYPE c AS (a bigint, b text, old text)'), target)).toEqual(
      { lossy: false, messages: [] },
    );
    expect(
      rebuildRisk(composite('CREATE TYPE c AS (b text, a integer, old text)'), target),
    ).toBeUndefined();
  });
});

describe('partitionsOverlap', () => {
  it.each([
    [
      "FOR VALUES FROM ('2023-01-01') TO ('2024-01-01')",
      "FOR VALUES FROM (MINVALUE) TO ('2024-01-01')",
      true,
    ],
    [
      "FOR VALUES FROM ('2023-01-01') TO ('2024-01-01')",
      "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
      false,
    ],
    ['FOR VALUES FROM (10) TO (20)', 'FOR VALUES FROM (9) TO (MAXVALUE)', true],
    ['FOR VALUES FROM (10) TO (20)', 'FOR VALUES FROM (2) TO (10)', false],
    ["FOR VALUES IN ('de', 'fr')", "FOR VALUES IN ('it''s', 'fr')", true],
    ["FOR VALUES IN ('de', 'fr')", "FOR VALUES IN ('us')", false],
    ['FOR VALUES WITH (modulus 4, remainder 1)', 'FOR VALUES WITH (modulus 2, remainder 1)', true],
    ['FOR VALUES WITH (modulus 4, remainder 2)', 'FOR VALUES WITH (modulus 2, remainder 1)', false],
    ['DEFAULT', undefined, true],
    ['DEFAULT', "FOR VALUES IN ('x')", false],
    ['FOR VALUES FROM (1, 2) TO (3, 4)', 'FOR VALUES FROM (5, 6) TO (7, 8)', true],
  ] as const)('%s / %s', (a, b, expected) => {
    expect(partitionsOverlap(a, b)).toBe(expected);
    expect(partitionsOverlap(b, a)).toBe(expected);
  });
});
