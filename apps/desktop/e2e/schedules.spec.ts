import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@querybara/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Schedules (spec: scheduler and automation) against PostgreSQL: a SQL file scheduled from Run
 * SQL File and a table export scheduled from the export wizard, each set up in the schedule
 * editor (when, where each run writes, what to keep), then run from the Schedules panel: the SQL
 * changes the database, the export writes a new file named from the template, and the run
 * history shows both. A schedule is turned off, its rule changed, and deleted. The password is
 * remembered for the session, which scheduled runs in the same session can use.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E Schedules';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let work: string;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(direct, 'CREATE TABLE orders (id integer PRIMARY KEY, total numeric(10,2) NOT NULL)');
  await query(direct, 'INSERT INTO orders VALUES (1, 10), (2, 20), (3, 30)');
  work = mkdtempSync(join(tmpdir(), 'querybara-schedules-'));
  writeFileSync(join(work, 'refresh.sql'), 'INSERT INTO orders VALUES (4, 40);\n');
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  // Closing with a schedule on asks first: answer Quit.
  await launched?.app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = (() =>
        Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    })
    .catch(() => undefined);
  await launched?.close();
  await direct?.close();
  await database?.drop();
  rmSync(work, { recursive: true, force: true });
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Native file dialogs answer with `path`. */
async function stubDialogs(path: string): Promise<void> {
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, path);
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

async function menu(row: Locator, item: string): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

function panel(): Locator {
  return page.getByTestId('schedules-panel').filter({ visible: true });
}

function row(name: string): Locator {
  return panel().locator(`[data-testid="schedule-row"][data-schedule="${name}"]`);
}

test('schedules a SQL file and runs it from the Schedules panel', async () => {
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
  await expect(treeRow(database!.name)).toBeVisible();

  await stubDialogs(join(work, 'refresh.sql'));
  await menu(treeRow(database!.name), 'Run SQL file…');
  const runFile = page.getByRole('dialog', { name: 'Run SQL file' });
  await runFile.getByRole('button', { name: 'Choose file…' }).click();
  await expect(runFile).toContainText('refresh.sql');
  await runFile.getByRole('button', { name: 'Schedule…' }).click();

  const editor = page.getByTestId('schedule-editor');
  await expect(editor).toContainText(`Run refresh.sql on ${NAME}`);
  await expect(editor.getByLabel('Schedule name')).toHaveValue('Run refresh.sql');
  await expect(editor.getByTestId('rule-summary')).toContainText('Every day at 02:00');
  await editor.getByRole('radio', { name: 'Every…' }).click();
  await editor.getByLabel('Every', { exact: true }).fill('15');
  await editor.getByLabel('Unit').selectOption('minutes');
  await expect(editor.getByTestId('rule-summary')).toContainText('Every 15 minutes');
  await shot('schedule-editor');
  await page.getByTestId('schedule-save').click();

  // The panel opens on the new schedule.
  await expect(row('Run refresh.sql')).toBeVisible();
  await expect(row('Run refresh.sql')).toContainText('Every 15 minutes');
  await expect(row('Run refresh.sql')).toContainText(/Next in (1[0-5]|[1-9]) min/);
  const details = panel().getByTestId('schedule-details');
  await details.getByTestId('schedule-run-now').click();
  await expect(details.getByTestId('schedule-run').first()).toHaveAttribute(
    'data-status',
    'success',
  );
  await expect(details.getByTestId('schedule-run').first()).toContainText('1 statements');
  expect(await query(direct!, 'SELECT count(*) FROM orders')).toEqual([[4]]);
});

test('schedules a table export that writes a new file each run', async () => {
  const folder = join(work, 'exports');
  await treeRow(database!.name).click();
  await treeRow('public').click();
  await treeRow('Tables').click();
  await menu(treeRow('orders'), 'Export…');
  const wizard = page.getByRole('dialog', { name: 'Export tables of public' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Schedule…' }).click();

  const editor = page.getByTestId('schedule-editor');
  await expect(editor).toContainText(`Export orders of ${NAME} as CSV`);
  await expect(page.getByTestId('schedule-save')).toBeDisabled();
  await stubDialogs(folder);
  await editor.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(editor.getByTestId('schedule-folder')).toHaveText(folder);
  await expect(editor.getByLabel('File name')).toHaveValue('{name}-{date}-{time}.csv');
  await expect(editor).toContainText(/Like Export-orders-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv/);
  await editor.getByLabel('File name').fill('orders.csv');
  await expect(editor).toContainText('Put {date} or {time} in the name');
  await expect(page.getByTestId('schedule-save')).toBeDisabled();
  await editor.getByLabel('File name').fill('orders-{date}-{time}.csv');
  await page.getByTestId('schedule-save').click();

  await expect(row('Export orders')).toBeVisible();
  const details = panel().getByTestId('schedule-details');
  await expect(details).toContainText(folder);
  await details.getByTestId('schedule-run-now').click();
  const run = details.getByTestId('schedule-run').first();
  await expect(run).toHaveAttribute('data-status', 'success');
  const files = readdirSync(folder);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^orders-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  expect(readFileSync(join(folder, files[0]!), 'utf8')).toContain('4,40.00');
  await expect(run).toContainText(join(folder, files[0]!));

  // A second run in the same minute does not overwrite the first.
  await details.getByTestId('schedule-run-now').click();
  await expect(details.getByTestId('schedule-run')).toHaveCount(2);
  await expect(details.getByTestId('schedule-run').first()).toHaveAttribute(
    'data-status',
    'success',
  );
  expect(readdirSync(folder)).toHaveLength(2);
  await shot('schedules-panel');
});

test('turns a schedule off, edits it and deletes it', async () => {
  const exportRow = row('Export orders');
  await exportRow.getByRole('switch').click();
  await expect(exportRow).toContainText('Off');
  await exportRow.getByRole('switch').click();
  await expect(exportRow).toContainText(/Next in/);

  await exportRow.click();
  const details = panel().getByTestId('schedule-details');
  await details.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByTestId('schedule-editor');
  await editor.getByRole('radio', { name: 'Monthly' }).click();
  await editor
    .getByRole('group', { name: 'Days of the month' })
    .getByRole('button', { name: 'Last' })
    .click();
  await expect(editor.getByTestId('rule-summary')).toContainText(
    'Monthly on the 1st and the last day at 03:00',
  );
  await page.getByTestId('schedule-save').click();
  await expect(exportRow).toContainText('Monthly on the 1st and the last day at 03:00');

  await details.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(exportRow).toHaveCount(0);
  // The files its runs wrote stay.
  expect(existsSync(join(work, 'exports'))).toBe(true);
  expect(readdirSync(join(work, 'exports'))).toHaveLength(2);
});

test('asks before quitting while a schedule is on, and stays open on Cancel', async () => {
  // Native message boxes answer Cancel and record what they were asked.
  await launched!.app.evaluate(({ dialog }) => {
    const asked: Electron.MessageBoxOptions[] = [];
    (globalThis as { querybaraAsked?: typeof asked }).querybaraAsked = asked;
    dialog.showMessageBox = ((...args: unknown[]) => {
      asked.push(args.at(-1) as Electron.MessageBoxOptions);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    }) as typeof dialog.showMessageBox;
  });
  const asked = () =>
    launched!.app.evaluate(
      () => (globalThis as { querybaraAsked?: Electron.MessageBoxOptions[] }).querybaraAsked ?? [],
    );

  await launched!.app.evaluate(({ app }) => app.quit());
  await expect.poll(async () => (await asked()).length).toBe(1);
  const [question] = await asked();
  expect(question!.message).toMatch(
    /^(Quit|Close) Querybara\? Schedules don’t run while it’s closed\.$/,
  );
  expect(question!.detail).toMatch(
    /^The schedule “Run refresh\.sql” is on; its next run is (today|tomorrow) at \d\d:\d\d\./,
  );
  expect(question!.checkboxLabel).toBe('Don’t ask again');
  // Cancelled: Querybara is still here.
  await expect(panel()).toBeVisible();

  // The panel's switch turns the question off, and on again.
  const ask = panel().getByRole('switch', { name: 'Ask before closing Querybara' });
  await expect(ask).toHaveAttribute('aria-checked', 'true');
  await ask.click();
  await expect(ask).toHaveAttribute('aria-checked', 'false');
  await ask.click();
  await expect(ask).toHaveAttribute('aria-checked', 'true');
  await shot('schedules-ask-before-closing');
});
