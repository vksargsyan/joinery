import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaSnapshotSchema } from '@querybara/core';
import type { SchemaSnapshot } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { compareSchemas, generateScript, normalizeSnapshot } from '../src';
import type { CompareOptions } from '../src';

/**
 * Golden tests (spec §20): each directory under test/golden holds a source and a target
 * snapshot (written to the producer conventions; PostgreSQL ones were captured from real
 * databases built from the neighbouring source.sql/target.sql), optional compare options, and
 * the expected script with every operation included. Regenerate with UPDATE_GOLDEN=1.
 */

const root = fileURLToPath(new URL('./golden', import.meta.url));
const update = process.env.UPDATE_GOLDEN === '1';

interface GoldenCase {
  readonly name: string;
  readonly source: SchemaSnapshot;
  readonly target: SchemaSnapshot;
  readonly options: CompareOptions;
}

function load(name: string): GoldenCase {
  const dir = join(root, name);
  const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  return {
    name,
    source: schemaSnapshotSchema.parse(read('source.json')),
    target: schemaSnapshotSchema.parse(read('target.json')),
    options: existsSync(join(dir, 'options.json')) ? (read('options.json') as CompareOptions) : {},
  };
}

const cases = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => load(entry.name));

describe('golden scripts', () => {
  it('has fixtures for both engine families', () => {
    expect(cases.filter((c) => c.name.startsWith('pg-')).length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((c) => c.name.startsWith('my-')).length).toBeGreaterThanOrEqual(10);
  });

  for (const golden of cases) {
    it(golden.name, () => {
      const { diff } = compareSchemas(golden.source, golden.target, golden.options);
      const script = generateScript(diff, { include: 'all' });
      const file = join(root, golden.name, 'script.sql');
      if (update || !existsSync(file)) writeFileSync(file, script.text);
      expect(script.text).toBe(readFileSync(file, 'utf8'));
      expect(diff.identical).toBe(diff.operations.length === 0);
    });
  }
});

describe('invariants over every fixture', () => {
  for (const golden of cases) {
    for (const side of ['source', 'target'] as const) {
      const snapshot = golden[side];

      it(`${golden.name}: diff(${side}, ${side}) is empty`, () => {
        const { diff, summary } = compareSchemas(snapshot, snapshot, golden.options);
        expect(diff.operations.map((op) => op.id)).toEqual([]);
        expect(summary.total).toBe(0);
        expect(generateScript(diff).statements).toEqual([]);
      });

      it(`${golden.name}: normalising the ${side} is idempotent`, () => {
        const once = normalizeSnapshot(snapshot, golden.options);
        expect(normalizeSnapshot(once, golden.options)).toEqual(once);
      });
    }

    it(`${golden.name}: default selection never keeps an operation whose dependency is unselected`, () => {
      const { diff } = compareSchemas(golden.source, golden.target, golden.options);
      const selected = new Set(diff.operations.filter((op) => op.selected).map((op) => op.id));
      for (const op of diff.operations) {
        if (!op.selected) continue;
        for (const dep of op.dependsOn)
          expect(selected.has(dep), `${op.id} needs ${dep}`).toBe(true);
        expect(op.destructive).toBe(false);
      }
    });
  }
});
