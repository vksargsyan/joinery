import type { SchemaSnapshot } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  documentLayout,
  documentText,
  modelDocument,
  parseModelFile,
  rebaseModel,
  restoreDraft,
  sameFamily,
  type DiagramLayout,
} from '../src/renderer/src/state/er-diagram/document';
import {
  addRelation,
  addTable,
  findTable,
  renameTable,
  startModel,
  updateColumn,
  type EditContext,
} from '../src/renderer/src/state/er-diagram/edit';
import { modelScript } from '../src/renderer/src/state/er-diagram/forward';
import { tableId } from '../src/renderer/src/state/er-diagram/model';
import { shop, shopMysql } from './er-fixtures';

const PG: EditContext = { engine: 'postgres', schema: 'public' };

const layout: DiagramLayout = {
  positions: {
    [tableId('public', 'customers')]: { x: 10.4, y: 20.6 },
    [tableId('sales', 'invoices')]: { x: 300, y: 40 },
  },
  hidden: new Set([tableId('public', 'employees')]),
  display: { columns: 'keys', types: false },
  includeViews: true,
};

/** The shop database with an empty `public` schema: a database to open a model on. */
function emptyPublic(): SchemaSnapshot {
  const snapshot = shop();
  return {
    ...snapshot,
    database: 'shop_staging',
    schemas: snapshot.schemas.map((s) =>
      s.name === 'public' ? { ...s, tables: [], views: [] } : s,
    ),
  };
}

function edited(): ReturnType<typeof startModel> {
  let model = renameTable(startModel(shop(), PG), PG, 'customers', 'clients');
  model = updateColumn(model, PG, 'orders', 'note', { name: 'remarks' });
  return addTable(model, PG, 'tags').state;
}

describe('ER model documents', () => {
  it('hold the edited schema, the origins and the layout; drafts also the base', () => {
    const model = edited();
    const file = modelDocument({
      model,
      context: PG,
      layout,
      diagramSchema: 'public',
      savedAt: '2026-09-30T10:00:00.000Z',
    });
    expect(file).toMatchObject({
      format: 'querybara.er-model',
      version: 1,
      engine: 'postgres',
      database: 'shop',
      schema: 'public',
      model: {
        tableOrigins: { clients: 'customers', tags: null, orders: 'orders' },
        columnOrigins: { orders: { remarks: 'note' }, tags: { id: null } },
      },
      layout: {
        positions: [
          { table: 'customers', x: 10, y: 21 },
          { schema: 'sales', table: 'invoices', x: 300, y: 40 },
        ],
        hidden: [{ table: 'employees' }],
        display: { columns: 'keys', types: false },
        includeViews: true,
      },
    });
    expect(file.model.schemas.map((s) => s.name)).toEqual(['public']);
    expect('base' in file).toBe(false);

    // A draft keeps its base, and every schema the model changed: sales.invoices follows the
    // renamed... orders was not renamed here, so only public.
    const draft = modelDocument({
      model: renameTable(model, PG, 'orders', 'purchases'),
      context: PG,
      base: shop(),
      layout,
      diagramSchema: 'public',
      savedAt: '2026-09-30T10:00:00.000Z',
    });
    expect(draft.base).toEqual(shop());
    expect(draft.model.schemas.map((s) => s.name)).toEqual(['public', 'sales']);
  });

  it('read back from a file, and refuse what is not a model', () => {
    const text = documentText(
      modelDocument({
        model: edited(),
        context: PG,
        layout,
        diagramSchema: 'public',
        savedAt: '2026-09-30T10:00:00.000Z',
      }),
    );
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "format": "querybara.er-model",');
    const parsed = parseModelFile(text);
    expect(parsed.ok).toBe(true);

    expect(parseModelFile('not json')).toEqual({
      ok: false,
      message: 'The file is not a Querybara ER model (it is not JSON)',
    });
    expect(parseModelFile('{"tables": []}')).toEqual({
      ok: false,
      message: 'The file is not a Querybara ER model',
    });
    expect(parseModelFile('{"format": "querybara.er-model", "version": 2}')).toEqual({
      ok: false,
      message: 'The model was saved by a newer Querybara; update Querybara to open it',
    });
    const damaged = JSON.parse(text) as { model: { schemas: unknown[] } };
    damaged.model.schemas = [];
    expect(parseModelFile(JSON.stringify(damaged))).toMatchObject({
      ok: false,
      message: expect.stringContaining('The model file is damaged (model.schemas'),
    });
  });

  it('restore a draft on the database it started from', () => {
    const model = renameTable(edited(), PG, 'orders', 'purchases');
    const document = parseModelFile(
      documentText(
        modelDocument({
          model,
          context: PG,
          base: shop(),
          layout,
          diagramSchema: 'public',
          savedAt: '2026-09-30T10:00:00.000Z',
        }),
      ),
    );
    if (!document.ok) throw new Error(document.message);
    const restored = restoreDraft(document.document);
    expect(restored.base).toEqual(shop());
    expect(modelScript(restored.model, restored.base, PG).statements).toEqual(
      modelScript(model, shop(), PG).statements,
    );
    expect(documentLayout(document.document, 'public')).toEqual({
      ...layout,
      positions: {
        [tableId('public', 'customers')]: { x: 10, y: 21 },
        [tableId('sales', 'invoices')]: { x: 300, y: 40 },
      },
    });
  });

  it('rebase a file on another database: what the schema there should become', () => {
    const file = parseModelFile(
      documentText(
        modelDocument({
          model: edited(),
          context: PG,
          layout,
          diagramSchema: 'public',
          savedAt: '2026-09-30T10:00:00.000Z',
        }),
      ),
    );
    if (!file.ok) throw new Error(file.message);

    // On an empty schema, everything is new.
    const onEmpty = rebaseModel(file.document, emptyPublic(), PG);
    expect(Object.values(onEmpty.tableOrigins).every((o) => o === null)).toBe(true);
    const created = modelScript(onEmpty, emptyPublic(), PG).statements;
    expect(created.filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(5);
    expect(created.join('\n')).not.toMatch(/RENAME|DROP/);

    // On the database it came from, the renames are renames again.
    const onShop = rebaseModel(file.document, shop(), PG);
    expect(onShop.tableOrigins).toMatchObject({
      clients: 'customers',
      orders: 'orders',
      tags: null,
    });
    const script = modelScript(onShop, shop(), PG).statements;
    expect(script).toContain('ALTER TABLE "public"."customers" RENAME TO "clients"');
    expect(script).toContain('ALTER TABLE "public"."orders" RENAME COLUMN "note" TO "remarks"');
  });

  it('rebase into another schema, its own references following', () => {
    const file = parseModelFile(
      documentText(
        modelDocument({
          model: startModel(shop(), PG),
          context: PG,
          layout,
          diagramSchema: 'public',
          savedAt: '2026-09-30T10:00:00.000Z',
        }),
      ),
    );
    if (!file.ok) throw new Error(file.message);
    const live: SchemaSnapshot = {
      ...emptyPublic(),
      schemas: [...emptyPublic().schemas, { ...emptyPublic().schemas[0]!, name: 'staging' }],
    };
    const staging: EditContext = { engine: 'postgres', schema: 'staging' };
    const model = rebaseModel(file.document, live, staging);
    // Unqualified or naming the file's schema, a reference now means the schema it opens in.
    expect(findTable(model, staging, 'orders').foreignKeys[0]!.refSchema ?? 'staging').toBe(
      'staging',
    );
    expect(modelScript(model, live, staging).statements.join('\n')).toContain(
      'REFERENCES "staging"."customers" ("id")',
    );

    // A relationship drawn in the model names its schema: it follows too.
    const drawn = addRelation(startModel(shop(), PG), PG, {
      child: 'employees',
      parent: 'customers',
    });
    const drawnFile = parseModelFile(
      documentText(
        modelDocument({
          model: drawn.state,
          context: PG,
          layout,
          diagramSchema: 'public',
          savedAt: 'x',
        }),
      ),
    );
    if (!drawnFile.ok) throw new Error(drawnFile.message);
    const moved = rebaseModel(drawnFile.document, live, staging);
    expect(findTable(moved, staging, 'employees').foreignKeys.at(-1)).toMatchObject({
      refSchema: 'staging',
      refTable: 'customers',
    });
  });

  it('keep a renamed-away table and a new one of the old name apart', () => {
    // The file renamed customers to clients and made a new customers table.
    let model = renameTable(startModel(shop(), PG), PG, 'customers', 'clients');
    model = addTable(model, PG, 'customers').state;
    const file = parseModelFile(
      documentText(
        modelDocument({ model, context: PG, layout, diagramSchema: 'public', savedAt: 'x' }),
      ),
    );
    if (!file.ok) throw new Error(file.message);
    const rebased = rebaseModel(file.document, shop(), PG);
    expect(rebased.tableOrigins['clients']).toBe('customers');
    expect(rebased.tableOrigins['customers']).toBeNull();
  });

  it('open MySQL models on MariaDB and back, never on PostgreSQL', () => {
    expect(sameFamily('mysql', 'mariadb')).toBe(true);
    expect(sameFamily('mariadb', 'mysql')).toBe(true);
    expect(sameFamily('mysql', 'postgres')).toBe(false);
    const MY: EditContext = { engine: 'mysql', schema: 'shop' };
    const file = parseModelFile(
      documentText(
        modelDocument({
          model: startModel(shopMysql(), MY),
          context: MY,
          layout: { ...layout, positions: {}, hidden: new Set() },
          diagramSchema: 'shop',
          savedAt: 'x',
        }),
      ),
    );
    if (!file.ok) throw new Error(file.message);
    // On a database of another name: the schema is that database.
    const other: SchemaSnapshot = {
      ...shopMysql(),
      database: 'shop_copy',
      schemas: [{ ...shopMysql().schemas[0]!, name: 'shop_copy', tables: [] }],
    };
    const model = rebaseModel(file.document, other, { engine: 'mysql', schema: 'shop_copy' });
    expect(model.snapshot.schemas.map((s) => s.name)).toEqual(['shop_copy']);
    expect(
      modelScript(model, other, { engine: 'mysql', schema: 'shop_copy' }).statements,
    ).toContain(
      'ALTER TABLE `orders` ADD CONSTRAINT `orders_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)',
    );
  });
});
