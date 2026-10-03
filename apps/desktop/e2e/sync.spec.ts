import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@querybara/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Structure sync and data sync in the app against a real PostgreSQL server (spec §13): two
 * databases with differences are compared from the explorer, one operation is left unticked
 * and a destructive one ticked, the script applied, and the automatic re-compare shows only the
 * unticked difference; the HTML report is exported through the save dialog and the comparison
 * saved. Then a data compare from the Compare menu finds an insert, an update and a delete,
 * applies them after the confirmation, and compares clean.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const NAME = 'E2E Sync';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let source: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let target: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let work = '';

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'querybara-e2e-sync-'));
  source = await scratchDatabase(PG_URL!);
  target = await scratchDatabase(PG_URL!);
  const setup = await connect(PG_URL!, source.name);
  try {
    for (const sql of [
      'CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL, email text)',
      'CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id), total numeric(10,2) NOT NULL, note text)',
      'CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100',
      'CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL, price numeric(8,2))',
      'CREATE TABLE notes (body text)',
      "INSERT INTO items VALUES (1, 'one', 1.00), (2, 'two', 2.00), (3, 'three', 3.00), (4, 'four', 4.00), (5, 'five', 5.00)",
    ]) {
      await query(setup, sql);
    }
  } finally {
    await setup.close();
  }
  direct = await connect(PG_URL!, target.name);
  for (const sql of [
    'CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL)',
    'CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id), total numeric(10,2) NOT NULL)',
    'CREATE TABLE legacy (id integer PRIMARY KEY)',
    'CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL, price numeric(8,2))',
    'CREATE TABLE notes (body text)',
    "INSERT INTO items VALUES (1, 'one', 1.00), (2, 'TWO', 2.50), (3, 'three', 3.00), (4, 'four', 4.00), (6, 'six', 6.00)",
  ]) {
    await query(direct, sql);
  }
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await source?.drop();
  await target?.drop();
  if (work) rmSync(work, { recursive: true, force: true });
});

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

/** Right-clicks a tree row and picks an item of its actions menu. */
async function contextMenu(row: Locator, item: string): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

/** The next native save dialog answers with `path`. */
async function stubSave(path: string): Promise<void> {
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, path);
}

function panel(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

async function chooseTarget(view: Locator): Promise<void> {
  await view.getByLabel('Target connection').selectOption({ label: `${NAME} · PostgreSQL` });
  await view.getByLabel('Target database').fill(target!.name);
}

test('connects and shows both databases', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(source!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(treeRow(source!.name)).toBeVisible();
  await expect(treeRow(target!.name)).toBeVisible();
});

test('compares structure, applies all but one operation and re-compares to it', async () => {
  await contextMenu(treeRow(source!.name), 'Compare structure with…');
  const view = panel('structure-compare');
  await expect(view.getByLabel('Source database')).toHaveValue(source!.name);
  await chooseTarget(view);
  await view.getByRole('button', { name: 'Compare', exact: true }).click();

  const summary = view.getByTestId('sync-summary');
  await expect(summary).toContainText('4 differences');
  const email = view.getByRole('checkbox', {
    name: 'Apply create column public.customers.email',
  });
  const legacy = view.getByRole('checkbox', { name: 'Apply drop table public.legacy' });
  // Destructive operations start unticked.
  await expect(legacy).not.toBeChecked();
  await expect(email).toBeChecked();
  await expect(
    view.getByRole('checkbox', { name: 'Apply create view public.big_orders' }),
  ).toBeChecked();

  // The side-by-side view shows both definitions of the operation in focus.
  await view.getByRole('button', { name: 'public.orders.note' }).click();
  await expect(view.getByTestId('source-ddl')).toContainText('note');
  await expect(view.getByTestId('target-ddl')).toContainText('(absent)');

  await email.uncheck();
  await legacy.check();
  await view.getByRole('tab', { name: 'Script' }).click();
  const script = view.getByTestId('sync-script');
  await expect(script).toContainText('DROP TABLE "public"."legacy"');
  await expect(script).not.toContainText('"email"');

  const report = join(work, 'report.html');
  await stubSave(report);
  await view.getByRole('button', { name: 'Export report…' }).click();
  await expect(view.getByTestId('sync-notice')).toContainText(`to ${report}`);
  expect(readFileSync(report, 'utf8')).toContain('Structure comparison');

  await view.getByRole('button', { name: 'Apply…' }).click();
  const review = page.getByRole('alertdialog', { name: 'Review and apply' });
  await expect(review.getByTestId('apply-script')).toContainText('BEGIN;');
  await expect(review).toContainText('1 destructive operation');
  await review.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(view.getByTestId('sync-notice')).toContainText(
    'Compared again: 1 difference remains, none of them applied.',
  );
  await expect(view.getByTestId('sync-error')).toHaveCount(0);
  const remaining = view.getByTestId('sync-operation');
  await expect(remaining).toHaveCount(1);
  await expect(remaining).toHaveAttribute(
    'data-operation-id',
    'column:public.customers.email:create',
  );
  expect(
    await query(
      direct!,
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'note'",
    ),
  ).toEqual([['note']]);
  expect(await query(direct!, "SELECT to_regclass('public.legacy')::text")).toEqual([[null]]);
  expect(await query(direct!, "SELECT to_regclass('public.big_orders')::text")).toEqual([
    ['big_orders'],
  ]);

  await view.getByRole('button', { name: 'Save comparison…' }).click();
  await view.getByLabel('Comparison name').fill('Nightly structure');
  await view.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(view.getByTestId('sync-notice')).toContainText('Saved "Nightly structure"');
  await page.locator('header').getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Saved comparisons…' }).click();
  const saved = page.getByRole('dialog', { name: 'Saved comparisons' });
  await expect(saved.getByTestId('saved-comparison')).toContainText('Nightly structure');
  await saved.getByRole('button', { name: 'Close' }).click();
  await expect(saved).toBeHidden();

  const job = page.getByTestId('job-item').filter({ hasText: 'Apply structure changes to' });
  await page.getByRole('button', { name: 'Jobs' }).click();
  await expect(job).toHaveAttribute('data-state', 'completed');
});

test('compares data, applies an insert, an update and a delete, and compares clean', async () => {
  await page.locator('header').getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Compare data…' }).click();
  const view = panel('data-compare');
  await view.getByLabel('Source connection').selectOption({ label: `${NAME} · PostgreSQL` });
  await view.getByLabel('Source database').fill(source!.name);
  await chooseTarget(view);
  await view.getByRole('button', { name: 'Compare data', exact: true }).click();

  const items = view.getByTestId('data-table-row').filter({ hasText: 'public.items' });
  await expect(items).toContainText('public.items');
  await expect(items.locator('td').nth(3)).toHaveText('1');
  await expect(items.locator('td').nth(4)).toHaveText('1');
  await expect(items.locator('td').nth(5)).toHaveText('1');
  await expect(items.locator('td').nth(6)).toHaveText('3');
  await view.getByTestId('skipped-tables').click();
  await expect(view.getByTestId('skipped-tables')).toContainText(
    'public.notes — The source table has no primary or unique NOT NULL key',
  );

  const grid = view.getByTestId('data-row-grid');
  await expect(grid).toContainText('five');
  await view.getByRole('tab', { name: 'Updates (1)' }).click();
  const changed = grid.locator('td[data-changed]');
  await expect(changed).toHaveCount(2);
  await expect(changed.first()).toContainText('TWO');
  await expect(changed.first()).toContainText('two');

  await view.getByRole('button', { name: 'Apply…' }).click();
  const review = page.getByRole('alertdialog', { name: 'Review and apply the data changes' });
  await expect(review.getByTestId('data-apply-script')).toContainText('DELETE FROM');
  const apply = review.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeDisabled();
  await review.getByRole('checkbox', { name: 'I want to delete 1 row from the target' }).check();
  await apply.click();

  await expect(view.getByTestId('sync-notice')).toContainText(
    'Applied 3 row changes to 1 table. Compared again: no differences remain in the synced tables.',
  );
  expect(await query(direct!, 'SELECT id, name, price::text FROM items ORDER BY id')).toEqual([
    [1, 'one', '1.00'],
    [2, 'two', '2.00'],
    [3, 'three', '3.00'],
    [4, 'four', '4.00'],
    [5, 'five', '5.00'],
  ]);
});
