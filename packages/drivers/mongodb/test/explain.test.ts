import { readFileSync } from 'node:fs';

import type { PlanNode } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { normaliseExplain } from '../src';

/** Explain outputs recorded from MongoDB 7.0 (standalone) and 8.0 (replica set). */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/explain-${name}.json`, import.meta.url), 'utf8'));

function shape(node: PlanNode, depth = 0): string[] {
  const label = `${'  '.repeat(depth)}${node.operation}${node.relation ? ` on ${node.relation}` : ''}${node.index ? ` [${node.index}]` : ''}`;
  return [label, ...node.children.flatMap((child) => shape(child, depth + 1))];
}

function find(node: PlanNode, operation: string): PlanNode | undefined {
  if (node.operation === operation) return node;
  for (const child of node.children) {
    const found = find(child, operation);
    if (found) return found;
  }
  return undefined;
}

describe.each(['70', '80'])('normaliseExplain (MongoDB %s)', (version) => {
  it('flags a collection scan with its counts', () => {
    const { plan, summary } = normaliseExplain(fixture(`${version}-find-collscan-executionStats`));
    expect(shape(plan)).toEqual(['COLLSCAN on orders']);
    expect(plan).toMatchObject({
      id: '0',
      actualRows: 90,
      detail: { collectionScan: true, docsExamined: 500 },
    });
    expect(summary).toEqual({
      nReturned: 90,
      executionTimeMillis: 0,
      totalKeysExamined: 0,
      totalDocsExamined: 500,
      collectionScan: true,
      indexes: [],
    });
  });

  it('shows index scans with bounds and keys examined', () => {
    const { plan, summary } = normaliseExplain(
      fixture(`${version}-find-ixscan-sort-executionStats`),
    );
    expect(shape(plan)).toEqual([
      'LIMIT',
      '  PROJECTION_COVERED',
      '    IXSCAN on orders [status_amount]',
    ]);
    const scan = find(plan, 'IXSCAN')!;
    expect(scan.id).toBe('0.0.0');
    expect(scan.actualRows).toBe(5);
    expect(scan.detail).toMatchObject({ keysExamined: 5, direction: 'forward', isMultiKey: false });
    expect(JSON.parse(String(scan.detail['keyPattern']))).toEqual({ status: 1, amount: -1 });
    expect(String(scan.detail['indexBounds'])).toContain('"status"');
    expect(summary).toMatchObject({
      collectionScan: false,
      indexes: ['status_amount'],
      totalKeysExamined: 5,
    });
  });

  it('reads queryPlanner output without execution counts', () => {
    const { plan, summary } = normaliseExplain(fixture(`${version}-find-ixscan-sort-queryPlanner`));
    expect(shape(plan)).toEqual([
      'LIMIT',
      '  PROJECTION_COVERED',
      '    IXSCAN on orders [status_amount]',
    ]);
    expect(find(plan, 'IXSCAN')!.actualRows).toBeUndefined();
    expect(summary.nReturned).toBeUndefined();
  });

  it('keeps in-memory sorts and skips in the tree', () => {
    const { plan } = normaliseExplain(fixture(`${version}-find-sort-memory-executionStats`));
    expect(shape(plan)).toEqual(['SKIP', '  SORT', '    COLLSCAN on orders']);
    expect(plan.children[0]!.detail).toMatchObject({ memLimit: expect.any(Number) });
  });

  it('turns aggregation stages into a chain fed by the query plan', () => {
    const { plan, summary } = normaliseExplain(
      fixture(`${version}-aggregate-group-executionStats`),
    );
    const lines = shape(plan);
    expect(lines[0]).toBe('$sort');
    expect(lines.at(-1)).toBe(
      version === '80'
        ? '      IXSCAN on orders [status_amount]'
        : '        IXSCAN on orders [status_amount]',
    );
    // 8.0 pushes $group into the slot-based engine (GROUP, counts by planNodeId); 7.0 keeps a $group stage.
    expect(lines).toContain(version === '80' ? '  GROUP' : '  $group');
    const group = find(plan, version === '80' ? 'GROUP' : '$group')!;
    expect(group.actualRows).toBe(20);
    const fetch = find(plan, 'FETCH')!;
    expect(fetch.actualRows).toBe(167);
    expect(fetch.detail['docsExamined']).toBe(167);
    expect(summary).toMatchObject({
      totalKeysExamined: 167,
      totalDocsExamined: 167,
      indexes: ['status_amount'],
    });
  });

  it('shows $lookup, $facet sub-pipelines and scans inside the pipeline', () => {
    const { plan, summary } = normaliseExplain(
      fixture(`${version}-aggregate-lookup-executionStats`),
    );
    expect(shape(plan)).toEqual([
      '$facet',
      '  $project',
      '    $lookup on customers',
      '      PROJECTION_SIMPLE',
      '        COLLSCAN on orders',
      '  $project on a',
      '    $group',
      '      $internalFacetTeeConsumer',
    ]);
    const lookup = find(plan, '$lookup')!;
    expect(lookup.detail).toMatchObject({
      totalDocsExamined: 52,
      indexesUsed: '_id_',
      collectionScans: 0,
    });
    expect(summary).toMatchObject({ collectionScan: true, indexes: ['_id_'] });
  });
});

describe('normaliseExplain edge cases', () => {
  it('handles sharded and unknown output', () => {
    const sharded = normaliseExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { shardName: 'shard0', winningPlan: { stage: 'COLLSCAN' } },
            { shardName: 'shard1', winningPlan: { stage: 'IXSCAN', indexName: 'a_1' } },
          ],
        },
      },
    });
    expect(shape(sharded.plan)).toEqual([
      'SHARD_MERGE',
      '  shard on shard0',
      '    COLLSCAN',
      '  shard on shard1',
      '    IXSCAN [a_1]',
    ]);
    expect(sharded.summary).toMatchObject({ collectionScan: true, indexes: ['a_1'] });
    expect(normaliseExplain(null).plan.operation).toBe('unknown');
  });
});
