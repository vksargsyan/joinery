import { tableDefSchema, type TableDef } from '@joinery/core';
import {
  ChangeSet,
  DEFAULT,
  and,
  condition,
  describeColumns,
  type ColumnInfo,
} from '@joinery/table-data';
import { describe, expect, it } from 'vitest';

import {
  addChild,
  checkRawCondition,
  compileDraft,
  draftFromFilter,
  emptyFilter,
  hasConditions,
  newCondition,
  operandShape,
  removeNode,
  setConditionColumn,
  splitList,
  updateNode,
  type ConditionDraft,
  type GroupDraft,
} from '../src/renderer/src/state/table/filter-draft';
import {
  cellValue,
  displayCell,
  gridRowCount,
  insertKeys,
  rowAt,
  rowStatus,
  selectionStats,
  type LoadedRows,
} from '../src/renderer/src/state/table/grid-model';
import { nextSort, sortMark } from '../src/renderer/src/state/table/sort';

const items: TableDef = tableDefSchema.parse({
  name: 'items',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
    { name: 'name', ordinal: 2, dataType: 'text', nullable: true },
    { name: 'qty', ordinal: 3, dataType: 'integer', nullable: false, default: '0' },
    { name: 'price', ordinal: 4, dataType: 'numeric(10,2)', nullable: true },
    { name: 'born', ordinal: 5, dataType: 'date', nullable: true },
    { name: 'active', ordinal: 6, dataType: 'boolean', nullable: true },
  ],
  primaryKey: { name: 'items_pkey', columns: ['id'] },
});
const columns: ColumnInfo[] = describeColumns(items, { dialect: 'postgres' });
const byName = (name: string): ColumnInfo => columns.find((c) => c.name === name)!;

function withConditions(...conditions: Partial<ConditionDraft>[]): GroupDraft {
  let root = emptyFilter();
  for (const patch of conditions) {
    const base = newCondition(byName(patch.column ?? 'id'), 'postgres');
    root = addChild(root, root.id, { ...base, ...patch });
  }
  return root;
}

describe('filter builder draft', () => {
  it('compiles conditions with operands parsed for their columns', () => {
    const root = withConditions(
      { column: 'qty', operator: '>=', text: '25' },
      { column: 'name', operator: 'contains', text: '50%' },
      { column: 'born', operator: 'between', text: '2026-1-2', text2: '2026-12-31' },
    );
    const { filter, issues } = compileDraft(root, columns, 'postgres');
    expect(issues).toEqual({});
    expect(filter).toEqual(
      and(
        condition('qty', '>=', 25),
        condition('name', 'contains', '50%'),
        condition('born', 'between', ['2026-01-02', '2026-12-31']),
      ),
    );
  });

  it('reports unparsable operands on the condition that holds them and runs nothing', () => {
    const root = withConditions(
      { column: 'qty', operator: '=', text: 'many' },
      { column: 'price', operator: '<', text: '1.234' },
    );
    const [qty, price] = root.children as ConditionDraft[];
    const { issues } = compileDraft(root, columns, 'postgres');
    expect(issues[qty!.id]).toBe('Expected a whole number');
    expect(issues[price!.id]).toBe('At most 2 digits after the decimal point');
  });

  it('reads in-lists with quotes and NULL', () => {
    expect(splitList('a, "b,c", NULL, "NULL", ""')).toEqual([
      { text: 'a', isNull: false },
      { text: 'b,c', isNull: false },
      { text: 'NULL', isNull: true },
      { text: 'NULL', isNull: false },
      { text: '', isNull: false },
    ]);
    const root = withConditions({ column: 'id', operator: 'in', text: '1, 2, null' });
    expect(compileDraft(root, columns, 'postgres').filter).toEqual(
      and(condition('id', 'in', [1, 2, null])),
    );
    const empty = withConditions({ column: 'id', operator: 'in', text: ' ' });
    expect(Object.values(compileDraft(empty, columns, 'postgres').issues)).toEqual([
      'Type one or more values, separated by commas',
    ]);
  });

  it('keeps disabled conditions and empty groups out of the query', () => {
    let root = withConditions({ column: 'qty', operator: '>', text: '1', disabled: true });
    expect(compileDraft(root, columns, 'postgres').filter).toBeUndefined();
    expect(hasConditions(root)).toBe(false);
    const group: GroupDraft = { ...emptyFilter(), combinator: 'or' };
    root = addChild(root, root.id, group);
    root = addChild(root, group.id, { ...newCondition(byName('active'), 'postgres') });
    const compiled = compileDraft(root, columns, 'postgres');
    expect(compiled.filter).toEqual(
      and({ type: 'group', combinator: 'or', children: [condition('active', 'is-true')] }),
    );
  });

  it('maps the engine’s own issues back to the draft node', () => {
    const root = withConditions(
      { column: 'name', operator: 'is-null' },
      { column: 'qty', operator: 'is-true' },
    );
    const [, qty] = root.children as ConditionDraft[];
    expect(compileDraft(root, columns, 'postgres').issues).toEqual({
      [qty!.id]: '"is-true" does not apply to integer column qty',
    });
    const gone = addChild(root, root.id, { ...qty!, id: 'x', column: 'gone' });
    expect(compileDraft(gone, columns, 'postgres').issues['x']).toBe('Unknown column gone');
  });

  it('edits the tree by node id', () => {
    const root = withConditions({ column: 'qty', operator: '=', text: '1' });
    const [first] = root.children as ConditionDraft[];
    const changed = updateNode(root, first!.id, { text: '2' });
    expect((changed.children[0] as ConditionDraft).text).toBe('2');
    expect(root.children[0]).toBe(first);
    expect(removeNode(changed, first!.id).children).toEqual([]);
    expect(removeNode(changed, changed.id).children).toEqual([]);
  });

  it('keeps an operator the new column offers and replaces one it does not', () => {
    const numeric = { ...newCondition(byName('qty'), 'postgres'), operator: '>' as const };
    expect(setConditionColumn(numeric, byName('price'), 'postgres').operator).toBe('>');
    expect(setConditionColumn(numeric, byName('active'), 'postgres').operator).toBe('is-true');
    expect(operandShape('is-null')).toBe('none');
    expect(operandShape('not-in')).toBe('list');
    expect(operandShape('between')).toBe('range');
  });

  it('turns an engine filter back into a draft (a referenced row)', () => {
    const draft = draftFromFilter(
      and(condition('id', '=', 7n), condition('name', 'in', ['a,b', null])),
    );
    const compiled = compileDraft(draft, columns, 'postgres');
    expect(compiled.issues).toEqual({});
    expect(compiled.filter).toEqual(
      and(condition('id', '=', 7), condition('name', 'in', ['a,b', null])),
    );
  });

  it('checks the raw WHERE box before it runs', () => {
    expect(checkRawCondition('  ', 'postgres')).toBeUndefined();
    expect(checkRawCondition('qty > 1', 'postgres')).toMatchObject({ ok: true });
    expect(checkRawCondition('qty > 1; drop table items', 'postgres')).toMatchObject({
      ok: false,
      message: 'Only one condition is allowed: remove the ";"',
      position: 7,
    });
  });
});

describe('server-side sort', () => {
  it('cycles a column through ascending, descending and off', () => {
    let sort = nextSort([], 'name', false);
    expect(sort).toEqual([{ column: 'name', direction: 'asc' }]);
    sort = nextSort(sort, 'name', false);
    expect(sort).toEqual([{ column: 'name', direction: 'desc' }]);
    expect(nextSort(sort, 'name', false)).toEqual([]);
    expect(nextSort(sort, 'qty', false)).toEqual([{ column: 'qty', direction: 'asc' }]);
  });

  it('adds and cycles columns within a multi-column sort with Shift', () => {
    let sort = nextSort([{ column: 'name', direction: 'asc' }], 'qty', true);
    expect(sort).toEqual([
      { column: 'name', direction: 'asc' },
      { column: 'qty', direction: 'asc' },
    ]);
    sort = nextSort(sort, 'name', true);
    expect(sort[0]).toEqual({ column: 'name', direction: 'desc' });
    expect(sortMark(sort, 'qty')).toBe('▲2');
    expect(nextSort(sort, 'name', true)).toEqual([{ column: 'qty', direction: 'asc' }]);
    expect(sortMark([{ column: 'qty', direction: 'desc' }], 'qty')).toBe('▼');
  });
});

describe('grid model', () => {
  const loaded: LoadedRows = {
    columns: ['id', 'name', 'qty'],
    rows: [
      [1, 'a', 3],
      [2, null, 4],
    ],
    keys: ['n1', 'n2'],
  };

  it('shows loaded rows, then staged inserts, with staged values over loaded ones', () => {
    const changes = ChangeSet.empty()
      .edit({ key: 'n1', values: { id: 1, name: 'a', qty: 3 } }, 'name', 'b')
      .delete({ key: 'n2', values: { id: 2, name: null, qty: 4 } })
      .insert({ name: 'new' });
    const inserts = insertKeys(changes);
    expect(gridRowCount(loaded, changes)).toBe(3);
    const first = rowAt(loaded, inserts, 0)!;
    const inserted = rowAt(loaded, inserts, 2)!;
    expect(rowAt(loaded, inserts, 3)).toBeUndefined();
    expect(cellValue(loaded, changes, first, 1)).toBe('b');
    expect(cellValue(loaded, changes, inserted, 1)).toBe('new');
    expect(cellValue(loaded, changes, inserted, 2)).toEqual(DEFAULT);
    expect(rowStatus(changes, first)).toBe('edited');
    expect(rowStatus(changes, rowAt(loaded, inserts, 1)!)).toBe('deleted');
    expect(rowStatus(changes, inserted)).toBe('inserted');
  });

  it('draws NULL, the empty string and DEFAULT as distinct states, long values as previews', () => {
    expect(displayCell(null)).toEqual({ text: 'NULL', state: 'null', truncated: false });
    expect(displayCell('')).toEqual({ text: "''", state: 'empty', truncated: false });
    expect(displayCell(DEFAULT)).toEqual({ text: 'DEFAULT', state: 'default', truncated: false });
    expect(displayCell('a\nb')).toMatchObject({ text: 'a↵b', state: 'value' });
    const long = displayCell('x'.repeat(500));
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(201);
    expect(displayCell(new Uint8Array(40).fill(255)).text).toMatch(/^0x(ff){32}… \(40 bytes\)$/);
    expect(
      displayCell({ $handle: 'h1', preview: 'abc', byteLength: 9_000_000, kind: 'text' }),
    ).toEqual({ text: 'abc…', state: 'preview', truncated: true });
  });

  it('sums, averages and ranges the numeric cells of a selection', () => {
    const cells = [
      { value: 3, column: byName('qty') },
      { value: 4n, column: byName('qty') },
      { value: '2.50', column: byName('price') },
      { value: null, column: byName('price') },
      { value: 'x', column: byName('name') },
    ];
    expect(selectionStats(cells, 3)).toEqual({
      cells: 5,
      rows: 3,
      numeric: { count: 3, sum: 9.5, avg: 9.5 / 3, min: 2.5, max: 4 },
    });
    expect(selectionStats([{ value: 'x', column: byName('name') }], 1)).toEqual({
      cells: 1,
      rows: 1,
    });
  });
});
