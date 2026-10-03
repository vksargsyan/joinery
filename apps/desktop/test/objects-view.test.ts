import type { BrowseNode } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  columnsFor,
  countLabel,
  formatCell,
  objectsPathFor,
  sortObjects,
  totalSize,
} from '../src/renderer/src/state/objects-model';

/** The Objects view (Navicat's): which node lists what, and its columns, cells and order. */

function node(
  name: string,
  detail: BrowseNode['detail'] = {},
  kind: BrowseNode['kind'] = 'table',
): BrowseNode {
  return { kind, name, path: ['shop', 'tables', name], hasChildren: true, detail };
}

describe('objectsPathFor', () => {
  const at = (kind: BrowseNode['kind'], path: string[]): BrowseNode => ({
    kind,
    name: path.at(-1)!,
    path,
    hasChildren: true,
  });

  it('lists a MySQL database’s tables and a PostgreSQL schema’s tables', () => {
    expect(objectsPathFor(at('database', ['shop']), 'mysql')).toEqual(['shop', 'tables']);
    expect(objectsPathFor(at('schema', ['app', 'public']), 'postgres')).toEqual([
      'app',
      'public',
      'tables',
    ]);
  });

  it('lists a PostgreSQL database’s schemas and any folder’s objects', () => {
    expect(objectsPathFor(at('database', ['app']), 'postgres')).toEqual(['app']);
    expect(objectsPathFor(at('folder', ['shop', 'views']), 'mariadb')).toEqual(['shop', 'views']);
  });

  it('lists a MongoDB database’s collections and its folders’ objects', () => {
    expect(objectsPathFor(at('database', ['shop']), 'mongodb')).toEqual(['shop', 'collections']);
    expect(objectsPathFor(at('folder', ['shop', 'views']), 'mongodb')).toEqual(['shop', 'views']);
    expect(objectsPathFor(at('collection', ['shop', 'collections', 'orders']), 'mongodb')).toBe(
      undefined,
    );
    expect(objectsPathFor(at('database', ['0']), 'redis')).toBeUndefined();
  });

  it('lists nothing for an object', () => {
    expect(objectsPathFor(at('table', ['shop', 'tables', 'orders']), 'mysql')).toBeUndefined();
    expect(objectsPathFor(at('view', ['app', 'public', 'views', 'v']), 'postgres')).toBeUndefined();
  });
});

describe('columns', () => {
  it('shows the statistics present, in Navicat’s order, the comment last', () => {
    const nodes = [
      node('orders', {
        comment: 'Paid orders',
        updated: '2026-09-30 20:01:34',
        rows: 12,
        engine: 'InnoDB',
        dataSize: 16384,
        collation: 'utf8mb4_unicode_ci',
        created: '2026-02-02 08:36:14',
      }),
      node('notes', { rows: 0, indexSize: 0, pageCount: 3 }),
    ];
    expect(columnsFor(nodes).map((column) => column.label)).toEqual([
      'Rows',
      'Data size',
      'Index size',
      'Engine',
      'Created',
      'Modified',
      'Collation',
      'Page count',
      'Comment',
    ]);
    expect(columnsFor([node('x', { system: 1 })])).toEqual([]);
  });

  it('shows a MongoDB collection’s documents, sizes and indexes', () => {
    const nodes = [
      node(
        'orders',
        { count: 150, size: 3700, storageSize: 20480, indexSize: 20480, indexes: 1 },
        'collection',
      ),
    ];
    expect(columnsFor(nodes).map((column) => column.label)).toEqual([
      'Documents',
      'Size',
      'Storage size',
      'Index size',
      'Indexes',
    ]);
    expect(totalSize(nodes)).toBe(40960);
    expect(countLabel(nodes)).toBe('1 collection');
  });

  it('reads counts, sizes, dates and flags', () => {
    expect(formatCell(179536, 'count')).toBe('179,536');
    expect(formatCell(16384, 'bytes')).toBe('16 KB');
    expect(formatCell('2026-09-30T20:01:34.000Z', 'time')).toBe('2026-09-30 20:01:34');
    expect(formatCell(1, 'flag')).toBe('Yes');
    expect(formatCell(0, 'flag')).toBe('No');
    expect(formatCell(null, 'count')).toBe('');
  });
});

describe('sortObjects', () => {
  const nodes = [
    node('b', { rows: 10 }),
    node('a', { rows: null }),
    node('c', { rows: 2 }),
    node('d10', {}),
    node('d9', { rows: 10 }),
  ];

  it('sorts numbers as numbers, empty values last, ties by name', () => {
    expect(sortObjects(nodes, { key: 'rows', descending: false }).map((n) => n.name)).toEqual([
      'c',
      'b',
      'd9',
      'a',
      'd10',
    ]);
    expect(sortObjects(nodes, { key: 'rows', descending: true }).map((n) => n.name)).toEqual([
      'b',
      'd9',
      'c',
      'a',
      'd10',
    ]);
  });

  it('sorts names naturally', () => {
    expect(sortObjects(nodes, { key: 'name', descending: false }).map((n) => n.name)).toEqual([
      'a',
      'b',
      'c',
      'd9',
      'd10',
    ]);
  });
});

describe('summary', () => {
  it('counts by kind and adds up data and index sizes', () => {
    expect(countLabel([node('a'), node('b')])).toBe('2 tables');
    expect(countLabel([node('v', {}, 'view')])).toBe('1 view');
    expect(countLabel([node('a'), node('v', {}, 'view')])).toBe('2 objects');
    expect(countLabel([])).toBe('0 objects');
    expect(totalSize([node('a', { dataSize: 1000, indexSize: 24 }), node('b')])).toBe(1024);
    expect(totalSize([node('v', {}, 'view')])).toBeUndefined();
  });
});
