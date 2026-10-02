import { schemaSnapshotSchema } from '@joinery/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { column, shop } from './er-fixtures';
import { diagramMermaid } from '../src/renderer/src/state/er-diagram/mermaid';
import { markerSvg } from '../src/renderer/src/state/er-diagram/markers';
import {
  BOX,
  anchorY,
  boxSize,
  describeRelation,
  erDiagram,
  keyLetters,
  matchingTables,
  neighbourhood,
  relationColumns,
  tableId,
  tableLabel,
  visibleColumns,
  type ErDiagram,
  type ErTable,
} from '../src/renderer/src/state/er-diagram/model';
import { STUB, relationRoute, roundedPath } from '../src/renderer/src/state/er-diagram/route';
import { LIGHT_PALETTE, diagramSvg, escapeXml } from '../src/renderer/src/state/er-diagram/svg';

const mocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  refresh: vi.fn(),
  saveFile: vi.fn(),
  writeFile: vi.fn(),
  copy: vi.fn(),
}));

vi.mock('../src/renderer/src/state/metadata', () => ({
  loadSnapshot: mocks.loadSnapshot,
  metadataCache: { refresh: mocks.refresh },
}));
vi.mock('../src/renderer/src/lib/main-client', () => ({
  mainApi: () => ({ dialogs: { saveFile: mocks.saveFile, writeFile: mocks.writeFile } }),
}));
vi.mock('../src/renderer/src/lib/clipboard', () => ({ copyToClipboard: mocks.copy }));

const { ErDiagramView } = await import('../src/renderer/src/state/er-diagram/view');

function table(diagram: ErDiagram, label: string): ErTable {
  const found = diagram.tables.find((t) => tableLabel(diagram, t) === label);
  if (!found) throw new Error(`no table ${label}`);
  return found;
}

function relation(diagram: ErDiagram, name: string) {
  const found = diagram.relations.find((r) => r.name === name);
  if (!found) throw new Error(`no relation ${name}`);
  return found;
}

// ---------------------------------------------------------------------------------------------

describe('the ER model', () => {
  it('draws every schema with qualified names and a relationship per foreign key', () => {
    const diagram = erDiagram(shop(), 'postgres');
    expect(diagram.schemas).toEqual(['public', 'sales']);
    expect(diagram.tables.map((t) => tableLabel(diagram, t))).toEqual([
      'public.customer_profiles',
      'public.customers',
      'public.employees',
      'public.orders',
      'sales.invoices',
    ]);
    expect(diagram.relations).toHaveLength(4);
    const invoices = relation(diagram, 'invoices_order_id_fkey');
    expect(invoices.child).toBe(tableId('sales', 'invoices'));
    expect(invoices.parent).toBe(tableId('public', 'orders'));
    expect(diagram.tables.some((t) => t.external)).toBe(false);
  });

  it('reads the crow’s-foot ends from nullability and keys', () => {
    const diagram = erDiagram(shop(), 'postgres', { schema: 'public' });
    // NOT NULL foreign key: exactly one customer, zero or many orders.
    expect(relation(diagram, 'orders_customer_id_fkey')).toMatchObject({
      parentEnd: 'one',
      childEnd: 'zero-or-many',
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
    });
    // The foreign key is the primary key: one to one.
    expect(relation(diagram, 'customer_profiles_customer_id_fkey')).toMatchObject({
      parentEnd: 'one',
      childEnd: 'zero-or-one',
    });
    // A nullable self-reference: zero or one manager.
    const manager = relation(diagram, 'employees_manager_id_fkey');
    expect(manager.child).toBe(manager.parent);
    expect(manager).toMatchObject({ parentEnd: 'zero-or-one', childEnd: 'zero-or-many' });
  });

  it('marks keys on the columns', () => {
    const diagram = erDiagram(shop(), 'postgres', { schema: 'public' });
    const customers = table(diagram, 'customers');
    expect(customers.comment).toBe('People who buy');
    expect(customers.columns.map((c) => keyLetters(c).join(''))).toEqual(['P', '', 'U']);
    expect(table(diagram, 'customer_profiles').columns[0]).toMatchObject({
      primaryKey: true,
      foreignKey: true,
      unique: false,
    });
    expect(keyLetters(table(diagram, 'customer_profiles').columns[0]!)).toEqual(['P', 'F']);
  });

  it('shows one schema, with tables it reaches elsewhere as stubs', () => {
    const diagram = erDiagram(shop(), 'postgres', { schema: 'sales' });
    expect(diagram.schemas).toEqual(['sales']);
    const orders = table(diagram, 'public.orders');
    expect(orders).toMatchObject({ external: true, kind: 'table' });
    // Only the referenced columns, with what the snapshot knows of them.
    expect(orders.columns).toEqual([
      {
        name: 'id',
        type: 'integer',
        nullable: false,
        primaryKey: true,
        foreignKey: false,
        unique: false,
      },
    ]);
    expect(tableLabel(diagram, table(diagram, 'invoices'))).toBe('invoices');
    // External tables come last.
    expect(diagram.tables.at(-1)).toBe(orders);
  });

  it('adds the views when asked', () => {
    const without = erDiagram(shop(), 'postgres', { schema: 'public' });
    expect(without.tables.some((t) => t.name === 'order_totals')).toBe(false);
    const withViews = erDiagram(shop(), 'postgres', { schema: 'public', includeViews: true });
    expect(table(withViews, 'order_totals')).toMatchObject({
      kind: 'view',
      columns: [
        expect.objectContaining({ name: 'customer_id', type: undefined }),
        expect.objectContaining({ name: 'total' }),
      ],
    });
  });

  it('names MySQL tables by the database', () => {
    const snapshot = schemaSnapshotSchema.parse({
      engine: 'mysql',
      database: 'shop',
      capturedAt: '2026-09-30T00:00:00Z',
      schemas: [
        {
          name: 'shop',
          tables: [
            {
              name: 'a',
              columns: [column('id', 1, 'int', false)],
              primaryKey: { name: 'PRIMARY', columns: ['id'] },
            },
            {
              name: 'b',
              columns: [column('a_id', 1, 'int')],
              foreignKeys: [{ name: 'b_a', columns: ['a_id'], refTable: 'a', refColumns: ['id'] }],
            },
          ],
        },
      ],
    });
    const diagram = erDiagram(snapshot, 'mysql', { schema: 'ignored' });
    expect(diagram.schemas).toEqual(['shop']);
    expect(diagram.relations[0]).toMatchObject({
      child: tableId('shop', 'b'),
      parent: tableId('shop', 'a'),
      parentEnd: 'zero-or-one',
    });
    expect(diagram.tables.map((t) => tableLabel(diagram, t))).toEqual(['a', 'b']);
  });

  it('lists all columns, the keys and related ones, or none', () => {
    const diagram = erDiagram(shop(), 'postgres', { schema: 'public' });
    const related = relationColumns(diagram);
    const orders = table(diagram, 'orders');
    expect(visibleColumns(orders, 'all', related.get(orders.id))).toHaveLength(4);
    expect(visibleColumns(orders, 'keys', related.get(orders.id)).map((c) => c.name)).toEqual([
      'id',
      'customer_id',
    ]);
    expect(visibleColumns(orders, 'none', related.get(orders.id))).toEqual([]);
    const stub = table(erDiagram(shop(), 'postgres', { schema: 'sales' }), 'public.orders');
    expect(visibleColumns(stub, 'keys', undefined)).toHaveLength(1);
  });

  it('sizes boxes from their text, within bounds', () => {
    const diagram = erDiagram(shop(), 'postgres', { schema: 'public' });
    const orders = table(diagram, 'orders');
    const all = boxSize(diagram, orders, orders.columns, true);
    expect(all.height).toBe(BOX.header + 4 * BOX.row + BOX.padding);
    expect(all.width).toBeGreaterThanOrEqual(BOX.minWidth);
    expect(boxSize(diagram, orders, [], true)).toEqual({ width: BOX.minWidth, height: BOX.header });
    const long = { ...orders, name: 'x'.repeat(200) };
    expect(boxSize(diagram, long, [], false).width).toBe(BOX.maxWidth);
    // Types make boxes wider, never narrower.
    expect(all.width).toBeGreaterThanOrEqual(boxSize(diagram, orders, orders.columns, false).width);
  });

  it('anchors relationship lines on column rows, or the header', () => {
    const columns = table(erDiagram(shop(), 'postgres'), 'public.orders').columns;
    expect(anchorY(columns, 'id')).toBe(BOX.header + BOX.row / 2);
    expect(anchorY(columns, 'customer_id')).toBe(BOX.header + BOX.row * 1.5);
    expect(anchorY([], 'customer_id')).toBe(BOX.header / 2);
    expect(anchorY(columns, undefined)).toBe(BOX.header / 2);
  });

  it('finds neighbours and search matches, and describes relationships', () => {
    const diagram = erDiagram(shop(), 'postgres', { schema: 'public' });
    const customers = tableId('public', 'customers');
    const near = neighbourhood(diagram, customers);
    expect([...near.tables].sort()).toEqual(
      [customers, tableId('public', 'orders'), tableId('public', 'customer_profiles')].sort(),
    );
    expect(near.relations.size).toBe(2);
    expect([...matchingTables(diagram, ' BIO ')]).toEqual([tableId('public', 'customer_profiles')]);
    expect(matchingTables(diagram, '  ').size).toBe(0);
    expect(describeRelation(diagram, relation(diagram, 'orders_customer_id_fkey'))).toBe(
      'one to many: orders (customer_id) references customers (id)',
    );
  });
});

describe('relationship lines', () => {
  const left = { x: 0, y: 0, width: 200, height: 100 };
  const right = { x: 400, y: 50, width: 200, height: 100 };

  it('crosses the gap between boxes side by side, turning halfway', () => {
    const route = relationRoute(left, 20, right, 80);
    expect(route.points).toEqual([
      { x: 200, y: 20 },
      { x: 300, y: 20 },
      { x: 300, y: 80 },
      { x: 400, y: 80 },
    ]);
    expect(route.label).toEqual({ x: 300, y: 50 });
    const back = relationRoute(right, 80, left, 20);
    expect(back.points[0]).toEqual({ x: 400, y: 80 });
    expect(back.points.at(-1)).toEqual({ x: 200, y: 20 });
  });

  it('goes around the nearer side of boxes above one another', () => {
    const below = { x: 20, y: 300, width: 200, height: 100 };
    const route = relationRoute(left, 20, below, 320);
    expect(route.points).toEqual([
      { x: 200, y: 20 },
      { x: 220 + STUB, y: 20 },
      { x: 220 + STUB, y: 320 },
      { x: 220, y: 320 },
    ]);
    // The shorter way round: left, past the narrower box's nearer edge.
    const shifted = { x: -40, y: 300, width: 100, height: 100 };
    expect(relationRoute(left, 20, shifted, 320).points[1]).toEqual({ x: -40 - STUB, y: 20 });
  });

  it('loops a self-reference off the right side, between two rows', () => {
    const route = relationRoute(left, 60, left, 20);
    expect(route.points[0]).toEqual({ x: 200, y: 60 });
    expect(route.points[1]!.x).toBeGreaterThan(200 + STUB);
    expect(route.points.at(-1)).toEqual({ x: 200, y: 20 });
    // Both ends on the header: the loop still has height.
    const header = relationRoute(left, 16, left, 16);
    expect(header.points[0]!.y).toBeLessThan(header.points.at(-1)!.y);
  });

  it('leaves room for the glyph at both ends', () => {
    for (const [a, b] of [
      [left, right],
      [right, left],
      [left, { x: 150, y: 300, width: 100, height: 50 }],
    ] as const) {
      const { points } = relationRoute(a, 30, b, 330);
      const first = Math.abs(points[1]!.x - points[0]!.x);
      const last = Math.abs(points.at(-1)!.x - points.at(-2)!.x);
      expect(Math.min(first, last)).toBeGreaterThanOrEqual(STUB);
    }
  });

  it('rounds the corners', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 40 },
        { x: 100, y: 40 },
      ]),
    ).toBe('M0 0 L40 0 Q50 0 50 10 L50 30 Q50 40 60 40 L100 40');
    // A straight line has no corners; repeated points are dropped.
    expect(
      roundedPath([
        { x: 0, y: 5 },
        { x: 0, y: 5 },
        { x: 30, y: 5 },
        { x: 60, y: 5 },
      ]),
    ).toBe('M0 5 L60 5');
    expect(roundedPath([])).toBe('');
  });
});

describe('the exported SVG', () => {
  const diagram = erDiagram(shop(), 'postgres', { schema: 'public' });
  const positions = Object.fromEntries(
    diagram.tables.map((t, i) => [t.id, { x: (i % 2) * 400, y: Math.floor(i / 2) * 250 }]),
  );

  it('draws the boxes, the keys and the relationship ends', () => {
    const { svg, width, height } = diagramSvg({
      diagram,
      positions,
      display: { columns: 'all', types: true },
      caption: 'shop · public — 4 tables',
    });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`width="${width}" height="${height}"`);
    // The boxes' extent and a 40px margin all round.
    expect(width).toBe(400 + widthOf(diagram) + 80);
    expect(svg).toContain('>shop · public — 4 tables<');
    for (const name of ['customers', 'orders', 'customer_profiles', 'employees']) {
      expect(svg).toContain(`>${name}<`);
    }
    expect(svg).toContain('numeric(10,2)');
    expect(svg).toContain('<tspan fill="#8f5d0e">P</tspan><tspan fill="#2d5bb5">F</tspan>');
    expect(svg).toContain(markerSvg('one', false, LIGHT_PALETTE.line, LIGHT_PALETTE.background));
    expect(svg.match(/<path d="M[^"]*" marker-start/g)).toHaveLength(3);
    expect(svg).toContain('marker-start="url(#er-zero-or-one)" marker-end="url(#er-one)"');
    // NOT NULL columns carry a star; the primary key does not.
    expect(svg).toContain(`name<tspan fill="${LIGHT_PALETTE.muted}"> *</tspan>`);
  });

  it('leaves out hidden tables and their lines, and the types when asked', () => {
    const hidden = new Set([tableId('public', 'customers')]);
    const { svg } = diagramSvg({
      diagram,
      positions,
      hidden,
      display: { columns: 'keys', types: false },
    });
    expect(svg).not.toContain('>customers<');
    expect(svg).not.toContain('numeric');
    expect(svg).not.toContain('>note<');
    expect(svg.match(/marker-start/g)).toHaveLength(1);
  });

  it('escapes names', () => {
    expect(escapeXml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  });
});

/** The widest box of the right-hand column in the fixture layout. */
function widthOf(diagram: ErDiagram): number {
  const related = relationColumns(diagram);
  return Math.max(
    ...diagram.tables
      .filter((_, i) => i % 2 === 1)
      .map((t) => boxSize(diagram, t, visibleColumns(t, 'all', related.get(t.id)), true).width),
  );
}

describe('the Mermaid export', () => {
  it('writes entities, keys and crow’s-foot lines', () => {
    const diagram = erDiagram(shop(), 'postgres', { schema: 'public' });
    const text = diagramMermaid(diagram);
    expect(text.split('\n')[0]).toBe('erDiagram');
    expect(text).toContain('    customers ||--o{ orders : "orders_customer_id_fkey"');
    expect(text).toContain(
      '    customers ||--o| customer_profiles : "customer_profiles_customer_id_fkey"',
    );
    expect(text).toContain('    employees |o--o{ employees : "employees_manager_id_fkey"');
    expect(text).toContain(
      '    orders {\n        integer id PK\n        integer customer_id FK\n        numeric(10_2) total\n',
    );
    expect(text).toContain('        integer customer_id PK, FK\n');
    expect(text).toContain('        text email UK\n');
  });

  it('qualifies names across schemas and cleans them for Mermaid', () => {
    const diagram = erDiagram(shop(), 'postgres');
    const text = diagramMermaid(diagram, {
      hidden: new Set([tableId('public', 'employees')]),
      types: false,
    });
    expect(text).toContain('public__orders ||--o{ sales__invoices');
    expect(text).toContain('public__orders["public.orders"] {');
    expect(text).toContain('        column id PK');
    expect(text).not.toContain('employees');
  });
});

describe('the ER diagram view', () => {
  const target = { profileId: 'p1', dialect: 'postgres' as const, database: 'shop' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSnapshot.mockResolvedValue(shop());
  });

  it('loads the database, lays it out and fits it', async () => {
    const view = new ErDiagramView('panel', target);
    expect(view.state.status).toBe('loading');
    await view.load();
    expect(mocks.loadSnapshot).toHaveBeenCalledWith('p1', {
      dialect: 'postgres',
      database: 'shop',
    });
    expect(view.state).toMatchObject({
      status: 'ready',
      schemas: ['public', 'sales'],
      laying: false,
    });
    expect(Object.keys(view.state.positions)).toHaveLength(5);
    expect(view.state.fit.seq).toBe(1);
    expect(view.caption()).toBe('shop — 5 tables, 4 relationships');
  });

  it('switches schema and views, keeping what the user did where it still applies', async () => {
    const view = new ErDiagramView('panel', { ...target, schema: 'public' });
    await view.load();
    expect(view.state.diagram!.schemas).toEqual(['public']);
    const orders = tableId('public', 'orders');
    view.move({ [orders]: { x: 999, y: 999 } });
    view.setHidden(tableId('public', 'employees'), true);
    await view.setIncludeViews(true);
    expect(view.state.diagram!.tables.some((t) => t.kind === 'view')).toBe(true);
    // The dragged box stays; the new view goes to the right of the diagram.
    expect(view.state.positions[orders]).toEqual({ x: 999, y: 999 });
    expect(view.state.positions[tableId('public', 'order_totals')]!.x).toBeGreaterThan(999 + 180);
    expect(view.state.hidden.size).toBe(1);
    // Another schema is laid out afresh (orders comes back as the stub of another schema).
    await view.setSchema('sales');
    expect(view.state.positions[orders]).not.toEqual({ x: 999, y: 999 });
    expect(view.state.hidden.size).toBe(0);
    expect(view.state.diagram!.tables.map((t) => t.name)).toEqual(['invoices', 'orders']);
  });

  it('forgets a schema that is gone', async () => {
    const view = new ErDiagramView('panel', { ...target, schema: 'archive' });
    await view.load();
    expect(view.state.schema).toBeUndefined();
    expect(view.state.diagram!.schemas).toEqual(['public', 'sales']);
  });

  it('selects, focuses, isolates and hides tables', async () => {
    const view = new ErDiagramView('panel', { ...target, schema: 'public' });
    await view.load();
    const customers = tableId('public', 'customers');
    const employees = tableId('public', 'employees');
    view.isolate(customers);
    expect(view.state.selected).toBe(customers);
    expect([...view.state.hidden]).toEqual([employees]);
    view.setHidden(customers, true);
    expect(view.state.selected).toBeUndefined();
    const seq = view.state.fit.seq;
    view.focus(customers);
    expect(view.state.hidden.has(customers)).toBe(false);
    expect(view.state.fit).toEqual({ seq: seq + 1, table: customers });
    view.showAll();
    expect(view.state.hidden.size).toBe(0);
    view.setSearch('bio');
    expect([...view.matches()]).toEqual([tableId('public', 'customer_profiles')]);
  });

  it('keeps the last diagram when a reload fails, and says why', async () => {
    const view = new ErDiagramView('panel', target);
    await view.load();
    mocks.loadSnapshot.mockRejectedValueOnce(new Error('connection lost'));
    mocks.refresh.mockRejectedValueOnce(new Error('connection lost'));
    await view.refresh();
    expect(mocks.refresh).toHaveBeenCalledWith('p1', ['shop']);
    expect(view.state).toMatchObject({ status: 'error', error: 'connection lost' });
    expect(view.state.diagram).toBeDefined();
  });

  it('lays out again when the columns shown change the box sizes', async () => {
    const view = new ErDiagramView('panel', { ...target, schema: 'public' });
    await view.load();
    const seq = view.state.fit.seq;
    await view.setColumns('none');
    expect(view.state.display).toEqual({ columns: 'none', types: true });
    expect(view.state.fit.seq).toBe(seq + 1);
    await view.setTypes(false);
    expect(view.state.display.types).toBe(false);
  });

  it('exports SVG, PNG and Mermaid through the save dialog', async () => {
    const view = new ErDiagramView('panel', { ...target, schema: 'public' });
    await view.load();
    mocks.saveFile.mockResolvedValueOnce({ path: '/out/shop-public-erd.svg' });
    await view.export('svg');
    expect(mocks.saveFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultName: 'shop-public-erd.svg' }),
    );
    expect(mocks.writeFile).toHaveBeenLastCalledWith({
      path: '/out/shop-public-erd.svg',
      text: expect.stringMatching(/^<svg /),
    });
    expect(view.state.notice).toEqual({
      kind: 'success',
      text: 'Saved to /out/shop-public-erd.svg',
    });

    mocks.saveFile.mockResolvedValueOnce({ path: '/out/d.png' });
    const rasterise = vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    await view.export('png', rasterise);
    expect(rasterise).toHaveBeenCalledWith(
      expect.stringMatching(/^<svg /),
      expect.any(Number),
      expect.any(Number),
      2,
    );
    expect(mocks.writeFile).toHaveBeenLastCalledWith({ path: '/out/d.png', base64: 'iVBORw==' });

    mocks.saveFile.mockResolvedValueOnce({ path: '/out/d.mmd' });
    await view.export('mermaid');
    expect(mocks.writeFile).toHaveBeenLastCalledWith({
      path: '/out/d.mmd',
      text: expect.stringMatching(/^erDiagram\n/),
    });

    // Cancelled: nothing written; a failure: said.
    mocks.saveFile.mockResolvedValueOnce({ path: null });
    await view.export('svg');
    expect(mocks.writeFile).toHaveBeenCalledTimes(3);
    mocks.saveFile.mockResolvedValueOnce({ path: '/out/e.svg' });
    mocks.writeFile.mockRejectedValueOnce(new Error('disk full'));
    await view.export('svg');
    expect(view.state.notice).toEqual({
      kind: 'error',
      text: 'The diagram could not be exported: disk full',
    });
    expect(view.state.exporting).toBe(false);
  });

  it('copies the diagram as Mermaid or SVG', async () => {
    const view = new ErDiagramView('panel', target);
    await view.load();
    mocks.copy.mockReturnValueOnce(true);
    view.copy('mermaid');
    expect(mocks.copy).toHaveBeenLastCalledWith(expect.stringMatching(/^erDiagram\n/));
    expect(view.state.notice).toEqual({ kind: 'success', text: 'Copied the diagram as Mermaid' });
    mocks.copy.mockReturnValueOnce(false);
    view.copy('svg');
    expect(view.state.notice?.kind).toBe('error');
  });
});
