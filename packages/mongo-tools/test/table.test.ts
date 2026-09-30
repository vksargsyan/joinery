import { describe, expect, it } from 'vitest';

import {
  Int32,
  cellText,
  parseShellDocument,
  tableView,
  toEjson,
  valueAtPath,
  withValueAt,
} from '../src';

const docs = [
  "{ _id: 1, name: 'Ada', address: { city: 'London', geo: { lat: 51.5 } }, tags: ['a', 'b'] }",
  "{ _id: 2, name: 'Alan', tags: [], extra: true }",
  "{ _id: 3, address: 'unknown', tags: [{ k: 1 }, { k: 2, v: 'x' }] }",
].map((text) => parseShellDocument(text));

describe('table view', () => {
  it('turns top-level fields into columns with drill-down cells', () => {
    const view = tableView(docs);
    expect(view.columns.map((c) => c.key)).toEqual(['_id', 'name', 'address', 'tags', 'extra']);
    expect(view.columns[2]!.types).toEqual(['object', 'string']);
    expect(view.rows).toHaveLength(3);
    const [first, second] = view.rows;
    expect(first!.cells[2]).toEqual({ type: 'object', text: '{ 2 fields }', drill: ['address'] });
    expect(first!.cells[3]).toEqual({ type: 'array', text: '[ 2 elements ]', drill: ['tags'] });
    expect(second!.cells[2]).toEqual({ type: 'missing', text: '' });
    expect(second!.cells[1]).toEqual({ type: 'string', text: 'Alan' });
    expect(second!.cells[4]).toEqual({ type: 'bool', text: 'true' });
  });

  it('flattens sub-documents into dotted columns on request', () => {
    const view = tableView(docs, { expandDepth: 2 });
    expect(view.columns.map((c) => c.key)).toEqual([
      '_id',
      'name',
      'address.city',
      'address.geo.lat',
      'tags',
      'extra',
      'address',
    ]);
    expect(view.rows[0]!.cells[3]).toEqual({ type: 'double', text: '51.5' });
    expect(view.rows[2]!.cells[6]).toEqual({ type: 'string', text: 'unknown' });
  });

  it('puts the columns of a select list first, in its order', () => {
    const ordered = tableView(docs, { columnOrder: ['tags', 'address.city', 'name'] });
    expect(ordered.columns.map((c) => c.key)).toEqual(['tags', 'address', 'name', '_id', 'extra']);
    // Cells move with their columns.
    expect(ordered.rows[1]!.cells[2]).toEqual({ type: 'string', text: 'Alan' });
    const flat = tableView(docs, {
      expandDepth: 2,
      columnOrder: ['address.geo.lat', 'address.city', 'nope'],
    });
    expect(flat.columns.map((c) => c.key)).toEqual([
      'address.geo.lat',
      // The unflattened `address` (a string in one document) is a prefix of the first path.
      'address',
      'address.city',
      '_id',
      'name',
      'tags',
      'extra',
    ]);
  });

  it('drills into arrays (a row per element) and sub-documents', () => {
    const tags = tableView(docs, { path: ['tags'] });
    expect(tags.rows.map((r) => r.path)).toEqual([
      ['tags', 0],
      ['tags', 1],
      ['tags', 0],
      ['tags', 1],
    ]);
    expect(tags.columns.map((c) => c.key)).toEqual(['', 'k', 'v']);
    expect(tags.rows[0]!.cells[0]).toEqual({ type: 'string', text: 'a' });
    expect(tags.rows[3]!.cells[2]).toEqual({ type: 'string', text: 'x' });
    const address = tableView(docs, { path: ['address'] });
    expect(address.rows.map((r) => r.document)).toEqual([0, 2]);
    expect(address.rows[0]!.cells.find((c) => c.drill)?.drill).toEqual(['address', 'geo']);
  });

  it('bounds columns and cell text', () => {
    const wide = parseShellDocument(
      `{ ${Array.from({ length: 20 }, (_, i) => `f${i}: 'x'`).join(', ')} }`,
    );
    const view = tableView([wide], { maxColumns: 5 });
    expect(view.columns).toHaveLength(5);
    expect(view.truncatedColumns).toBe(true);
    expect(cellText('x'.repeat(10), 4)).toBe('xxxx…');
  });

  it('reads and replaces values at a path, keeping field order', () => {
    const doc = docs[0]!;
    expect(valueAtPath(doc, ['address', 'geo', 'lat'])).toBeDefined();
    expect(valueAtPath(doc, ['tags', 1])).toBe('b');
    expect(valueAtPath(doc, ['tags', 'x'])).toBeUndefined();
    const updated = withValueAt(doc, ['address', 'city'], 'Paris');
    expect(toEjson(valueAtPath(updated, ['address']))).toBe(
      toEjson(parseShellDocument("{ city: 'Paris', geo: { lat: 51.5 } }")),
    );
    expect(Object.keys(withValueAt(doc, ['name'], undefined) as object)).toEqual([
      '_id',
      'address',
      'tags',
    ]);
    expect(withValueAt(doc, ['tags', 0], undefined)).toMatchObject({ tags: ['b'] });
    expect(withValueAt(doc, ['new'], new Int32(1))).toMatchObject({ new: new Int32(1) });
    expect(() => withValueAt(doc, ['missing', 'x'], 1)).toThrow('No field');
  });
});
