import { compactJson, member, nodeText, numberAt, parseJsonTree, type JsonNode } from './json';

/**
 * Aggregation results two ways (spec §11): a tree (aggregations, their buckets and the metrics
 * under them) and a flattened table with one row per innermost bucket, as Kibana's tabify does:
 * a column per bucket aggregation holding the bucket key, a column per metric, and a count
 * column where a bucket has no metric under it. Values keep the server's text (exact numbers,
 * `key_as_string` for dates).
 */

export type AggregationKind = 'buckets' | 'single-bucket' | 'metric' | 'metrics' | 'hits' | 'other';

/** One node of the aggregation tree: an aggregation, a bucket, or a metric value. */
export interface AggregationNode {
  /** The aggregation's name, the bucket's key, or the metric's name. */
  readonly label: string;
  readonly type: 'aggregation' | 'bucket' | 'value';
  /** For aggregations: what shape its result has. */
  readonly kind?: AggregationKind;
  readonly docCount?: number;
  /** For values: the value as the server wrote it (`value_as_string` when there is one). */
  readonly value?: string;
  readonly children: readonly AggregationNode[];
}

/** Keys of a bucket that are not sub-aggregations. */
const BUCKET_FIELDS = new Set([
  'key',
  'key_as_string',
  'doc_count',
  'from',
  'from_as_string',
  'to',
  'to_as_string',
  'bg_count',
  'score',
  'doc_count_error_upper_bound',
]);

/** Keys of a result that describe it rather than hold sub-aggregations. */
const RESULT_FIELDS = new Set([
  'meta',
  'buckets',
  'doc_count',
  'doc_count_error_upper_bound',
  'sum_other_doc_count',
  'after_key',
  'interval',
  'bg_count',
]);

function scalarText(text: string, node: JsonNode): string {
  switch (node.type) {
    case 'string':
      return node.value;
    case 'number':
      return node.text;
    case 'boolean':
      return String(node.value);
    case 'null':
      return 'null';
    default:
      return compactJson(nodeText(text, node));
  }
}

/** A bucket's key: `key_as_string`, else `key` (a composite key reads "a=1, b=x"). */
function bucketKey(text: string, bucket: JsonNode, fallback: string): string {
  const asString = member(bucket, 'key_as_string');
  if (asString?.type === 'string') return asString.value;
  const key = member(bucket, 'key');
  if (key?.type === 'object') {
    return key.members.map((m) => `${m.key}=${scalarText(text, m.value)}`).join(', ');
  }
  if (key !== undefined) return scalarText(text, key);
  return fallback;
}

function kindOf(node: JsonNode): AggregationKind {
  if (node.type !== 'object') return 'other';
  if (member(node, 'buckets') !== undefined) return 'buckets';
  if (member(node, 'hits') !== undefined) return 'hits';
  if (member(node, 'value') !== undefined) return 'metric';
  if (member(node, 'values') !== undefined) return 'metrics';
  if (member(node, 'doc_count') !== undefined) return 'single-bucket';
  const numeric = node.members.filter((m) => m.value.type === 'number' || m.value.type === 'null');
  return numeric.length > 0 ? 'metrics' : 'other';
}

/** The metric values of a multi-value metric (stats, percentiles...) as name → text. */
function metricValues(text: string, node: JsonNode): [string, string][] {
  const values = member(node, 'values');
  if (values?.type === 'object') {
    return values.members
      .filter((m) => !m.key.endsWith('_as_string'))
      .map((m) => {
        const asString = member(values, `${m.key}_as_string`);
        return [m.key, asString?.type === 'string' ? asString.value : scalarText(text, m.value)];
      });
  }
  if (values?.type === 'array') {
    return values.items.map((item, i) => {
      const key = member(item, 'key');
      const value = member(item, 'value');
      return [key ? scalarText(text, key) : String(i), value ? scalarText(text, value) : ''];
    });
  }
  if (node.type !== 'object') return [];
  return node.members
    .filter(
      (m) =>
        !m.key.endsWith('_as_string') &&
        m.key !== 'meta' &&
        (m.value.type === 'number' || m.value.type === 'null' || m.value.type === 'string'),
    )
    .map((m) => {
      const asString = member(node, `${m.key}_as_string`);
      return [m.key, asString?.type === 'string' ? asString.value : scalarText(text, m.value)];
    });
}

function singleValue(text: string, node: JsonNode): string {
  const asString = member(node, 'value_as_string');
  if (asString?.type === 'string') return asString.value;
  const value = member(node, 'value');
  return value === undefined ? '' : scalarText(text, value);
}

/** The sub-aggregations of a bucket or single-bucket result, in order. */
function subAggregations(node: JsonNode, skip: ReadonlySet<string>): [string, JsonNode][] {
  if (node.type !== 'object') return [];
  return node.members
    .filter((m) => !skip.has(m.key) && m.value.type === 'object')
    .map((m) => [m.key, m.value]);
}

function treeOf(text: string, name: string, node: JsonNode): AggregationNode {
  const kind = kindOf(node);
  const docCount = numberAt(node, 'doc_count');
  switch (kind) {
    case 'buckets': {
      const buckets = member(node, 'buckets')!;
      const entries: [string, JsonNode][] =
        buckets.type === 'array'
          ? buckets.items.map((b, i) => [bucketKey(text, b, String(i)), b])
          : buckets.type === 'object'
            ? buckets.members.map((m) => [m.key, m.value])
            : [];
      return {
        label: name,
        type: 'aggregation',
        kind,
        children: entries.map(([key, bucket]) => {
          const count = numberAt(bucket, 'doc_count');
          return {
            label: key,
            type: 'bucket',
            ...(count !== undefined ? { docCount: count } : {}),
            children: subAggregations(bucket, BUCKET_FIELDS).map(([n, v]) => treeOf(text, n, v)),
          };
        }),
      };
    }
    case 'single-bucket':
      return {
        label: name,
        type: 'aggregation',
        kind,
        ...(docCount !== undefined ? { docCount } : {}),
        children: subAggregations(node, RESULT_FIELDS).map(([n, v]) => treeOf(text, n, v)),
      };
    case 'metric':
      return { label: name, type: 'value', kind, value: singleValue(text, node), children: [] };
    case 'metrics':
      return {
        label: name,
        type: 'aggregation',
        kind,
        children: metricValues(text, node).map(([key, value]) => ({
          label: key,
          type: 'value',
          value,
          children: [],
        })),
      };
    case 'hits': {
      const total = numberAt(node, 'hits', 'total', 'value') ?? numberAt(node, 'hits', 'total');
      const hits = member(member(node, 'hits'), 'hits');
      return {
        label: name,
        type: 'value',
        kind,
        value: `${total ?? (hits?.type === 'array' ? hits.items.length : 0)} hits`,
        children: [],
      };
    }
    default:
      return {
        label: name,
        type: 'aggregation',
        kind,
        children:
          node.type === 'object'
            ? node.members.map((m) => ({
                label: m.key,
                type: 'value' as const,
                value: scalarText(text, m.value),
                children: [],
              }))
            : [],
      };
  }
}

/** The tree of an `aggregations` object (JSON text). */
export function aggregationTree(aggregations: string): AggregationNode[] {
  const root = parseJsonTree(aggregations);
  if (root.type !== 'object') return [];
  return root.members.map((m) => treeOf(aggregations, m.key, m.value));
}

/** The flattened table of an aggregation result: one row per innermost bucket. */
export interface AggregationTable {
  readonly columns: readonly string[];
  /** Cells in column order; '' where a row has no value. */
  readonly rows: readonly (readonly string[])[];
}

type Row = Map<string, string>;

/**
 * Flattens an `aggregations` object (JSON text) into rows (see AggregationTable). Sibling bucket
 * aggregations each contribute their own rows; metrics beside them repeat on each. A metric
 * under a bucket aggregation is named after it ("by_day › total"), so metrics of the same name
 * at different levels get their own columns.
 */
export function aggregationTable(aggregations: string): AggregationTable {
  const text = aggregations;
  const root = parseJsonTree(aggregations);
  const columns: string[] = [];
  const addColumn = (name: string): void => {
    if (!columns.includes(name)) columns.push(name);
  };
  const rows: Row[] = [];

  /** The metric cells of a level: its metric aggregations, by column. */
  const metricsOf = (
    level: [string, JsonNode][],
    owner: string | undefined,
  ): [string, string][] => {
    const prefix = owner === undefined ? '' : `${owner} › `;
    const cells: [string, string][] = [];
    for (const [name, node] of level) {
      const kind = kindOf(node);
      if (kind === 'metric') cells.push([`${prefix}${name}`, singleValue(text, node)]);
      else if (kind === 'metrics') {
        for (const [key, value] of metricValues(text, node)) {
          cells.push([`${prefix}${name}.${key}`, value]);
        }
      } else if (kind === 'hits') {
        cells.push([`${prefix}${name}`, treeOf(text, name, node).value ?? '']);
      }
    }
    return cells;
  };

  /** One level of aggregations: the top, a bucket's, or a single-bucket aggregation's. */
  const walk = (
    level: [string, JsonNode][],
    context: Row,
    owner: string | undefined,
    count: number | undefined,
  ): void => {
    const metrics = metricsOf(level, owner);
    const nested = level.filter(([, node]) => {
      const kind = kindOf(node);
      return kind === 'buckets' || kind === 'single-bucket';
    });
    const base = new Map(context);
    for (const [column, value] of metrics) {
      addColumn(column);
      base.set(column, value);
    }
    if (metrics.length === 0 && owner !== undefined && count !== undefined) {
      addColumn(`${owner} count`);
      base.set(`${owner} count`, String(count));
    }
    if (nested.length === 0) {
      rows.push(base);
      return;
    }
    for (const [name, node] of nested) {
      if (kindOf(node) === 'single-bucket') {
        walk(subAggregations(node, RESULT_FIELDS), base, name, numberAt(node, 'doc_count') ?? 0);
        continue;
      }
      addColumn(name);
      const buckets = member(node, 'buckets')!;
      const entries: [string, JsonNode][] =
        buckets.type === 'array'
          ? buckets.items.map((b, i) => [bucketKey(text, b, String(i)), b])
          : buckets.type === 'object'
            ? buckets.members.map((m) => [m.key, m.value])
            : [];
      // A bucket aggregation without buckets still shows what its parent knows.
      if (entries.length === 0) rows.push(base);
      for (const [key, bucket] of entries) {
        const row = new Map(base);
        row.set(name, key);
        walk(subAggregations(bucket, BUCKET_FIELDS), row, name, numberAt(bucket, 'doc_count') ?? 0);
      }
    }
  };

  if (root.type === 'object') {
    walk(
      root.members.map((m) => [m.key, m.value]),
      new Map(),
      undefined,
      undefined,
    );
  }
  const filled = rows.filter((row) => row.size > 0);
  return { columns, rows: filled.map((row) => columns.map((c) => row.get(c) ?? '')) };
}

/** The `aggregations` of a search response (JSON text), when it has any. */
export function aggregationsOf(response: string): string | undefined {
  let root: JsonNode;
  try {
    root = parseJsonTree(response);
  } catch {
    return undefined;
  }
  const aggregations = member(root, 'aggregations');
  return aggregations?.type === 'object' && aggregations.members.length > 0
    ? nodeText(response, aggregations)
    : undefined;
}
