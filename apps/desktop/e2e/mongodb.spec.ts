import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { MongoSession } from '@joinery/driver-mongodb';
import { toEjson } from '@joinery/mongo-tools';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connectMongo, scratchMongoDatabase, withoutTls } from './mongo-db';

/**
 * The MongoDB module against the test replica set (spec §5, §9): a connection from a URI, the
 * object tree, the collection view (query bar and find() text, tree, table with drill-down and
 * JSON), the document editor with a conflicting change made elsewhere, insert, clone and delete,
 * a bulk update counted before it runs, explain before and after an index, and the command
 * console. With JOINERY_E2E_SHOTS set, screenshots of the collection view are saved there.
 */

const MONGO_URL = process.env['JOINERY_TEST_MONGODB_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E Mongo';

test.skip(!MONGO_URL, 'Set JOINERY_TEST_MONGODB_URL to run the MongoDB end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let direct: MongoSession | undefined;
let database: ReturnType<typeof scratchMongoDatabase> | undefined;
let db = '';

const CITIES = ['London', 'Paris', 'Yerevan', 'Oslo'];

test.beforeAll(async () => {
  direct = await connectMongo(MONGO_URL!);
  database = scratchMongoDatabase(direct);
  db = database.name;
  const orders = Array.from({ length: 150 }, (_, i) => ({
    _id: i + 1,
    status: i % 2 === 0 ? 'open' : 'shipped',
    total: i * 5,
    at: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
    customer: { name: `Customer ${i % 7}`, address: { city: CITIES[i % CITIES.length] } },
    items: [
      { sku: `sku-${i}-a`, qty: 1 + (i % 3), tags: ['red', 'big'] },
      { sku: `sku-${i}-b`, qty: 2, tags: [] },
    ],
  }));
  await direct.insertMany({ db, collection: 'orders' }, toEjson(orders));
  await direct.insertMany({ db, collection: 'customers' }, toEjson([{ _id: 'c1', name: 'Ada' }]));
  await direct.createView(
    { db, collection: 'big_orders' },
    'orders',
    toEjson([{ $match: { total: { $gt: 500 } } }]),
  );
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await database?.drop().catch(() => undefined);
  await direct?.close();
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function panel(): Locator {
  return page.getByTestId('mongo-collection-panel').filter({ visible: true });
}

async function setField(field: string, text: string): Promise<void> {
  await panel().getByTestId(`mongo-${field}`).fill(text);
}

async function run(): Promise<void> {
  await panel().getByTestId('mongo-filter').press('Enter');
}

/** Replaces the text of a Monaco editor (typed as one input, so brackets are not auto-closed). */
async function replaceText(editor: Locator, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

async function stored(id: number): Promise<Record<string, unknown>> {
  for await (const page of direct!.find(
    { db, collection: 'orders' },
    { filter: toEjson({ _id: id }) },
  )) {
    if (page.documents[0]) return JSON.parse(page.documents[0]) as Record<string, unknown>;
  }
  throw new Error(`order ${id} is gone`);
}

async function confirmDialog(label: string): Promise<Locator> {
  const dialog = page.getByRole('alertdialog').last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  return dialog;
}

test('creates a MongoDB connection from a URI and tests it', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(withoutTls(MONGO_URL!));
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await expect(dialog.getByLabel('Password', { exact: true })).not.toHaveValue('');
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Test Connection' }).click();
  await expect(dialog.getByText('Connection succeeded')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('treeitem', { name: NAME })).toBeVisible();
});

test('browses databases, collections, views and indexes', async () => {
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().click();
  await treeRow(db).click();
  await treeRow('Collections').click();
  await expect(treeRow('orders')).toContainText('150');
  await expect(treeRow('customers')).toBeVisible();
  await treeRow('Views').click();
  await expect(treeRow('big_orders')).toBeVisible();
  await treeRow('orders').click();
  await treeRow('Indexes').first().click();
  await expect(treeRow('_id_')).toBeVisible();
});

test('opens a collection and pages its documents as the view scrolls', async () => {
  await treeRow('orders').dblclick();
  await expect(panel()).toBeVisible();
  const loaded = panel().getByTestId('mongo-loaded');
  await expect(loaded).toHaveText('100 documents loaded');
  await expect(panel().getByTestId('mongo-total')).toContainText('150');
  await panel()
    .getByTestId('mongo-tree')
    .evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(loaded).toHaveText('150 documents loaded');
  await panel().getByRole('button', { name: 'Document 1', exact: true }).click();
  await expect(
    panel().getByTestId('mongo-tree').locator('[data-field="customer"]').first(),
  ).toBeVisible();
  await shot('mongo-tree');
});

test('filters, sorts and projects, with the find() text editable both ways', async () => {
  await setField('filter', '{ total: { $gt: 100 } }');
  await setField('sort', '{ total: -1 }');
  const findText = panel().getByTestId('mongo-find-text');
  await expect(findText).toContainText(
    'db.orders.find({ total: { $gt: 100 } }).sort({ total: -1 })',
  );
  await run();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('100 documents loaded');
  await expect(panel().getByRole('button', { name: 'Document 1', exact: true })).toContainText(
    '_id: 150',
  );
  await panel().getByRole('button', { name: 'Count matches' }).click();
  await expect(panel().getByTestId('mongo-total')).toContainText('129 matching');

  await setField('projection', '{ total: 1 }');
  await run();
  await panel().getByRole('radio', { name: 'JSON' }).click();
  const json = panel().getByTestId('mongo-json-text');
  await expect(json).toContainText('{ _id: 150, total: 745 }');
  await expect(json).not.toContainText('status');

  // A syntax error is shown where it is, and nothing runs.
  await setField('filter', '{ total: { $gt: } }');
  await expect(panel().getByTestId('mongo-filter-issue')).toContainText('column 17');

  // The text drives the fields too.
  await replaceText(findText, "db.orders.find({ status: 'open' }).sort({ _id: 1 }).limit(5)");
  await expect(panel().getByTestId('mongo-filter')).toHaveValue("{ status: 'open' }");
  await expect(panel().getByTestId('mongo-projection')).toHaveValue('');
  await expect(panel().getByTestId('mongo-limit')).toHaveValue('5');
  await run();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('5 documents loaded');
  await expect(json).toContainText("status: 'open'");
  await panel().getByRole('radio', { name: 'Relaxed EJSON' }).click();
  await expect(json).toContainText('"$date": "2026-01-01T00:00:00Z"');
});

test('shows the table view and drills into an array and back', async () => {
  await panel().getByRole('radio', { name: 'Table' }).click();
  const table = panel().getByTestId('mongo-table');
  await expect(table.locator('th[data-column="customer.address.city"]')).toBeVisible();
  await table.locator('tr[data-row="0"]').getByRole('button', { name: '[ 2 elements ]' }).click();
  const crumbs = table.getByTestId('mongo-breadcrumb');
  await expect(crumbs).toContainText('Documents›Document 1›items');
  await expect(table.locator('th[data-column="sku"]')).toBeVisible();
  await expect(table.locator('tr[data-row="1"]')).toContainText('sku-0-b');
  await shot('mongo-table-drill');
  await table.locator('tr[data-row="0"]').getByRole('button', { name: '[ 2 elements ]' }).click();
  await expect(crumbs).toContainText('items›[0]›tags');
  await expect(table).toContainText('big');
  await crumbs.getByRole('button', { name: 'Documents' }).click();
  await expect(table.locator('th[data-column="_id"]')).toBeVisible();
});

test('edits a document and resolves a conflict with a concurrent change', async () => {
  await panel().getByRole('button', { name: 'Reset' }).click();
  await panel().getByRole('radio', { name: 'Tree' }).click();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('100 documents loaded');
  await panel().getByRole('button', { name: 'Edit document 1', exact: true }).click();
  const editor = page.getByTestId('document-editor');
  await expect(editor).toBeVisible();
  const text = editor.getByTestId('document-editor-text');
  await expect(text).toContainText("status: 'open'");
  await shot('mongo-editor');
  await replaceText(text, "{ _id: 1, status: 'packed', total: NumberDecimal('10.50') }");
  // Someone else changes the document meanwhile.
  await direct!.updateMany(
    { db, collection: 'orders' },
    toEjson({ _id: 1 }),
    toEjson({ $set: { status: 'changed elsewhere' } }),
  );
  await page.getByTestId('editor-save').click();
  await expect(page.getByTestId('editor-conflict')).toContainText("status: 'changed elsewhere'");
  await shot('mongo-editor-conflict');
  await page.getByTestId('editor-reload').click();
  await expect(text).toContainText("status: 'changed elsewhere'");
  await replaceText(text, "{ _id: 1, status: 'packed', total: NumberDecimal('10.50') }");
  await page.getByTestId('editor-save').click();
  await expect(editor).toBeHidden();
  await expect(panel().getByTestId('mongo-notice')).toContainText('Document saved');
  expect(await stored(1)).toEqual({
    _id: { $numberInt: '1' },
    status: 'packed',
    total: { $numberDecimal: '10.50' },
  });
});

test('inserts, clones and deletes documents', async () => {
  await panel().getByRole('button', { name: 'Insert' }).click();
  const editor = page.getByTestId('document-editor');
  await replaceText(
    editor.getByTestId('document-editor-text'),
    "{ _id: 1000, status: 'new', at: ISODate('2026-09-29T10:00:00Z'), ref: UUID('0f8fad5b-d9cb-469f-a165-70867728950e') }",
  );
  await page.getByTestId('editor-save').click();
  await expect(panel().getByTestId('mongo-notice')).toContainText('Document inserted');
  expect(await stored(1000)).toMatchObject({ status: 'new', ref: { $binary: { subType: '04' } } });

  await setField('filter', '{ _id: 1000 }');
  await run();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('1 document loaded');
  await panel().getByRole('button', { name: 'Clone document 1', exact: true }).click();
  await expect(editor.getByTestId('document-editor-text')).not.toContainText('_id');
  await page.getByTestId('editor-save').click();
  await expect(panel().getByTestId('mongo-notice')).toContainText('Document inserted');
  expect(await direct!.count({ db, collection: 'orders' }, toEjson({ status: 'new' }))).toBe(2);

  await panel().getByRole('button', { name: 'Delete document 1', exact: true }).click();
  const confirm = page.getByRole('alertdialog').last();
  await expect(confirm.getByTestId('confirm-detail')).toHaveText(
    `db.getSiblingDB('${db}').orders.deleteOne({ _id: 1000 })`,
  );
  await confirmDialog('Delete');
  await expect(panel().getByTestId('mongo-notice')).toContainText('Document deleted');
  expect(await direct!.count({ db, collection: 'orders' }, toEjson({ _id: 1000 }))).toBe(0);
});

test('bulk-updates the filtered documents after showing the matched count', async () => {
  await setField('filter', "{ status: 'shipped' }");
  await run();
  await panel().getByRole('button', { name: 'Bulk update…' }).click();
  const dialog = page.getByTestId('bulk-dialog');
  await replaceText(dialog.getByTestId('bulk-update-text'), '{ $set: { flagged: true } }');
  await page.getByTestId('bulk-count').click();
  await expect(page.getByTestId('bulk-matched')).toContainText('75 documents match');
  expect(await direct!.count({ db, collection: 'orders' }, toEjson({ flagged: true }))).toBe(0);
  await page.getByTestId('bulk-run').click();
  const confirm = page.getByRole('alertdialog', { name: 'Update 75 documents?' });
  await expect(confirm.getByTestId('confirm-detail')).toContainText(
    "updateMany({ status: 'shipped' }, { $set: { flagged: true } })",
  );
  await confirm.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByTestId('bulk-done')).toHaveText('Updated 75 of 75 documents');
  await page
    .getByRole('alertdialog', { name: 'Bulk update' })
    .getByRole('button', { name: 'Close' })
    .click();
  expect(await direct!.count({ db, collection: 'orders' }, toEjson({ flagged: true }))).toBe(75);
});

test('explains a collection scan, then the index scan once an index exists', async () => {
  await setField('filter', '{ total: { $gt: 700 } }');
  await panel().getByRole('button', { name: 'Explain', exact: true }).click();
  const explain = panel().getByTestId('mongo-explain');
  await expect(explain.getByTestId('explain-collscan')).toBeVisible();
  await expect(explain.locator('[data-stage="COLLSCAN"]')).toBeVisible();
  await expect(explain.getByTestId('explain-returned')).toHaveText('9');
  await shot('mongo-explain-collscan');
  await direct!.createIndex({ db, collection: 'orders' }, { keys: toEjson({ total: 1 }) });
  await panel().getByRole('button', { name: 'Explain', exact: true }).click();
  await expect(explain.getByTestId('explain-indexed')).toContainText('total_1');
  await expect(explain.locator('[data-stage="IXSCAN"]')).toContainText('total_1');
  await expect(explain.getByTestId('explain-keys-examined')).toHaveText('9');
  await shot('mongo-explain');
});

test('runs a command in the console and records it in the history', async () => {
  await page.getByRole('button', { name: 'New query' }).click();
  const consolePanel = page.getByTestId('mongo-console').filter({ visible: true });
  await expect(consolePanel).toBeVisible();
  await consolePanel.getByTestId('mongo-console-database').selectOption(db);
  const command = '{ find: "orders", filter: { total: { $gt: 700 } }, sort: { total: -1 } }';
  await replaceText(consolePanel.getByTestId('mongo-console-editor'), command);
  await consolePanel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(consolePanel.getByTestId('mongo-console-count')).toContainText('9 documents');
  await expect(consolePanel.getByRole('button', { name: 'Document 1', exact: true })).toContainText(
    '_id: 150',
  );
  await consolePanel.getByRole('radio', { name: 'Table' }).click();
  await expect(consolePanel.getByTestId('mongo-table').locator('tbody tr')).toHaveCount(9);
  await shot('mongo-console');

  // A destructive command asks first; declining runs nothing.
  await replaceText(consolePanel.getByTestId('mongo-console-editor'), '{ drop: "customers" }');
  await consolePanel.getByRole('button', { name: 'Run', exact: true }).click();
  await confirmDialog('Cancel');
  expect(await direct!.count({ db, collection: 'customers' })).toBe(1);

  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByTestId('history-list')).toContainText('{ find: "orders"');
});
