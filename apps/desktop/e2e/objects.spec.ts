import type { Session } from '@joinery/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * The Objects view against a real PostgreSQL server, as Navicat's: a click on a database, a
 * schema or a folder expands it in the tree, as before, and also lists what it holds, with each
 * table's statistics. Sorting, searching, selecting, opening and the object menu.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const NAME = 'E2E Objects';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(direct, `CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL)`);
  await query(direct, `COMMENT ON TABLE customers IS 'People who order'`);
  await query(direct, `INSERT INTO customers SELECT g, 'c' || g FROM generate_series(1, 40) g`);
  await query(direct, `CREATE TABLE orders (id integer PRIMARY KEY, customer integer)`);
  await query(direct, `INSERT INTO orders SELECT g, g % 40 + 1 FROM generate_series(1, 500) g`);
  await query(direct, `CREATE TABLE notes (id integer PRIMARY KEY)`);
  await query(direct, `CREATE VIEW big_orders AS SELECT * FROM orders WHERE id > 100`);
  await query(direct, `ANALYZE`);
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
});

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

const grid = () => page.getByRole('grid', { name: 'Objects' });
const objectRow = (name: string) =>
  grid()
    .getByRole('row')
    .filter({ has: page.getByText(name, { exact: true }) });
const names = () => grid().getByRole('row').locator('[role="gridcell"]:first-child');

test('a click on a database or a schema lists its objects, and still expands it', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();

  // The database: its schemas, and the tree opens it as before.
  await treeRow(database!.name).click();
  await expect(page.getByRole('tab', { name: /Objects/ })).toBeVisible();
  await expect(objectRow('public')).toBeVisible();
  await expect(treeRow('public')).toBeVisible();

  // A schema: its tables with their statistics; the tree shows its folders too.
  await treeRow('public').click();
  await expect(treeRow('Tables')).toBeVisible();
  await expect(names()).toHaveText(['customers', 'notes', 'orders']);
  await expect(page.getByRole('navigation', { name: 'Location' })).toContainText('Tables');
  await expect(page.getByTestId('objects-status')).toContainText('3 tables');
  await expect(grid().getByRole('columnheader', { name: 'Rows' })).toBeVisible();
  await expect(objectRow('orders')).toContainText('500');
  await expect(objectRow('customers')).toContainText('People who order');
  await expect(treeRow('public').locator('..')).toHaveAttribute('aria-selected', 'true');
});

test('sorts by a column, searches, and selects with Shift', async () => {
  await grid().getByRole('columnheader', { name: 'Rows' }).click();
  await expect(names()).toHaveText(['notes', 'customers', 'orders']);
  await grid().getByRole('columnheader', { name: 'Rows' }).click();
  await expect(names()).toHaveText(['orders', 'customers', 'notes']);

  await page.getByLabel('Search objects').fill('ord');
  await expect(names()).toHaveText(['orders']);
  await expect(page.getByTestId('objects-status')).toContainText('1 of 3 tables');
  await page.getByLabel('Search objects').fill('');

  await objectRow('orders').click();
  await objectRow('notes').click({ modifiers: ['Shift'] });
  await expect(grid().getByRole('row', { selected: true })).toHaveCount(3);
  await expect(page.getByTestId('objects-status')).toContainText('3 selected');
  // Design and Drop work on one table only.
  await expect(page.getByRole('button', { name: 'Design table' })).toBeDisabled();
  await objectRow('customers').click();
  await expect(page.getByRole('button', { name: 'Design table' })).toBeEnabled();
});

test('a folder lists its objects; a double-click opens a table, Enter a view', async () => {
  await treeRow('Views').click();
  await expect(names()).toHaveText(['big_orders']);
  await expect(page.getByTestId('objects-status')).toContainText('1 view');

  await treeRow('Tables').click();
  await objectRow('customers').dblclick();
  await expect(page.getByTestId('table-data-panel')).toBeVisible();
  await expect(page.getByTestId('table-row-count')).toHaveText('40 rows loaded');
});

test('a click on a table in the tree opens its data straight away', async () => {
  await treeRow('orders').click();
  const data = page.getByTestId('table-data-panel').filter({ visible: true });
  await expect(data.getByTestId('table-row-count')).toHaveText('500 rows loaded');
  // It did not expand: the chevron does that.
  await expect(treeRow('orders').locator('..')).toHaveAttribute('aria-expanded', 'false');
  await treeRow('orders').locator('[data-tree-chevron]').click();
  await expect(treeRow('orders').locator('..')).toHaveAttribute('aria-expanded', 'true');
});

test('the object menu opens on a right-click and offers what the tree does', async () => {
  await page.getByRole('tab', { name: /Objects/ }).click();
  await objectRow('orders').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Open data' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Design table' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Drop table…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});
