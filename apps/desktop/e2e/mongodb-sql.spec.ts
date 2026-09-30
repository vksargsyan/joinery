import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MongoSession } from '@joinery/driver-mongodb';
import { toEjson } from '@joinery/mongo-tools';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connectMongo, scratchMongoDatabase, withoutTls } from './mongo-db';

/**
 * SQL and code export for MongoDB in the app, against the test replica set (spec §9, "Query
 * tools"): a SQL tab translating as it is typed, runs through find() and aggregate() with the
 * table in the select list's order, mistakes and unsupported SQL marked, a find() opened in the
 * collection view, and the query exported as Python and saved. With JOINERY_E2E_SHOTS set,
 * screenshots are saved there as mongo-sql-*.png.
 */

const MONGO_URL = process.env['JOINERY_TEST_MONGODB_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E Mongo SQL';

test.skip(!MONGO_URL, 'Set JOINERY_TEST_MONGODB_URL to run the MongoDB end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let direct: MongoSession | undefined;
let database: ReturnType<typeof scratchMongoDatabase> | undefined;
let db = '';
let files = '';

test.beforeAll(async () => {
  direct = await connectMongo(MONGO_URL!);
  database = scratchMongoDatabase(direct);
  db = database.name;
  files = mkdtempSync(join(tmpdir(), 'joinery-e2e-mongo-sql-'));
  const teams = ['core', 'web', 'ops'];
  const orders = Array.from({ length: 30 }, (_, i) => ({
    _id: i + 1,
    total: i * 10,
    team: teams[i % 3],
    customer: { name: `Customer ${i}`, city: i % 2 === 0 ? 'Yerevan' : 'Lisbon' },
  }));
  await direct.insertMany({ db, collection: 'orders' }, toEjson(orders));
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await database?.drop().catch(() => undefined);
  await direct?.close();
  if (files) rmSync(files, { recursive: true, force: true });
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function treeRow(text: string): Locator {
  return page
    .locator('[data-tree-row]')
    .filter({ has: page.getByText(text, { exact: true }) })
    .first();
}

async function treeMenu(text: string, item: string): Promise<void> {
  const row = treeRow(text);
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

function visible(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

/** Replaces the text of a Monaco editor (typed as one input, so brackets are not auto-closed). */
async function replaceText(editor: Locator, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

async function stubSaveDialog(path: string): Promise<void> {
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, path);
}

test('connects and shows the scratch database', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(withoutTls(MONGO_URL!));
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().click();
  await treeRow(db).click();
  await treeRow('Collections').click();
  await expect(treeRow('orders')).toBeVisible();
});

test('translates a SELECT as it is typed and runs it as a find()', async () => {
  await treeMenu(db, 'New SQL query');
  const tab = visible('mongo-sql');
  await expect(tab).toBeVisible();
  await replaceText(
    tab.getByTestId('mongo-sql-editor'),
    "SELECT customer.name, total FROM orders WHERE total >= 240 AND team = 'core' ORDER BY total DESC",
  );
  const mql = tab.getByTestId('mongo-sql-mql');
  await expect(mql).toContainText('db.orders.find(');
  await expect(mql).toContainText('$gte: 240');
  await expect(tab.getByText('find()', { exact: true })).toBeVisible();
  await tab.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(tab.getByTestId('mongo-sql-count')).toContainText('2 documents');
  // The table's columns follow the select list, not the documents' field order.
  await expect(tab.locator('th[data-column]').first()).toHaveAttribute(
    'data-column',
    'customer.name',
  );
  await expect(tab.locator('th[data-column]').nth(1)).toHaveAttribute('data-column', 'total');
  await expect(tab.getByTestId('mongo-table').locator('tbody tr').first()).toContainText('270');
  await shot('mongo-sql-find');
});

test('runs GROUP BY as an aggregate() and marks what does not translate', async () => {
  const tab = visible('mongo-sql');
  const editor = tab.getByTestId('mongo-sql-editor');
  await replaceText(
    editor,
    'SELECT team, COUNT(*) AS orders, SUM(total) AS revenue FROM orders GROUP BY team ORDER BY revenue DESC',
  );
  await expect(tab.getByText(/^aggregate\(\) · \d stages?$/)).toBeVisible();
  await expect(tab.getByTestId('mongo-sql-mql')).toContainText('$group');
  await tab.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(tab.getByTestId('mongo-sql-count')).toContainText('3 documents');
  await expect(tab.getByTestId('mongo-sql-ran')).toContainText('aggregate() on orders');
  await expect(tab.locator('th[data-column]').first()).toHaveAttribute('data-column', 'team');
  await shot('mongo-sql-aggregate');

  await replaceText(editor, 'SELECT team FROM orders WHERE');
  const issue = tab.getByTestId('mongo-sql-issue');
  await expect(issue).toContainText('Does not translate');
  await expect(issue).toContainText('line 1');
  await tab.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(tab.getByTestId('mongo-notice')).toContainText('Fix the SQL first');

  await replaceText(editor, 'SELECT team FROM orders UNION SELECT team FROM orders');
  await expect(issue).toContainText('Not supported');
  await expect(issue).toContainText('Supported:');
});

test('opens a find() in the collection view with its query', async () => {
  const tab = visible('mongo-sql');
  await replaceText(
    tab.getByTestId('mongo-sql-editor'),
    "SELECT total FROM orders WHERE team = 'web' ORDER BY total DESC LIMIT 4",
  );
  await expect(tab.getByTestId('mongo-sql-mql')).toContainText('db.orders.find(');
  await tab.getByRole('button', { name: 'Open in collection view' }).click();
  const collection = visible('mongo-collection-panel');
  await expect(collection).toBeVisible();
  await expect(collection.getByTestId('mongo-filter')).toHaveValue("{ team: 'web' }");
  await expect(collection.getByTestId('mongo-sort')).toHaveValue('{ total: -1 }');
  await expect(collection.getByTestId('mongo-limit')).toHaveValue('4');
});

test('exports the collection view query as Python and saves it', async () => {
  const collection = visible('mongo-collection-panel');
  await collection.getByRole('button', { name: 'Export code…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export code' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${db}.orders · find()`);
  await dialog.getByRole('radio', { name: 'Python' }).click();
  await expect(dialog.getByTestId('code-export-install')).toHaveText('pip install pymongo');
  const code = dialog.getByTestId('code-export-editor');
  await expect(code).toContainText('MONGODB_URI');
  await expect(code).toContainText(`client["${db}"]["orders"]`);
  await shot('mongo-sql-export');
  const file = join(files, 'query.py');
  await stubSaveDialog(file);
  await dialog.getByRole('button', { name: 'Save as…' }).click();
  await expect(dialog.getByTestId('code-export-status')).toHaveText(`Saved to ${file}`);
  const saved = readFileSync(file, 'utf8');
  expect(saved).toContain('from pymongo import MongoClient');
  expect(saved).toContain('"team": "web"');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("opens a collection's SQL tab with a starter query, and exports a translation", async () => {
  const collection = visible('mongo-collection-panel');
  await collection.getByRole('button', { name: 'SQL', exact: true }).click();
  const tab = page.getByTestId('mongo-sql').filter({ visible: true });
  await expect(tab.getByTestId('mongo-sql-editor')).toContainText('FROM orders');
  await expect(tab.getByTestId('mongo-sql-mql')).toContainText('.limit(100)');
  await tab.getByRole('button', { name: 'Export code…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export code' });
  // The language picked last is picked again.
  await expect(dialog.getByRole('radio', { name: 'Python' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dialog.getByRole('radio', { name: 'Go' }).click();
  await expect(dialog.getByTestId('code-export-install')).toHaveText(
    'go get go.mongodb.org/mongo-driver/v2/mongo',
  );
  await expect(dialog.getByTestId('code-export-editor')).toContainText('package main');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
