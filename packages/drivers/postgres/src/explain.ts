import { JoineryError, type PlanNode } from '@joinery/core';
import { isRecord, planNode, scalarDetail, toNumber } from '@joinery/driver-sql-base';

/**
 * Normalises PostgreSQL `EXPLAIN (FORMAT JSON)` output into PlanNode trees.
 *
 * Operation names follow the text format ("Hash Left Join", "HashAggregate", "Index Scan
 * Backward", "Insert on"), so the tree reads like psql. Rows and times are per loop, as
 * PostgreSQL reports them; multiply by `loops` for totals. Everything else on the node lands in
 * `detail`; top-level facts (planning and execution time, trigger times) go on the root.
 */

const NODE_KEYS = new Set([
  'Node Type',
  'Relation Name',
  'Index Name',
  'Startup Cost',
  'Total Cost',
  'Plan Rows',
  'Actual Rows',
  'Actual Total Time',
  'Actual Loops',
  'Plans',
]);

const JOIN_NODES = new Set(['Nested Loop', 'Hash Join', 'Merge Join']);

function operationName(node: Readonly<Record<string, unknown>>): string {
  const type = typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Unknown';
  const join = node['Join Type'];
  if (JOIN_NODES.has(type) && typeof join === 'string' && join !== 'Inner') {
    // "Hash Join" + Left → "Hash Left Join"; "Nested Loop" + Anti → "Nested Loop Anti Join".
    return type === 'Nested Loop'
      ? `Nested Loop ${join} Join`
      : type.replace(' Join', ` ${join} Join`);
  }
  if (type === 'Aggregate') {
    switch (node['Strategy']) {
      case 'Hashed':
        return 'HashAggregate';
      case 'Sorted':
        return 'GroupAggregate';
      case 'Mixed':
        return 'MixedAggregate';
      default:
        return 'Aggregate';
    }
  }
  if (type === 'SetOp') {
    const command = typeof node['Command'] === 'string' ? ` ${node['Command']}` : '';
    return (node['Strategy'] === 'Hashed' ? 'HashSetOp' : 'SetOp') + command;
  }
  if (type === 'ModifyTable' && typeof node['Operation'] === 'string') {
    return node['Operation'];
  }
  if (node['Scan Direction'] === 'Backward') return `${type} Backward`;
  return type;
}

function relationName(node: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['Relation Name', 'CTE Name', 'Function Name']) {
    const value = node[key];
    if (typeof value === 'string') {
      const schema = node['Schema'];
      return key === 'Relation Name' && typeof schema === 'string' ? `${schema}.${value}` : value;
    }
  }
  return undefined;
}

function convert(node: Readonly<Record<string, unknown>>, id: string): PlanNode {
  const children = Array.isArray(node['Plans'])
    ? node['Plans'].filter(isRecord).map((child, i) => convert(child, `${id}.${i}`))
    : [];
  return planNode({
    id,
    operation: operationName(node),
    relation: relationName(node),
    index: typeof node['Index Name'] === 'string' ? node['Index Name'] : undefined,
    startupCost: toNumber(node['Startup Cost']),
    totalCost: toNumber(node['Total Cost']),
    estimatedRows: toNumber(node['Plan Rows']),
    actualRows: toNumber(node['Actual Rows']),
    actualTimeMs: toNumber(node['Actual Total Time']),
    loops: toNumber(node['Actual Loops']),
    detail: scalarDetail(node, NODE_KEYS),
    children,
  });
}

/** Converts the parsed JSON of `EXPLAIN (FORMAT JSON ...)` into a PlanNode tree. */
export function normalisePgPlan(explain: unknown): PlanNode {
  const top = Array.isArray(explain) ? explain[0] : explain;
  if (!isRecord(top) || !isRecord(top['Plan'])) {
    throw new JoineryError({
      code: 'INTERNAL',
      message: 'Unexpected EXPLAIN output: no plan found',
    });
  }
  const root = convert(top['Plan'], '0');
  const extra = scalarDetail(top, new Set(['Plan']));
  if (Array.isArray(top['Triggers'])) {
    for (const trigger of top['Triggers'].filter(isRecord)) {
      const name =
        typeof trigger['Trigger Name'] === 'string' ? trigger['Trigger Name'] : 'trigger';
      const time = toNumber(trigger['Time']);
      if (time !== undefined) extra[`Trigger ${name} Time`] = time;
    }
  }
  return { ...root, detail: { ...root.detail, ...extra } };
}
