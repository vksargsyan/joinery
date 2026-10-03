import { QuerybaraError, type PlanNode } from '@querybara/core';
import {
  isRecord,
  planNode,
  scalarDetail,
  toNumber,
  type PlanDetail,
} from '@querybara/driver-sql-base';

/**
 * Normalises MySQL and MariaDB plans into PlanNode trees. Four inputs:
 *
 * - MySQL `EXPLAIN FORMAT=JSON` version 1: `query_block` with `nested_loop`, `table`,
 *   `ordering_operation`... Costs are strings; `cost_info.prefix_cost` is the cumulative cost.
 * - MySQL JSON version 2 (8.3+, `explain_json_format_version=2`): an iterator tree of
 *   `operation` / `inputs`, with `actual_*` fields under EXPLAIN ANALYZE.
 * - MySQL `EXPLAIN ANALYZE` (tree text, 8.0.18+): "-> Operation  (cost=… rows=…) (actual
 *   time=a..b rows=… loops=…)" lines, indented four spaces per level.
 * - MariaDB `EXPLAIN FORMAT=JSON` / `ANALYZE FORMAT=JSON`: `query_block` like MySQL v1, but
 *   `rows` instead of `rows_examined_per_scan`, `cost` numbers (11.x), `r_*` runtime fields,
 *   and its own node names (`block-nl-join`, `filesort`, `read_sorted_file`, `subqueries`).
 *
 * Rows and times are per loop where the server reports loops, matching the PostgreSQL plans;
 * MariaDB's cumulative `r_*_time_ms` are divided by `r_loops`.
 */

const ACCESS_TYPES: Readonly<Record<string, string>> = {
  ALL: 'Full table scan',
  index: 'Full index scan',
  range: 'Index range scan',
  ref: 'Non-unique key lookup',
  eq_ref: 'Unique key lookup',
  ref_or_null: 'Key lookup or null',
  const: 'Single row (constant)',
  system: 'Single row (system table)',
  fulltext: 'Fulltext index search',
  index_merge: 'Index merge',
  unique_subquery: 'Unique subquery lookup',
  index_subquery: 'Subquery index lookup',
  hash: 'Hash lookup',
};

/** Wrapper keys that become a node with their contents as children. */
const OPERATION_KEYS: Readonly<Record<string, string>> = {
  ordering_operation: 'Sort',
  grouping_operation: 'Group',
  duplicates_removal: 'Remove duplicates',
  windowing: 'Window',
  union_result: 'Union',
  nested_loop: 'Nested loop',
  filesort: 'Filesort',
  temporary_table: 'Temporary table',
  read_sorted_file: 'Read sorted file',
  'block-nl-join': 'Block nested loop join',
  materialized_from_subquery: 'Materialize',
  materialized: 'Materialize',
  expression_cache: 'Expression cache',
  window_functions_computation: 'Window functions',
  attached_subqueries: 'Subqueries',
  optimized_away_subqueries: 'Optimized away subqueries',
  select_list_subqueries: 'Select list subqueries',
  having_subqueries: 'Having subqueries',
  order_by_subqueries: 'Order by subqueries',
  group_by_subqueries: 'Group by subqueries',
  update_value_subqueries: 'Update value subqueries',
  subqueries: 'Subqueries',
  query_specifications: 'Union parts',
};

const TABLE_KEYS = new Set([
  'table_name',
  'access_type',
  'key',
  'rows_examined_per_scan',
  'rows',
  'r_rows',
  'r_loops',
  'loops',
  'cost',
  'cost_info',
  'r_table_time_ms',
  'r_other_time_ms',
]);

class IdSource {
  private readonly counters = new Map<string, number>();
  next(parent: string): string {
    const n = this.counters.get(parent) ?? 0;
    this.counters.set(parent, n + 1);
    return parent === '' ? String(n) : `${parent}.${n}`;
  }
}

/** Per-loop time from MariaDB's cumulative r_* timings. */
function mariadbTime(
  node: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | undefined {
  let total: number | undefined;
  for (const key of keys) {
    const value = toNumber(node[key]);
    if (value !== undefined) total = (total ?? 0) + value;
  }
  if (total === undefined) return undefined;
  const loops = toNumber(node['r_loops']);
  return loops && loops > 0 ? total / loops : total;
}

function costOf(node: Readonly<Record<string, unknown>>): number | undefined {
  const info = node['cost_info'];
  if (isRecord(info)) {
    return (
      toNumber(info['prefix_cost']) ?? toNumber(info['query_cost']) ?? toNumber(info['sort_cost'])
    );
  }
  return toNumber(node['cost']);
}

function costDetail(node: Readonly<Record<string, unknown>>): PlanDetail {
  const info = node['cost_info'];
  return isRecord(info) ? scalarDetail(info, new Set(), 'cost_info.') : {};
}

/** Children of a v1 / MariaDB JSON object: every nested operation it contains. */
function childrenOf(
  value: Readonly<Record<string, unknown>>,
  parent: string,
  ids: IdSource,
  skip: ReadonlySet<string>,
): PlanNode[] {
  const children: PlanNode[] = [];
  for (const [member, child] of Object.entries(value)) {
    // `table#2`...: a repeated key kept by parseExplainJson.
    const key = member.replace(/#\d+$/, '');
    if (skip.has(key)) continue;
    if (key === 'table' && isRecord(child)) children.push(tableNode(child, parent, ids));
    else if (key === 'query_block' && isRecord(child))
      children.push(queryBlockNode(child, parent, ids));
    else if (key in OPERATION_KEYS) {
      const op = wrapperNode(key, child, parent, ids);
      if (op) children.push(op);
    }
  }
  return children;
}

function wrapperNode(
  key: string,
  value: unknown,
  parent: string,
  ids: IdSource,
): PlanNode | undefined {
  const id = ids.next(parent);
  const operation = OPERATION_KEYS[key] ?? key;
  if (Array.isArray(value)) {
    const children: PlanNode[] = [];
    for (const item of value.filter(isRecord)) {
      // nested_loop: [{table}], subqueries: [{query_block}], duplicates_removal (MariaDB): [...]
      children.push(...childrenOf(item, id, ids, new Set()));
    }
    // A nested loop of one table is just that table.
    if (key === 'nested_loop' && children.length === 1) return children[0];
    return planNode({ id, operation, detail: {}, children });
  }
  if (!isRecord(value)) return undefined;
  const actualRows = toNumber(value['r_rows']);
  const loops = toNumber(value['r_loops']);
  return planNode({
    id,
    operation:
      key === 'ordering_operation' && value['using_filesort'] === true
        ? 'Sort (filesort)'
        : operation,
    relation: typeof value['table_name'] === 'string' ? value['table_name'] : undefined,
    totalCost: costOf(value),
    actualRows,
    loops,
    actualTimeMs: mariadbTime(value, ['r_total_time_ms', 'r_used_time_ms']),
    detail: {
      ...scalarDetail(value, new Set(['table_name', 'r_rows', 'r_loops'])),
      ...costDetail(value),
    },
    children: childrenOf(value, id, ids, new Set()),
  });
}

function tableNode(
  table: Readonly<Record<string, unknown>>,
  parent: string,
  ids: IdSource,
): PlanNode {
  const id = ids.next(parent);
  const access = typeof table['access_type'] === 'string' ? table['access_type'] : undefined;
  let operation = access ? (ACCESS_TYPES[access] ?? access) : 'Table';
  if (table['insert'] === true) operation = 'Insert';
  else if (table['update'] === true) operation = 'Update';
  else if (table['delete'] === true) operation = 'Delete';
  else if (typeof table['message'] === 'string' && !access) operation = table['message'];
  return planNode({
    id,
    operation,
    relation: typeof table['table_name'] === 'string' ? table['table_name'] : undefined,
    index: typeof table['key'] === 'string' ? table['key'] : undefined,
    totalCost: costOf(table),
    estimatedRows: toNumber(table['rows_examined_per_scan']) ?? toNumber(table['rows']),
    actualRows: toNumber(table['r_rows']),
    loops: toNumber(table['r_loops']),
    actualTimeMs: mariadbTime(table, ['r_table_time_ms', 'r_other_time_ms']),
    detail: {
      ...(access ? { access_type: access } : {}),
      ...scalarDetail(table, TABLE_KEYS),
      ...costDetail(table),
    },
    children: childrenOf(table, id, ids, new Set()),
  });
}

function queryBlockNode(
  block: Readonly<Record<string, unknown>>,
  parent: string,
  ids: IdSource,
): PlanNode {
  const id = ids.next(parent);
  const selectId = block['select_id'];
  const message = typeof block['message'] === 'string' ? block['message'] : undefined;
  return planNode({
    id,
    operation: message ?? (selectId !== undefined ? `Select #${String(selectId)}` : 'Query block'),
    totalCost: costOf(block),
    loops: toNumber(block['r_loops']),
    actualTimeMs: mariadbTime(block, ['r_total_time_ms']),
    detail: {
      ...scalarDetail(block, new Set(['r_loops', 'r_total_time_ms'])),
      ...costDetail(block),
    },
    children: childrenOf(block, id, ids, new Set()),
  });
}

/**
 * MySQL JSON format version 2 (iterator tree). The relation is the table's alias when it has
 * one, as version 1 and the operation text name it; the table's own name stays in the detail.
 */
function iteratorNode(node: Readonly<Record<string, unknown>>, id: string): PlanNode {
  const inputs = Array.isArray(node['inputs']) ? node['inputs'].filter(isRecord) : [];
  const table = typeof node['table_name'] === 'string' ? node['table_name'] : undefined;
  const alias = typeof node['alias'] === 'string' ? node['alias'] : undefined;
  return planNode({
    id,
    operation: typeof node['operation'] === 'string' ? node['operation'] : 'Unknown',
    relation: alias ?? table,
    index: typeof node['index_name'] === 'string' ? node['index_name'] : undefined,
    startupCost: toNumber(node['estimated_first_row_cost']),
    totalCost: toNumber(node['estimated_total_cost']),
    estimatedRows: toNumber(node['estimated_rows']),
    actualRows: toNumber(node['actual_rows']),
    actualTimeMs: toNumber(node['actual_last_row_ms']),
    loops: toNumber(node['actual_loops']),
    detail: scalarDetail(
      node,
      new Set([
        'inputs',
        'operation',
        'alias',
        ...(alias === undefined || alias === table ? ['table_name'] : []),
        'index_name',
        'estimated_first_row_cost',
        'estimated_total_cost',
        'estimated_rows',
        'actual_rows',
        'actual_last_row_ms',
        'actual_loops',
      ]),
    ),
    children: inputs.map((input, i) => iteratorNode(input, `${id}.${i}`)),
  });
}

/**
 * Parses EXPLAIN JSON text, keeping repeated keys: MariaDB before 10.9 prints the tables of a
 * join as several `"table"` members of one object, where JSON.parse would keep only the last.
 * The second and later ones become `table#2`, `table#3`..., in their original order.
 */
export function parseExplainJson(text: string): unknown {
  let at = 0;
  const fail = (): never => {
    throw new QuerybaraError({
      code: 'INTERNAL',
      message: `Unexpected EXPLAIN output: invalid JSON at offset ${at}`,
    });
  };
  const space = (): void => {
    while (at < text.length && ' \t\n\r'.includes(text.charAt(at))) at += 1;
  };
  const string = (): string => {
    const start = at;
    at += 1;
    while (at < text.length && text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1;
    if (at >= text.length) fail();
    at += 1;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (): unknown => {
    space();
    const char = text.charAt(at);
    if (char === '{') {
      at += 1;
      const object: Record<string, unknown> = {};
      const seen = new Map<string, number>();
      space();
      if (text.charAt(at) === '}') {
        at += 1;
        return object;
      }
      for (;;) {
        space();
        if (text.charAt(at) !== '"') fail();
        const key = string();
        space();
        if (text.charAt(at) !== ':') fail();
        at += 1;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        object[count === 1 ? key : `${key}#${count}`] = value();
        space();
        if (text.charAt(at) === ',') at += 1;
        else if (text.charAt(at) === '}') {
          at += 1;
          return object;
        } else fail();
      }
    }
    if (char === '[') {
      at += 1;
      const array: unknown[] = [];
      space();
      if (text.charAt(at) === ']') {
        at += 1;
        return array;
      }
      for (;;) {
        array.push(value());
        space();
        if (text.charAt(at) === ',') at += 1;
        else if (text.charAt(at) === ']') {
          at += 1;
          return array;
        } else fail();
      }
    }
    if (char === '"') return string();
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(at));
    if (!literal) return fail();
    at += literal[0].length;
    return JSON.parse(literal[0]) as unknown;
  };
  const result = value();
  space();
  if (at !== text.length) fail();
  return result;
}

/** Converts the parsed JSON of a MySQL or MariaDB JSON plan into a PlanNode tree. */
export function normaliseMysqlJsonPlan(explain: unknown): PlanNode {
  if (!isRecord(explain)) {
    throw new QuerybaraError({
      code: 'INTERNAL',
      message: 'Unexpected EXPLAIN output: not a JSON object',
    });
  }
  if (typeof explain['operation'] === 'string') return iteratorNode(explain, '0');
  // Version 2 as MySQL 9 prints it by default: the iterator tree under `query_plan`, next to
  // the rewritten query and its type.
  const plan = explain['query_plan'];
  if (isRecord(plan) && typeof plan['operation'] === 'string') {
    const root = iteratorNode(plan, '0');
    const queryType = explain['query_type'];
    return typeof queryType === 'string'
      ? { ...root, detail: { ...root.detail, query_type: queryType } }
      : root;
  }
  const block = explain['query_block'];
  if (!isRecord(block)) {
    throw new QuerybaraError({
      code: 'INTERNAL',
      message: 'Unexpected EXPLAIN output: no query_block',
    });
  }
  const root = queryBlockNode(block, '', new IdSource());
  // MariaDB ANALYZE reports optimizer time next to the query block.
  const optimization = explain['query_optimization'];
  if (!isRecord(optimization)) return root;
  return {
    ...root,
    detail: { ...root.detail, ...scalarDetail(optimization, new Set(), 'query_optimization.') },
  };
}

const TREE_LINE = /^(\s*)-> (.*)$/;
const COST = /\(cost=(?:([\d.e+-]+)\.\.)?([\d.e+-]+) rows=([\d.e+-]+)\)/;
const ACTUAL = /\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=(\d+)\)/;

const NOT_EXECUTABLE = '<not executable by iterator executor>';

/**
 * True when MySQL answered EXPLAIN ANALYZE with "<not executable by iterator executor>" (8.0
 * prints it bare, later versions as a "-> " line): the statement kind cannot be analyzed
 * (single-table UPDATE and DELETE).
 */
export function isNotExecutableTreePlan(text: string): boolean {
  return /^\s*(?:-> )?<not executable by iterator executor>/.test(text);
}

/**
 * True for a JSON version 2 plan that is only "<not executable by iterator executor>": MySQL 9
 * has no iterator plan for single-table UPDATE and DELETE, while version 1 still describes them.
 */
export function isNotExecutableJsonPlan(explain: unknown): boolean {
  if (!isRecord(explain)) return false;
  const plan = explain['query_plan'];
  return isRecord(plan) && plan['operation'] === NOT_EXECUTABLE;
}

/** Converts MySQL `EXPLAIN ANALYZE` / `EXPLAIN FORMAT=TREE` text into a PlanNode tree. */
export function normaliseMysqlTreePlan(text: string): PlanNode {
  interface Draft {
    depth: number;
    node: Omit<PlanNode, 'children'> & { children: Draft[] };
  }
  const roots: Draft[] = [];
  const stack: Draft[] = [];
  for (const line of text.split('\n')) {
    const match = TREE_LINE.exec(line);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    let body = match[2]!;
    const cost = COST.exec(body);
    const actual = ACTUAL.exec(body);
    const neverExecuted = body.includes('(never executed)');
    body = body.replace(COST, '').replace(ACTUAL, '').replace('(never executed)', '').trim();
    const detail: PlanDetail = {};
    if (neverExecuted) detail['never_executed'] = true;
    if (actual) detail['actual_first_row_ms'] = Number(actual[1]);
    const base = planNode({
      id: '',
      operation: body,
      startupCost: cost?.[1] !== undefined ? Number(cost[1]) : undefined,
      totalCost: cost ? Number(cost[2]) : undefined,
      estimatedRows: cost ? Number(cost[3]) : undefined,
      actualTimeMs: actual ? Number(actual[2]) : undefined,
      actualRows: actual ? Number(actual[3]) : undefined,
      loops: actual ? Number(actual[4]) : undefined,
      detail,
      children: [],
    });
    const draft: Draft = { depth, node: { ...base, children: [] } };
    while (stack.length > 0 && stack.at(-1)!.depth >= depth) stack.pop();
    const parent = stack.at(-1);
    if (parent) parent.node.children.push(draft);
    else roots.push(draft);
    stack.push(draft);
  }
  if (roots.length === 0) {
    throw new QuerybaraError({
      code: 'INTERNAL',
      message: 'Unexpected EXPLAIN output: no plan lines',
    });
  }
  const finish = (draft: Draft, id: string): PlanNode => ({
    ...draft.node,
    id,
    children: draft.node.children.map((child, i) => finish(child, `${id}.${i}`)),
  });
  if (roots.length === 1) return finish(roots[0]!, '0');
  return {
    id: '0',
    operation: 'Plan',
    detail: {},
    children: roots.map((root, i) => finish(root, `0.${i}`)),
  };
}
