import type { PlanNode } from '@querybara/core';
import {
  isRecord,
  planNode,
  scalarDetail,
  toNumber,
  type PlanDetail,
} from '@querybara/driver-sql-base';
import type { ExplainSummary } from '@querybara/mongo-tools';

/**
 * Explain output → PlanNode tree (spec §9, visual explain for queryPlanner and executionStats).
 *
 * - find (and aggregations fully pushed down): the winning plan's stage tree. With
 *   executionStats the classic engine's `executionStages` carries per-stage counts; for the
 *   slot-based engine (explainVersion 2) the tree is `winningPlan.queryPlan` and each node's
 *   counts come from the SBE stages with the same planNodeId.
 * - aggregate: one node per pipeline stage, each fed by the previous one; the `$cursor` stage
 *   becomes its query plan, and `$facet` sub-pipelines hang below their facet.
 * - sharded: SHARD_MERGE / shards become children named after the shard.
 *
 * Nodes carry `actualRows` (nReturned) and `actualTimeMs` (executionTimeMillisEstimate, which
 * includes the inputs); keys and documents examined, index bounds and filters go in `detail`.
 * A COLLSCAN (or a $lookup that scans) is flagged with `detail.collectionScan = true`.
 */

type Doc = Record<string, unknown>;

const CHILD_KEYS = ['inputStage', 'outerStage', 'innerStage', 'thenStage', 'elseStage'] as const;
const OMIT = new Set([
  'stage',
  'inputStage',
  'inputStages',
  'outerStage',
  'innerStage',
  'thenStage',
  'elseStage',
  'shards',
  'indexName',
  'nReturned',
  'executionTimeMillisEstimate',
  'planNodeId',
]);
/** Object-valued plan fields worth showing, as compact JSON. */
const JSON_FIELDS = [
  'keyPattern',
  'indexBounds',
  'filter',
  'transformBy',
  'sortPattern',
  'multiKeyPaths',
  'collation',
];

interface SbeStats {
  nReturned?: number;
  time?: number;
  keysExamined: number;
  docsExamined: number;
}

function json(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(value);
  }
}

function collectionOf(namespace: unknown): string | undefined {
  if (typeof namespace !== 'string') return undefined;
  const dot = namespace.indexOf('.');
  return dot === -1 ? namespace : namespace.slice(dot + 1);
}

class PlanBuilder {
  readonly indexes = new Set<string>();
  collectionScan = false;

  constructor(
    private readonly relation: string | undefined,
    private readonly sbe?: Map<number, SbeStats>,
  ) {}

  /** A query-planner stage tree (classic or SBE queryPlan) → PlanNode. */
  stage(stage: Doc, id: string): PlanNode {
    const operation = typeof stage['stage'] === 'string' ? stage['stage'] : 'unknown';
    const detail: PlanDetail = scalarDetail(stage, OMIT);
    for (const key of JSON_FIELDS) if (isRecord(stage[key])) detail[key] = json(stage[key]);
    const index = typeof stage['indexName'] === 'string' ? stage['indexName'] : undefined;
    if (index) this.indexes.add(index);
    let actualRows = toNumber(stage['nReturned']);
    let actualTimeMs = toNumber(stage['executionTimeMillisEstimate']);
    const planNodeId = toNumber(stage['planNodeId']);
    const sbe = planNodeId !== undefined ? this.sbe?.get(planNodeId) : undefined;
    if (sbe) {
      actualRows ??= sbe.nReturned;
      actualTimeMs ??= sbe.time;
      if (sbe.keysExamined > 0) detail['keysExamined'] ??= sbe.keysExamined;
      if (sbe.docsExamined > 0) detail['docsExamined'] ??= sbe.docsExamined;
    }
    if (operation === 'COLLSCAN') {
      detail['collectionScan'] = true;
      this.collectionScan = true;
    }
    const children: PlanNode[] = [];
    const add = (child: unknown): void => {
      if (isRecord(child)) children.push(this.stage(child, `${id}.${children.length}`));
    };
    for (const key of CHILD_KEYS) add(stage[key]);
    if (Array.isArray(stage['inputStages'])) stage['inputStages'].forEach(add);
    if (Array.isArray(stage['shards'])) {
      for (const shard of stage['shards']) {
        if (isRecord(shard)) children.push(this.shard(shard, `${id}.${children.length}`));
      }
    }
    const scans = operation === 'COLLSCAN' || operation === 'IXSCAN' || operation === 'FETCH';
    return planNode({
      id,
      operation,
      relation: scans ? this.relation : undefined,
      index,
      actualRows,
      actualTimeMs,
      detail,
      children,
    });
  }

  /** One shard of a sharded explain: its own plan below a node named after the shard. */
  private shard(shard: Doc, id: string): PlanNode {
    const plan = shard['executionStages'] ?? winningPlanOf(shard);
    const children = isRecord(plan) ? [this.stage(plan, `${id}.0`)] : [];
    return planNode({
      id,
      operation: 'shard',
      relation: typeof shard['shardName'] === 'string' ? shard['shardName'] : undefined,
      actualRows: toNumber(shard['nReturned']),
      actualTimeMs: toNumber(shard['executionTimeMillis']),
      detail: scalarDetail(shard, new Set(['shardName', 'winningPlan', 'executionStages'])),
      children,
    });
  }
}

/** The winning plan of a queryPlanner section, preferring the SBE queryPlan shape. */
function winningPlanOf(section: Doc): Doc | undefined {
  const winning = section['winningPlan'];
  if (!isRecord(winning)) return undefined;
  return isRecord(winning['queryPlan']) ? winning['queryPlan'] : winning;
}

/** Per planNodeId: the top-most SBE stage's counts and the keys/documents examined below it. */
function sbeStats(root: unknown): Map<number, SbeStats> {
  const stats = new Map<number, SbeStats>();
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    const id = toNumber(node['planNodeId']);
    if (id !== undefined) {
      let entry = stats.get(id);
      if (!entry) {
        entry = { keysExamined: 0, docsExamined: 0 };
        const n = toNumber(node['nReturned']);
        const t = toNumber(node['executionTimeMillisEstimate']);
        if (n !== undefined) entry.nReturned = n;
        if (t !== undefined) entry.time = t;
        stats.set(id, entry);
      }
      entry.keysExamined = Math.max(entry.keysExamined, toNumber(node['keysExamined']) ?? 0);
      entry.docsExamined = Math.max(
        entry.docsExamined,
        toNumber(node['totalDocsExamined']) ?? toNumber(node['docsExamined']) ?? 0,
      );
    }
    for (const key of CHILD_KEYS) visit(node[key]);
    if (Array.isArray(node['inputStages'])) node['inputStages'].forEach(visit);
  };
  visit(root);
  return stats;
}

interface QueryPlanResult {
  readonly node: PlanNode;
  readonly builder: PlanBuilder;
  /** The executionStats section, when the verbosity ran the query. */
  readonly stats?: Doc;
}

/** The tree for a queryPlanner (+ executionStats) pair, as found in find and $cursor. */
function queryPlan(
  section: Doc,
  id: string,
  builder: (sbe?: Map<number, SbeStats>) => PlanBuilder,
): QueryPlanResult {
  const planner = isRecord(section['queryPlanner']) ? section['queryPlanner'] : section;
  const stats = isRecord(section['executionStats']) ? section['executionStats'] : undefined;
  const winning = isRecord(planner['winningPlan']) ? planner['winningPlan'] : undefined;
  const sbe = winning && isRecord(winning['queryPlan']);
  const b = builder(sbe && stats ? sbeStats(stats['executionStages']) : undefined);
  const classicStages =
    !sbe && stats && isRecord(stats['executionStages']) ? stats['executionStages'] : undefined;
  const plan = classicStages ?? winningPlanOf(planner) ?? {};
  const node = b.stage(plan, id);
  return { node, builder: b, ...(stats ? { stats } : {}) };
}

export interface NormalisedExplain {
  readonly plan: PlanNode;
  readonly summary: ExplainSummary;
}

/** Normalises the output of the `explain` command for find or aggregate (see module comment). */
export function normaliseExplain(raw: unknown): NormalisedExplain {
  const explain = isRecord(raw) ? raw : {};
  const indexes = new Set<string>();
  let collectionScan = false;
  let totals: Doc | undefined;
  const namespace = isRecord(explain['queryPlanner'])
    ? explain['queryPlanner']['namespace']
    : undefined;
  const makeBuilder = (relation: string | undefined) => (sbe?: Map<number, SbeStats>) =>
    new PlanBuilder(relation, sbe);

  const absorb = (b: PlanBuilder): void => {
    for (const index of b.indexes) indexes.add(index);
    if (b.collectionScan) collectionScan = true;
  };

  let plan: PlanNode;
  if (Array.isArray(explain['stages'])) {
    plan = pipelinePlan(explain['stages'], '0');
  } else if (isRecord(explain['queryPlanner'])) {
    const result = queryPlan(explain, '0', makeBuilder(collectionOf(namespace)));
    absorb(result.builder);
    totals = result.stats;
    plan = result.node;
  } else if (isRecord(explain['shards'])) {
    const children = Object.entries(explain['shards']).map(([shard, value], i) => {
      const inner = isRecord(value) ? value : {};
      const child = Array.isArray(inner['stages'])
        ? pipelinePlan(inner['stages'], `0.${i}`)
        : queryPlan(inner, `0.${i}.0`, makeBuilder(undefined)).node;
      return planNode({
        id: `0.${i}`,
        operation: 'shard',
        relation: shard,
        detail: {},
        children: [child],
      });
    });
    plan = planNode({ id: '0', operation: 'SHARD_MERGE', detail: {}, children });
  } else {
    plan = planNode({ id: '0', operation: 'unknown', detail: {}, children: [] });
  }

  /** An aggregation's stages, each fed by the one before. */
  function pipelinePlan(stages: readonly unknown[], id: string): PlanNode {
    let current: PlanNode | undefined;
    stages.forEach((entry) => {
      if (!isRecord(entry)) return;
      const operator = Object.keys(entry).find((key) => key.startsWith('$')) ?? 'unknown';
      const body = entry[operator];
      if (operator === '$cursor' && isRecord(body)) {
        const planner = isRecord(body['queryPlanner']) ? body['queryPlanner'] : {};
        const result = queryPlan(body, 'x', makeBuilder(collectionOf(planner['namespace'])));
        absorb(result.builder);
        totals ??= result.stats;
        current = result.node;
        return;
      }
      const detail: PlanDetail = scalarDetail(
        entry,
        new Set([operator, 'nReturned', 'executionTimeMillisEstimate']),
      );
      if (isRecord(body) || Array.isArray(body)) {
        if (operator !== '$facet') detail['spec'] = json(body);
      } else if (body !== undefined) {
        detail['spec'] = json(body);
      }
      const scans = toNumber(entry['collectionScans']);
      if (scans !== undefined && scans > 0) {
        detail['collectionScan'] = true;
        collectionScan = true;
      }
      if (Array.isArray(entry['indexesUsed'])) {
        for (const index of entry['indexesUsed']) if (typeof index === 'string') indexes.add(index);
      }
      const children: PlanNode[] = current ? [current] : [];
      if (operator === '$facet' && isRecord(body)) {
        for (const [facet, pipeline] of Object.entries(body)) {
          if (!Array.isArray(pipeline)) continue;
          const sub = pipelinePlan(pipeline, 'x');
          children.push({ ...sub, relation: facet });
        }
      }
      current = planNode({
        id: 'x',
        operation: operator,
        relation:
          operator === '$lookup' && isRecord(body) && typeof body['from'] === 'string'
            ? body['from']
            : undefined,
        actualRows: toNumber(entry['nReturned']),
        actualTimeMs: toNumber(entry['executionTimeMillisEstimate']),
        detail,
        children,
      });
    });
    return renumber(
      current ?? planNode({ id, operation: 'empty pipeline', detail: {}, children: [] }),
      id,
    );
  }

  const summary: ExplainSummary = {
    ...(totals && toNumber(totals['nReturned']) !== undefined
      ? { nReturned: toNumber(totals['nReturned'])! }
      : {}),
    ...(totals && toNumber(totals['executionTimeMillis']) !== undefined
      ? { executionTimeMillis: toNumber(totals['executionTimeMillis'])! }
      : {}),
    ...(totals && toNumber(totals['totalKeysExamined']) !== undefined
      ? { totalKeysExamined: toNumber(totals['totalKeysExamined'])! }
      : {}),
    ...(totals && toNumber(totals['totalDocsExamined']) !== undefined
      ? { totalDocsExamined: toNumber(totals['totalDocsExamined'])! }
      : {}),
    collectionScan,
    indexes: [...indexes].sort(),
  };
  return { plan: renumber(plan, '0'), summary };
}

/** Gives every node a path id ("0", "0.1", "0.1.0"...) after the tree is assembled. */
function renumber(node: PlanNode, id: string): PlanNode {
  return {
    ...node,
    id,
    children: node.children.map((child, i) => renumber(child, `${id}.${i}`)),
  };
}
