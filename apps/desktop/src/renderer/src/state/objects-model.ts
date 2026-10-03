import { isSqlEngine, type BrowseNode, type BrowseNodeKind, type EngineId } from '@querybara/core';

import { formatCount } from '../lib/format';
import { formatBytes } from './redis/value-model';

/**
 * The Objects view's model (state/objects-view.ts holds the view): which path a node lists, the
 * columns: the statistics `browse` returns in each node's `detail`, in a
 * fixed order (Navicat's: rows, sizes, engine, dates, collation, owner... comment last), with
 * how each value reads and sorts. Keys no engine is known for still show, labelled from the key.
 */

export type ColumnFormat = 'count' | 'bytes' | 'time' | 'flag' | 'text';

export interface ObjectColumn {
  readonly key: string;
  readonly label: string;
  readonly format: ColumnFormat;
}

const KNOWN: readonly ObjectColumn[] = [
  { key: 'rows', label: 'Rows', format: 'count' },
  { key: 'count', label: 'Documents', format: 'count' },
  { key: 'files', label: 'Files', format: 'count' },
  { key: 'dataSize', label: 'Data size', format: 'bytes' },
  { key: 'size', label: 'Size', format: 'bytes' },
  { key: 'storageSize', label: 'Storage size', format: 'bytes' },
  { key: 'indexSize', label: 'Index size', format: 'bytes' },
  { key: 'indexes', label: 'Indexes', format: 'count' },
  { key: 'sizeOnDisk', label: 'Size on disk', format: 'bytes' },
  { key: 'engine', label: 'Engine', format: 'text' },
  { key: 'autoIncrement', label: 'Auto increment', format: 'count' },
  { key: 'created', label: 'Created', format: 'time' },
  { key: 'updated', label: 'Modified', format: 'time' },
  { key: 'collation', label: 'Collation', format: 'text' },
  { key: 'owner', label: 'Owner', format: 'text' },
  { key: 'returns', label: 'Returns', format: 'text' },
  { key: 'language', label: 'Language', format: 'text' },
  { key: 'definer', label: 'Definer', format: 'text' },
  { key: 'security', label: 'Security', format: 'text' },
  { key: 'updatable', label: 'Updatable', format: 'flag' },
  { key: 'partitioned', label: 'Partitioned', format: 'flag' },
  { key: 'parent', label: 'Partition of', format: 'text' },
  { key: 'bound', label: 'Bound', format: 'text' },
  { key: 'systemVersioned', label: 'System versioned', format: 'flag' },
  { key: 'aggregate', label: 'Aggregate', format: 'flag' },
  { key: 'viewOn', label: 'View on', format: 'text' },
  { key: 'capped', label: 'Capped', format: 'text' },
  { key: 'timeField', label: 'Time field', format: 'text' },
  { key: 'metaField', label: 'Meta field', format: 'text' },
  { key: 'granularity', label: 'Granularity', format: 'text' },
];

const COMMENT: ObjectColumn = { key: 'comment', label: 'Comment', format: 'text' };

/** "dataType" → "Data type". */
function labelOf(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** The columns the nodes have values for, in display order (after the name). */
export function columnsFor(nodes: readonly BrowseNode[]): ObjectColumn[] {
  const present = new Set<string>();
  const numeric = new Map<string, boolean>();
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.detail ?? {})) {
      if (value === undefined) continue;
      present.add(key);
      if (value !== null) numeric.set(key, (numeric.get(key) ?? true) && typeof value === 'number');
    }
  }
  const known = new Set(KNOWN.map((column) => column.key));
  const columns = KNOWN.filter((column) => present.has(column.key));
  for (const key of [...present].sort()) {
    if (known.has(key) || key === COMMENT.key || key === 'system') continue;
    columns.push({ key, label: labelOf(key), format: numeric.get(key) ? 'count' : 'text' });
  }
  if (present.has(COMMENT.key)) columns.push(COMMENT);
  return columns;
}

/** A date as the server wrote it, to the second: "2026-02-02 08:36:14". */
function formatTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : value;
}

/** How a statistic reads; empty when the server has none. */
export function formatCell(
  value: string | number | null | undefined,
  format: ColumnFormat,
): string {
  if (value === null || value === undefined || value === '') return '';
  switch (format) {
    case 'count':
      return typeof value === 'number' ? formatCount(value) : value;
    case 'bytes':
      return typeof value === 'number' ? formatBytes(value) : value;
    case 'time':
      return formatTime(String(value));
    case 'flag':
      return value === 1 || value === '1' ? 'Yes' : 'No';
    case 'text':
      return String(value);
  }
}

export interface ObjectSort {
  /** "name" or a column key. */
  readonly key: string;
  readonly descending: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function valueOf(node: BrowseNode, key: string): string | number | null {
  if (key === 'name') return node.name;
  const value = node.detail?.[key];
  return value === undefined || value === '' ? null : value;
}

/** The nodes in the sort's order; empty values last either way. */
export function sortObjects(nodes: readonly BrowseNode[], sort: ObjectSort): BrowseNode[] {
  const sign = sort.descending ? -1 : 1;
  return [...nodes].sort((a, b) => {
    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);
    if (left === null || right === null) {
      return left === right ? collator.compare(a.name, b.name) : left === null ? 1 : -1;
    }
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : collator.compare(String(left), String(right));
    return order === 0 ? collator.compare(a.name, b.name) : order * sign;
  });
}

/**
 * The combined data and index size of the nodes on disk, when any has one: a SQL table's data
 * and index sizes, a MongoDB collection's storage and index sizes.
 */
export function totalSize(nodes: readonly BrowseNode[]): number | undefined {
  let total: number | undefined;
  for (const node of nodes) {
    const detail = node.detail ?? {};
    const data = detail['dataSize'] ?? detail['storageSize'];
    for (const value of [data, detail['indexSize']]) {
      if (typeof value === 'number') total = (total ?? 0) + value;
    }
  }
  return total;
}

/**
 * The path a node's objects are listed from, or undefined when the node is an object itself. A
 * MySQL or MariaDB database and a PostgreSQL schema list their tables, a PostgreSQL database its
 * schemas, a MongoDB database its collections, and any folder its objects.
 */
export function objectsPathFor(node: BrowseNode, engine: EngineId): readonly string[] | undefined {
  if (engine === 'mongodb') return mongoObjectsPathFor(node);
  if (!isSqlEngine(engine)) return undefined;
  if (node.kind === 'folder') return node.path;
  if (engine === 'postgres') {
    if (node.kind === 'schema' && node.path.length === 2) return [...node.path, 'tables'];
    if (node.kind === 'database' && node.path.length === 1) return node.path;
    return undefined;
  }
  if (node.kind === 'database' && node.path.length === 1) return [...node.path, 'tables'];
  return undefined;
}

/** MongoDB: a database lists its collections; a folder (views, users, indexes...) its objects. */
export function mongoObjectsPathFor(node: BrowseNode): readonly string[] | undefined {
  if (node.kind === 'database' && node.path.length === 1) return [...node.path, 'collections'];
  if (node.kind === 'folder') return node.path;
  return undefined;
}

const PLURALS: Readonly<Partial<Record<BrowseNodeKind, [string, string]>>> = {
  table: ['table', 'tables'],
  partition: ['partition', 'partitions'],
  view: ['view', 'views'],
  'materialized-view': ['materialized view', 'materialized views'],
  function: ['function', 'functions'],
  procedure: ['procedure', 'procedures'],
  trigger: ['trigger', 'triggers'],
  event: ['event', 'events'],
  sequence: ['sequence', 'sequences'],
  type: ['type', 'types'],
  extension: ['extension', 'extensions'],
  'foreign-table': ['foreign table', 'foreign tables'],
  schema: ['schema', 'schemas'],
  database: ['database', 'databases'],
  collection: ['collection', 'collections'],
  'time-series': ['time series collection', 'time series collections'],
  'gridfs-bucket': ['bucket', 'buckets'],
  user: ['user', 'users'],
  role: ['role', 'roles'],
  index: ['index', 'indexes'],
  column: ['column', 'columns'],
};

/** "43 tables", "1 view", "3 objects" (mixed kinds). */
export function countLabel(nodes: readonly BrowseNode[], count = nodes.length): string {
  const kinds = new Set(nodes.map((node) => node.kind));
  const [one, many] =
    kinds.size === 1 ? (PLURALS[[...kinds][0]!] ?? ['object', 'objects']) : ['object', 'objects'];
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
