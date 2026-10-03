import type { PlanNode } from '@querybara/core';

/**
 * The visual explain's view model (spec §6: plans render as a node tree with cost and row
 * estimates, and the slowest node is highlighted). Pure: it reads a normalised PlanNode tree
 * (PostgreSQL EXPLAIN JSON, MySQL JSON or EXPLAIN ANALYZE, MariaDB ANALYZE) and works out per
 * node what the tree shows — totals over loops, the node's own share of time and cost, row
 * misestimates, buffers — and which node to highlight.
 *
 * Times and rows in PlanNode are per loop and include the node's children, as the servers report
 * them; a node's own ("self") figure is its total minus its children's totals, never below zero.
 */

/** Estimates this many times off (either way) are flagged. */
export const MISESTIMATE_FACTOR = 10;

export interface Misestimate {
  /** How many times off: actual / estimate when under-estimated, estimate / actual when over. */
  readonly factor: number;
  /** `under`: more rows came back than planned; `over`: fewer. */
  readonly direction: 'under' | 'over';
}

/** PostgreSQL BUFFERS figures of a node (blocks), when EXPLAIN reported them. */
export interface BufferCounts {
  readonly sharedHit?: number;
  readonly sharedRead?: number;
  readonly sharedDirtied?: number;
  readonly sharedWritten?: number;
  readonly localHit?: number;
  readonly localRead?: number;
  readonly tempRead?: number;
  readonly tempWritten?: number;
}

export interface PlanRow {
  readonly node: PlanNode;
  readonly depth: number;
  readonly parentId: string | undefined;
  /** Rows produced over every loop (actual rows × loops). */
  readonly totalRows: number | undefined;
  /** Time over every loop, children included (actual time × loops), in ms. */
  readonly totalTimeMs: number | undefined;
  /** Time spent in this node alone, in ms. */
  readonly selfTimeMs: number | undefined;
  /** Cost of this node alone (its total cost minus its children's). */
  readonly selfCost: number | undefined;
  readonly misestimate: Misestimate | undefined;
  readonly buffers: BufferCounts | undefined;
  /** ANALYZE ran and this node never did (a branch the executor skipped). */
  readonly neverExecuted: boolean;
}

export interface PlanModel {
  /** Every node, depth first, parents before children. */
  readonly rows: readonly PlanRow[];
  readonly byId: ReadonlyMap<string, PlanRow>;
  /** ANALYZE figures are present: actual rows, times, loops. */
  readonly analyzed: boolean;
  /**
   * The node to highlight: the most time spent in it when the plan was analyzed, otherwise the
   * highest cost of its own. Undefined for a plan with neither.
   */
  readonly hottestId: string | undefined;
  readonly hottestBy: 'time' | 'cost' | undefined;
  /** The measure the hottest node leads by, to draw every node's share against. */
  readonly peak: number | undefined;
  readonly summary: PlanSummary;
}

export interface PlanSummary {
  readonly planningMs: number | undefined;
  readonly executionMs: number | undefined;
  readonly totalCost: number | undefined;
  /** Rows the root returned (estimated when not analyzed). */
  readonly rows: number | undefined;
  readonly estimatedRows: number | undefined;
  /** MySQL could not analyze the statement and gave the estimated plan instead. */
  readonly analyzeUnavailable: boolean;
  /** Nodes whose row estimate is off by MISESTIMATE_FACTOR or more. */
  readonly misestimates: number;
}

function numberDetail(node: PlanNode, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = node.detail[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function times(value: number | undefined, loops: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value * (loops ?? 1);
}

/** Whether actual and estimated rows differ by `MISESTIMATE_FACTOR` or more (both per loop). */
export function misestimateOf(
  estimated: number | undefined,
  actual: number | undefined,
): Misestimate | undefined {
  if (estimated === undefined || actual === undefined) return undefined;
  // A zero on either side counts as one row, so "0 of 1 planned" is not a misestimate.
  const e = Math.max(estimated, 1);
  const a = Math.max(actual, 1);
  if (a >= e * MISESTIMATE_FACTOR) return { factor: a / e, direction: 'under' };
  if (e >= a * MISESTIMATE_FACTOR) return { factor: e / a, direction: 'over' };
  return undefined;
}

function buffersOf(node: PlanNode): BufferCounts | undefined {
  const entries: [keyof BufferCounts, string][] = [
    ['sharedHit', 'Shared Hit Blocks'],
    ['sharedRead', 'Shared Read Blocks'],
    ['sharedDirtied', 'Shared Dirtied Blocks'],
    ['sharedWritten', 'Shared Written Blocks'],
    ['localHit', 'Local Hit Blocks'],
    ['localRead', 'Local Read Blocks'],
    ['tempRead', 'Temp Read Blocks'],
    ['tempWritten', 'Temp Written Blocks'],
  ];
  const counts: Partial<Record<keyof BufferCounts, number>> = {};
  let any = false;
  for (const [field, key] of entries) {
    const value = numberDetail(node, key);
    if (value !== undefined) {
      counts[field] = value;
      any = true;
    }
  }
  return any ? counts : undefined;
}

/** Builds the tree's view model. */
export function buildPlanModel(root: PlanNode): PlanModel {
  const rows: PlanRow[] = [];
  const analyzed = hasActuals(root);
  const visit = (node: PlanNode, depth: number, parentId: string | undefined): void => {
    const loops = node.loops;
    const neverExecuted =
      analyzed && (node.detail['never_executed'] === true || (loops !== undefined && loops === 0));
    const totalTimeMs = times(node.actualTimeMs, loops);
    const childTime = node.children.reduce<number | undefined>((sum, child) => {
      const t = times(child.actualTimeMs, child.loops);
      return t === undefined ? sum : (sum ?? 0) + t;
    }, undefined);
    const childCost = node.children.reduce<number | undefined>(
      (sum, child) => (child.totalCost === undefined ? sum : (sum ?? 0) + child.totalCost),
      undefined,
    );
    rows.push({
      node,
      depth,
      parentId,
      totalRows: times(node.actualRows, loops),
      totalTimeMs,
      selfTimeMs:
        totalTimeMs === undefined ? undefined : Math.max(0, totalTimeMs - (childTime ?? 0)),
      selfCost:
        node.totalCost === undefined ? undefined : Math.max(0, node.totalCost - (childCost ?? 0)),
      misestimate: neverExecuted ? undefined : misestimateOf(node.estimatedRows, node.actualRows),
      buffers: buffersOf(node),
      neverExecuted,
    });
    for (const child of node.children) visit(child, depth + 1, node.id);
  };
  visit(root, 0, undefined);

  let hottestId: string | undefined;
  let hottestBy: PlanModel['hottestBy'];
  let peak: number | undefined;
  const pick = (measure: (row: PlanRow) => number | undefined): void => {
    for (const row of rows) {
      const value = measure(row);
      if (value === undefined || value <= 0) continue;
      if (peak === undefined || value > peak) {
        peak = value;
        hottestId = row.node.id;
      }
    }
  };
  if (analyzed) {
    pick((row) => row.selfTimeMs);
    if (hottestId !== undefined) hottestBy = 'time';
  }
  if (hottestId === undefined) {
    pick((row) => row.selfCost);
    if (hottestId !== undefined) hottestBy = 'cost';
  }

  const rootRow = rows[0]!;
  return {
    rows,
    byId: new Map(rows.map((row) => [row.node.id, row])),
    analyzed,
    hottestId,
    hottestBy,
    peak,
    summary: {
      planningMs: numberDetail(root, 'Planning Time', 'query_optimization.r_total_time_ms'),
      executionMs:
        numberDetail(root, 'Execution Time') ??
        (analyzed ? (rootRow.totalTimeMs ?? undefined) : undefined),
      totalCost: root.totalCost,
      rows: analyzed ? rootRow.totalRows : root.estimatedRows,
      estimatedRows: root.estimatedRows,
      analyzeUnavailable: root.detail['analyze_unavailable'] === true,
      misestimates: rows.filter((row) => row.misestimate !== undefined).length,
    },
  };
}

function hasActuals(node: PlanNode): boolean {
  return (
    node.actualRows !== undefined ||
    node.actualTimeMs !== undefined ||
    node.children.some(hasActuals)
  );
}

/** The share (0..1) of the hottest node's measure a row has, for its bar. */
export function shareOf(model: PlanModel, row: PlanRow): number {
  if (model.peak === undefined || model.peak <= 0) return 0;
  const value = model.hottestBy === 'time' ? row.selfTimeMs : row.selfCost;
  return value === undefined ? 0 : Math.min(1, value / model.peak);
}

/** The rows shown when some nodes are collapsed: descendants of a collapsed node are left out. */
export function visibleRows(model: PlanModel, collapsed: ReadonlySet<string>): PlanRow[] {
  const shown: PlanRow[] = [];
  const hidden = new Set<string>();
  for (const row of model.rows) {
    if (row.parentId !== undefined && (hidden.has(row.parentId) || collapsed.has(row.parentId))) {
      hidden.add(row.node.id);
      continue;
    }
    shown.push(row);
  }
  return shown;
}

/** "1.2 ms", "340 ms", "2.41 s"; plan times are fractional milliseconds. */
export function formatPlanTime(ms: number): string {
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Costs and row counts as the servers print them, without noise. */
export function formatPlanNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
