import type { SchemaSnapshot } from '@joinery/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tableId } from '../src/renderer/src/state/er-diagram/model';
import { shop } from './er-fixtures';

const mocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  saveFile: vi.fn(),
  writeFile: vi.fn(),
  runScript: vi.fn(),
  patchPanel: vi.fn(),
  laneClosed: vi.fn(),
  profile: {
    id: 'p1',
    name: 'Shop',
    engine: 'postgres',
    presentation: { readOnly: false, environment: 'dev' },
  } as {
    id: string;
    name: string;
    engine: string;
    presentation: { readOnly: boolean; environment: string };
  },
}));

vi.mock('../src/renderer/src/state/metadata', () => ({
  loadSnapshot: mocks.loadSnapshot,
  metadataCache: { refresh: mocks.refresh },
  invalidateMetadata: mocks.invalidate,
}));
vi.mock('../src/renderer/src/lib/main-client', () => ({
  mainApi: () => ({ dialogs: { saveFile: mocks.saveFile, writeFile: mocks.writeFile } }),
}));
vi.mock('../src/renderer/src/lib/clipboard', () => ({ copyToClipboard: () => true }));
vi.mock('../src/renderer/src/state/data', () => ({
  cachedProfile: () => mocks.profile,
  profileById: async () => mocks.profile,
}));
vi.mock('../src/renderer/src/state/designer', () => ({ runScript: mocks.runScript }));
vi.mock('../src/renderer/src/state/panels', () => ({ patchPanel: mocks.patchPanel }));
vi.mock('../src/renderer/src/state/session-lane', () => ({
  SessionLane: class {
    readonly database: string | undefined;
    constructor(_profile: string, database?: string) {
      this.database = database;
    }
    close(): Promise<void> {
      mocks.laneClosed(this.database);
      return Promise.resolve();
    }
  },
}));

const { ErDiagramView } = await import('../src/renderer/src/state/er-diagram/view');

const target = {
  profileId: 'p1',
  dialect: 'postgres' as const,
  database: 'shop',
  schema: 'public',
};
const id = (name: string): string => tableId('public', name);

async function editing() {
  const view = new ErDiagramView('panel', target);
  await view.load();
  view.startEditing();
  const editor = view.state.editor;
  if (!editor) throw new Error('not editing');
  return { view, editor };
}

describe('editing an ER diagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profile.presentation.readOnly = false;
    mocks.loadSnapshot.mockResolvedValue(shop());
  });

  it('edits one schema of a connection that is not read-only', async () => {
    const all = new ErDiagramView('panel', { ...target, schema: undefined });
    await all.load();
    expect(all.editBlocker()).toBe('Choose a schema to edit it');
    all.startEditing();
    expect(all.state.editor).toBeUndefined();
    expect(all.state.notice).toEqual({ kind: 'error', text: 'Choose a schema to edit it' });

    mocks.profile.presentation.readOnly = true;
    const view = new ErDiagramView('panel', target);
    await view.load();
    expect(view.editBlocker()).toBe('The connection is read-only');
    mocks.profile.presentation.readOnly = false;
    expect(view.editBlocker()).toBeUndefined();
    view.startEditing();
    expect(view.state.editor?.context).toEqual({ engine: 'postgres', schema: 'public' });
  });

  it('draws the model, marks what changed and flags the panel as unsaved', async () => {
    const { view, editor } = await editing();
    const before = Object.keys(view.state.positions).length;
    const name = editor.addTable({ x: 10, y: 20 });
    expect(name).toBe('new_table');
    expect(view.state.diagram!.tables.some((t) => t.name === 'new_table')).toBe(true);
    expect(view.state.positions[id('new_table')]).toEqual({ x: 10, y: 20 });
    expect(Object.keys(view.state.positions)).toHaveLength(before + 1);
    expect(view.state.selected).toBe(id('new_table'));
    expect(editor.state.changes.tables.get('new_table')).toBe('new');
    expect(mocks.patchPanel).toHaveBeenLastCalledWith('panel', { dirty: true });

    // Without a place, a new table goes to the right of the diagram.
    editor.addTable();
    const spot = view.state.positions[id('new_table_2')]!;
    const others = Object.entries(view.state.positions).filter(
      ([key]) => key !== id('new_table_2'),
    );
    expect(spot.x).toBeGreaterThan(Math.max(...others.map(([, p]) => p.x)));
  });

  it('keeps a renamed table where it was, and its relationships', async () => {
    const { view, editor } = await editing();
    const place = view.state.positions[id('customers')];
    expect(editor.renameTable('customers', ' clients ')).toBe(true);
    expect(view.state.positions[id('clients')]).toEqual(place);
    expect(view.state.positions[id('customers')]).toBeUndefined();
    expect(
      view.state.diagram!.relations.filter((r) => r.parent === id('clients')).map((r) => r.name),
    ).toEqual(['customer_profiles_customer_id_fkey', 'orders_customer_id_fkey']);
  });

  it('undoes and redoes, and says what the model refuses', async () => {
    const { view, editor } = await editing();
    expect(editor.state.canUndo).toBe(false);
    editor.addColumn('orders');
    expect(editor.state.focusColumn).toEqual({ table: 'orders', column: 'column5' });
    editor.updateColumn('orders', 'column5', { name: 'placed_at', dataType: 'date' });
    expect(editor.state.canUndo).toBe(true);
    editor.undo();
    expect(editor.state.changes.columns.get('orders')?.has('column5')).toBe(true);
    editor.undo();
    expect(editor.state.changes.count).toBe(0);
    expect(mocks.patchPanel).toHaveBeenLastCalledWith('panel', { dirty: false });
    expect(editor.state.canRedo).toBe(true);
    editor.redo();
    editor.redo();
    expect(editor.state.changes.columns.get('orders')?.get('placed_at')).toBe('new');
    expect(editor.state.canRedo).toBe(false);

    expect(editor.renameTable('orders', 'customers')).toBe(false);
    expect(view.state.notice).toEqual({
      kind: 'error',
      text: 'There is already a table or view named customers',
    });
    // A refused edit is not a step of the history.
    editor.undo();
    expect(editor.state.changes.columns.get('orders')?.has('placed_at')).toBe(false);
  });

  it('validates the changed tables', async () => {
    const { editor } = await editing();
    editor.updateColumn('orders', 'total', { dataType: 'nonsense(' });
    expect(editor.state.issues).toContainEqual(
      expect.objectContaining({ table: 'orders', column: 'total', severity: 'error' }),
    );
  });

  it('adds a relationship and selects it on the canvas', async () => {
    const { view, editor } = await editing();
    expect(editor.addRelation({ child: 'employees', parent: 'customers' })).toBe(
      'employees_customer_id_fkey',
    );
    expect(view.state.selectedRelation).toBe(
      JSON.stringify(['public', 'employees', 'employees_customer_id_fkey']),
    );
    expect(view.state.selected).toBeUndefined();
  });

  it('reviews the script and applies it on the diagram’s database', async () => {
    const { view, editor } = await editing();
    editor.review();
    expect(editor.state.review).toBeUndefined();
    expect(view.state.notice?.text).toContain('nothing to apply');

    editor.renameTable('orders', 'purchases');
    editor.review();
    expect(editor.state.review?.statements).toEqual([
      'BEGIN',
      'ALTER TABLE "public"."orders" RENAME TO "purchases"',
      'COMMIT',
    ]);
    mocks.runScript.mockResolvedValueOnce({ ok: true });
    expect(await editor.apply()).toBe(true);
    expect(mocks.runScript).toHaveBeenCalledWith(
      expect.anything(),
      mocks.profile,
      'postgres',
      editor.state.review?.statements ?? expect.any(Array),
      true,
    );
    expect(mocks.laneClosed).toHaveBeenCalledWith('shop');
    expect(view.state.editor).toBeUndefined();
    expect(view.state.notice).toEqual({ kind: 'success', text: 'Applied 1 change to public' });
    expect(mocks.invalidate).toHaveBeenCalledWith('p1');
    expect(mocks.patchPanel).toHaveBeenCalledWith('panel', { dirty: false });
  });

  it('keeps the model when the script fails or is cancelled', async () => {
    const { view, editor } = await editing();
    editor.dropTable('employees');
    editor.review();
    mocks.runScript.mockResolvedValueOnce({ ok: false, cancelled: true });
    expect(await editor.apply()).toBe(false);
    expect(editor.state.review).toBeDefined();
    mocks.runScript.mockResolvedValueOnce({ ok: false, cancelled: false, message: 'lock timeout' });
    expect(await editor.apply()).toBe(false);
    expect(view.state.editor).toBe(editor);
    expect(view.state.notice).toEqual({ kind: 'error', text: 'lock timeout' });
    expect(editor.state.changes.dropped).toEqual(['employees']);
    // PostgreSQL rolled the whole script back: nothing to read again.
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('notes a change on the server while editing, without touching the model', async () => {
    const { view, editor } = await editing();
    editor.addTable();
    const changed: SchemaSnapshot = {
      ...shop(),
      schemas: shop().schemas.map((s) =>
        s.name === 'public' ? { ...s, tables: s.tables.filter((t) => t.name !== 'employees') } : s,
      ),
    };
    mocks.loadSnapshot.mockResolvedValueOnce(changed);
    await view.load();
    expect(editor.state.stale).toBe(true);
    expect(view.state.diagram!.tables.some((t) => t.name === 'new_table')).toBe(true);
    expect(view.state.diagram!.tables.some((t) => t.name === 'employees')).toBe(true);
  });

  it('discards the model and draws the live structure again', async () => {
    const { view, editor } = await editing();
    editor.addTable();
    editor.discard();
    expect(view.state.editor).toBeUndefined();
    expect(view.state.diagram!.tables.some((t) => t.name === 'new_table')).toBe(false);
    expect(mocks.patchPanel).toHaveBeenLastCalledWith('panel', { dirty: false });
  });

  it('saves the reviewed script as a file', async () => {
    const { view, editor } = await editing();
    editor.setTableComment('orders', 'Bought');
    editor.review();
    mocks.saveFile.mockResolvedValueOnce({ path: '/out/public-changes.sql' });
    await editor.saveScript();
    expect(mocks.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ defaultName: 'public-changes.sql' }),
    );
    expect(mocks.writeFile).toHaveBeenCalledWith({
      path: '/out/public-changes.sql',
      text: expect.stringContaining(`COMMENT ON TABLE "public"."orders" IS 'Bought';`),
    });
    expect(view.state.notice).toEqual({
      kind: 'success',
      text: 'Saved to /out/public-changes.sql',
    });
  });
});
