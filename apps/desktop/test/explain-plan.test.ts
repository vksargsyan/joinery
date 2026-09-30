import { readFileSync } from 'node:fs';

import type { PlanNode } from '@joinery/core';
import {
  normaliseMysqlJsonPlan,
  normaliseMysqlTreePlan,
  parseExplainJson,
} from '@joinery/driver-mysql';
import { normalisePgPlan } from '@joinery/driver-postgres';
import { describe, expect, it } from 'vitest';

import {
  buildPlanModel,
  formatPlanTime,
  misestimateOf,
  shareOf,
  visibleRows,
} from '../src/renderer/src/state/explain/model';
import { pickExplainStatement } from '../src/renderer/src/state/explain/statement';
import { buildRunPlan, type RunPlan } from '../src/renderer/src/state/run-plan';

/**
 * The visual explain's view model on real plans from each engine (the drivers' fixtures, through
 * the drivers' own normalisers): totals over loops, each node's own time and cost, the node to
 * highlight, misestimates and buffers.
 */

const fixture = (driver: 'postgres' | 'mysql', name: string): string =>
  readFileSync(
    new URL(`../../../packages/drivers/${driver}/test/fixtures/${name}`, import.meta.url),
    'utf8',
  );

function node(partial: Partial<PlanNode> & { id: string; operation: string }): PlanNode {
  return { detail: {}, children: [], ...partial };
}

describe('PostgreSQL plans', () => {
  it('highlights the most expensive node of an estimated plan by its own cost', () => {
    const model = buildPlanModel(normalisePgPlan(JSON.parse(fixture('postgres', 'explain.json'))));
    expect(model.analyzed).toBe(false);
    expect(model.hottestBy).toBe('cost');
    const hottest = model.byId.get(model.hottestId!)!;
    // Seq Scan on fx_o costs 90.5 of its own; every other node adds far less.
    expect(hottest.node.operation).toBe('Seq Scan');
    expect(hottest.node.relation).toMatch(/fx_o$/);
    expect(hottest.selfCost).toBeCloseTo(90.5);
    expect(model.summary).toMatchObject({ totalCost: 133.13, rows: 5, misestimates: 0 });
    expect(model.rows.map((r) => [r.node.operation, r.depth])).toEqual([
      ['Limit', 0],
      ['Sort', 1],
      ['HashAggregate', 2],
      ['Hash Left Join', 3],
      ['Seq Scan', 4],
      ['Hash', 4],
      ['Seq Scan', 5],
    ]);
    expect(model.rows.every((r) => r.totalTimeMs === undefined)).toBe(true);
  });

  it('highlights the slowest node of an analyzed plan by its own time, with buffers', () => {
    const model = buildPlanModel(
      normalisePgPlan(JSON.parse(fixture('postgres', 'explain-analyze.json'))),
    );
    expect(model.analyzed).toBe(true);
    expect(model.hottestBy).toBe('time');
    const hottest = model.byId.get(model.hottestId!)!;
    // The aggregate spends 1.797 − 1.131 ms itself; the hash join 1.131 − (0.486 + 0.018).
    expect(hottest.node.operation).toBe('HashAggregate');
    expect(hottest.selfTimeMs).toBeCloseTo(0.666, 3);
    expect(model.summary).toMatchObject({ planningMs: 0.505, executionMs: 1.886, rows: 5 });
    const limit = model.rows[0]!;
    expect(limit.buffers).toMatchObject({ sharedHit: 32, sharedRead: 0 });
    // The Sort planned 50 rows and returned 5: off by 10.
    expect(model.rows[1]!.misestimate).toEqual({ factor: 10, direction: 'over' });
    expect(shareOf(model, hottest)).toBe(1);
    expect(shareOf(model, model.rows[0]!)).toBeLessThan(0.01);
  });
});

describe('MySQL and MariaDB plans', () => {
  it('reads EXPLAIN ANALYZE tree output: loops, own time, never executed', () => {
    const model = buildPlanModel(normaliseMysqlTreePlan(fixture('mysql', 'mysql-analyze.txt')));
    expect(model.analyzed).toBe(true);
    const lookup = model.rows.find((r) => r.node.operation.startsWith('Index lookup on o'))!;
    expect(lookup.node.loops).toBe(3);
    expect(lookup.totalTimeMs).toBeCloseTo(0.0306, 4);
    expect(lookup.totalRows).toBe(3);
    const filter = model.rows.find((r) => r.node.operation.startsWith('Filter'))!;
    expect(filter.neverExecuted).toBe(true);
    expect(filter.misestimate).toBeUndefined();
    const hottest = model.byId.get(model.hottestId!)!;
    expect(hottest.node.operation).toBe('Aggregate using temporary table');
    expect(model.summary.executionMs).toBeCloseTo(0.153, 3);
  });

  it('reads EXPLAIN FORMAT=JSON: version 1 estimated, version 2 with ANALYZE figures', () => {
    const v1 = buildPlanModel(
      normaliseMysqlJsonPlan(parseExplainJson(fixture('mysql', 'mysql-explain-v1.json'))),
    );
    expect(v1.analyzed).toBe(false);
    expect(v1.hottestBy).toBe('cost');
    expect(v1.rows.some((r) => r.node.relation !== undefined)).toBe(true);
    const v2 = buildPlanModel(
      normaliseMysqlJsonPlan(parseExplainJson(fixture('mysql', 'mysql-explain-v2.json'))),
    );
    expect(v2.analyzed).toBe(true);
    expect(v2.hottestBy).toBe('time');
    expect(v2.rows.some((r) => r.totalRows !== undefined)).toBe(true);
  });

  it('reads MariaDB ANALYZE FORMAT=JSON with runtime figures', () => {
    const model = buildPlanModel(
      normaliseMysqlJsonPlan(parseExplainJson(fixture('mysql', 'mariadb-analyze.json'))),
    );
    expect(model.analyzed).toBe(true);
    expect(model.rows.some((r) => r.node.actualRows !== undefined)).toBe(true);
    expect(model.hottestId).toBeDefined();
  });

  it('says when the server fell back to the estimated plan', () => {
    const model = buildPlanModel(
      node({ id: '0', operation: 'Update', detail: { analyze_unavailable: true } }),
    );
    expect(model.summary.analyzeUnavailable).toBe(true);
    expect(model.hottestId).toBeUndefined();
  });
});

describe('plan model details', () => {
  it('flags estimates ten or more times off, either way, treating zero as one row', () => {
    expect(misestimateOf(100, 1_000)).toEqual({ factor: 10, direction: 'under' });
    expect(misestimateOf(5_000, 12)).toEqual({ factor: 5_000 / 12, direction: 'over' });
    expect(misestimateOf(1, 0)).toBeUndefined();
    expect(misestimateOf(0, 9)).toBeUndefined();
    expect(misestimateOf(50, 60)).toBeUndefined();
    expect(misestimateOf(undefined, 60)).toBeUndefined();
  });

  it('never gives a node negative time of its own (parallel children overlap)', () => {
    const model = buildPlanModel(
      node({
        id: '0',
        operation: 'Gather',
        actualTimeMs: 10,
        actualRows: 3,
        loops: 1,
        children: [node({ id: '0.0', operation: 'Parallel Seq Scan', actualTimeMs: 8, loops: 3 })],
      }),
    );
    expect(model.byId.get('0')!.selfTimeMs).toBe(0);
    expect(model.byId.get('0.0')!.totalTimeMs).toBe(24);
    expect(model.hottestId).toBe('0.0');
  });

  it('hides the descendants of collapsed nodes', () => {
    const model = buildPlanModel(normalisePgPlan(JSON.parse(fixture('postgres', 'explain.json'))));
    const join = model.rows.find((r) => r.node.operation === 'Hash Left Join')!;
    const shown = visibleRows(model, new Set([join.node.id]));
    expect(shown.map((r) => r.node.operation)).toEqual([
      'Limit',
      'Sort',
      'HashAggregate',
      'Hash Left Join',
    ]);
  });

  it('formats plan times to a useful precision', () => {
    expect(formatPlanTime(0.0123)).toBe('0.012 ms');
    expect(formatPlanTime(4.5)).toBe('4.50 ms');
    expect(formatPlanTime(340.26)).toBe('340.3 ms');
    expect(formatPlanTime(2410)).toBe('2.41 s');
  });
});

describe('the statement to explain', () => {
  const plan = (text: string, selection?: { start: number; end: number }): RunPlan =>
    buildRunPlan({
      text,
      dialect: 'postgres',
      mode: selection ? 'selection' : 'statement',
      cursor: 0,
      ...(selection ? { selection } : {}),
      policy: { readOnly: false, production: false },
    });

  it('takes the statement at the cursor, or exactly one selected statement', () => {
    const picked = pickExplainStatement(plan('SELECT 1; SELECT 2'));
    expect(picked).toMatchObject({ statement: { text: 'SELECT 1' } });
    const text = 'SELECT 1; DELETE FROM t';
    expect(pickExplainStatement(plan(text, { start: 0, end: text.length }))).toMatchObject({
      error: expect.stringContaining('one statement'),
    });
  });

  it('refuses an EXPLAIN statement and an empty editor', () => {
    expect(pickExplainStatement(plan('EXPLAIN SELECT 1'))).toMatchObject({
      error: expect.stringContaining('EXPLAIN already'),
    });
    expect(pickExplainStatement(plan('   '))).toMatchObject({
      error: expect.stringContaining('cursor'),
    });
  });
});
