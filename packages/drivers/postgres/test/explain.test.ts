import { readFileSync } from 'node:fs';

import type { PlanNode } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { normalisePgPlan } from '../src';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function flatten(node: PlanNode, depth = 0): string[] {
  return [
    `${'  '.repeat(depth)}${node.operation}${node.relation ? ` on ${node.relation}` : ''}`,
  ].concat(node.children.flatMap((child) => flatten(child, depth + 1)));
}

describe('normalisePgPlan', () => {
  it('names nodes like the text format and keeps the tree', () => {
    const plan = normalisePgPlan(fixture('explain.json'));
    expect(flatten(plan)).toEqual([
      'Limit',
      '  Sort',
      '    HashAggregate',
      '      Hash Left Join',
      '        Seq Scan on fx_o',
      '        Hash',
      '          Seq Scan on fx_c',
    ]);
    expect(plan.operation).toBe('Limit');
    expect(plan.id).toBe('0');
    expect(plan.children[0]!.id).toBe('0.0');
    expect(plan.startupCost).toBeGreaterThan(0);
    expect(plan.totalCost).toBeGreaterThanOrEqual(plan.startupCost!);
    expect(plan.estimatedRows).toBe(5);
    expect(plan.actualRows).toBeUndefined();
  });

  it('carries actual rows, time, loops and top-level timings under ANALYZE', () => {
    const plan = normalisePgPlan(fixture('explain-analyze.json'));
    expect(plan.actualRows).toBe(5);
    expect(plan.loops).toBe(1);
    expect(plan.actualTimeMs).toBeGreaterThan(0);
    expect(plan.detail['Execution Time']).toEqual(expect.any(Number));
    expect(plan.detail['Planning Time']).toEqual(expect.any(Number));
    const scan = (function find(node: PlanNode): PlanNode | undefined {
      if (node.relation === 'fx_o') return node;
      for (const child of node.children) {
        const found = find(child);
        if (found) return found;
      }
      return undefined;
    })(plan);
    expect(scan).toMatchObject({ operation: 'Seq Scan', actualRows: expect.any(Number) });
    expect(scan!.detail['Filter']).toBe('(v > 10)');
    expect(scan!.detail['Shared Hit Blocks']).toEqual(expect.any(Number));
    expect(scan!.detail['Relation Name']).toBeUndefined();
  });

  it('names backward index scans and their index', () => {
    const plan = normalisePgPlan(fixture('explain-index.json'));
    expect(plan.children[0]).toMatchObject({
      operation: 'Index Scan Backward',
      relation: 'fx_o',
      index: 'fx_o_pkey',
    });
  });

  it('builds join and aggregate names from their attributes', () => {
    const plan = normalisePgPlan([
      {
        Plan: {
          'Node Type': 'Aggregate',
          Strategy: 'Sorted',
          Plans: [
            { 'Node Type': 'Nested Loop', 'Join Type': 'Anti', Plans: [] },
            { 'Node Type': 'Merge Join', 'Join Type': 'Full' },
            {
              'Node Type': 'ModifyTable',
              Operation: 'Update',
              'Relation Name': 't',
              Schema: 'app',
            },
            { 'Node Type': 'SetOp', Strategy: 'Hashed', Command: 'Intersect' },
            { 'Node Type': 'CTE Scan', 'CTE Name': 'recent' },
          ],
        },
      },
    ]);
    expect(plan.operation).toBe('GroupAggregate');
    expect(plan.children.map((c) => [c.operation, c.relation])).toEqual([
      ['Nested Loop Anti Join', undefined],
      ['Merge Full Join', undefined],
      ['Update', 'app.t'],
      ['HashSetOp Intersect', undefined],
      ['CTE Scan', 'recent'],
    ]);
  });

  it('rejects output without a plan', () => {
    expect(() => normalisePgPlan([{}])).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});
