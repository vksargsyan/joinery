import { readFileSync } from 'node:fs';

import type { PlanNode } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { normaliseMysqlJsonPlan, normaliseMysqlTreePlan } from '../src';

const text = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string): unknown => JSON.parse(text(name));

function outline(node: PlanNode, depth = 0): string[] {
  const label = [
    node.operation,
    node.relation && `on ${node.relation}`,
    node.index && `using ${node.index}`,
  ]
    .filter(Boolean)
    .join(' ');
  return [`${'  '.repeat(depth)}${label}`].concat(
    node.children.flatMap((c) => outline(c, depth + 1)),
  );
}

function find(node: PlanNode, relation: string): PlanNode | undefined {
  if (node.relation === relation) return node;
  for (const child of node.children) {
    const found = find(child, relation);
    if (found) return found;
  }
  return undefined;
}

describe('MySQL EXPLAIN FORMAT=JSON (version 1)', () => {
  it('turns query blocks, wrappers and tables into a tree', () => {
    const plan = normaliseMysqlJsonPlan(json('mysql-explain-v1.json'));
    expect(outline(plan)).toEqual([
      'Select #1',
      '  Sort (filesort)',
      '    Group',
      '      Nested loop',
      '        Full table scan on c',
      '        Non-unique key lookup on o using orders_customer_fk',
    ]);
    expect(plan.totalCost).toBe(4.75);
    const orders = find(plan, 'o')!;
    expect(orders).toMatchObject({ estimatedRows: 1, totalCost: 1.6 });
    expect(orders.detail).toMatchObject({
      access_type: 'ref',
      attached_condition: '(`shop`.`o`.`id` > 0)',
      used_key_parts: 'customer_id',
      'cost_info.read_cost': '0.75',
    });
    expect(plan.id).toBe('0');
    expect(plan.children[0]!.id).toBe('0.0');
  });

  it('follows derived tables and unions', () => {
    const plan = normaliseMysqlJsonPlan(json('mysql-explain-subquery.json'));
    expect(outline(plan)).toEqual([
      'Select #1',
      '  Full table scan on d',
      '    Materialize',
      '      Query block',
      '        Union on <union2,3>',
      '          Union parts',
      '            No tables used',
      '            No tables used',
    ]);
  });
});

describe('MySQL JSON version 2 (iterator tree)', () => {
  it('maps operations, estimates and actuals', () => {
    const plan = normaliseMysqlJsonPlan(json('mysql-explain-v2.json'));
    expect(outline(plan)).toEqual([
      'Nested loop inner join',
      '  Table scan on c on c',
      '  Index lookup on o using orders_customer_fk (customer_id = c.id) on o using orders_customer_fk',
    ]);
    expect(plan).toMatchObject({
      totalCost: 1.6,
      estimatedRows: 3,
      actualRows: 3,
      loops: 1,
      actualTimeMs: 0.061,
    });
    expect(plan.children[1]).toMatchObject({ loops: 3, actualRows: 1, id: '0.1' });
    expect(plan.detail['join_algorithm']).toBe('nested_loop');
  });
});

describe('MySQL EXPLAIN ANALYZE (tree text)', () => {
  it('parses indentation, costs and actual timings', () => {
    const plan = normaliseMysqlTreePlan(text('mysql-analyze.txt'));
    expect(outline(plan)).toEqual([
      'Sort: count(0) DESC',
      '  Table scan on <temporary>',
      '    Aggregate using temporary table',
      '      Nested loop inner join',
      '        Table scan on c',
      '        Index lookup on o using orders_customer_fk (customer_id=c.id)',
      '      Select #2 (subquery in condition; run only once)',
      '        Filter: (r.id > 10)',
    ]);
    expect(plan).toMatchObject({ actualTimeMs: 0.153, actualRows: 3, loops: 1 });
    expect(plan.totalCost).toBeUndefined();
    const join = plan.children[0]!.children[0]!.children[0]!;
    expect(join).toMatchObject({ totalCost: 1.6, estimatedRows: 3, actualTimeMs: 0.0612 });
    expect(join.children[1]).toMatchObject({
      startupCost: 0.25,
      totalCost: 0.283,
      loops: 3,
      id: '0.0.0.0.1',
    });
    const filter = plan.children[0]!.children[0]!.children[1]!.children[0]!;
    expect(filter.detail['never_executed']).toBe(true);
    expect(filter.actualRows).toBeUndefined();
  });

  it('rejects text without plan lines', () => {
    expect(() => normaliseMysqlTreePlan('nothing here')).toThrow(
      expect.objectContaining({ code: 'INTERNAL' }),
    );
  });
});

describe('MariaDB EXPLAIN / ANALYZE FORMAT=JSON', () => {
  it('reads MariaDB node names and row estimates', () => {
    const plan = normaliseMysqlJsonPlan(json('mariadb-explain.json'));
    const lines = outline(plan).map((l) => l.trim());
    expect(lines[0]).toBe('Select #1');
    expect(lines).toContain('Filesort');
    expect(lines).toContain('Temporary table');
    expect(find(plan, 'c2')).toMatchObject({ operation: 'Full table scan', estimatedRows: 10 });
    expect(find(plan, 'o2')).toMatchObject({ operation: 'Non-unique key lookup', index: 'cid' });
  });

  it('turns cumulative r_* timings into per-loop actuals', () => {
    const plan = normaliseMysqlJsonPlan(json('mariadb-analyze.json'));
    expect(plan.loops).toBe(1);
    expect(plan.actualTimeMs).toBeGreaterThan(0);
    expect(plan.detail['query_optimization.r_total_time_ms']).toEqual(expect.any(Number));
    const raw = json('mariadb-analyze.json') as {
      query_block: {
        filesort: { temporary_table: { nested_loop: { table: Record<string, number> }[] } };
      };
    };
    const orders = raw.query_block.filesort.temporary_table.nested_loop[1]!.table;
    const node = find(plan, 'o2')!;
    expect(node.loops).toBe(orders['r_loops']);
    expect(node.actualRows).toBe(orders['r_rows']);
    expect(node.actualTimeMs).toBeCloseTo(
      (orders['r_table_time_ms']! + orders['r_other_time_ms']!) / orders['r_loops']!,
    );
  });

  it('follows unions and subqueries', () => {
    const plan = normaliseMysqlJsonPlan(json('mariadb-union.json'));
    const relations: string[] = [];
    const walk = (node: PlanNode): void => {
      if (node.relation) relations.push(node.relation);
      node.children.forEach(walk);
    };
    walk(plan);
    expect(relations).toEqual(expect.arrayContaining(['o2', 'c2']));
  });

  it('rejects output without a query block', () => {
    expect(() => normaliseMysqlJsonPlan({})).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
    expect(() => normaliseMysqlJsonPlan('x')).toThrow(
      expect.objectContaining({ code: 'INTERNAL' }),
    );
  });
});
