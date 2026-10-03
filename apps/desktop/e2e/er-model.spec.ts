import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@querybara/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * ER model editing (spec §8, forward engineering) against PostgreSQL: the public schema's
 * diagram put in edit mode; a table added and renamed, columns added and typed, a relationship
 * added from the side panel and one by dragging from a column to another table; a live column
 * renamed; undo and redo; the review showing the script (a rename, not a drop and create) and
 * the apply running it, checked on the server; then a table dropped, which the review only
 * applies once the data loss is acknowledged. Screenshots go to QUERYBARA_E2E_SHOTS.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E ER model';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let files: string;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  for (const sql of [
    'CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL)',
    "INSERT INTO customers VALUES (1, 'Ada'), (2, 'Brian')",
  ]) {
    await query(direct, sql);
  }
  files = mkdtempSync(join(tmpdir(), 'querybara-er-model-'));
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
  rmSync(files, { recursive: true, force: true });
});

async function stubDialogs(path: string): Promise<void> {
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, path);
}

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
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

function editorPanel(): Locator {
  return diagram().getByTestId('er-table-editor');
}

function columnEditor(name: string): Locator {
  return editorPanel().locator(`[data-testid="er-column"][data-column="${name}"]`);
}

async function fill(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.press('Enter');
}

async function columns(table: string): Promise<string[]> {
  const rows = await query(
    direct!,
    `SELECT column_name || ' ' || data_type || ' ' || is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position`,
  );
  return rows.map((row) => String(row[0]));
}

test('designs a table, relates it and applies the script', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('treeitem', { name: NAME }).locator('[data-tree-row]').first().dblclick();
  await treeRow(database!.name).click();
  await treeRow('public').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ER diagram' }).click();
  const view = diagram();
  await expect(box('customers')).toBeVisible();

  await view.getByTestId('er-edit').click();
  const bar = view.getByTestId('er-edit-bar');
  await expect(bar).toContainText('Editing public');
  await expect(bar.getByTestId('er-changes')).toHaveText('No changes yet');

  // A new table, renamed, with columns.
  await bar.getByRole('button', { name: 'Table' }).click();
  await expect(box('new_table')).toHaveAttribute('data-mark', 'new');
  await fill(editorPanel().getByTestId('er-table-name'), 'orders');
  await expect(box('orders')).toBeVisible();
  await editorPanel().getByRole('button', { name: 'Add', exact: true }).click();
  await expect(columnEditor('column2')).toBeVisible();
  await expect(columnEditor('column2').getByLabel('Name of column column2')).toBeFocused();
  await fill(columnEditor('column2').getByLabel('Name of column column2'), 'total');
  await fill(columnEditor('total').getByLabel('Type of total'), 'numeric(10,2)');
  await columnEditor('total')
    .getByRole('button', { name: /make it NOT NULL/ })
    .click();
  await fill(columnEditor('total').getByLabel('Default of total'), '0');
  await expect(box('orders').locator('li', { hasText: 'total' })).toContainText('numeric(10,2)');

  // A reference from the side panel: the column is made and named in the singular.
  await editorPanel().getByLabel('Add a reference from orders').selectOption('customers');
  await expect(view.locator('.react-flow__edge')).toHaveCount(1);
  await expect(diagram().getByTestId('er-relation-editor')).toBeVisible();
  await diagram().getByTestId('er-relation-editor').getByLabel('ON DELETE').selectOption('CASCADE');
  await expect(box('orders').locator('li', { hasText: 'customer_id' })).toBeVisible();

  // A live column renamed, then undone and redone.
  await box('customers').click();
  await fill(columnEditor('name').getByLabel('Name of column name'), 'full_name');
  await expect(box('customers')).toHaveAttribute('data-mark', 'changed');
  await view.getByRole('button', { name: 'Undo' }).click();
  await expect(box('customers').locator('li', { hasText: 'full_name' })).toHaveCount(0);
  await view.getByRole('button', { name: 'Redo' }).click();
  await expect(box('customers').locator('li', { hasText: 'full_name' })).toBeVisible();
  await expect(bar.getByTestId('er-changes')).toHaveText('2 changes');
  await shot('er-model-editing');

  // Review: the script, a rename rather than a drop and a create.
  await bar.getByTestId('er-review-button').click();
  const review = page.getByTestId('er-review');
  // The table and its foreign key; the live column's rename.
  await expect(review).toContainText('2 create');
  await expect(review).toContainText('1 rename');
  const script = review.getByTestId('er-script');
  await expect(script).toContainText('CREATE TABLE "public"."orders"');
  await expect(script).toContainText('"total" numeric(10,2) DEFAULT 0 NOT NULL');
  await expect(script).toContainText('RENAME COLUMN "name" TO "full_name"');
  await expect(script).toContainText(
    'FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE CASCADE',
  );
  await expect(script).not.toContainText('DROP');
  await shot('er-model-review');
  await page.getByTestId('er-apply').click();
  await expect(view.getByTestId('er-notice')).toContainText('Applied');
  await expect(view.getByTestId('er-edit-bar')).toHaveCount(0);

  // On the server.
  expect(await columns('customers')).toEqual(['id integer NO', 'full_name text NO']);
  expect(await columns('orders')).toEqual([
    'id bigint NO',
    'total numeric NO',
    'customer_id integer NO',
  ]);
  await expect(box('orders')).toBeVisible();
  await expect(box('orders')).not.toHaveAttribute('data-mark', /.+/);
  await expect(view.locator('.react-flow__edge')).toHaveCount(1);
});

test('adds a relationship by dragging from a column to a table', async () => {
  const view = diagram();
  await view.getByTestId('er-edit').click();
  await view.getByTestId('er-edit-bar').getByRole('button', { name: 'Table' }).click();
  await fill(editorPanel().getByTestId('er-table-name'), 'notes');
  await view.getByRole('button', { name: 'Fit', exact: true }).click();
  // Let the fit animation settle before measuring.
  await page.waitForTimeout(500);
  const from = box('notes').locator('li[data-column="id"]');
  const to = box('customers');
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // Dropped on the box's header, not a row: the relationship references its key.
  await page.mouse.move(b.x + b.width / 2, b.y + 12, { steps: 12 });
  await page.mouse.up();
  await shot('er-model-drag');
  await expect(view.locator('.react-flow__edge')).toHaveCount(2);
  const relation = diagram().getByTestId('er-relation-editor');
  await expect(relation).toContainText('notes (id)');
  await expect(relation).toContainText('customers (id)');
  await view.getByTestId('er-edit-bar').getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(box('notes')).toHaveCount(0);
  await expect(view.locator('.react-flow__edge')).toHaveCount(1);
});

test('keeps unapplied changes when the diagram closes, and brings them back', async () => {
  const view = diagram();
  await view.getByTestId('er-edit').click();
  await view.getByTestId('er-edit-bar').getByRole('button', { name: 'Table' }).click();
  await fill(editorPanel().getByTestId('er-table-name'), 'wishlist');
  await expect(view.getByTestId('er-kept')).toHaveText('Kept');

  // Closing asks nothing: the changes are kept.
  await page.getByRole('button', { name: 'Close ER diagram (public)' }).click();
  await expect(page.getByTestId('er-diagram')).toHaveCount(0);

  await treeRow('public').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ER diagram' }).click();
  const reopened = diagram();
  await expect(reopened.getByTestId('er-edit-bar')).toBeVisible();
  await expect(box('wishlist')).toHaveAttribute('data-mark', 'new');
  await expect(reopened.getByTestId('er-notice')).toContainText(
    'Restored your unapplied changes to public',
  );
  await shot('er-model-restored');

  await reopened.getByTestId('er-edit-bar').getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(box('wishlist')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close ER diagram (public)' }).click();
  await treeRow('public').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ER diagram' }).click();
  await expect(box('customers')).toBeVisible();
  await expect(diagram().getByTestId('er-edit-bar')).toHaveCount(0);
});

test('saves the model to a file and applies it to another schema', async () => {
  const file = join(files, 'shop.model.json');
  await stubDialogs(file);
  const view = diagram();
  await view.getByTestId('er-model-menu').click();
  await page.getByRole('menuitem', { name: /Save as model file/ }).click();
  await expect(view.getByTestId('er-notice')).toContainText(`Saved the model to ${file}`);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { format: string; base?: unknown };
  expect(saved.format).toBe('querybara.er-model');
  expect(saved.base).toBeUndefined();

  // A new, empty schema: the model opens there as what it should become.
  await query(direct!, 'CREATE SCHEMA staging');
  await treeRow(database!.name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
  await treeRow('staging').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ER diagram' }).click();
  const staging = diagram();
  await staging.getByRole('button', { name: 'Open model file…' }).click();
  await expect(staging.getByTestId('er-edit-bar')).toContainText('Editing staging');
  await expect(staging.getByTestId('er-notice')).toContainText(
    'Opened shop.model.json: it changes 2 tables of staging',
  );
  await expect(box('customers')).toHaveAttribute('data-mark', 'new');

  await staging.getByTestId('er-review-button').click();
  const script = page.getByTestId('er-script');
  await expect(script).toContainText('CREATE TABLE "staging"."customers"');
  await expect(script).toContainText('REFERENCES "staging"."customers" ("id")');
  await page.getByTestId('er-apply').click();
  await expect(staging.getByTestId('er-notice')).toContainText('Applied');
  const tables = await query(
    direct!,
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'staging' ORDER BY 1",
  );
  expect(tables.map((row) => row[0])).toEqual(['customers', 'orders']);
  await page.getByRole('button', { name: 'Close ER diagram (staging)' }).click();
  await expect(box('customers')).toBeVisible();
});

test('drops a table only once the data loss is acknowledged', async () => {
  const view = diagram();
  await view.getByTestId('er-edit').click();
  await box('orders').click();
  await editorPanel().getByTestId('er-delete-table').click();
  await expect(box('orders')).toHaveCount(0);
  await view.getByTestId('er-edit-bar').getByTestId('er-review-button').click();
  const review = page.getByTestId('er-review');
  await expect(review).toContainText('1 drop');
  await expect(review).toContainText('This change loses data');
  const apply = page.getByTestId('er-apply');
  await expect(apply).toBeDisabled();
  await review.getByLabel('I understand the data in these objects will be lost').check();
  await apply.click();
  // The app's write-safety check may ask again about the DROP.
  const risky = page.getByRole('alertdialog', { name: 'Run these statements?' });
  const notice = view.getByTestId('er-notice');
  await expect(risky.or(notice)).toBeVisible();
  if (await risky.isVisible()) await risky.getByRole('button', { name: 'Run anyway' }).click();
  await expect(notice).toContainText('Applied');
  expect(await columns('orders')).toEqual([]);
});
