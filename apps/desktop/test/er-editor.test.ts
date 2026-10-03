import type { SchemaSnapshot } from '@querybara/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tableId } from '../src/renderer/src/state/er-diagram/model';
import { shop } from './er-fixtures';

const mocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  saveFile: vi.fn(),
  writeFile: vi.fn(),
  openFile: vi.fn(),
  readFile: vi.fn(),
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  putDraft: vi.fn(),
  deleteDraft: vi.fn(),
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
  mainApi: () => ({
    dialogs: {
      saveFile: mocks.saveFile,
      writeFile: mocks.writeFile,
      openFile: mocks.openFile,
      readFile: mocks.readFile,
    },
    erModels: {
      listDrafts: mocks.listDrafts,
      getDraft: mocks.getDraft,
      putDraft: mocks.putDraft,
      deleteDraft: mocks.deleteDraft,
    },
  }),
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

/** Views made by a test: their editors are closed after it, so no draft timer outlives it. */
const views: InstanceType<typeof ErDiagramView>[] = [];

function track<T extends InstanceType<typeof ErDiagramView>>(view: T): T {
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.state.editor?.dispose();
});

async function editing() {
  const view = track(new ErDiagramView('panel', target));
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
    mocks.listDrafts.mockResolvedValue([]);
    mocks.putDraft.mockImplementation(async (input: { changes: number }) => ({
      ...input,
      savedAt: new Date().toISOString(),
    }));
    mocks.deleteDraft.mockResolvedValue({ deleted: true });
  });

  it('edits one schema of a connection that is not read-only', async () => {
    const all = new ErDiagramView('panel', { ...target, schema: undefined });
    await all.load();
    expect(all.editBlocker()).toBe('Choose a schema to edit it');
    all.startEditing();
    expect(all.state.editor).toBeUndefined();
    expect(all.state.notice).toEqual({ kind: 'error', text: 'Choose a schema to edit it' });

    mocks.profile.presentation.readOnly = true;
    const view = track(new ErDiagramView('panel', target));
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

describe('keeping and reopening ER models', () => {
  const key = { profileId: 'p1', database: 'shop', schema: 'public' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profile.engine = 'postgres';
    mocks.loadSnapshot.mockResolvedValue(shop());
    mocks.listDrafts.mockResolvedValue([]);
    mocks.putDraft.mockImplementation(async (input: { changes: number }) => ({
      ...input,
      savedAt: new Date().toISOString(),
    }));
    mocks.deleteDraft.mockResolvedValue({ deleted: true });
  });

  it('keeps the changes as a draft, and drops it once nothing is changed', async () => {
    const { view, editor } = await editing();
    expect(editor.state.kept).toBe('none');
    editor.renameTable('orders', 'purchases');
    expect(editor.state.kept).toBe('pending');
    editor.flush();
    await vi.waitFor(() => expect(editor.state.kept).toBe('kept'));
    const put = mocks.putDraft.mock.calls[0]![0] as {
      changes: number;
      document: { base: SchemaSnapshot; model: { tableOrigins: Record<string, string | null> } };
    };
    expect(put).toMatchObject({ ...key, changes: 1 });
    expect(put.document.base).toEqual(shop());
    expect(put.document.model.tableOrigins['purchases']).toBe('orders');

    // Moving a box is kept too.
    view.move({ [id('purchases')]: { x: 1, y: 2 } });
    editor.flush();
    await vi.waitFor(() => expect(mocks.putDraft).toHaveBeenCalledTimes(2));

    editor.undo();
    editor.flush();
    await vi.waitFor(() => expect(mocks.deleteDraft).toHaveBeenCalledWith(key));
    expect(editor.state.kept).toBe('none');
  });

  it('says once when the changes cannot be kept', async () => {
    const { view, editor } = await editing();
    mocks.putDraft.mockRejectedValue(new Error('disk full'));
    editor.renameTable('orders', 'purchases');
    editor.flush();
    await vi.waitFor(() => expect(editor.state.kept).toBe('failed'));
    expect(view.state.notice).toEqual({
      kind: 'error',
      text: 'The changes could not be kept for later: disk full',
    });
    view.note(undefined);
    editor.renameTable('purchases', 'orders_2');
    editor.flush();
    await vi.waitFor(() => expect(mocks.putDraft).toHaveBeenCalledTimes(2));
    expect(view.state.notice).toBeUndefined();
  });

  it('drops the draft once the changes are applied or discarded', async () => {
    const applied = await editing();
    applied.editor.renameTable('orders', 'purchases');
    applied.editor.flush();
    await vi.waitFor(() => expect(applied.editor.state.kept).toBe('kept'));
    applied.editor.review();
    mocks.runScript.mockResolvedValueOnce({ ok: true });
    await applied.editor.apply();
    expect(mocks.deleteDraft).toHaveBeenCalledWith(key);

    mocks.deleteDraft.mockClear();
    const discarded = await editing();
    discarded.editor.dropTable('employees');
    discarded.editor.flush();
    await vi.waitFor(() => expect(discarded.editor.state.kept).toBe('kept'));
    discarded.editor.discard();
    await vi.waitFor(() => expect(mocks.deleteDraft).toHaveBeenCalledWith(key));
  });

  it('writes a pending draft when the panel closes', async () => {
    const { editor } = await editing();
    editor.addTable();
    editor.dispose();
    await vi.waitFor(() => expect(mocks.putDraft).toHaveBeenCalledTimes(1));
    editor.addTable();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mocks.putDraft).toHaveBeenCalledTimes(1);
  });

  it('resumes the shown schema’s draft when the diagram opens', async () => {
    const { modelDocument, documentText, parseModelFile } =
      await import('../src/renderer/src/state/er-diagram/document');
    const { renameTable, startModel } = await import('../src/renderer/src/state/er-diagram/edit');
    const context = { engine: 'postgres' as const, schema: 'public' };
    const model = renameTable(startModel(shop(), context), context, 'orders', 'purchases');
    const parsed = parseModelFile(
      documentText(
        modelDocument({
          model,
          context,
          base: shop(),
          layout: {
            positions: { [id('purchases')]: { x: 500, y: 60 } },
            hidden: new Set(),
            display: { columns: 'keys', types: true },
            includeViews: false,
          },
          diagramSchema: 'public',
          savedAt: new Date().toISOString(),
        }),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const summary = { ...key, changes: 1, savedAt: new Date().toISOString() };
    mocks.listDrafts.mockResolvedValue([summary, { ...summary, schema: 'sales' }]);
    mocks.getDraft.mockResolvedValue({ ...summary, document: parsed.document });

    const view = track(new ErDiagramView('panel', target));
    await view.load();
    const editor = view.state.editor;
    expect(editor?.state.changes.tables.get('purchases')).toBe('changed');
    expect(editor?.state.kept).toBe('kept');
    expect(view.state.positions[id('purchases')]).toEqual({ x: 500, y: 60 });
    expect(view.state.display.columns).toBe('keys');
    expect(view.state.notice).toEqual({
      kind: 'info',
      text: 'Restored your unapplied changes to public (1 table, just now)',
    });
    // The other schema's draft is offered, not opened.
    expect(view.state.drafts.map((d) => d.schema)).toEqual(['public', 'sales']);

    // Reloading does not resume it again over the editor.
    mocks.getDraft.mockClear();
    await view.load();
    expect(mocks.getDraft).not.toHaveBeenCalled();
  });

  it('saves the shown schema as a model file, live or edited', async () => {
    const { parseModelFile } = await import('../src/renderer/src/state/er-diagram/document');
    const view = track(new ErDiagramView('panel', target));
    await view.load();
    mocks.saveFile.mockResolvedValueOnce({ path: '/m/shop-public.model.json' });
    await view.saveModelFile();
    expect(mocks.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ defaultName: 'shop-public.model.json' }),
    );
    const text = (mocks.writeFile.mock.calls[0]![0] as { text: string }).text;
    const saved = parseModelFile(text);
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.document.base).toBeUndefined();
    expect(saved.document.model.schemas[0]!.tables.map((t) => t.name)).toContain('orders');

    view.startEditing();
    view.state.editor!.renameTable('orders', 'purchases');
    mocks.saveFile.mockResolvedValueOnce({ path: '/m/edited.model.json' });
    await view.saveModelFile();
    const edited = parseModelFile((mocks.writeFile.mock.calls[1]![0] as { text: string }).text);
    expect(edited.ok && edited.document.model.tableOrigins['purchases']).toBe('orders');
    expect(view.state.notice).toEqual({
      kind: 'success',
      text: 'Saved the model to /m/edited.model.json',
    });
  });

  it('opens a model file on the database, in edit mode, to review', async () => {
    const { modelDocument, documentText } =
      await import('../src/renderer/src/state/er-diagram/document');
    const { startModel } = await import('../src/renderer/src/state/er-diagram/edit');
    const context = { engine: 'postgres' as const, schema: 'public' };
    const file = documentText(
      modelDocument({
        model: startModel(shop(), context),
        context,
        layout: {
          positions: {},
          hidden: new Set(),
          display: { columns: 'all', types: true },
          includeViews: false,
        },
        diagramSchema: 'public',
        savedAt: new Date().toISOString(),
      }),
    );
    const empty: SchemaSnapshot = {
      ...shop(),
      database: 'staging',
      schemas: shop().schemas.map((s) =>
        s.name === 'public' ? { ...s, tables: [], views: [] } : s,
      ),
    };
    mocks.loadSnapshot.mockResolvedValue(empty);
    const view = track(new ErDiagramView('panel', { ...target, database: 'staging' }));
    await view.load();

    mocks.openFile.mockResolvedValueOnce({ path: null });
    await view.openModelFile();
    expect(view.state.editor).toBeUndefined();

    mocks.openFile.mockResolvedValue({ path: '/m/shop.model.json' });
    mocks.readFile.mockResolvedValueOnce({ text: 'nonsense' });
    await view.openModelFile();
    expect(view.state.notice).toEqual({
      kind: 'error',
      text: 'The file is not a Querybara ER model (it is not JSON)',
    });

    mocks.readFile.mockResolvedValueOnce({ text: file.replace('"postgres"', '"mysql"') });
    await view.openModelFile();
    expect(view.state.notice?.text).toBe('The model is for MySQL; this connection is PostgreSQL');

    mocks.readFile.mockResolvedValueOnce({ text: file });
    await view.openModelFile();
    expect(mocks.readFile).toHaveBeenLastCalledWith({ path: '/m/shop.model.json' });
    const editor = view.state.editor!;
    expect(editor.base).toBe(empty);
    expect(editor.state.changes.count).toBe(4);
    expect([...editor.state.changes.tables.values()].every((mark) => mark === 'new')).toBe(true);
    expect(view.state.notice?.text).toBe(
      'Opened shop.model.json: it changes 4 tables of public. Review before applying.',
    );
    // An opened file is kept like any other change.
    editor.flush();
    await vi.waitFor(() =>
      expect(mocks.putDraft).toHaveBeenCalledWith(
        expect.objectContaining({ database: 'staging', schema: 'public', changes: 4 }),
      ),
    );
  });
});
