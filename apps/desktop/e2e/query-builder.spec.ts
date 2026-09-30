import { join } from 'node:path';

import type { Session } from '@joinery/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * The visual query builder (spec §8) against PostgreSQL: two tables related by a foreign key in
 * a scratch database; the builder opened from the database's menu; both tables added from the
 * list, the join proposed from the foreign key; columns ticked, a criterion and a sort; the SQL
 * written live; run into the result grid; the SQL edited and the builder following; SQL with a
 * CTE opening read-only with a note naming it, still running as written; and a SQL tab's
 * statement opened in a builder. Screenshots go to JOINERY_E2E_SHOTS when it is set.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E Builder';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  for (const sql of [
    'CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL, city text)',
    'CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id), total numeric(10,2) NOT NULL)',
    "INSERT INTO customers VALUES (1, 'Ada', 'Paris'), (2, 'Brian', 'Oslo'), (3, 'Chen', 'Rome')",
    'INSERT INTO orders VALUES (10, 1, 25.00), (11, 1, 5.00), (12, 2, 40.00), (13, 3, 12.50)',
  ]) {
    await query(direct, sql);
  }
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function builder(): Locator {
  return page.getByTestId('query-builder').filter({ visible: true });
}

/** The builder's SQL as Monaco shows it (lines run together). */
function sqlText(): Locator {
  return builder().getByTestId('builder-sql').locator('.view-lines');
}

/** A result cell through Glide's accessibility table (column 0 is the row markers). */
function cell(column: number, row: number): Locator {
  return builder().getByTestId(`glide-cell-${column + 1}-${row}`);
}

/** Replaces the builder's SQL as a paste would. */
async function replaceSql(sql: string): Promise<void> {
  await builder().getByTestId('builder-sql').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
}

test('builds a joined query from the canvas and side panels, and runs it', async () => {
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
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().click();
  await expect(treeRow(database!.name)).toBeVisible();

  await treeRow(database!.name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New query builder' }).click();
  const view = builder();
  await expect(view).toBeVisible();
  await expect(sqlText()).toHaveText('SELECT *');

  // Tables from the searchable list; the second one brings the join its foreign key proposes.
  const search = view.getByLabel('Search tables');
  await search.fill('cust');
  await view.getByRole('button', { name: 'Add customers' }).click();
  await search.fill('ord');
  await view.getByRole('button', { name: 'Add orders' }).click();
  await expect(view.getByTestId('builder-table')).toHaveCount(2);
  await expect(view.locator('.react-flow__edge')).toHaveCount(1);
  await expect(view.getByText('INNER JOIN', { exact: true })).toBeVisible();
  await view.getByRole('tab', { name: 'Joins' }).click();
  await expect(view.getByTestId('builder-join')).toContainText('customers → orders');
  await expect(
    view.getByLabel('Join customers to orders: condition 1 customers column'),
  ).toHaveValue('id');
  await expect(view.getByLabel('Join customers to orders: condition 1 orders column')).toHaveValue(
    'customer_id',
  );

  // Columns ticked on the canvas.
  await view.getByRole('checkbox', { name: 'customers.name', exact: true }).check();
  await view.getByRole('checkbox', { name: 'orders.total', exact: true }).check();

  // A criterion: orders.total > 10.
  await view.getByRole('tab', { name: 'Criteria' }).click();
  await view.getByRole('button', { name: 'Add condition' }).click();
  await view
    .getByLabel('Criteria condition 1', { exact: true })
    .selectOption({ label: 'orders.total' });
  await view.getByLabel('Criteria condition 1 operator').selectOption('>');
  await view.getByLabel('Criteria condition 1 value', { exact: true }).fill('10');

  // A sort: orders.total descending.
  await view.getByRole('tab', { name: 'Sort & limit' }).click();
  await view.getByRole('button', { name: 'Add sort' }).click();
  await view.getByLabel('Sort 1', { exact: true }).selectOption({ label: 'orders.total' });
  await view.getByLabel('Sort 1 direction').selectOption('desc');

  // The SQL follows every step.
  await expect(sqlText()).toContainText('"customers"."name"');
  // Long lines wrap in the pane, so the checks stay within a line's first words.
  await expect(sqlText()).toContainText('FROM "public"."customers"');
  await expect(sqlText()).toContainText('INNER JOIN "public"."orders" ON');
  await expect(sqlText()).toContainText('= "orders"."customer_id"');
  await expect(sqlText()).toContainText('WHERE "orders"."total" > 10');
  await expect(sqlText()).toContainText('ORDER BY "orders"."total" DESC');
  await shot('query-builder');

  await view.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(view.getByTestId('row-count')).toHaveText('3 rows');
  await expect(cell(0, 0)).toHaveText('Brian');
  await expect(cell(1, 0)).toHaveText('40.00');
  await expect(cell(0, 2)).toHaveText('Chen');
});

test('follows SQL edited by hand', async () => {
  const view = builder();
  await replaceSql(
    'SELECT customers.name, customers.city FROM public.customers JOIN public.orders ON orders.customer_id = customers.id WHERE orders.total < 20 ORDER BY customers.name',
  );
  await expect(view.getByRole('checkbox', { name: 'customers.city', exact: true })).toBeChecked();
  await expect(view.getByRole('checkbox', { name: 'customers.name', exact: true })).toBeChecked();
  await expect(view.getByRole('checkbox', { name: 'orders.total', exact: true })).not.toBeChecked();
  await expect(view.getByTestId('builder-table')).toHaveCount(2);
  await expect(view.locator('.react-flow__edge')).toHaveCount(1);
  await view.getByRole('tab', { name: 'Criteria' }).click();
  await expect(view.getByLabel('Criteria condition 1 operator')).toHaveValue('<');
  await expect(view.getByLabel('Criteria condition 1 value', { exact: true })).toHaveValue('20');
  await expect(view.getByTestId('builder-readonly')).toHaveCount(0);

  await view.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(view.getByTestId('row-count')).toHaveText('2 rows');
  await expect(cell(0, 0)).toHaveText('Ada');
  await expect(cell(1, 1)).toHaveText('Rome');

  // A builder edit writes the builder's SQL again.
  await view.getByRole('checkbox', { name: 'orders.total', exact: true }).check();
  await expect(sqlText()).toContainText('"orders"."total"');
  await expect(sqlText()).toContainText('WHERE "orders"."total" < 20');
});

test('opens SQL with a CTE read-only, naming the construct, and still runs it', async () => {
  const view = builder();
  await replaceSql(
    'WITH big AS (SELECT * FROM public.orders WHERE total > 20) SELECT id, total FROM big ORDER BY id',
  );
  const note = view.getByTestId('builder-readonly');
  await expect(note).toBeVisible();
  await expect(note).toContainText('a WITH clause (common table expression)');
  await expect(view.getByRole('checkbox', { name: 'customers.city', exact: true })).toBeDisabled();
  await expect(view.getByLabel('Search tables')).toBeVisible();
  await expect(view.getByRole('button', { name: 'Add orders' })).toBeDisabled();
  await shot('query-builder-read-only');

  await view.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(view.getByTestId('row-count')).toHaveText('2 rows');
  await expect(cell(1, 1)).toHaveText('40.00');

  await note.getByRole('button', { name: 'Back to the builder’s query' }).click();
  await expect(note).toBeHidden();
  await expect(sqlText()).toContainText('WHERE "orders"."total" < 20');
  await expect(view.getByRole('checkbox', { name: 'customers.city', exact: true })).toBeEnabled();
});

test('opens the statement at the cursor of a SQL tab in a builder', async () => {
  await page.getByRole('button', { name: 'New query' }).click();
  const editor = page.getByTestId('sql-editor').filter({ visible: true });
  await editor.click();
  await page.keyboard.insertText(
    'SELECT 1;\nSELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.total >= 25',
  );
  await page.getByRole('button', { name: 'Open in query builder' }).click();
  const view = builder();
  await expect(view.getByTestId('builder-table')).toHaveCount(2);
  await expect(view.getByRole('checkbox', { name: 'c.name', exact: true })).toBeChecked();
  await expect(sqlText()).toContainText('SELECT c.name FROM customers c');
  await view.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(view.getByTestId('row-count')).toHaveText('2 rows');
});
