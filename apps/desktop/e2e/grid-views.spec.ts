import { join } from 'node:path';

import type { Session } from '@joinery/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Grid columns and saved views (spec §7, "Viewing") against a real PostgreSQL server: hide,
 * pin, reorder (by the Columns list and by dragging a header) in the table data grid; a view
 * with the layout, sort and filter saved as the table's default, applied when the table opens
 * again, reset and deleted; and the same column controls on a query result. Screenshots go to
 * JOINERY_E2E_SHOTS when it is set.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const NAME = 'E2E Views';
const SHOTS = process.env['JOINERY_E2E_SHOTS'];

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(
    direct,
    'CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL, qty integer NOT NULL, note text)',
  );
  await query(
    direct,
    `INSERT INTO items SELECT g, 'item ' || g, g, 'note ' || g FROM generate_series(1, 30) g`,
  );
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

function panel(): Locator {
  return page.getByTestId('table-data-panel').filter({ visible: true });
}

/** A data cell through Glide's accessibility table (column 0 is the row markers). */
function cell(scope: Locator, column: number, row: number): Locator {
  return scope.getByTestId(`glide-cell-${column + 1}-${row}`);
}

/** The values of the first row, in display order. */
async function firstRow(scope: Locator, columns: number): Promise<string[]> {
  const values: string[] = [];
  for (let c = 0; c < columns; c++) values.push((await cell(scope, c, 0).textContent()) ?? '');
  return values;
}

async function columnsList(scope: Locator): Promise<Locator> {
  await scope.getByRole('button', { name: /^Columns/ }).click();
  const popover = page.getByTestId('columns-popover');
  await expect(popover).toBeVisible();
  return popover;
}

async function openItems(): Promise<void> {
  await treeRow('items').dblclick();
  await expect(panel()).toBeVisible();
  await expect(panel().getByTestId('table-row-count')).toHaveText(/rows loaded/);
}

test('hides, pins and reorders table columns', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('TLS').selectOption('disable');
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().click();
  await treeRow(database!.name).click();
  await treeRow('public').click();
  await treeRow('Tables').click();
  await openItems();
  await expect.poll(() => firstRow(panel(), 4)).toEqual(['1', 'item 1', '1', 'note 1']);

  let popover = await columnsList(panel());
  await popover.locator('[data-column="note"]').getByRole('checkbox').uncheck();
  await popover.getByRole('button', { name: 'Pin qty' }).click();
  await popover.getByRole('button', { name: 'Move id right' }).click();
  await page.keyboard.press('Escape');
  await expect(panel().getByRole('button', { name: 'Columns (1 hidden)' })).toBeVisible();
  // qty is pinned first; id moved after name; note is hidden.
  await expect.poll(() => firstRow(panel(), 3)).toEqual(['1', 'item 1', '1']);
  await expect(cell(panel(), 0, 1)).toHaveText('2');
  await expect(cell(panel(), 1, 1)).toHaveText('item 2');
  await expect(cell(panel(), 3, 0)).toHaveCount(0);

  // Dragging the name header back before qty pins it into the frozen block.
  const canvas = panel().getByTestId('data-grid-canvas');
  const box = (await canvas.boundingBox())!;
  const header = (x: number) => ({ x: box.x + x, y: box.y + 14 });
  // Row markers (32 px), qty (100 px), name (200 px).
  const from = header(32 + 100 + 100);
  const to = header(32 + 20);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 40, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => firstRow(panel(), 3)).toEqual(['item 1', '1', '1']);

  popover = await columnsList(panel());
  await expect(popover.getByRole('button', { name: 'Unpin name' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('saves a view with the layout, sort and filter, and opens the table with it', async () => {
  const bar = panel().getByTestId('filter-bar');
  await bar.getByRole('radio', { name: 'WHERE' }).click();
  await bar.getByLabel('WHERE condition').fill('qty >= 25');
  await bar.getByRole('button', { name: 'Apply filter' }).click();
  await expect(panel().getByTestId('table-row-count')).toHaveText('6 rows loaded');

  await panel().getByTestId('view-picker').click();
  await page.getByRole('menuitem', { name: 'Save view as…' }).click();
  const save = page.getByRole('dialog', { name: 'Save view' });
  await save.getByLabel('Name').fill('Big qty');
  await save.getByLabel('Open the table with this view').check();
  await save.getByRole('button', { name: 'Save view' }).click();
  await expect(save).toBeHidden();
  await expect(panel().getByTestId('view-picker')).toHaveText(/View: Big qty/);

  // Close the table and open it again: the default view comes back.
  await page.getByRole('button', { name: 'Close items' }).filter({ visible: true }).first().click();
  await expect(panel()).toHaveCount(0);
  await openItems();
  await expect(panel().getByTestId('view-picker')).toHaveText(/View: Big qty/);
  await expect(panel().getByTestId('table-row-count')).toHaveText('6 rows loaded');
  await shot('grid-views-saved');
  await expect.poll(() => firstRow(panel(), 3)).toEqual(['item 25', '25', '25']);
  await expect(panel().getByLabel('WHERE condition')).toHaveValue('qty >= 25');
});

test('switches back to the default view, and deletes the saved one', async () => {
  await panel().getByTestId('view-picker').click();
  await page.getByRole('menuitemradio', { name: 'Default', exact: true }).click();
  await expect(panel().getByTestId('table-row-count')).toHaveText('30 rows loaded');
  await expect.poll(() => firstRow(panel(), 4)).toEqual(['1', 'item 1', '1', 'note 1']);

  await panel().getByTestId('view-picker').click();
  await page.getByRole('menuitemradio', { name: /Big qty/ }).click();
  await expect(panel().getByTestId('table-row-count')).toHaveText('6 rows loaded');
  // A change to the applied view shows, and Reset puts the view back.
  const popover = await columnsList(panel());
  await popover.getByRole('button', { name: 'Show all' }).click();
  await page.keyboard.press('Escape');
  await expect(panel().getByTestId('view-picker')).toContainText('*');
  await panel().getByTestId('view-picker').click();
  await page.getByRole('menuitem', { name: /Reset to/ }).click();
  await expect(panel().getByRole('button', { name: 'Columns (1 hidden)' })).toBeVisible();

  await panel().getByTestId('view-picker').click();
  await page.getByRole('menuitem', { name: /Delete “Big qty”/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete view' }).click();
  await expect(panel().getByTestId('view-picker')).toHaveText(/View: Default/);
  await panel().getByTestId('view-picker').click();
  await expect(page.getByRole('menuitemradio', { name: /Big qty/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('hides and pins columns of a query result', async () => {
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().hover();
  await profile.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'New query tab' }).click();
  const editor = page.getByTestId('sql-editor').filter({ visible: true });
  await editor.click();
  await page.keyboard.type('select 1 as a, 2 as b, 3 as c');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Enter');
  const grid = page.getByTestId('result-grid').filter({ visible: true });
  await expect(page.getByTestId('row-count').filter({ visible: true })).toHaveText('1 row');
  await expect.poll(() => firstRow(grid, 3)).toEqual(['1', '2', '3']);

  const popover = await columnsList(page.getByTestId('query-panel').filter({ visible: true }));
  await popover.locator('[data-column="b"]').getByRole('checkbox').uncheck();
  await popover.getByRole('button', { name: 'Pin c' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => firstRow(grid, 2)).toEqual(['3', '1']);
  await expect(cell(grid, 2, 0)).toHaveCount(0);
});
