import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@joinery/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Import and export through the job runner against a real PostgreSQL server (spec §12, §14):
 * a CSV into an existing table and into a new one, a table exported to CSV and JSON and the
 * files compared, Excel and Parquet exports imported into new tables, and a SQL file with one
 * failing statement run in continue mode. Native file
 * dialogs are stubbed in the main process, so they answer with files in a temporary folder.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E Transfer';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let work = '';

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'joinery-e2e-transfer-'));
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(
    direct,
    `CREATE TABLE people (id integer PRIMARY KEY, name text NOT NULL, score numeric(6,2))`,
  );
  await query(
    direct,
    `CREATE TABLE orders (id integer PRIMARY KEY, customer text NOT NULL, total numeric(10,2), note text)`,
  );
  await query(
    direct,
    `INSERT INTO orders VALUES (1, 'Ada', 12.50, 'first'), (2, 'Grace, Hopper', 7.00, NULL), (3, 'Linus', 100.25, 'say "hi"')`,
  );
  writeFileSync(
    join(work, 'people.csv'),
    'id,name,score\n1,Ada Lovelace,9.5\n2,"Hopper, Grace",8.25\n3,Linus,\n',
  );
  writeFileSync(
    join(work, 'products.csv'),
    'code;label;price;added\nA-1;Anvil;19.99;2024-01-02\nB-2;Bucket;4.50;2024-02-03\n',
  );
  writeFileSync(
    join(work, 'script.sql'),
    [
      'CREATE TABLE audit (id integer, what text);',
      "INSERT INTO missing_table VALUES (1, 'nope');",
      "INSERT INTO audit VALUES (1, 'kept');",
      '',
    ].join('\n'),
  );
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

async function menu(row: Locator, item: string): Promise<void> {
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** The next native open or save dialog answers with `path`. */
async function stubDialog(kind: 'open' | 'save', path: string): Promise<void> {
  await launched!.app.evaluate(
    ({ dialog }, [which, file]) => {
      if (which === 'open') {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
      } else {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      }
    },
    [kind, path] as const,
  );
}

function job(title: string): Locator {
  return page.getByTestId('job-item').filter({ hasText: title });
}

test('connects and shows the tables', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  // Main parses the URI asynchronously; typing before it answers races the fill.
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
  await expect(treeRow('people')).toBeVisible();
});

test('imports a CSV file into an existing table', async () => {
  await stubDialog('open', join(work, 'people.csv'));
  await menu(treeRow('people'), 'Import data…');
  const wizard = page.getByRole('dialog', { name: 'Import data into public.people' });
  await wizard.getByRole('button', { name: 'Choose file…' }).click();

  // Detected: CSV, comma, a header row; the preview shows the quoted comma intact.
  await expect(wizard.getByLabel('Delimiter')).toHaveValue(',');
  await expect(wizard.getByText('First row holds the column names')).toBeVisible();
  await expect(wizard.getByTestId('import-preview')).toContainText('Hopper, Grace');
  await wizard.getByRole('button', { name: 'Next' }).click();

  await expect(wizard.getByLabel('Table column for id')).toHaveValue('id');
  await expect(wizard.getByLabel('Table column for name')).toHaveValue('name');
  await expect(wizard.getByLabel('Table column for score')).toHaveValue('score');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByRole('radio', { name: 'Append' })).toBeChecked();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByTestId('import-review')).toContainText('id → id, name → name');
  await wizard.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(wizard).toBeHidden();

  const item = job('Import people.csv into public.people');
  await expect(item).toHaveAttribute('data-state', 'completed');
  await expect(item.getByTestId('job-summary')).toContainText('3 rows imported');
  expect(await query(direct!, `SELECT id, name, score::text FROM people ORDER BY id`)).toEqual([
    [1, 'Ada Lovelace', '9.50'],
    [2, 'Hopper, Grace', '8.25'],
    [3, 'Linus', null],
  ]);

  await treeRow('people').dblclick();
  const view = page.getByTestId('table-data-panel').filter({ visible: true });
  await expect(view.getByTestId('table-row-count')).toHaveText('3 rows loaded');
});

test('imports a CSV file into a new table', async () => {
  await stubDialog('open', join(work, 'products.csv'));
  await menu(treeRow('Tables'), 'Import into new table…');
  const wizard = page.getByRole('dialog', { name: 'Import into a new table in public' });
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByLabel('Delimiter')).toHaveValue(';');
  await wizard.getByRole('button', { name: 'Next' }).click();

  await expect(wizard.getByLabel('Table name')).toHaveValue('products');
  await wizard.getByLabel('code is in the primary key').check();
  await wizard.getByLabel('Type of label').fill('varchar(40)');
  const ddl = wizard.getByTestId('import-ddl');
  await expect(ddl).toContainText('CREATE TABLE "public"."products"');
  await expect(ddl).toContainText('"label" varchar(40)');
  await expect(ddl).toContainText('"added" date');
  await expect(ddl).toContainText('PRIMARY KEY ("code")');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(wizard).toBeHidden();

  const item = job('Import products.csv into new table public.products');
  await expect(item).toHaveAttribute('data-state', 'completed');
  expect(
    await query(
      direct!,
      `SELECT code, label, price::text, added::text FROM products ORDER BY code`,
    ),
  ).toEqual([
    ['A-1', 'Anvil', '19.99', '2024-01-02'],
    ['B-2', 'Bucket', '4.50', '2024-02-03'],
  ]);
  // The explorer reads the structure again and lists the new table.
  await expect(treeRow('products')).toBeVisible();
  await treeRow('products').dblclick();
  const view = page.getByTestId('table-data-panel').filter({ visible: true });
  await expect(view.getByTestId('table-row-count')).toHaveText('2 rows loaded');
});

test('exports a table to CSV and to JSON', async () => {
  const csvPath = join(work, 'orders.csv');
  await stubDialog('save', csvPath);
  await menu(treeRow('orders'), 'Export…');
  let wizard = page.getByRole('dialog', { name: 'Export tables of public' });
  await expect(wizard.getByRole('checkbox', { name: 'orders' })).toBeChecked();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByLabel('Format')).toHaveValue('csv');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('export-destination')).toHaveText(csvPath);
  await wizard.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(wizard).toBeHidden();
  await expect(job('Export orders to CSV')).toHaveAttribute('data-state', 'completed');
  expect(readFileSync(csvPath, 'utf8')).toBe(
    [
      'id,customer,total,note',
      '1,Ada,12.50,first',
      '2,"Grace, Hopper",7.00,',
      '3,Linus,100.25,"say ""hi"""',
      '',
    ].join('\r\n'),
  );

  const jsonPath = join(work, 'orders.json');
  await stubDialog('save', jsonPath);
  await menu(treeRow('orders'), 'Export…');
  wizard = page.getByRole('dialog', { name: 'Export tables of public' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel('Format').selectOption('json');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await wizard.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(job('Export orders to JSON')).toHaveAttribute('data-state', 'completed');
  expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toEqual([
    { id: 1, customer: 'Ada', total: 12.5, note: 'first' },
    { id: 2, customer: 'Grace, Hopper', total: 7, note: null },
    { id: 3, customer: 'Linus', total: 100.25, note: 'say "hi"' },
  ]);
});

test('exports a table to an Excel workbook and imports it into a new table', async () => {
  const xlsxPath = join(work, 'orders.xlsx');
  await stubDialog('save', xlsxPath);
  await menu(treeRow('orders'), 'Export…');
  let wizard = page.getByRole('dialog', { name: 'Export tables of public' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel('Format').selectOption('xlsx');
  await expect(wizard.getByText('Header row with the column names')).toBeVisible();
  // A workbook is compressed already: no gzip, no text encoding.
  await expect(wizard.getByLabel('Encoding')).toHaveCount(0);
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('export-destination')).toHaveText(xlsxPath);
  await wizard.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(wizard).toBeHidden();
  await expect(job('Export orders to XLSX')).toHaveAttribute('data-state', 'completed');
  expect(readFileSync(xlsxPath).subarray(0, 2).toString('latin1')).toBe('PK');

  await stubDialog('open', xlsxPath);
  await menu(treeRow('Tables'), 'Import into new table…');
  wizard = page.getByRole('dialog', { name: 'Import into a new table in public' });
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByLabel('Worksheet')).toHaveValue('orders');
  await expect(wizard.getByLabel('Header row (0: none)')).toHaveValue('1');
  await expect(wizard.getByTestId('import-preview')).toContainText('Grace, Hopper');
  await wizard.getByRole('button', { name: 'Next' }).click();

  await expect(wizard.getByLabel('Table name')).toHaveValue('orders');
  await wizard.getByLabel('Table name').fill('orders_copy');
  await wizard.getByLabel('id is in the primary key').check();
  await expect(wizard.getByTestId('import-ddl')).toContainText(
    'CREATE TABLE "public"."orders_copy"',
  );
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByTestId('import-review')).toContainText('worksheet "orders"');
  await wizard.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(wizard).toBeHidden();

  const item = job('Import orders.xlsx into new table public.orders_copy');
  await expect(item).toHaveAttribute('data-state', 'completed');
  await expect(item.getByTestId('job-summary')).toContainText('3 rows imported');
  const count = `SELECT count(*)::int FROM`;
  expect(await query(direct!, `${count} orders_copy`)).toEqual(
    await query(direct!, `${count} orders`),
  );
  const values = (table: string): string =>
    `SELECT id, customer, total::text, note FROM ${table} ORDER BY id`;
  expect(await query(direct!, values('orders_copy'))).toEqual(
    await query(direct!, values('orders')),
  );
  expect(await query(direct!, values('orders_copy'))).toEqual([
    [1, 'Ada', '12.50', 'first'],
    [2, 'Grace, Hopper', '7.00', null],
    [3, 'Linus', '100.25', 'say "hi"'],
  ]);
});

test('exports a table to Parquet and imports it into a new table typed from the file', async () => {
  const parquetPath = join(work, 'orders.parquet');
  await stubDialog('save', parquetPath);
  await menu(treeRow('orders'), 'Export…');
  let wizard = page.getByRole('dialog', { name: 'Export tables of public' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel('Format').selectOption('parquet');
  await expect(wizard).toContainText('Columnar and typed');
  await wizard.getByLabel('Parquet codec').selectOption('zstd');
  // Parquet compresses its own pages and is binary: no gzip, no text encoding.
  await expect(wizard.getByLabel('Encoding')).toHaveCount(0);
  await expect(wizard.getByLabel('Compression').locator('option[value="gzip"]')).toHaveCount(0);
  await shot('export-parquet');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('export-destination')).toHaveText(parquetPath);
  await wizard.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(wizard).toBeHidden();
  await expect(job('Export orders to Parquet')).toHaveAttribute('data-state', 'completed');
  expect(readFileSync(parquetPath).subarray(0, 4).toString('latin1')).toBe('PAR1');

  await stubDialog('open', parquetPath);
  await menu(treeRow('Tables'), 'Import into new table…');
  wizard = page.getByRole('dialog', { name: 'Import into a new table in public' });
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('import-parquet-summary')).toContainText(
    '3 rows · 1 row group · ZSTD · written by hyparquet',
  );
  await expect(wizard.getByLabel('Encoding')).toHaveCount(0);
  await expect(wizard.getByTestId('import-preview')).toContainText('Grace, Hopper');
  await shot('import-parquet');
  await wizard.getByRole('button', { name: 'Next' }).click();

  await wizard.getByLabel('Table name').fill('orders_parquet');
  await wizard.getByLabel('id is in the primary key').check();
  // Types come from the file's schema, not from guessing at sample text.
  await expect(wizard.getByTestId('import-ddl')).toContainText('"total" numeric(10,2)');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByTestId('import-review')).toContainText(
    'Parquet · 3 rows in 1 row group',
  );
  await wizard.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(wizard).toBeHidden();

  const item = job('Import orders.parquet into new table public.orders_parquet');
  await expect(item).toHaveAttribute('data-state', 'completed');
  await expect(item.getByTestId('job-summary')).toContainText('3 rows imported');
  const values = (table: string): string =>
    `SELECT id, customer, total::text, note FROM ${table} ORDER BY id`;
  expect(await query(direct!, values('orders_parquet'))).toEqual(
    await query(direct!, values('orders')),
  );
});

test('runs a SQL file past a failing statement and logs the error', async () => {
  await stubDialog('open', join(work, 'script.sql'));
  await menu(treeRow(database!.name), 'Run SQL file…');
  const dialog = page.getByRole('dialog', { name: 'Run SQL file' });
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await expect(dialog).toContainText('CREATE TABLE audit');
  await dialog.getByRole('radio', { name: 'Log it and continue' }).check();
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog).toBeHidden();

  const item = job('Run script.sql');
  await expect(item).toHaveAttribute('data-state', 'completed');
  await expect(item.getByTestId('job-summary')).toContainText('3 statements, 1 failed');
  await expect(item.getByTestId('job-log')).toContainText(
    'Statement 2 (line 2): relation "missing_table" does not exist',
  );
  await expect(item.getByTestId('job-errors')).toContainText('missing_table');
  expect(await query(direct!, `SELECT what FROM audit`)).toEqual([['kept']]);
});
