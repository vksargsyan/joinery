import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@joinery/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * The ER diagram viewer (spec §8) against PostgreSQL: a scratch database with two schemas, a
 * one-to-many, a many-to-many through a junction table, a one-to-one, a self-reference and a
 * foreign key across schemas. The diagram opened from the database's menu shows every schema,
 * then one (the table of the other schema as a stub); a table selected brings out its
 * relationships and the inspector lists them; columns shown all, keys only or none; a search
 * rings the tables it matches; tables hidden and shown; views added; the diagram exported as
 * SVG, PNG and Mermaid; a new table picked up on Refresh. Screenshots go to JOINERY_E2E_SHOTS.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E ER diagram';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let exports: string;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  for (const sql of [
    `CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL, email text UNIQUE,
       created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE customer_profiles (customer_id integer PRIMARY KEY REFERENCES customers (id),
       bio text)`,
    `CREATE TABLE orders (id integer PRIMARY KEY,
       customer_id integer NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
       total numeric(10,2) NOT NULL, note text)`,
    'CREATE TABLE products (id integer PRIMARY KEY, sku text NOT NULL UNIQUE, name text NOT NULL)',
    `CREATE TABLE order_items (order_id integer REFERENCES orders (id),
       product_id integer REFERENCES products (id), quantity integer NOT NULL,
       PRIMARY KEY (order_id, product_id))`,
    'CREATE TABLE employees (id integer PRIMARY KEY, manager_id integer REFERENCES employees (id))',
    `CREATE VIEW order_totals AS
       SELECT customer_id, sum(total) AS total FROM orders GROUP BY customer_id`,
    'CREATE SCHEMA sales',
    `CREATE TABLE sales.invoices (id integer PRIMARY KEY,
       order_id integer NOT NULL REFERENCES public.orders (id))`,
  ]) {
    await query(direct, sql);
  }
  exports = mkdtempSync(join(tmpdir(), 'joinery-er-'));
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
  rmSync(exports, { recursive: true, force: true });
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function stubSaveDialog(path: string): Promise<void> {
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, path);
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function diagram(): Locator {
  return page.getByTestId('er-diagram').filter({ visible: true });
}

function box(label: string): Locator {
  return diagram().locator(`[data-testid="er-table"][data-table="${label}"]`);
}

function edges(): Locator {
  return diagram().locator('.react-flow__edge');
}

test('draws the whole database, then one schema', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(NAME);
  await dialog.getByLabel('TLS').selectOption('disable');
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('treeitem', { name: NAME }).locator('[data-tree-row]').first().click();
  await expect(treeRow(database!.name)).toBeVisible();

  await treeRow(database!.name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ER diagram' }).click();
  const view = diagram();
  await expect(view).toBeVisible();

  // Every schema: names are schema-qualified, and the foreign key across schemas is drawn.
  await expect(view.getByTestId('er-table')).toHaveCount(7);
  await expect(box('public.orders')).toBeVisible();
  await expect(box('sales.invoices')).toBeVisible();
  await expect(edges()).toHaveCount(6);
  await expect(view.getByTestId('er-stats')).toHaveText('7 tables · 6 relationships');
  await shot('er-all-schemas');

  // One schema: the other schema's table is gone; public's tables lose the prefix.
  await view.getByLabel('Schema').selectOption('public');
  await expect(view.getByTestId('er-table')).toHaveCount(6);
  await expect(box('orders')).toBeVisible();
  await expect(box('sales.invoices')).toHaveCount(0);
  await expect(edges()).toHaveCount(5);

  // The columns with their keys: P primary, F foreign, U unique; * not null.
  const items = box('order_items');
  await expect(items.getByText('order_id')).toBeVisible();
  await expect(items.locator('li').first()).toContainText('PF');
  await expect(box('customers').locator('li', { hasText: 'email' })).toContainText('U');
  await expect(box('customers').locator('li', { hasText: 'name' })).toContainText('name *');
  await shot('er-public');
});

test('a sales schema diagram shows the referenced table as a stub', async () => {
  await treeRow(database!.name).click();
  await treeRow('sales').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ER diagram' }).click();
  const view = diagram();
  await expect(view.getByTestId('er-table')).toHaveCount(2);
  const stub = box('public.orders');
  await expect(stub).toBeVisible();
  await expect(stub).toHaveAttribute('aria-label', /other schema/);
  await expect(stub.locator('li')).toHaveCount(1);
  await expect(edges()).toHaveCount(1);
  await page.getByRole('button', { name: 'Close ER diagram (sales)' }).click();
  await expect(diagram().getByTestId('er-table')).toHaveCount(6);
});

test('selecting a table brings out its relationships', async () => {
  const view = diagram();
  await box('orders').click();
  await expect(box('orders')).toHaveAttribute('data-tone', 'selected');
  await expect(box('customers')).toHaveAttribute('data-tone', 'related');
  await expect(box('order_items')).toHaveAttribute('data-tone', 'related');
  await expect(box('products')).toHaveAttribute('data-tone', 'dimmed');

  const inspector = view.getByTestId('er-inspector');
  await expect(inspector.getByRole('heading', { name: 'orders' })).toBeVisible();
  const references = inspector.getByRole('region', { name: 'References' });
  await expect(references.getByRole('button', { name: /customers/ })).toContainText('one to many');
  await expect(references).toContainText('customer_id → id');
  await expect(references).toContainText('ON DELETE CASCADE');
  const referencedBy = inspector.getByRole('region', { name: 'Referenced by' });
  await expect(referencedBy.getByRole('button', { name: /order_items/ })).toBeVisible();
  await shot('er-selected');

  // The one-to-one and the self-reference read as such.
  await referencedBy.getByRole('button', { name: /order_items/ }).click();
  await expect(box('order_items')).toHaveAttribute('data-tone', 'selected');
  await box('customer_profiles').click();
  await expect(
    view.getByTestId('er-inspector').getByRole('region', { name: 'References' }),
  ).toContainText('one to one');
  await box('employees').click();
  await expect(view.getByTestId('er-inspector')).toContainText('zero or one to many');

  await page.keyboard.press('Escape');
  await expect(view.getByTestId('er-inspector')).toBeHidden();
  await expect(box('products')).toHaveAttribute('data-tone', 'normal');
});

test('shows all columns, the keys only, or none', async () => {
  const view = diagram();
  const columns = view.getByRole('radiogroup', { name: 'Columns shown' });
  await columns.getByRole('radio', { name: 'Keys' }).click();
  await expect(box('orders').locator('li')).toHaveText([/^P\s*id/, /^F\s*customer_id/]);
  await expect(box('customers').locator('li', { hasText: 'created_at' })).toHaveCount(0);
  await shot('er-keys');
  await columns.getByRole('radio', { name: 'None' }).click();
  await expect(box('orders').locator('li')).toHaveCount(0);
  await expect(edges()).toHaveCount(5);
  await columns.getByRole('radio', { name: 'All' }).click();
  await expect(box('orders').locator('li')).toHaveCount(4);

  await view.getByRole('button', { name: 'Types', pressed: true }).click();
  await expect(box('orders')).not.toContainText('numeric');
  await view.getByRole('button', { name: 'Types', pressed: false }).click();
  await expect(box('orders')).toContainText('numeric');
});

test('finds, hides and shows tables, and adds the views', async () => {
  const view = diagram();
  const find = view.getByLabel('Find tables and columns');
  await find.fill('sku');
  await expect(box('products')).toHaveAttribute('data-match', 'true');
  await expect(box('orders')).toHaveAttribute('data-tone', 'dimmed');
  await expect(view.getByTestId('er-table-list').getByRole('button')).toHaveCount(1);
  await find.press('Escape');
  await expect(find).toHaveValue('');

  await view.getByRole('checkbox', { name: 'Show employees' }).uncheck();
  await expect(view.getByTestId('er-table')).toHaveCount(5);
  await expect(view.getByTestId('er-stats')).toContainText('1 hidden');
  await box('orders').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show only related tables' }).click();
  await expect(view.getByTestId('er-table')).toHaveCount(3);
  await view.getByRole('button', { name: 'Show all' }).click();
  await expect(view.getByTestId('er-table')).toHaveCount(6);

  await view.getByRole('button', { name: 'Views' }).click();
  await expect(box('order_totals')).toBeVisible();
  await expect(box('order_totals')).toHaveAttribute('aria-label', /view/);
  await view.getByRole('button', { name: 'Views' }).click();
  await expect(box('order_totals')).toHaveCount(0);
});

test('exports the diagram as SVG, PNG and Mermaid', async () => {
  const view = diagram();
  const svg = join(exports, 'shop.svg');
  await stubSaveDialog(svg);
  await view.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: /SVG image/ }).click();
  await expect(view.getByTestId('er-notice')).toContainText(`Saved to ${svg}`);
  const text = readFileSync(svg, 'utf8');
  expect(text).toMatch(/^<svg /);
  expect(text).toContain('>order_items<');
  expect(text).toContain('marker-end="url(#er-one)"');

  const png = join(exports, 'shop.png');
  await stubSaveDialog(png);
  await view.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: /PNG image/ }).click();
  await expect(view.getByTestId('er-notice')).toContainText(`Saved to ${png}`);
  expect(readFileSync(png).subarray(1, 4).toString('latin1')).toBe('PNG');

  const mermaid = join(exports, 'shop.mmd');
  await stubSaveDialog(mermaid);
  await view.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: /Mermaid diagram/ }).click();
  await expect(view.getByTestId('er-notice')).toContainText(`Saved to ${mermaid}`);
  const mmd = readFileSync(mermaid, 'utf8');
  expect(mmd).toMatch(/^erDiagram\n/);
  expect(mmd).toContain('customers ||--o{ orders');
  expect(mmd).toContain('customers ||--o| customer_profiles');
});

test('picks up a new table on Refresh', async () => {
  await query(
    direct!,
    'CREATE TABLE shipments (id integer PRIMARY KEY, order_id integer REFERENCES orders (id))',
  );
  const view = diagram();
  await view.getByRole('button', { name: 'Refresh' }).click();
  await expect(box('shipments')).toBeVisible();
  await expect(edges()).toHaveCount(6);
  await expect(view.getByTestId('er-stats')).toHaveText('7 tables · 6 relationships');
  await shot('er-refreshed');
});
